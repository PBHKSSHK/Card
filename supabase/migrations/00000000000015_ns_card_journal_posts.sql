-- Card-journal posts to NetSuite (Journal Export → Post to NetSuite).
-- One row per externalId (CARDJE-<last4>-<month>[-IC-<entity>]) so the UI can
-- badge already-posted card/month groups. Written by the edge function
-- (service role); read-only for app users. Applied live 2026-08-14.
create table if not exists public.ns_card_journal_posts (
  external_id text primary key,
  netsuite_id text,
  label       text,
  posted_at   timestamptz not null default now(),
  posted_by   uuid
);
alter table public.ns_card_journal_posts enable row level security;
drop policy if exists ns_cjp_read on public.ns_card_journal_posts;
create policy ns_cjp_read on public.ns_card_journal_posts
  for select to authenticated using (true);
grant select on public.ns_card_journal_posts to authenticated;
