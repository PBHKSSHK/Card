-- ============================================================
-- Migration 04: Add period_month for grouping by billing month
-- Format: 'YYYY-MM' (e.g. '2025-11')
-- Auto-derived from document dates during upload
-- ============================================================

ALTER TABLE upload_batches
  ADD COLUMN IF NOT EXISTS period_month TEXT DEFAULT NULL;

ALTER TABLE card_transactions
  ADD COLUMN IF NOT EXISTS period_month TEXT DEFAULT NULL;

ALTER TABLE meta_invoices
  ADD COLUMN IF NOT EXISTS period_month TEXT DEFAULT NULL;

-- Backfill existing data from statement_period or dates
-- upload_batches: extract from statement_period (e.g. "2025-12 to 2026-01" → "2025-12")
UPDATE upload_batches
SET period_month = LEFT(statement_period, 7)
WHERE period_month IS NULL AND statement_period IS NOT NULL AND LENGTH(statement_period) >= 7;

-- card_transactions: extract from txn_date
UPDATE card_transactions
SET period_month = TO_CHAR(txn_date::date, 'YYYY-MM')
WHERE period_month IS NULL AND txn_date IS NOT NULL;

-- meta_invoices: extract from invoice_date
UPDATE meta_invoices
SET period_month = TO_CHAR(invoice_date::date, 'YYYY-MM')
WHERE period_month IS NULL AND invoice_date IS NOT NULL;

-- Index for fast filtering
CREATE INDEX IF NOT EXISTS idx_batches_period ON upload_batches(period_month);
CREATE INDEX IF NOT EXISTS idx_txn_period ON card_transactions(period_month);
CREATE INDEX IF NOT EXISTS idx_inv_period ON meta_invoices(period_month);

-- ============================================================
-- Done! period_month is auto-set by the frontend during upload.
-- Existing records have been backfilled from their dates.
-- ============================================================
