// D1-backed persistence for auth: clinics (tier lives here) and accounts (one row per staff
// login). Schema: migrations/0003_add_accounts_and_clinics.sql.
export const AccountsDb = {
    // Atomically creates the clinic + its first account together via D1's batch() — if the
    // account insert's UNIQUE(email) constraint fails, the clinic insert is rolled back too, so
    // a failed registration never leaves an orphan clinic row behind.
    //
    // facilityType ('facility' | 'individual', see migrations/0005) is the ONLY thing that
    // distinguishes a standalone practitioner from a real multi-staff facility -- deliberately
    // NOT a schema change to the accounts/clinic_id relationship itself (still NOT NULL, still
    // exactly one clinic row per account family). An individual practitioner's "clinic" is just
    // themselves; the onboarding journey uses this flag to skip every facility-only screen (HFR
    // registration, team invites) rather than the data model needing a parallel shape.
    createClinicAndAccount: (db, clinicId, clinicName, accountId, email, passwordHash, adminName, designation, facilityType = 'facility') => {
        return db.batch([
            db.prepare("INSERT INTO clinics (id, name, tier, facility_type) VALUES (?, ?, 'free', ?)")
                .bind(clinicId, clinicName, facilityType),
            db.prepare(
                "INSERT INTO accounts (id, clinic_id, email, password_hash, admin_name, designation) VALUES (?, ?, ?, ?, ?, ?)"
            ).bind(accountId, clinicId, email, passwordHash, adminName ?? null, designation ?? null),
        ]);
    },

    getClinicById: (db, clinicId) => {
        return db.prepare("SELECT * FROM clinics WHERE id = ?").bind(clinicId).first();
    },

    getAccountByEmail: (db, email) => {
        return db.prepare("SELECT * FROM accounts WHERE email = ?").bind(email).first();
    },

    getAccountById: (db, accountId) => {
        return db.prepare("SELECT * FROM accounts WHERE id = ?").bind(accountId).first();
    },

    // Phase D: adds ANOTHER login onto an EXISTING clinic — unlike createClinicAndAccount above,
    // there's no clinic insert here, and no batch()/rollback concern since only one row is
    // written.
    createTeammateAccount: (db, clinicId, accountId, email, passwordHash, adminName, designation) => {
        return db.prepare(
            "INSERT INTO accounts (id, clinic_id, email, password_hash, admin_name, designation) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(accountId, clinicId, email, passwordHash, adminName ?? null, designation ?? null).run();
    },

    countAccountsByClinicId: (db, clinicId) => {
        return db.prepare("SELECT COUNT(*) as count FROM accounts WHERE clinic_id = ?").bind(clinicId).first();
    },

    // No password_hash in the SELECT — this powers a "who else is on my team" list, never
    // anything that needs the hash.
    listAccountsByClinicId: async (db, clinicId) => {
        const { results } = await db.prepare(
            "SELECT id, email, admin_name, designation, created_at FROM accounts WHERE clinic_id = ? ORDER BY created_at ASC"
        ).bind(clinicId).all();
        return results;
    },

    // Links an EXISTING independent practitioner account to this facility as an affiliate —
    // never creates a new account (see migrations/0005's own comment: affiliates keep their own
    // login, never become a seat under the facility's clinic_id). INSERT OR REPLACE so re-linking
    // an already-revoked affiliate reactivates the same row instead of erroring on the composite
    // primary key.
    addAffiliate: (db, facilityClinicId, practitionerAccountId, role) => {
        return db.prepare(
            `INSERT INTO facility_affiliates (facility_clinic_id, practitioner_account_id, role, status)
             VALUES (?, ?, ?, 'active')
             ON CONFLICT(facility_clinic_id, practitioner_account_id)
             DO UPDATE SET role = excluded.role, status = 'active'`
        ).bind(facilityClinicId, practitionerAccountId, role ?? null).run();
    },

    revokeAffiliate: (db, facilityClinicId, practitionerAccountId) => {
        return db.prepare(
            "UPDATE facility_affiliates SET status = 'revoked' WHERE facility_clinic_id = ? AND practitioner_account_id = ?"
        ).bind(facilityClinicId, practitionerAccountId).run();
    },

    // Joins in the practitioner's own account details (name/designation) so callers don't need a
    // second round-trip per affiliate — this is always a small list (a facility's own visiting
    // consultants), not worth a paginated/lazy design.
    listAffiliatesByFacility: async (db, facilityClinicId) => {
        const { results } = await db.prepare(
            `SELECT a.practitioner_account_id AS accountId, a.role, a.status, a.created_at AS createdAt,
                    acc.email, acc.admin_name AS adminName, acc.designation
             FROM facility_affiliates a
             JOIN accounts acc ON acc.id = a.practitioner_account_id
             WHERE a.facility_clinic_id = ? AND a.status = 'active'
             ORDER BY a.created_at ASC`
        ).bind(facilityClinicId).all();
        return results;
    },

    // The direct (non-QR) Provider-composition mirror — see migrations/0005's own comment. One
    // row per clinic; upsert on every PUT, same ON CONFLICT pattern the Tauri shared server's own
    // /api/collections/:name route already uses for the identical reason (idempotent re-push).
    getProviderComposition: (db, clinicId) => {
        return db.prepare("SELECT data, updated_at AS updatedAt FROM provider_composition WHERE clinic_id = ?")
            .bind(clinicId).first();
    },

    upsertProviderComposition: (db, clinicId, dataJson) => {
        return db.prepare(
            `INSERT INTO provider_composition (clinic_id, data, updated_at) VALUES (?, ?, datetime('now'))
             ON CONFLICT(clinic_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
        ).bind(clinicId, dataJson).run();
    },
};
