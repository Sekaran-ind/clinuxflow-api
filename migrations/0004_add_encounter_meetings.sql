-- Phase E: video conferencing via Cloudflare RealtimeKit in Consultation Desk. Maps a clinical
-- encounter to its RealtimeKit meeting, so every care-team member joining the same encounter's
-- call lands in the SAME meeting rather than each join minting a new one. Cloudflare generates
-- the meeting's own id server-side (POST .../meetings' response) -- this table is purely the
-- encounterId -> that id lookup, created lazily on first join (see src/lib/realtime-client.js /
-- POST /api/realtime/join in src/index.js).

CREATE TABLE IF NOT EXISTS encounter_meetings (
    encounter_id TEXT PRIMARY KEY,
    clinic_id TEXT NOT NULL,
    cf_meeting_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_encounter_meetings_clinic_id ON encounter_meetings (clinic_id);
