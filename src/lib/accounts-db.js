// D1-backed persistence for auth: clinics (tier lives here) and accounts (one row per staff
// login). Schema: migrations/0003_add_accounts_and_clinics.sql.
export const AccountsDb = {
    // Atomically creates the clinic + its first account together via D1's batch() — if the
    // account insert's UNIQUE(email) constraint fails, the clinic insert is rolled back too, so
    // a failed registration never leaves an orphan clinic row behind.
    createClinicAndAccount: (db, clinicId, clinicName, accountId, email, passwordHash, adminName, designation) => {
        return db.batch([
            db.prepare("INSERT INTO clinics (id, name, tier) VALUES (?, ?, 'free')")
                .bind(clinicId, clinicName),
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
};
