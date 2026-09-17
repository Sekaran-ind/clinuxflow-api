-- SPEC-25 (docs/SPEC-25-FEDERATED-TASK-PERSISTENCE.md) §6 — federated Task persistence's durable
-- (paid-tier) mirror. Three tables, each a direct generalization of an already-proven pattern in
-- this schema, not a new one:
--
--   task_snapshots — the XState actor snapshot mirror, same shape/purpose as
--   provider_composition (migrations/0005): one row per running plan, PUT on save, GET on load,
--   "eventually consistent, best-effort" — never automatic, always explicit push/pull from
--   clinux-frontend's taskSync.js.
--
--   task_audit_log — the durable half of workflowRuntime.js's own `auditLog` (previously
--   in-memory-only, lost on reload — SPEC-20 §4's original ask, never actually persisted until
--   now). Append-only, one row per transition, never updated in place. task_id is the stable
--   `${planId}:${actionId}` composite (taskAuditLog.js's own taskId() helper, the local
--   collection this mirrors); action_id is kept as its own column too since most real queries
--   filter/group by it directly, not because it's independent information. account_id/clinic_id
--   are NOT NULL here even though the LOCAL collection allows a null accountId (an anonymous
--   pre-login transition, e.g. SPEC-20's own register/login flow) — that's deliberate, not an
--   oversight: reaching this table at all requires an authenticated, requirePaidTier()-gated
--   push (same boundary every route below enforces), so an anonymous entry can only ever exist
--   locally and simply never gets pushed here — taskSync.js's own push function is written to
--   skip a null-accountId entry rather than attempt one.
--
--   task_locks — SPEC-25 §4's single-writer enforcement, the exact same primitive
--   encounter_assignments' `kind = 'lock'` rows already prove live for encounter stages (see
--   migrations/0006's own comment), generalized from (encounter_id, stage) to (plan_id) as its
--   own sibling table rather than widening encounter_assignments itself — encounter_assignments'
--   own CHECK constraints and NOT NULL encounter_id column don't have a clean slot for a
--   plan-keyed row, and SPEC-25 §6 explicitly allows a sibling table "if that reads as
--   overloading one table too far." Locks only — no durable 'assignment' kind here (unlike
--   encounter_assignments): SPEC-25 §4 only ever asked for single-writer TTL enforcement, and
--   reassigning a Task's owner (§7) is just handing this same lock off, not a second durable-
--   routing concept. Deliberately NOT deleted on release (see clinuxflow-api's task-db.js
--   releaseLock) — Task.owner ("whoever holds the lock, or last held it", SPEC-25 §5) needs a
--   "last held it" answer even once nothing currently holds the lock, so release clears
--   expires_at instead of dropping the row; a fresh acquire overwrites it, same as
--   encounter_assignments' own upsert does.
CREATE TABLE IF NOT EXISTS task_snapshots (
    plan_id TEXT PRIMARY KEY,
    clinic_id TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_snapshots_clinic ON task_snapshots (clinic_id);

CREATE TABLE IF NOT EXISTS task_audit_log (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    clinic_id TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    action_id TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_audit_log_plan ON task_audit_log (plan_id, created_at);

CREATE TABLE IF NOT EXISTS task_locks (
    plan_id TEXT PRIMARY KEY,
    clinic_id TEXT NOT NULL,
    assigned_to_account_id TEXT NOT NULL REFERENCES accounts(id),
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_locks_assignee ON task_locks (assigned_to_account_id, clinic_id);
