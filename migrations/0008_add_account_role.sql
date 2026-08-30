-- Adds a coarse account-level role for routing the post-signup HFR/HPR prerequisite journeys
-- (see docs/SPEC-11-ABDM-M1-M4-ALIGNMENT.md) -- distinct from facility_affiliates.role (an
-- unrelated free-text per-affiliate relationship label like "Visiting Cardiologist"). This is a
-- fixed 3-value enum describing what the LOGGED-IN ACCOUNT itself is, purely for which
-- self-service onboarding cards ClinicHome offers it -- NOT a permission/authorization system;
-- nothing server-side is gated by this column, and it is deliberately NOT added to the JWT
-- payload (same "don't trust convenience fields from the token" convention requirePaidTier()
-- already established for tier/facility_type -- role is looked up fresh from D1 wherever it's
-- returned, via account/me responses only).
--
-- DEFAULT 'hospital_admin' (not NULL) for backward compatibility -- matches migration 0005's own
-- facility_type precedent exactly. Every pre-existing account was, in effect, the sole
-- owner/admin of its clinic (no admin-vs-professional distinction existed before this column),
-- so this is the closest honest fit, not an arbitrary guess. Also applies going forward to any
-- account-creation path that doesn't explicitly set role (createTeammateAccount, unchanged by
-- this migration -- an invited teammate's real role isn't necessarily "hospital admin", flagged
-- as a follow-up in SPEC-11, out of scope for this pass).
ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'hospital_admin'
    CHECK (role IN ('hospital_admin', 'health_professional', 'admin_and_health_professional'));
