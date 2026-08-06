-- ============================================================
-- Migration 05: Add parent_invoice_id for parent/child invoices
-- Meta Ads: parent = total invoice, children = campaign line items
-- Other invoices: no parent (parent_invoice_id = NULL)
-- ============================================================

ALTER TABLE meta_invoices
  ADD COLUMN IF NOT EXISTS parent_invoice_id UUID DEFAULT NULL
  REFERENCES meta_invoices(id) ON DELETE CASCADE;

-- Index for fast child lookup
CREATE INDEX IF NOT EXISTS idx_inv_parent ON meta_invoices(parent_invoice_id)
  WHERE parent_invoice_id IS NOT NULL;

-- ============================================================
-- Done! Edge Function will now create:
--   1 parent row (total amount, is_parent = true via NULL parent_invoice_id)
--   N child rows (campaign line items, parent_invoice_id = parent.id)
-- Recon Queue shows parents only; expand to see children.
-- ============================================================
