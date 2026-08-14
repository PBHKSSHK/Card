-- Auto-sync of NetSuite bank-account GL lines (Edge Function netsuite-sync-gl)
-- needs a stable dedupe key per NetSuite line so re-runs only insert NEW rows
-- and never touch existing ones (preserving is_matched set by Bank Recon).
--
-- ns_line_key = '<netsuite transaction id>:<netsuite line id>'.
-- Manually-imported XLSX rows keep ns_line_key NULL; the unique index still
-- works because Postgres treats NULLs as distinct.
--
-- NOTE: this must be a FULL unique index — PostgREST upsert (ON CONFLICT)
-- cannot target a partial unique index ("there is no unique or exclusion
-- constraint matching the ON CONFLICT specification").

alter table public.ns_gl_entries
  add column if not exists ns_line_key text;

create unique index if not exists ns_gl_entries_line_key_uidx
  on public.ns_gl_entries (ns_line_key);
