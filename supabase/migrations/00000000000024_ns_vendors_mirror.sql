-- NetSuite vendor 名冊鏡射表 — 付款申請「收款人名稱」欄嘅揀選來源。
-- (ns_vendors 已存在做 IC vendor 對照，所以呢張叫 ns_vendor_directory。)
-- 由 Edge Function netsuite-sync-vendors 同步 (service role 寫入)。
-- is_person: NetSuite vendor type — individual = 自由工作者 (freelancer)，
-- company = 供應商 (supplier)；兩個申請表格各自只顯示對應類型。
-- 同事揀已存在嘅收款人，冇嘅可以照打新名 (free text)。
create table if not exists public.ns_vendor_directory (
  internal_id integer primary key,   -- NetSuite vendor internal id
  entityid text,                     -- e.g. V10000083
  company_name text,                 -- 顯示名 (person vendor 用 entityid 補上)
  is_person boolean,                 -- true = individual (自由工作者), false = company (供應商)
  is_inactive boolean not null default false,
  synced_at timestamptz not null default now()
);

create index if not exists idx_ns_vendor_dir_name on public.ns_vendor_directory (lower(company_name));

alter table public.ns_vendor_directory enable row level security;

-- 所有登入用戶可以讀 (BU user 開付款申請都要見到)；寫入只有 service role
create policy "ns_vendor_directory_read" on public.ns_vendor_directory
  for select to authenticated using (true);
