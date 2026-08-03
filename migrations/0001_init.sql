-- Ported from the original better-sqlite3 schema (see legacy-data/database.sqlite).
CREATE TABLE IF NOT EXISTS partner_profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hospital_name TEXT,
    address TEXT
);

CREATE TABLE IF NOT EXISTS room_workflows (
    room_id TEXT PRIMARY KEY,
    role TEXT,
    specialty TEXT,
    yaml_payload TEXT
);

CREATE TABLE IF NOT EXISTS local_holding_queue (
    session_id TEXT PRIMARY KEY,
    room_id TEXT,
    raw_transcript TEXT,
    questionnaire_response_json TEXT,
    status TEXT CHECK(status IN ('pending_review', 'approved')),
    captured_at TEXT
);
