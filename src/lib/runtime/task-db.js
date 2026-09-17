// SPEC-25 (docs/SPEC-25-FEDERATED-TASK-PERSISTENCE.md) §6/§10 step 4 — D1-backed persistence for
// the Task/PlanDefinition runtime's durable (paid-tier) mirror: snapshot mirror, append-only
// audit log, and single-writer lock. Copies encounter-coordination-db.js's own functions where
// the shape matches exactly (acquire/renew/release), rather than redesigning them — see this
// file's own migrations/0010 header for why task_locks is a sibling table, not a widened
// encounter_assignments.
const LOCK_TTL_MINUTES = 15;

export const TaskDb = {
    // --- Snapshot mirror (provider_composition/encounter_documents' own shape) ---
    getSnapshot: (db, planId) => {
        return db.prepare("SELECT snapshot, updated_at AS updatedAt FROM task_snapshots WHERE plan_id = ?")
            .bind(planId).first();
    },

    upsertSnapshot: (db, planId, clinicId, snapshotJson) => {
        return db.prepare(
            `INSERT INTO task_snapshots (plan_id, clinic_id, snapshot, updated_at) VALUES (?, ?, ?, datetime('now'))
             ON CONFLICT(plan_id) DO UPDATE SET snapshot = excluded.snapshot, clinic_id = excluded.clinic_id, updated_at = excluded.updated_at`
        ).bind(planId, clinicId, snapshotJson).run();
    },

    // --- Audit log (append-only — every call here is an INSERT, never an UPDATE) ---
    appendAuditEntry: (db, { id, planId, taskId, clinicId, accountId, actionId, fromStatus, toStatus }) => {
        return db.prepare(
            `INSERT INTO task_audit_log (id, plan_id, task_id, clinic_id, account_id, action_id, from_status, to_status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).bind(id, planId, taskId, clinicId, accountId, actionId, fromStatus ?? null, toStatus ?? null).run();
    },

    // Oldest first — what a live-verify pass (SPEC-25 §10 step 6) or a future audit-trail UI
    // reconstructs the real cross-device transition sequence from.
    listAuditLog: async (db, planId) => {
        const { results } = await db.prepare(
            "SELECT * FROM task_audit_log WHERE plan_id = ? ORDER BY created_at ASC"
        ).bind(planId).all();
        return results;
    },

    // --- Single-writer lock (encounter_assignments' `kind:'lock'` primitive, generalized) ---
    getLock: (db, planId) => {
        return db.prepare("SELECT * FROM task_locks WHERE plan_id = ?").bind(planId).first();
    },

    // Same atomic conditional-acquire idea as EncounterCoordinationDb.acquireLock: the UPDATE
    // branch only applies if no row exists yet, the existing lock has already expired, or the
    // same account is re-acquiring (a renew-via-acquire, harmless) — `changes` comes back 0
    // otherwise, the caller's signal that someone else already holds it.
    acquireLock: async (db, planId, clinicId, accountId) => {
        const result = await db.prepare(
            `INSERT INTO task_locks (plan_id, clinic_id, assigned_to_account_id, expires_at, created_at)
             VALUES (?, ?, ?, datetime('now', '+${LOCK_TTL_MINUTES} minutes'), datetime('now'))
             ON CONFLICT(plan_id) DO UPDATE SET
                assigned_to_account_id = excluded.assigned_to_account_id,
                expires_at = excluded.expires_at
             WHERE task_locks.expires_at IS NULL OR task_locks.expires_at < datetime('now')
                OR task_locks.assigned_to_account_id = excluded.assigned_to_account_id`
        ).bind(planId, clinicId, accountId).run();
        return result.meta.changes > 0;
    },

    renewLock: (db, planId, accountId) => {
        return db.prepare(
            `UPDATE task_locks SET expires_at = datetime('now', '+${LOCK_TTL_MINUTES} minutes')
             WHERE plan_id = ? AND assigned_to_account_id = ?`
        ).bind(planId, accountId).run();
    },

    // Clears expires_at rather than deleting the row (unlike EncounterCoordinationDb.releaseLock)
    // — Task.owner ("whoever holds the lock, or last held it", SPEC-25 §5) needs the row to
    // survive release so "last held it" still resolves to someone. Only the current holder can
    // release their own lock, same guard reasoning as encounter locks.
    releaseLock: (db, planId, accountId) => {
        return db.prepare(
            "UPDATE task_locks SET expires_at = NULL WHERE plan_id = ? AND assigned_to_account_id = ?"
        ).bind(planId, accountId).run();
    },
};
