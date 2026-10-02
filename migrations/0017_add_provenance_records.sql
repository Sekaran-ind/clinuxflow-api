-- Digital provenance published from clinux-frontend (paid plan only). Provenance is built and kept
-- on the clinic's device first (clinux-frontend src/provenance/); a paid clinic's devices publish it
-- here so it survives the device and syncs. The free tier never writes this table, so provenance
-- adds no server compute or storage for it. One row per FHIR Provenance resource, stored as sent
-- (ClinuxFlowProvenance profile), with the columns needed to find it again.
CREATE TABLE IF NOT EXISTS provenance_records (
    id TEXT PRIMARY KEY,                 -- the Provenance resource's own id (idempotent re-publish)
    clinic_id TEXT NOT NULL,
    account_id TEXT NOT NULL,            -- who published it (the session), not necessarily the agent
    target TEXT NOT NULL,                -- first target: "QuestionnaireResponse/rec-1" or "system|value"
    activity TEXT,                       -- v3-DataOperation code (CREATE/UPDATE/DELETE)
    recorded TEXT NOT NULL,              -- Provenance.recorded (on the device)
    resource_json TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_provenance_clinic_time ON provenance_records (clinic_id, recorded DESC);
CREATE INDEX IF NOT EXISTS idx_provenance_target ON provenance_records (clinic_id, target);
