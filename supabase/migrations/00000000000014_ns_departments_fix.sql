-- ============================================================================
-- ns_departments constraint fix (applied live 2026-08-12).
--
-- ns_departments rows are (entity x NetSuite department) mappings keyed by
-- charge_to — e.g. 704-Admin / CLS-Admin / JM-Admin all map to the ONE
-- NetSuite department "Admin, Finance, HR" (internal id 6), and PB-Prod /
-- SS-Prod / 704 all map to "Production" (id 2).
--
-- The original schema had unique constraints on BOTH name and internal_id,
-- which silently reduced the 23 charge-to rows to 11 during data migration
-- (first row per name won; the rest hit 23505 and were dropped). That is why
-- the 公司 / Department / Charge To dropdowns were incomplete in Upload
-- Centre, Assign and Split.
--
-- Fix: key on charge_to; keep internal_id as a plain (non-unique) index.
-- The 12 missing rows were re-imported from the old project and internal_id
-- backfilled from NetSuite department names (Ext / JS stay null — they book
-- via intercompany AR, not a NetSuite department).
-- ============================================================================

alter table public.ns_departments drop constraint if exists ns_departments_name_key;
create unique index if not exists ns_departments_charge_to_key
  on public.ns_departments (charge_to);

alter table public.ns_departments drop constraint if exists ns_departments_internal_id_key;
create index if not exists ns_departments_internal_id_idx
  on public.ns_departments (internal_id);
