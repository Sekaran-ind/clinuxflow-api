-- Durable encounter routing/locking — the coordination layer for staff who aren't on the same
-- LAN (see clinux-mobile-sync-multiuser-video-roadmap-style discussion). One table serves two
-- related but distinct needs, distinguished by `kind`:
--
--   'assignment' (Consultation stage) — durable, no expiry. Front Desk routes an encounter to a
--   SPECIFIC specialist at Triage. Must survive the specialist being offline when it's made —
--   unlike Cübo's chat design, this cannot be ephemeral/client-side-only, since a lost routing
--   decision is a real clinical hand-off failure, not a missed casual message.
--
--   'lock' (Front Desk and Checkout stages) — short-lived, self-acquired, auto-expiring via
--   expires_at. Front Desk and Checkout are shared worklists with no specific assignee (any
--   staff member can pick up any item) — the lock exists purely so two people can't work the
--   same encounter simultaneously. TTL-based expiry is the safety net for a crashed/closed
--   device that never explicitly released its lock.
--
-- PRIMARY KEY (encounter_id, stage) gives one active assignment/lock per encounter per stage,
-- for free, via the same ON CONFLICT upsert pattern already used elsewhere in this schema —
-- and, for locks specifically, a conditional ON CONFLICT ... WHERE clause (see
-- encounter-assignments-db.js) is what makes lock acquisition atomic: the update only applies
-- if no valid, unexpired lock already exists.
CREATE TABLE IF NOT EXISTS encounter_assignments (
    encounter_id TEXT NOT NULL,
    clinic_id TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('onboarding', 'consultation', 'checkout')),
    kind TEXT NOT NULL CHECK (kind IN ('assignment', 'lock')),
    assigned_to_account_id TEXT NOT NULL REFERENCES accounts(id),
    assigned_by_account_id TEXT REFERENCES accounts(id),
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (encounter_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_encounter_assignments_assignee
    ON encounter_assignments (assigned_to_account_id, clinic_id, stage);

-- The durable per-encounter document mirror — same shape/purpose as provider_composition
-- (migrations/0005), just keyed per-encounter instead of per-clinic. Lets an assigned/locked
-- device fetch the actual QuestionnaireResponse data regardless of LAN reachability; the
-- owning device's local-first collection keeps pushing its writes here, same "eventually
-- consistent, best-effort" model as the rest of this app's sync.
CREATE TABLE IF NOT EXISTS encounter_documents (
    encounter_id TEXT PRIMARY KEY,
    clinic_id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_encounter_documents_clinic ON encounter_documents (clinic_id);
