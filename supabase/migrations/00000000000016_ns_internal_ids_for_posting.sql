-- NetSuite internal ids for journal posting (applied live 2026-08-14).
--
-- The TBA token's role cannot see job (Project) or vendor records via
-- SuiteQL — NetSuite silently returns 0 rows — so the card-journal post
-- function resolves internal ids from these mirrors instead (with SuiteQL
-- kept only as a fallback). Ids were backfilled from NetSuite via an
-- Administrator session:
--   * ns_project_codes.internal_id — job (Project) internal id per P-code
--   * ns_entity_ids — customer/vendor internal ids (C…/V… entityids)
alter table public.ns_project_codes add column if not exists internal_id integer;

create table if not exists public.ns_entity_ids (
  entityid    text primary key,          -- e.g. C10000190 / V10000353
  internal_id integer not null,
  kind        text not null check (kind in ('customer','vendor'))
);
alter table public.ns_entity_ids enable row level security;
drop policy if exists ns_entity_ids_read on public.ns_entity_ids;
create policy ns_entity_ids_read on public.ns_entity_ids
  for select to authenticated using (true);
grant select on public.ns_entity_ids to authenticated;
