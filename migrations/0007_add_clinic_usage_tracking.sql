-- Per-clinic cloud-cost metering -- see docs/SPEC-05-DATA-TIER-AND-ABDM-BOUNDARY.md ("keep track
-- of the cloud cost components at the clinic level so we can build the right pricing model").
-- Tracks the same units Cloudflare actually bills on (D1 rows written, D1 read-call counts,
-- Workers AI calls) so the collected numbers map onto real invoice line items instead of an
-- invented abstraction, giving real data to calibrate the free/paid tier boundary later.
--
-- Aggregated daily per (clinic, component) rather than one row per event -- a row-per-event
-- design would mean the tracking writes themselves start outweighing the D1 writes being
-- measured. `component` is a free-text tag, not a CHECK-constrained enum, so new cost sources
-- (R2 ops, ABDM gateway calls, ...) can be added later with no migration -- see
-- src/lib/usageTracking.js for the values in use today.
CREATE TABLE IF NOT EXISTS clinic_usage_daily (
    clinic_id TEXT NOT NULL,
    date TEXT NOT NULL,
    component TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (clinic_id, date, component)
);

CREATE INDEX IF NOT EXISTS idx_clinic_usage_daily_date ON clinic_usage_daily (date);
