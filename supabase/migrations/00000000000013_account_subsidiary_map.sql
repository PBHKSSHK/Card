-- ============================================================================
-- Account -> subsidiary sharing map.
--
-- Background: in NetSuite (OneWorld) a single GL account record is *shared*
-- across many subsidiaries — the cost accounts (70000xx) and overhead accounts
-- (81000xx) are all shared across the operating subsidiaries. The old-project
-- migration flattened this many-to-many relationship into a single
-- `ns_chart_of_accounts.entity_code` per account (everything landed on 'PBHK').
--
-- The Upload Centre filters the expense-category dropdown by
-- entity_code -> Set<account_number>, so with the flattened data a non-PBHK
-- entity (e.g. CLS) saw an empty Category list after selecting a Project.
--
-- This table restores the real sharing (verified against NetSuite
-- AccountSubsidiaryMap) so the category filter is correct for every entity.
-- One row per (account_number, subsidiary). entity_code mirrors
-- ns_subsidiaries.short_code for convenience in the client.
-- ============================================================================

create table if not exists public.ns_account_subsidiaries (
  account_number         text    not null,
  subsidiary_internal_id integer not null,
  entity_code            text,
  created_at             timestamptz not null default now(),
  primary key (account_number, subsidiary_internal_id)
);

comment on table public.ns_account_subsidiaries is
  'Which NetSuite subsidiaries each GL account is shared with (mirrors NetSuite AccountSubsidiaryMap). Used to filter the expense-category dropdown per entity.';

alter table public.ns_account_subsidiaries enable row level security;

drop policy if exists ns_acct_sub_read on public.ns_account_subsidiaries;
create policy ns_acct_sub_read on public.ns_account_subsidiaries
  for select to authenticated using (true);

drop policy if exists ns_acct_sub_write on public.ns_account_subsidiaries;
create policy ns_acct_sub_write on public.ns_account_subsidiaries
  for all to authenticated using (is_super_user()) with check (is_super_user());

grant select on public.ns_account_subsidiaries to authenticated;

-- --------------------------------------------------------------------------
-- Seed the sharing for the accounts that back expense_categories.
-- Cost / overhead / other-income accounts are shared across the operating
-- subsidiaries PBHK(1), SSHK(2), CLS(5), JM(7), 704(8). (NetSuite also lists an
-- internal subsidiary 4 that is not an app charge-to entity; it is intentionally
-- omitted because it never maps to a selectable entity_code.)
-- --------------------------------------------------------------------------
insert into public.ns_account_subsidiaries (account_number, subsidiary_internal_id, entity_code)
select a.acct, s.internal_id, s.short_code
from (
  select unnest(array[
    '64000009',                                   -- Other Income
    '70000012','70000020','70000028','70000032',  -- Cost of Services
    '70000036','70000048','70000056','70000060',
    '81000009','81000027','81000048','81000057',  -- Overhead
    '81000064','81000069','81000081','81000087',
    '81000090','81000096','81000099'
  ]) as acct
) a
join public.ns_subsidiaries s on s.internal_id in (1, 2, 5, 7, 8)
on conflict (account_number, subsidiary_internal_id) do nothing;

-- Inventory - Motorcycle Accessories (21000013) is CLS-only (subsidiary 5).
insert into public.ns_account_subsidiaries (account_number, subsidiary_internal_id, entity_code)
select '21000013', s.internal_id, s.short_code
from public.ns_subsidiaries s where s.internal_id = 5
on conflict (account_number, subsidiary_internal_id) do nothing;
