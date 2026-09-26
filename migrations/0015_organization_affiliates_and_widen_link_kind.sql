-- Generalizes SPEC-26's join-token linking to a 3rd relationship kind: Organization Affiliate
-- (facility-to-facility, e.g. a partner lab or imaging centre), alongside the existing Staff and
-- Practitioner Affiliate kinds. Product direction: "There 2 groupings one for Practitioner as
-- Staff, Practitioner as Affiliate. Similarly there is Organization affiliate... all these needs
-- to be managed in similar way... ClinuxFlow maintains these entities in a D1 resource so a
-- consistent method should be possible." The system-provider-composition-v1 YAML's own
-- section_affiliate_organization group is free text ONLY (see its own comment — no reference-
-- resolution mechanism exists in that compiler) — this migration is what makes a REAL,
-- resolvable link to another ClinuxFlow-registered Organization possible, the same way
-- facility_affiliates (migrations/0005) already does for practitioners. ABDM registration status
-- (HFR/HPR) is a separate, orthogonal fact tracked in each side's own provider_composition — this
-- relationship layer doesn't care whether either side has registered with ABDM.

-- facility_join_tokens.link_kind's CHECK constraint needs widening to accept 'organization'.
-- SQLite has no ALTER TABLE ... ALTER COLUMN for constraints, so this is the standard rebuild:
-- new table (identical shape, widened CHECK) -> copy -> drop -> rename -> recreate the index.
-- No other table references facility_join_tokens as a foreign key (confirmed), so this is safe.
CREATE TABLE facility_join_tokens_new (
    token TEXT PRIMARY KEY,
    facility_clinic_id TEXT NOT NULL REFERENCES clinics(id),
    link_kind TEXT NOT NULL CHECK (link_kind IN ('staff', 'affiliate', 'organization')),
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

INSERT INTO facility_join_tokens_new SELECT * FROM facility_join_tokens;
DROP TABLE facility_join_tokens;
ALTER TABLE facility_join_tokens_new RENAME TO facility_join_tokens;

CREATE INDEX IF NOT EXISTS idx_facility_join_tokens_clinic
    ON facility_join_tokens (facility_clinic_id, status);

-- Organization Affiliates — the org-to-org counterpart to facility_affiliates (practitioners).
-- Deliberately its own table, not a generalized/polymorphic single table with facility_affiliates:
-- the "other side" is a clinics.id here vs. an accounts.id there (different FK target, different
-- identity shape — a real Organization has its own clinic row, not an account), so a shared table
-- would need a discriminator column and a nullable-FK-depending-on-kind design that adds more
-- complexity than it removes. Same CONSISTENT shape/pattern instead: identical column layout,
-- identical INSERT OR REPLACE upsert-on-reactivate semantics, identical bidirectional indexing.
CREATE TABLE IF NOT EXISTS facility_organization_affiliates (
    facility_clinic_id TEXT NOT NULL REFERENCES clinics(id),
    affiliate_clinic_id TEXT NOT NULL REFERENCES clinics(id),
    relationship TEXT,   -- free text: "Partner Lab", "Imaging Centre", "Referral Partner", ...
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (facility_clinic_id, affiliate_clinic_id)
);

-- The reverse-lookup index — "which facilities has MY organization been linked to as a partner",
-- the exact same real requirement idx_facility_affiliates_practitioner (migrations/0005) already
-- satisfies for practitioners. Standalone, not clinic_id-prefixed, so it actually answers that
-- query without a full scan (see the generic resource_records table's own limitation here, which
-- is precisely why that table wasn't reused for this).
CREATE INDEX IF NOT EXISTS idx_facility_org_affiliates_affiliate
    ON facility_organization_affiliates (affiliate_clinic_id);
