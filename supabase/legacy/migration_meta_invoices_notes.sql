-- migration_meta_invoices_notes.sql
-- ---------------------------------------------------------------------------
-- FIX: importing an invoice with a 備註 (note) fails with
--   "Could not find the 'notes' column of 'meta_invoices' in the schema cache"
--
-- UploadCentre writes the invoice-level note as meta_invoices.notes
-- (parentRecord: `...(meta.note ? { notes: meta.note } : {})`), but the column
-- was never created — no migration adds it. Add it (idempotent) and reload the
-- PostgREST schema cache so the API recognises it immediately.
-- ---------------------------------------------------------------------------

ALTER TABLE public.meta_invoices
  ADD COLUMN IF NOT EXISTS notes text;

-- Make PostgREST pick up the new column without waiting for its periodic reload.
NOTIFY pgrst, 'reload schema';
