// D1-backed persistence for encounter routing (durable, Consultation) and worklist locking
// (short-lived, Front Desk/Checkout) — one table, see migrations/0006's own comment for why
// these two are related enough to share a schema but distinct enough to need different upsert
// semantics below. Also the per-encounter document mirror, same shape as accounts-db.js's
// Provider-composition mirror, just keyed per-encounter.
const LOCK_TTL_MINUTES = 15;

export const EncounterCoordinationDb = {
    getAssignment: (db, encounterId, stage) => {
        return db.prepare(
            "SELECT * FROM encounter_assignments WHERE encounter_id = ? AND stage = ?"
        ).bind(encounterId, stage).first();
    },

    // Durable routing (Consultation) — a deliberate decision by Front Desk staff, not a
    // concurrent-worker race, so this is a plain unconditional upsert: whoever sets/changes the
    // routing last wins, same as correcting any other field. No expiry.
    assignEncounter: (db, encounterId, clinicId, assignedToAccountId, assignedByAccountId) => {
        return db.prepare(
            `INSERT INTO encounter_assignments (encounter_id, clinic_id, stage, kind, assigned_to_account_id, assigned_by_account_id, expires_at, created_at)
             VALUES (?, ?, 'consultation', 'assignment', ?, ?, NULL, datetime('now'))
             ON CONFLICT(encounter_id, stage) DO UPDATE SET
                assigned_to_account_id = excluded.assigned_to_account_id,
                assigned_by_account_id = excluded.assigned_by_account_id,
                created_at = excluded.created_at`
        ).bind(encounterId, clinicId, assignedToAccountId, assignedByAccountId).run();
    },

    // Worklist lock (Front Desk/Checkout) — atomic conditional acquire: the UPDATE branch only
    // applies if no row exists yet OR the existing row's lock has already expired. If someone
    // else holds a still-valid lock, the WHERE clause is false, D1 leaves the row untouched, and
    // `changes` comes back 0 — that's the caller's signal the acquisition failed (see
    // acquireLock() in index.js, which re-reads the row afterward to report who actually holds
    // it). This is the same "let the database's own conflict resolution do the atomicity" idea
    // already used elsewhere in this schema (e.g. facility_affiliates' addAffiliate), just with
    // a conditional WHERE instead of an unconditional one.
    acquireLock: async (db, encounterId, clinicId, stage, accountId) => {
        const result = await db.prepare(
            `INSERT INTO encounter_assignments (encounter_id, clinic_id, stage, kind, assigned_to_account_id, assigned_by_account_id, expires_at, created_at)
             VALUES (?, ?, ?, 'lock', ?, NULL, datetime('now', '+${LOCK_TTL_MINUTES} minutes'), datetime('now'))
             ON CONFLICT(encounter_id, stage) DO UPDATE SET
                assigned_to_account_id = excluded.assigned_to_account_id,
                expires_at = excluded.expires_at,
                created_at = excluded.created_at
             WHERE encounter_assignments.expires_at IS NULL OR encounter_assignments.expires_at < datetime('now')
                OR encounter_assignments.assigned_to_account_id = excluded.assigned_to_account_id`
        ).bind(encounterId, clinicId, stage, accountId).run();
        return result.meta.changes > 0;
    },

    // Renews an already-held lock's TTL — called periodically while the holder is actively
    // working (see the heartbeat wiring in index.js), so a normal-length work session never
    // hits the expiry that exists specifically to catch a crashed/closed device instead.
    renewLock: (db, encounterId, stage, accountId) => {
        return db.prepare(
            `UPDATE encounter_assignments SET expires_at = datetime('now', '+${LOCK_TTL_MINUTES} minutes')
             WHERE encounter_id = ? AND stage = ? AND assigned_to_account_id = ? AND kind = 'lock'`
        ).bind(encounterId, stage, accountId).run();
    },

    // Only the current holder can release their own lock — a stale/duplicate release call from
    // a device that already lost the lock (expired, taken over) can't accidentally clear
    // whoever holds it now.
    releaseLock: (db, encounterId, stage, accountId) => {
        return db.prepare(
            "DELETE FROM encounter_assignments WHERE encounter_id = ? AND stage = ? AND assigned_to_account_id = ? AND kind = 'lock'"
        ).bind(encounterId, stage, accountId).run();
    },

    // "What's assigned/locked to me" — the specialist-scoped Consultation queue, or (less
    // commonly needed, but symmetric) a listing of what a given account currently holds on the
    // shared Front Desk/Checkout worklists. Excludes expired locks — an expired lock is exactly
    // as if it never existed, freeing that encounter back to the shared worklist.
    listAssignedTo: async (db, accountId, clinicId, stage) => {
        const { results } = await db.prepare(
            `SELECT * FROM encounter_assignments
             WHERE assigned_to_account_id = ? AND clinic_id = ? AND stage = ?
                AND (kind = 'assignment' OR expires_at > datetime('now'))
             ORDER BY created_at DESC`
        ).bind(accountId, clinicId, stage).all();
        return results;
    },

    getDocument: (db, encounterId) => {
        return db.prepare("SELECT data, updated_at AS updatedAt FROM encounter_documents WHERE encounter_id = ?")
            .bind(encounterId).first();
    },

    upsertDocument: (db, encounterId, clinicId, dataJson) => {
        return db.prepare(
            `INSERT INTO encounter_documents (encounter_id, clinic_id, data, updated_at) VALUES (?, ?, ?, datetime('now'))
             ON CONFLICT(encounter_id) DO UPDATE SET data = excluded.data, clinic_id = excluded.clinic_id, updated_at = excluded.updated_at`
        ).bind(encounterId, clinicId, dataJson).run();
    },
};
