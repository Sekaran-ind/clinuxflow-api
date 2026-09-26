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
    //
    // role ('hospital_admin' | 'health_professional' | 'admin_and_health_professional', see
    // migrations/0008) is a SEPARATE concept from facilityType -- it routes which self-service
    // HFR/HPR onboarding journeys ClinicHome offers the account (see docs/SPEC-11-ABDM-M1-M4-
    // ALIGNMENT.md), not whether the clinic itself is a facility or a solo practice.
    createClinicAndAccount: (db, clinicId, clinicName, accountId, email, passwordHash, adminName, designation, facilityType = 'facility', role = 'hospital_admin') => {
        return db.batch([
            db.prepare("INSERT INTO clinics (id, name, tier, facility_type) VALUES (?, ?, 'free', ?)")
                .bind(clinicId, clinicName, facilityType),
            db.prepare(
                "INSERT INTO accounts (id, clinic_id, email, password_hash, admin_name, designation, role) VALUES (?, ?, ?, ?, ?, ?, ?)"
            ).bind(accountId, clinicId, email, passwordHash, adminName ?? null, designation ?? null, role),
        ]);
    },

    getClinicById: (db, clinicId) => {
        return db.prepare("SELECT * FROM clinics WHERE id = ?").bind(clinicId).first();
    },

    // Sign-up no longer collects a clinic name up front (see SPEC-11) -- clinics.name starts as a
    // placeholder derived from the registering email/role, replaced with the real hospital_name
    // once the new Hospital/HFR journey captures it. Called from there, not from registration.
    updateClinicName: (db, clinicId, name) => {
        return db.prepare("UPDATE clinics SET name = ? WHERE id = ?").bind(name, clinicId).run();
    },

    getAccountByEmail: (db, email) => {
        return db.prepare("SELECT * FROM accounts WHERE email = ?").bind(email).first();
    },

    // Change-password (SPEC-13/clinux-planDefinition-runtime-built's small closed-loop test case
    // — register/login/change-password, deliberately small so the new PlanDefinition runtime has
    // something well-understood to validate against). Mirrors updateClinicName's exact shape
    // above — one column, one WHERE-by-id UPDATE, no batch() needed.
    updatePasswordHash: (db, accountId, passwordHash) => {
        return db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?").bind(passwordHash, accountId).run();
    },

    // SPEC-20 (docs/SPEC-20-REFERENCE-PATTERN-JOURNEY-WORKBENCH-AND-UNAUTH-CUBO-ENTRY.md) §4's
    // Forgot Password design (migrations/0009). A deliberately separate call, not folded into
    // registration -- keeps createClinicAndAccount's contract (and its existing tests) unchanged;
    // the new entry-flow UI calls this right after register succeeds, using the fresh token
    // register already returns, same as change_password already does as its own independent step.
    // Also how a pre-existing account (created before this migration) sets one for the first time.
    updateSecurityQuestion: (db, accountId, securityQuestion, securityAnswerHash) => {
        return db.prepare("UPDATE accounts SET security_question = ?, security_answer_hash = ? WHERE id = ?")
            .bind(securityQuestion, securityAnswerHash, accountId).run();
    },

    getAccountById: (db, accountId) => {
        return db.prepare("SELECT * FROM accounts WHERE id = ?").bind(accountId).first();
    },

    // Phase D: adds ANOTHER login onto an EXISTING clinic — unlike createClinicAndAccount above,
    // there's no clinic insert here, and no batch()/rollback concern since only one row is
    // written. status defaults to 'active' (POST /api/auth/invite's own existing behavior,
    // unchanged) — SPEC-26's POST .../join-tokens/:token/redeem passes 'pending' explicitly for a
    // staff account created via token redemption, since that account must not be able to log in
    // until the admin approves the request (see migrations/0012's own comment on why).
    createTeammateAccount: (db, clinicId, accountId, email, passwordHash, adminName, designation, status = 'active') => {
        return db.prepare(
            "INSERT INTO accounts (id, clinic_id, email, password_hash, admin_name, designation, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(accountId, clinicId, email, passwordHash, adminName ?? null, designation ?? null, status).run();
    },

    // SPEC-26 §9's .../decide route — flips a pending-via-token staff account to 'active' on
    // approval or 'rejected' on rejection (POST /api/auth/login's own status check is what this
    // actually gates).
    setAccountStatus: (db, accountId, status) => {
        return db.prepare("UPDATE accounts SET status = ? WHERE id = ?").bind(status, accountId).run();
    },

    countAccountsByClinicId: (db, clinicId) => {
        return db.prepare("SELECT COUNT(*) as count FROM accounts WHERE clinic_id = ?").bind(clinicId).first();
    },

    // No password_hash in the SELECT — this powers a "who else is on my team" list, never
    // anything that needs the hash. status included (SPEC-26) so the admin's own team list can
    // show "pending approval" for a not-yet-decided join-token account, not just Cübo's chat card.
    listAccountsByClinicId: async (db, clinicId) => {
        const { results } = await db.prepare(
            "SELECT id, email, admin_name, designation, created_at, status FROM accounts WHERE clinic_id = ? ORDER BY created_at ASC"
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

    // The reverse of listAffiliatesByFacility — every facility THIS practitioner is actively
    // affiliated with, for their own "Clinic Association" surface (PractitionerHome.vue) to
    // render. A real gap found live: nothing ever called this query before, even though
    // migrations/0005 already added idx_facility_affiliates_practitioner specifically for it —
    // the practitioner-side read half of this relationship was simply never built. Joins in the
    // facility's own name so the practitioner's client never needs a second round-trip per
    // facility either, same reasoning listAffiliatesByFacility's own comment gives the other way.
    listAffiliationsByAccount: async (db, practitionerAccountId) => {
        const { results } = await db.prepare(
            `SELECT a.facility_clinic_id AS facilityClinicId, a.role, a.status, a.created_at AS createdAt,
                    c.name AS facilityName
             FROM facility_affiliates a
             JOIN clinics c ON c.id = a.facility_clinic_id
             WHERE a.practitioner_account_id = ? AND a.status = 'active'
             ORDER BY a.created_at ASC`
        ).bind(practitionerAccountId).all();
        return results;
    },

    // Organization Affiliates (migrations/0015) — the org-to-org counterpart to the 4 functions
    // just above. Same "consistent method" shape deliberately: addOrganizationAffiliate mirrors
    // addAffiliate's own INSERT-OR-reactivate semantics, revokeOrganizationAffiliate mirrors
    // revokeAffiliate, and the two list functions below mirror listAffiliatesByFacility/
    // listAffiliationsByAccount exactly, just joining clinics instead of accounts on the far side
    // (a real Organization has its own clinic row, not an account). ABDM (HFR) registration status
    // is orthogonal — whether either side has registered with ABDM lives in their own
    // provider_composition, never checked or touched here.
    addOrganizationAffiliate: (db, facilityClinicId, affiliateClinicId, relationship) => {
        return db.prepare(
            `INSERT INTO facility_organization_affiliates (facility_clinic_id, affiliate_clinic_id, relationship, status)
             VALUES (?, ?, ?, 'active')
             ON CONFLICT(facility_clinic_id, affiliate_clinic_id)
             DO UPDATE SET relationship = excluded.relationship, status = 'active'`
        ).bind(facilityClinicId, affiliateClinicId, relationship ?? null).run();
    },

    revokeOrganizationAffiliate: (db, facilityClinicId, affiliateClinicId) => {
        return db.prepare(
            "UPDATE facility_organization_affiliates SET status = 'revoked' WHERE facility_clinic_id = ? AND affiliate_clinic_id = ?"
        ).bind(facilityClinicId, affiliateClinicId).run();
    },

    // Joins in the affiliate organization's own clinic name — same one-round-trip reasoning
    // listAffiliatesByFacility's own comment gives.
    listOrganizationAffiliatesByFacility: async (db, facilityClinicId) => {
        const { results } = await db.prepare(
            `SELECT oa.affiliate_clinic_id AS affiliateClinicId, oa.relationship, oa.status, oa.created_at AS createdAt,
                    c.name AS affiliateClinicName
             FROM facility_organization_affiliates oa
             JOIN clinics c ON c.id = oa.affiliate_clinic_id
             WHERE oa.facility_clinic_id = ? AND oa.status = 'active'
             ORDER BY oa.created_at ASC`
        ).bind(facilityClinicId).all();
        return results;
    },

    // The reverse of listOrganizationAffiliatesByFacility — every facility MY organization is
    // linked to as a partner, for this clinic's own admin-facing "Partner Organizations" surface
    // to render (the org-level counterpart to listAffiliationsByAccount's practitioner-facing
    // "Clinic Association" card).
    listOrganizationAffiliationsByClinic: async (db, clinicId) => {
        const { results } = await db.prepare(
            `SELECT oa.facility_clinic_id AS facilityClinicId, oa.relationship, oa.status, oa.created_at AS createdAt,
                    c.name AS facilityName
             FROM facility_organization_affiliates oa
             JOIN clinics c ON c.id = oa.facility_clinic_id
             WHERE oa.affiliate_clinic_id = ? AND oa.status = 'active'
             ORDER BY oa.created_at ASC`
        ).bind(clinicId).all();
        return results;
    },

    // The direct (non-QR) Provider-composition mirror — see migrations/0005's own comment. One
    // row per clinic; upsert on every PUT, same ON CONFLICT pattern the Tauri shared server's own
    // /api/collections/:name route already uses for the identical reason (idempotent re-push).
    getProviderComposition: (db, clinicId) => {
        return db.prepare("SELECT data, updated_at AS updatedAt, published_at AS publishedAt FROM provider_composition WHERE clinic_id = ?")
            .bind(clinicId).first();
    },

    // published: whether onboarding.js's publish() has run — see migrations/0012's own comment
    // on why this couldn't just be inferred from data existing. One-way: a false here NEVER
    // clears an already-set published_at (COALESCE keeps the existing value), matching
    // everPublished's own client-side "go live" semantics — publishing is never un-done by a
    // later ordinary save.
    upsertProviderComposition: (db, clinicId, dataJson, published = false) => {
        return db.prepare(
            `INSERT INTO provider_composition (clinic_id, data, updated_at, published_at)
             VALUES (?, ?, datetime('now'), CASE WHEN ? THEN datetime('now') ELSE NULL END)
             ON CONFLICT(clinic_id) DO UPDATE SET
                data = excluded.data,
                updated_at = excluded.updated_at,
                published_at = COALESCE(provider_composition.published_at, excluded.published_at)`
        ).bind(clinicId, dataJson, published ? 1 : 0).run();
    },
};
