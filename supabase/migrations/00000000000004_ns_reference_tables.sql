-- ============================================================================
-- NetSuite reference/master-data mirror tables.
-- Populated by manual sync from NetSuite (see SettingsPage's Reference Data
-- tab); read-heavy, so RLS is simply "any authenticated user can read/write"
-- (matches the original migration's stated intent — see file comment history).
-- ============================================================================

create table if not exists public.ns_chart_of_accounts (
  id uuid primary key default gen_random_uuid(),
  internal_id integer,
  account_number text not null unique,
  account_name text not null,
  full_name text,          -- "parent:child" format e.g. "81000000 - Department Cost:81000027 - Computer"
  account_type text,
  entity_code text,
  subsidiary text,
  description text,
  currency text default 'HKD',
  parent_number text,
  is_active boolean default true,
  created_at timestamptz default now()
);

create table if not exists public.ns_subsidiaries (
  id uuid primary key default gen_random_uuid(),
  internal_id integer unique,
  name text not null unique,
  short_code text,                -- PBHK, SSHK, CLS, JM, 704, GoAsia
  full_name text,                 -- full NetSuite hierarchical path
  intercompany_ar_account text,
  intercompany_ap_account text,
  intercompany_ar_customer text,
  intercompany_ap_vendor text,
  is_active boolean default true,
  created_at timestamptz default now()
);

create table if not exists public.ns_departments (
  id uuid primary key default gen_random_uuid(),
  internal_id integer unique,
  name text not null unique,
  charge_to text,                 -- granular charge-to code, e.g. "PB-IT", "704-Mgt"
  entity_code text,
  subsidiary_name text,
  subsidiary_full_name text,      -- full "parent : child" NetSuite path, for CSV exports
  ns_subsidiary text,
  is_active boolean default true,
  created_at timestamptz default now()
);

create table if not exists public.ns_employees (
  id uuid primary key default gen_random_uuid(),
  internal_id integer,
  code text not null,
  employee_id text,
  name text not null,
  email text,
  login_access boolean default false,
  subsidiary text,
  department text,
  charge_to text,
  is_active boolean default true,
  created_at timestamptz default now(),
  unique (code, subsidiary)
);

create table if not exists public.ns_vendors (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  is_intercompany boolean default false,
  related_subsidiary text,
  is_active boolean default true,
  created_at timestamptz default now()
);

create table if not exists public.ns_customers (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  project_code text,
  project_name text,
  subsidiary text,
  is_intercompany boolean default false,
  related_subsidiary text,
  is_active boolean default true,
  created_at timestamptz default now(),
  unique (code)
);

create table if not exists public.ns_credit_card_accounts (
  id uuid primary key default gen_random_uuid(),
  account_number text not null unique,
  account_name text not null,
  full_account_name text,   -- "34001000 - Business credit card:34001012 - ..."
  cardholder_name text,
  cardholder_employee_code text,
  card_identifier text,     -- pattern to match from parsed statement (e.g. "Rex", "Alex")
  card_last4 text,
  bank text,
  subsidiary text default 'Photoblog.hk Limited',
  department text default 'Management',
  currency text default 'HKD',
  is_active boolean default true,
  created_at timestamptz default now()
);

create table if not exists public.ns_project_codes (
  id uuid primary key default gen_random_uuid(),
  entity_name text not null,
  charge_to text,
  project_id text not null,
  project_name text not null,
  customer_name text,
  subsidiary text,
  created_at timestamptz not null default now()
);

create index if not exists idx_ns_project_codes_charge_to on public.ns_project_codes(charge_to);

create table if not exists public.ns_intercompany_accounts (
  id bigserial primary key,
  entity_code text not null unique,           -- 704, CLS, JM, SSHK, GoAsia, JS, PBHK
  entity_name text not null,
  -- IC Receivable side: in PBHK's ledger
  ar_account_code text,
  ar_account_name text,
  ar_customer_code text,
  pbhk_subsidiary_path text,
  -- IC Payable side: in the subsidiary's own ledger — NULL if no payable side
  ap_account_code text,
  ap_account_name text,
  ap_vendor_code text,
  sub_subsidiary_path text,
  has_payable_side boolean not null default true,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_ic_accounts_entity on public.ns_intercompany_accounts(entity_code);

create table if not exists public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  category_key text not null unique,
  label_zh text,
  label_en text,
  ns_account_number text,
  sort_order int default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---- RLS: read for everyone authenticated, write for everyone authenticated
-- except ns_intercompany_accounts (admin-only writes; matches the final state
-- in migration_security_integrity_fixes.sql FIX7, which replaced an earlier
-- broken policy referencing a nonexistent public.user_roles table) and
-- expense_categories (admin-managed reference list). ----

alter table public.ns_chart_of_accounts enable row level security;
create policy "ns_coa_read" on public.ns_chart_of_accounts for select to authenticated using (true);
create policy "ns_coa_write" on public.ns_chart_of_accounts for all to authenticated using (true) with check (true);

alter table public.ns_subsidiaries enable row level security;
create policy "ns_sub_read" on public.ns_subsidiaries for select to authenticated using (true);
create policy "ns_sub_write" on public.ns_subsidiaries for all to authenticated using (true) with check (true);

alter table public.ns_departments enable row level security;
create policy "ns_dept_read" on public.ns_departments for select to authenticated using (true);
create policy "ns_dept_write" on public.ns_departments for all to authenticated using (true) with check (true);

alter table public.ns_employees enable row level security;
create policy "ns_emp_read" on public.ns_employees for select to authenticated using (true);
create policy "ns_emp_write" on public.ns_employees for all to authenticated using (true) with check (true);

alter table public.ns_vendors enable row level security;
create policy "ns_vend_read" on public.ns_vendors for select to authenticated using (true);
create policy "ns_vend_write" on public.ns_vendors for all to authenticated using (true) with check (true);

alter table public.ns_customers enable row level security;
create policy "ns_cust_read" on public.ns_customers for select to authenticated using (true);
create policy "ns_cust_write" on public.ns_customers for all to authenticated using (true) with check (true);

alter table public.ns_credit_card_accounts enable row level security;
create policy "ns_cc_read" on public.ns_credit_card_accounts for select to authenticated using (true);
create policy "ns_cc_write" on public.ns_credit_card_accounts for all to authenticated using (true) with check (true);

alter table public.ns_project_codes enable row level security;
create policy "ns_project_codes_read" on public.ns_project_codes for select to authenticated using (true);
create policy "ns_project_codes_write" on public.ns_project_codes for all to authenticated using (true) with check (true);

alter table public.ns_intercompany_accounts enable row level security;
create policy "ic_accounts_read_all" on public.ns_intercompany_accounts for select to authenticated using (true);
create policy "ic_accounts_write_admin" on public.ns_intercompany_accounts
  for all to authenticated
  using (public.is_super_user())
  with check (public.is_super_user());

alter table public.expense_categories enable row level security;
create policy "expense_categories_read" on public.expense_categories for select to authenticated using (true);
create policy "expense_categories_write_admin" on public.expense_categories
  for all to authenticated
  using (public.is_super_user())
  with check (public.is_super_user());
