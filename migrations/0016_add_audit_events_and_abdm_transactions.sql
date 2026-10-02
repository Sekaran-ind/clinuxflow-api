-- Operations: the workspace's Activity log and ABDM transactions screens (clinux-frontend
-- /operations/*), modelled on the Swastik ABDM Connector's Operations section.
--
-- Both tables hold identifiers and statuses only, never payloads: no Aadhaar numbers, OTPs,
-- passwords, demographics or clinical content. A row says what happened, to which object, by whom
-- and when — not what was in it.

-- Privacy-significant state changes: sign-ups, sign-ins, password changes, join links, and the
-- registry journeys' outcomes (an HPR ID linked, a facility submitted to HFR, an ABHA recorded on
-- a patient). Written server-side for what the server does itself (src/lib/shared/audit.js) and
-- through POST /api/operations/audit, from an allow-list, for what the browser does directly
-- against ABDM via clinuxflow-abdm-gateway.
CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    clinic_id TEXT NOT NULL,
    actor_account_id TEXT,              -- NULL for system-initiated events
    actor_label TEXT NOT NULL,          -- email, or 'system'
    action TEXT NOT NULL,               -- e.g. 'account.signed_in', 'abha.recorded'
    object_type TEXT,                   -- e.g. 'account', 'patient', 'facility', 'join_token'
    object_id TEXT,
    metadata_json TEXT,                 -- small object of identifiers/statuses only
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_events_clinic_time ON audit_events (clinic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor_time ON audit_events (actor_account_id, created_at DESC);

-- Every ABDM operation a clinic's users drove through clinuxflow-abdm-gateway (HPR, HFR, ABHA,
-- UHI): which operation, what came back, ABDM's REQUEST-ID when ABDM returned one, and how long it
-- took — the log to open when a registration stalls and you need to know which side went quiet.
-- Written by the gateway (same `clinuxflow` D1 database, bound there as DB); read here.
CREATE TABLE IF NOT EXISTS abdm_transactions (
    id TEXT PRIMARY KEY,
    clinic_id TEXT NOT NULL,
    account_id TEXT,
    service TEXT NOT NULL,              -- 'hpr' | 'hfr' | 'abha' | 'uhi'
    operation TEXT NOT NULL,            -- the gateway route pattern, e.g. 'POST /hpr/registration/aadhaar-link'
    http_status INTEGER NOT NULL,       -- what the gateway answered
    ok INTEGER NOT NULL,                -- 1 = success
    abdm_status INTEGER,                -- ABDM's own HTTP status, when the call reached ABDM and failed
    abdm_request_id TEXT,
    error TEXT,                         -- short gateway/ABDM message on failure; never a payload
    duration_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_abdm_transactions_clinic_time ON abdm_transactions (clinic_id, created_at DESC);
