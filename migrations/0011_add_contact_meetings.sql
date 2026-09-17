-- SPEC-25-adjacent (Hospital/Provider/Affiliate journey follow-up: contact-to-contact video
-- calling from Cübo) — generalizes encounter_meetings (migrations/0004) from "one meeting per
-- clinical encounter" to "one meeting per pair of people," the same real gap TeamChat.vue/
-- CuboContactConversation.vue already closed for CHAT (real P2P messaging between any staff
-- member and any linked affiliate) but never for video.
--
-- room_id is a deterministic sorted account-id pair — exactly runtime.js's own chatRoomName()
-- convention for the P2P chat signaling Durable Object, reused here (not reinvented) so both
-- participants' independent POST /api/realtime/contact-call/:peerAccountId/join calls agree on
-- the SAME room regardless of who initiates. A sibling table, not a widened encounter_meetings —
-- that table's own encounter_id is a real clinical-record foreign key or scoping is meant
-- to be a real Task/PlanDefinition anchor, and a plain deterministic string pair isn't a good fit
-- for that column's own meaning (same "own sibling table, not overloaded" discipline
-- migrations/0010's task_locks note already established for a materially similar precedent).
CREATE TABLE IF NOT EXISTS contact_meetings (
    room_id TEXT PRIMARY KEY,
    cf_meeting_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
