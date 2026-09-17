-- docs/SPEC-26-FACILITY-JOIN-TOKEN-LINKING.md — token-based staff/affiliate linking, replacing
-- POST /api/auth/invite's admin-invents-a-password flow and POST /api/facility/affiliates'
-- email-lookup-only flow with one consistent, self-service mechanism.

-- SPEC-26 §4's facilitySetupMachine needs a real "has this clinic ever published" signal
-- server-side to gate token issuance/redemption without trusting client state — provider_composition
-- (migrations/0005) only ever stored the document itself, never this. published_at is one-way
-- (set once, never cleared), same semantics onboarding.js's own client-side everPublished already
-- has — a real go-live moment, not just "some data exists" (see facilitySetupMachine.js's own
-- basics_saved vs. published distinction for why collapsing the two would defeat the point).
ALTER TABLE provider_composition ADD COLUMN published_at TEXT;

-- SPEC-26 §8. One table, not two (see SPEC-26 §6's revision) — the admin-approval step moved onto
-- the real Cübo chat/LForms transfer-key mechanism instead of a server-side request queue, so
-- there is no request *content* left to justify a separate facility_join_requests table. This row
-- is purely an existence-and-decision record: who issued it, whether/who redeemed it, whether the
-- admin approved it, plus (SPEC-26 §6's Cloudflare Queues revision) a `pending_payload` column
-- holding the SAME encodeSessionTransfer() ciphertext the live P2P chat path also sends — the
-- durable fallback for when the admin wasn't online at redemption time. Only ciphertext ever
-- lands here; plaintext name/role/personSetupStage details never do (see SPEC-26 §6's corrected
-- coherence note).
CREATE TABLE IF NOT EXISTS facility_join_tokens (
    token TEXT PRIMARY KEY,
    facility_clinic_id TEXT NOT NULL REFERENCES clinics(id),
    link_kind TEXT NOT NULL CHECK (link_kind IN ('staff', 'affiliate')),
    issued_by_account_id TEXT NOT NULL REFERENCES accounts(id),
    redeemed_by_account_id TEXT REFERENCES accounts(id),
    pending_payload TEXT,
    status TEXT NOT NULL DEFAULT 'issued'
        CHECK (status IN ('issued', 'redeemed', 'approved', 'rejected', 'expired', 'revoked')),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_by_account_id TEXT REFERENCES accounts(id),
    decided_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_facility_join_tokens_clinic
    ON facility_join_tokens (facility_clinic_id, status);

-- Real correctness gap found while wiring the redeem/decide routes: a staff account created at
-- REDEEM time (so the token can be marked consumed and a session issued) must NOT be able to log
-- in and reach clinic data until the admin actually APPROVES the request — otherwise "reject"
-- would be theater, since the account already exists and works. 'pending' blocks login (see
-- POST /api/auth/login's own check); .../decide flips it to 'active' on approve or 'rejected' on
-- reject. Every pre-existing account (register, invite, teammate) defaults to 'active' — this
-- migration doesn't change behavior for anything that isn't going through the new token flow.
ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'pending', 'rejected'));
