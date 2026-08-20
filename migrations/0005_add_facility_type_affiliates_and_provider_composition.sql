-- Unified onboarding journey (Facility vs. Individual practitioner fork), staff-vs-affiliate
-- linking, and the direct (non-QR) staff-onboarding data path. See
-- clinux-mobile-sync-multiuser-video-roadmap-style memory notes for the fuller design context.

-- Distinguishes a real multi-staff facility (the existing, only-supported shape until now) from
-- a standalone individual practitioner registering with no facility at all. Deliberately NOT a
-- schema change to accounts/clinics' NOT NULL clinic_id relationship -- an individual
-- practitioner still gets a clinic row, it's just a clinic-of-one, tagged here so the onboarding
-- journey and any facility-only screens (HFR registration, team invites) know to skip
-- themselves. Defaults to 'facility' so every pre-existing clinic row is correctly classified
-- with no backfill needed.
ALTER TABLE clinics ADD COLUMN facility_type TEXT NOT NULL DEFAULT 'facility'
    CHECK (facility_type IN ('facility', 'individual'));

-- A facility referencing an INDEPENDENT practitioner's own account (their own separate clinic-
-- of-one, or a facility-scoped account elsewhere) as a visiting/affiliate consultant --
-- deliberately NOT a row in `accounts`: an affiliate keeps their own login/identity and does
-- NOT become a seat under this facility's clinic_id, so this never touches
-- MAX_ACCOUNTS_PER_CLINIC (see src/index.js's /api/auth/invite) and never fragments the
-- practitioner's identity across every facility they work with. `role` is free text ("Visiting
-- Cardiologist", "Consulting Radiologist", ...) -- the FHIR-native shape (PractitionerRole.code)
-- lives in the Provider composition document itself once HAPI exists; this table is purely the
-- account-level cross-reference that makes "which facilities can this practitioner's device
-- reach" resolvable without a full FHIR store.
CREATE TABLE IF NOT EXISTS facility_affiliates (
    facility_clinic_id TEXT NOT NULL REFERENCES clinics(id),
    practitioner_account_id TEXT NOT NULL REFERENCES accounts(id),
    role TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (facility_clinic_id, practitioner_account_id)
);

CREATE INDEX IF NOT EXISTS idx_facility_affiliates_practitioner
    ON facility_affiliates (practitioner_account_id);

-- The direct (non-QR) replacement for bootstrapping a freshly-invited teammate's device with
-- the clinic's Provider composition (Hospital Profile/Care Team/Services/Hours/Consents) when
-- they're not on the clinic's own LAN (the Tauri shared server's poll-and-merge already handles
-- the on-LAN case with zero new code -- see sharedServerSync.js). One row per clinic, holding
-- the same QuestionnaireResponse-shaped document the local TanStack DB collection already
-- stores client-side -- this is a durable mirror of it, not a second source of truth to
-- reconcile: the owning clinic's own devices keep writing it via the existing local-first path,
-- this table just gives any newly-authenticated device on ANY network something to pull once.
CREATE TABLE IF NOT EXISTS provider_composition (
    clinic_id TEXT PRIMARY KEY REFERENCES clinics(id),
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
