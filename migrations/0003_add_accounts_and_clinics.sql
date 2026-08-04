-- Real server-side authentication. Replaces clinux-frontend's plaintext-password/client-only
-- `users` TanStack DB collection with actual account records here. Named `accounts` (not
-- `users`) to avoid confusion with that separate, non-auth frontend collection of a similar row
-- shape today (src/data/collections/users.js) — that collection still exists after this change,
-- narrowed to only the profile fields the server doesn't model (services/phone/city/etc).
--
-- Tier lives on `clinics`, not `accounts`: a clinic's 1-4 staff logins share one subscription.

CREATE TABLE IF NOT EXISTS clinics (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'paid')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    clinic_id TEXT NOT NULL REFERENCES clinics(id),
    -- Uniqueness relies on the app layer normalizing email to lowercased/trimmed before every
    -- insert/lookup (see src/index.js's register/login handlers) rather than a COLLATE NOCASE
    -- column, matching this codebase's existing "plain SQL, no cleverness" convention.
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    admin_name TEXT,
    designation TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_accounts_clinic_id ON accounts (clinic_id);
