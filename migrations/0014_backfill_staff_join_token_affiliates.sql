-- Backfill for a real bug found live: POST /api/facility/join-tokens/:token/decide's 'staff'
-- branch unconditionally flipped accounts.status on approval, which is a no-op for an already-
-- registered, independent practitioner account (their own clinic_id, from individual
-- registration) redeeming a 'staff' token via the bearer path — a real path .../redeem's own
-- comment explicitly anticipates. The approval was recorded (facility_join_tokens.status ->
-- 'approved'), but no relationship anywhere else was ever written: not accounts.clinic_id
-- (immutable by design), not facility_affiliates. Every token already stuck in that state gets
-- the facility_affiliates row the fixed runtime code (control.js's .../decide route) would have
-- written at approval time. INSERT OR IGNORE — safe to re-run, and never clobbers an
-- already-correct affiliate row for the same (facility, practitioner) pair.
INSERT OR IGNORE INTO facility_affiliates (facility_clinic_id, practitioner_account_id, role, status)
SELECT t.facility_clinic_id, t.redeemed_by_account_id, NULL, 'active'
FROM facility_join_tokens t
JOIN accounts acc ON acc.id = t.redeemed_by_account_id
WHERE t.status = 'approved'
  AND t.redeemed_by_account_id IS NOT NULL
  AND acc.clinic_id != t.facility_clinic_id;
