-- ============================================================================
-- Core credit-card reconciliation + bank reconciliation tables.
-- Column sets below were reconstructed from shared/schema.ts and verified
-- against every .from()/.select()/.insert()/.update() call in the client.
-- ============================================================================

-- ---- Legacy org-chart reference (still used by SettingsPage + the CC
-- matching engine's rule->entity/department resolution; kept alongside the
-- newer ns_departments below because both are actively queried) ----

create table if not exists public.entities (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid references public.entities(id) on delete cascade,
  code text not null,
  name text not null,
  dr_account text,
  created_at timestamptz not null default now(),
  unique (entity_id, code)
);

create table if not exists public.credit_cards (
  id uuid primary key default gen_random_uuid(),
  bank text not null,
  last4 text,
  card_name text,
  currency text not null default 'HKD',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.journal_settings (
  id uuid primary key default gen_random_uuid(),
  cr_account text default '2100',
  default_currency text default 'HKD',
  date_tolerance_days int default 5,
  fuzzy_threshold numeric(3,2) default 0.60,
  amount_tolerance_pct numeric(5,2) default 5.00,
  updated_at timestamptz not null default now()
);

create table if not exists public.journal_exports (
  id uuid primary key default gen_random_uuid(),
  export_name text not null,
  row_count int not null default 0,
  include_unmatched boolean not null default false,
  exported_at timestamptz not null default now(),
  exported_by text
);

-- ---- Upload batches (source-of-truth for every parsed document) ----

create table if not exists public.upload_batches (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  upload_type text not null check (upload_type in ('cc_statement', 'meta_invoice', 'matching_rules', 'bank_statement', 'expense_claim')),
  status text not null default 'uploaded' check (status in ('uploaded', 'processing', 'processed', 'error', 'archived')),
  row_count int default 0,
  error_message text,
  uploaded_at timestamptz not null default now(),
  processed_at timestamptz,
  statement_total numeric(14,2),
  ai_parsed_total numeric(14,2),
  bank text,
  card_last4 text,                -- stores cardholder name, not card digits
  statement_period text,
  statement_date date,            -- statement closing/billing date
  statement_due_date date,        -- payment due date (optional)
  user_id uuid references auth.users(id),
  notes text default '',
  file_path text,                 -- Supabase Storage path in the "documents" bucket
  period_month text,              -- e.g. '2026-01', for grouping
  subsidiary text,
  bank_account text,
  previous_balance numeric(14,2),
  module text default 'cc'        -- 'cc' | 'bank' | 'claim' etc.
);

comment on column public.upload_batches.statement_date is 'Statement closing/billing date (出單日)';
comment on column public.upload_batches.statement_due_date is 'Statement payment due date (找數日)';

create index if not exists idx_batches_period on public.upload_batches(period_month);
create index if not exists idx_upload_batches_statement_date on public.upload_batches(statement_date);

alter table public.upload_batches enable row level security;

create policy "batches_user_select" on public.upload_batches
  for select to authenticated
  using (user_id = auth.uid() or user_id is null or public.is_super_user());

create policy "batches_user_insert" on public.upload_batches
  for insert to authenticated
  with check (true);

create policy "batches_user_update" on public.upload_batches
  for update to authenticated
  using (user_id = auth.uid() or user_id is null or public.is_super_user());

create policy "batches_user_delete" on public.upload_batches
  for delete to authenticated
  using (user_id = auth.uid() or user_id is null or public.is_super_user());

-- ---- Credit card transactions ----

create table if not exists public.card_transactions (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.upload_batches(id) on delete cascade,
  card_id uuid,
  txn_date date not null,
  post_date date,
  merchant text not null,
  amount numeric(14,2) not null,          -- original currency
  amount_hkd numeric(14,2),               -- HKD equivalent; NULL, not guessed, if no real FX rate was shown
  currency text not null default 'HKD',
  fx_rate numeric(10,6),                  -- NULL (not 1 or 7.8) when the statement showed no real rate
  reference text,
  description text,
  card_last4 text,                        -- cardholder name, used to map to a CC account
  cardholder_name text,                   -- set from statement metadata at upload time
  user_id uuid references auth.users(id),
  period_month text,
  -- Manual "Assign" override (AssignModal) — set alongside/instead of the
  -- matching engine's rule-based classification.
  assigned_entity_code text,
  assigned_charge_to text,
  assigned_subsidiary text,
  assigned_dept_name text,
  assigned_expense_category text,
  assigned_ns_account_number text,
  assigned_ns_account_name text,
  assigned_note text,
  assigned_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_txn_period on public.card_transactions(period_month);
create index if not exists idx_txn_batch on public.card_transactions(batch_id);

alter table public.card_transactions enable row level security;

create policy "txn_user_select" on public.card_transactions
  for select to authenticated
  using (user_id = auth.uid() or user_id is null or public.is_super_user());

create policy "txn_user_insert" on public.card_transactions
  for insert to authenticated
  with check (true);

create policy "txn_user_update" on public.card_transactions
  for update to authenticated
  using (user_id = auth.uid() or user_id is null or public.is_super_user());

create policy "txn_user_delete" on public.card_transactions
  for delete to authenticated
  using (user_id = auth.uid() or user_id is null or public.is_super_user());

-- ---- Vendor invoices (Meta Ads etc.) — parent/child hierarchy ----

create table if not exists public.meta_invoices (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.upload_batches(id) on delete cascade,
  invoice_number text,
  billing_period text,
  amount numeric(14,2) not null,
  currency text not null default 'HKD',
  amount_hkd numeric(14,2),
  fx_rate numeric(10,6),
  invoice_date date,
  account_name text,                     -- vendor/account name
  account_id text,
  description text,
  notes text,
  is_matched boolean not null default false,  -- MUST stay in sync with reconciliation_results
  user_id uuid references auth.users(id),
  period_month text,
  parent_invoice_id uuid references public.meta_invoices(id) on delete cascade,
  charge_to_entity text,                 -- coarse entity (PBHK/704/SSHK/...)
  charge_to_code text,                   -- granular ns_departments.charge_to (e.g. "PB-IT", "704-Mgt")
  project_code text,
  expense_category text,
  ns_account_number text,
  ns_account_name text,
  card_last4 text,
  created_at timestamptz not null default now()
);

comment on column public.meta_invoices.charge_to_code is
  'Points at ns_departments.charge_to (e.g. "PB-IT", "704-Mgt"). Used to emit NetSuite Department + Subsidiary (parent:child) format.';

create index if not exists idx_inv_period on public.meta_invoices(period_month);
create index if not exists idx_inv_parent on public.meta_invoices(parent_invoice_id) where parent_invoice_id is not null;
create index if not exists idx_inv_batch on public.meta_invoices(batch_id);

alter table public.meta_invoices enable row level security;

create policy "meta_invoices_select" on public.meta_invoices
  for select to authenticated
  using (
    public.is_super_user()
    or public.user_can_see_entity(charge_to_entity)
    or charge_to_entity is null  -- unclassified invoices stay visible while uncategorized
  );

create policy "meta_invoices_insert" on public.meta_invoices
  for insert to authenticated
  with check (
    public.is_super_user()
    or charge_to_entity is null
    or public.user_can_see_entity(charge_to_entity)
  );

create policy "meta_invoices_update" on public.meta_invoices
  for update to authenticated
  using (
    public.is_super_user()
    or public.user_can_see_entity(charge_to_entity)
    or charge_to_entity is null
  )
  with check (
    public.is_super_user()
    or public.user_can_see_entity(charge_to_entity)
  );

create policy "meta_invoices_delete" on public.meta_invoices
  for delete to authenticated
  using (
    public.is_super_user()
    or public.user_can_see_entity(charge_to_entity)
  );

-- ---- Meta Ads invoice cost splits (one invoice split across projects) ----

create table if not exists public.meta_invoice_splits (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.meta_invoices(id) on delete cascade,
  project_code text,
  amount_hkd numeric(14,2) not null default 0,
  note text,
  sort_order int default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_invoice_splits_invoice on public.meta_invoice_splits(invoice_id);

alter table public.meta_invoice_splits enable row level security;

create policy "meta_invoice_splits_all" on public.meta_invoice_splits
  for all to authenticated
  using (
    public.is_super_user()
    or exists (
      select 1 from public.meta_invoices mi
      where mi.id = meta_invoice_splits.invoice_id
        and (public.user_can_see_entity(mi.charge_to_entity) or mi.charge_to_entity is null)
    )
  )
  with check (
    public.is_super_user()
    or exists (
      select 1 from public.meta_invoices mi
      where mi.id = meta_invoice_splits.invoice_id
        and (public.user_can_see_entity(mi.charge_to_entity) or mi.charge_to_entity is null)
    )
  );

-- ---- Reconciliation results (transaction <-> invoice junction) ----

create table if not exists public.reconciliation_results (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.card_transactions(id) on delete cascade,
  invoice_id uuid references public.meta_invoices(id),
  status text not null default 'pending' check (status in ('matched', 'pending', 'unmatched', 'exception', 'manual')),
  match_type text check (match_type in ('exact', 'fuzzy', 'near_date', 'split', 'manual')),
  confidence int,
  matched_at timestamptz,
  matched_by text,                       -- 'engine' or 'manual'
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_recon_transaction on public.reconciliation_results(transaction_id);
create index if not exists idx_recon_invoice on public.reconciliation_results(invoice_id);

alter table public.reconciliation_results enable row level security;

create policy "recon_results_select" on public.reconciliation_results
  for select to authenticated
  using (true);

create policy "recon_results_write" on public.reconciliation_results
  for all to authenticated
  using (
    public.is_super_user()
    or (
      invoice_id is null
      or exists (
        select 1 from public.meta_invoices mi
        where mi.id = reconciliation_results.invoice_id
          and (public.user_can_see_entity(mi.charge_to_entity) or mi.charge_to_entity is null)
      )
    )
  )
  with check (
    public.is_super_user()
    or (
      invoice_id is null
      or exists (
        select 1 from public.meta_invoices mi
        where mi.id = reconciliation_results.invoice_id
          and (public.user_can_see_entity(mi.charge_to_entity) or mi.charge_to_entity is null)
      )
    )
  );

-- ---- Matching rules (keyword -> account mapping) ----

create table if not exists public.matching_rules (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.upload_batches(id),
  keyword text not null,                 -- merchant pattern (supports "*" wildcard)
  account_name text,
  dr_account_code text,
  cr_account_code text,
  target_entity text,                    -- entity/company code
  dept_code text,
  customer text,
  vendor text,
  netsuite_account text,
  project_code text,
  notes text,
  priority int not null default 100,
  is_active boolean not null default true,
  -- NetSuite intercompany fields
  is_intercompany boolean default false,
  intercompany_account text,
  subsidiary_name text,
  ns_department text,
  ns_name_field text,
  ns_class text default '- No Class -',
  module text default 'card',            -- 'card' | 'bank' | 'all' — which matching engine reads this rule
  created_at timestamptz not null default now()
);

alter table public.matching_rules enable row level security;

create policy "shared_read" on public.matching_rules for select to authenticated using (true);
create policy "shared_insert" on public.matching_rules for insert to authenticated with check (true);
create policy "shared_update" on public.matching_rules for update to authenticated using (true);
create policy "shared_delete" on public.matching_rules for delete to authenticated using (true);

-- ---- Accounting lines (final coded journal line per transaction; supports
-- an entity/department pair for the legacy CC matching engine AND the newer
-- ns_* fields written by Assign/Split modals and read by Journal Export) ----

create table if not exists public.accounting_lines (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.card_transactions(id) on delete cascade,
  entity_id uuid references public.entities(id),
  department_id uuid references public.departments(id),
  amount_hkd numeric(14,2) not null,
  split_pct numeric(5,2) not null default 100,
  dr_account text,
  cr_account text,
  description text,
  is_confirmed boolean not null default false,
  ns_entity_code text,
  ns_charge_to text,
  ns_subsidiary_name text,
  ns_dept_name text,
  ns_account_number text,
  ns_account_name text,
  ns_project_code text,
  ns_project_name text,
  ns_customer_name text,
  expense_category text,
  created_at timestamptz not null default now()
);

create index if not exists idx_acct_lines_transaction on public.accounting_lines(transaction_id);

alter table public.accounting_lines enable row level security;

create policy "accounting_lines_all" on public.accounting_lines
  for all to authenticated
  using (
    public.is_super_user()
    or ns_entity_code is null
    or public.user_can_see_entity(ns_entity_code)
  )
  with check (
    public.is_super_user()
    or ns_entity_code is null
    or public.user_can_see_entity(ns_entity_code)
  );

-- Real production bug fixed here (see migration_accounting_lines_delete_policy.sql):
-- without an explicit DELETE policy, RLS silently no-ops a DELETE that matches
-- zero rows instead of raising an error, so the AssignModal/SplitModal
-- delete-then-insert pattern would silently fail to delete and accumulate
-- duplicate lines. accounting_lines_all (FOR ALL) above already covers DELETE;
-- this table has no other gaps to patch.

-- ---- Journal export log + settings RLS ----

alter table public.journal_settings enable row level security;
create policy "settings_read" on public.journal_settings for select to authenticated using (true);
create policy "settings_update" on public.journal_settings for update to authenticated using (true);

alter table public.journal_exports enable row level security;
create policy "journal_read" on public.journal_exports for select to authenticated using (true);
create policy "journal_insert" on public.journal_exports for insert to authenticated with check (true);

alter table public.entities enable row level security;
create policy "entities_read" on public.entities for select to authenticated using (true);

alter table public.departments enable row level security;
create policy "departments_read" on public.departments for select to authenticated using (true);

alter table public.credit_cards enable row level security;
create policy "cards_read" on public.credit_cards for select to authenticated using (true);
create policy "cards_insert" on public.credit_cards for insert to authenticated with check (true);

-- ============================================================================
-- Bank reconciliation
-- ============================================================================

create table if not exists public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.upload_batches(id) on delete cascade,
  subsidiary text not null,
  bank_name text,
  bank_account text,
  txn_date date not null,
  description text not null,
  reference text,
  debit numeric(14,2),
  credit numeric(14,2),
  balance numeric(14,2),
  currency text not null default 'HKD',
  period_month text,
  user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_bank_txn_period on public.bank_transactions(period_month);
create index if not exists idx_bank_txn_subsidiary on public.bank_transactions(subsidiary);

alter table public.bank_transactions enable row level security;

create policy "bank_transactions_select" on public.bank_transactions
  for select to authenticated using (true);

create policy "bank_transactions_write" on public.bank_transactions
  for all to authenticated
  using (public.is_super_user())
  with check (public.is_super_user());

-- ---- NetSuite GL entries (bank rec matching target) ----

create table if not exists public.ns_gl_entries (
  id uuid primary key default gen_random_uuid(),
  subsidiary text not null,
  account text,
  entry_type text,
  txn_date date not null,
  transaction_number text,
  document_number text,
  entity_name text,
  description text,
  debit numeric(14,2),
  credit numeric(14,2),
  balance numeric(14,2),
  vendor_invoice_number text,
  department text,
  employee text,
  client text,
  project text,
  campaign_name text,
  item_type text,
  memo text,
  period_month text,
  is_matched boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_gl_entries_period on public.ns_gl_entries(period_month);
create index if not exists idx_gl_entries_subsidiary on public.ns_gl_entries(subsidiary);
create index if not exists idx_gl_entries_matched on public.ns_gl_entries(is_matched);

alter table public.ns_gl_entries enable row level security;

create policy "ns_gl_entries_select" on public.ns_gl_entries
  for select to authenticated using (true);

create policy "ns_gl_entries_write" on public.ns_gl_entries
  for all to authenticated
  using (public.is_super_user())
  with check (public.is_super_user());

-- ---- Bank reconciliation results (module-scoped so this table can also
-- serve future non-bank modules; today only module='bank' is used) ----

create table if not exists public.bank_recon_results (
  id uuid primary key default gen_random_uuid(),
  module text not null default 'bank',
  source_type text not null default 'bank_transaction',
  source_id uuid not null,
  target_type text,
  target_id uuid,
  status text not null default 'pending' check (status in ('matched', 'pending', 'unmatched', 'exception')),
  match_type text,                        -- 'exact' | 'fuzzy' | 'near_date' | 'hs_fee' | 'rule' | 'manual'
  confidence int,
  matched_at timestamptz,
  matched_by text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_bank_recon_source on public.bank_recon_results(source_id);
create index if not exists idx_bank_recon_target on public.bank_recon_results(target_id);

alter table public.bank_recon_results enable row level security;

create policy "bank_recon_results_select" on public.bank_recon_results
  for select to authenticated using (true);

create policy "bank_recon_results_write" on public.bank_recon_results
  for all to authenticated
  using (public.is_super_user())
  with check (public.is_super_user());
