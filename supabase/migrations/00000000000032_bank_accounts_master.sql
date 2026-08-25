-- 各公司銀行戶口 master (用戶提供 bank_account.xlsx)：
-- NetSuite GL bank account ↔ 公司 ↔ 銀行 ↔ 月結單 section label ↔ 戶口號碼。
-- Bank Upload Centre 揀戶口用；PDF 多戶口月結單每個 section 對應返
-- 正確戶口 + GL account code，方便 Bank Recon 對數。
create table if not exists public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  gl_account_code text not null,
  gl_account_name text not null,
  company_name text not null,
  subsidiary_code text not null,
  bank text not null,
  account_label text,
  account_number text,
  currency text not null default 'HKD',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (gl_account_code)
);
alter table public.bank_accounts enable row level security;
drop policy if exists "bank_accounts_read" on public.bank_accounts;
create policy "bank_accounts_read" on public.bank_accounts
  for select to authenticated using (true);

insert into public.bank_accounts
  (gl_account_code, gl_account_name, company_name, subsidiary_code, bank, account_label, account_number, currency)
values
  ('26002010', '26002010 - Bank - Hang Seng - Current Accounts (SSHK)', 'Social Strategy Hong Kong Limited', 'SSHK', 'Hang Seng', 'Current 往來', '789-315058-001', 'HKD'),
  ('26002011', '26002011 - Bank - Hang Seng - Current Accounts (JM)', 'Jervois M Limited', 'JM', 'Hang Seng', 'Current 往來', '769-308792-001', 'HKD'),
  ('26002020', '26002020 - Bank - Hang Seng - Saving Accounts (SSHK)', 'Social Strategy Hong Kong Limited', 'SSHK', 'Hang Seng', 'HKD Statement Savings 港幣儲蓄', '789-315058-883', 'HKD'),
  ('26002021', '26002021 - Bank - Hang Seng - Saving Accounts (JM)', 'Jervois M Limited', 'JM', 'Hang Seng', 'HKD Statement Savings 港幣儲蓄', '769-308792-001', 'HKD'),
  ('26003010', '26003010 - Bank - HSBC - Current Accounts - HKD (PB)', 'Photoblog.hk Limited', 'PBHK', 'HSBC', 'HSBC Business Direct HKD Current 港元往來', '652-005836-838', 'HKD'),
  ('26003012', '26003012 - Bank - HSBC - Current Accounts - HKD (CLS Garage)', 'CLS Production Limited', 'CLS', 'HSBC', 'HSBC Business Direct HKD Current 港元往來', '143-163103-838', 'HKD'),
  ('26003013', '26003013 - Bank - HSBC - Current Accounts - HKD (704)', '704 Production Limited', '704', 'HSBC', 'HSBC Business Direct HKD Current 港元往來', '149-075533-001', 'HKD'),
  ('26003020', '26003020 - Bank - HSBC - Saving Accounts - HKD (PB)', 'Photoblog.hk Limited', 'PBHK', 'HSBC', 'HSBC Business Direct HKD Savings 港元儲蓄', '652-005836-838', 'HKD'),
  ('26003022', '26003022 - Bank - HSBC - Saving Accounts - HKD (CLS Garage)', 'CLS Production Limited', 'CLS', 'HSBC', 'HSBC Business Direct HKD Savings 港元儲蓄', '143-163103-838', 'HKD'),
  ('26003023', '26003023 - Bank - HSBC - Saving Accounts - HKD (704)', '704 Production Limited', '704', 'HSBC', 'HSBC Business Direct HKD Savings 港元儲蓄', '149-075533-838', 'HKD'),
  ('26003030', '26003030 - Bank - HSBC - Saving Accounts - USD (PB)', 'Photoblog.hk Limited', 'PBHK', 'HSBC', 'HSBC Business Direct Foreign Currency Savings 外幣儲蓄', '652-005836-838', 'USD'),
  ('26003031', '26003031 - Bank - HSBC - Saving Accounts - USD (CLS Garage)', 'CLS Production Limited', 'CLS', 'HSBC', 'HSBC Business Direct Foreign Currency Savings 外幣儲蓄', '143-163103-838', 'USD'),
  ('26004010', '26004010 - Bank - SCB - Current Accounts - 0747553 (PB)', 'Photoblog.hk Limited', 'PBHK', 'SCB', null, '570-0074755-3', 'HKD'),
  ('26006011', '26006011 - Airwallex - DBS HKD (CLS Garage)', 'CLS Production Limited', 'CLS', 'Airwallex', 'HKD Account Activity', '478-7949804404', 'HKD'),
  ('26007010', '26007010 - OCBC - Current Accounts (SSHK)', 'Social Strategy Hong Kong Limited', 'SSHK', 'OCBC', 'HKD Current 港元往來', '854-252472-051', 'HKD'),
  ('26007020', '26007020 - OCBC - Saving Accounts (SSHK)', 'Social Strategy Hong Kong Limited', 'SSHK', 'OCBC', 'HKD Statement Savings 港元結單儲蓄', '854-252472-831', 'HKD'),
  ('26007030', '26007030 - OCBC - Saving Accounts - USD (SSHK)', 'Social Strategy Hong Kong Limited', 'SSHK', 'OCBC', 'USD Statement Savings 美元結單儲蓄', null, 'USD')
on conflict (gl_account_code) do update set
  gl_account_name = excluded.gl_account_name,
  company_name = excluded.company_name,
  subsidiary_code = excluded.subsidiary_code,
  bank = excluded.bank,
  account_label = excluded.account_label,
  account_number = excluded.account_number,
  currency = excluded.currency,
  is_active = true;

-- 每行銀行交易記低對應嘅 NetSuite GL bank account (將來 recon 可以按戶口對數)
alter table public.bank_transactions add column if not exists gl_account_code text;
