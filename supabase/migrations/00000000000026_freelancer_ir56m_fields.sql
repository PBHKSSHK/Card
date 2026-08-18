-- 自由工作者付款申請 — IR56M 報稅個人資料。
-- 觸發條件 (表格 enforce)：NetSuite 未有呢位收款人，或者有但超過兩年
-- 冇銀行交易 (vendor payment / cheque) — 一律要重新提交 HKID / 住址 /
-- 性別 / 電話。

-- 1. vendor 名冊加「最後付款日期」(netsuite-sync-vendors 同步時計)
alter table public.ns_vendor_directory
  add column if not exists last_payment_date date;

-- 2. claim_batches 加個人資料欄 (freelancer payment 先有值)
alter table public.claim_batches
  add column if not exists payee_hkid text,
  add column if not exists payee_address text,
  add column if not exists payee_gender text check (payee_gender in ('M', 'F')),
  add column if not exists payee_phone text;

comment on column public.claim_batches.payee_hkid is 'IR56M — 自由工作者 HKID';
comment on column public.claim_batches.payee_address is 'IR56M — 住址';
comment on column public.claim_batches.payee_gender is 'IR56M — 性別 M/F';
comment on column public.claim_batches.payee_phone is 'IR56M — 電話';

-- 3. b.* view 欄位喺建立時固定 — 再 recreate 令審批 Inbox 見到新欄
drop view if exists public.claim_batches_with_team_head;

create view public.claim_batches_with_team_head as
select
  b.*,
  (
    select u.user_id from public.team_head_assignments tha
    join public.user_profiles u on u.user_id = tha.team_head_user_id
    where tha.charge_to_code = b.charge_to_code
    limit 1
  ) as assigned_team_head_user_id,
  (
    select u.full_name from public.team_head_assignments tha
    join public.user_profiles u on u.user_id = tha.team_head_user_id
    where tha.charge_to_code = b.charge_to_code
    limit 1
  ) as assigned_team_head_name,
  (
    select u.email from public.team_head_assignments tha
    join public.user_profiles u on u.user_id = tha.team_head_user_id
    where tha.charge_to_code = b.charge_to_code
    limit 1
  ) as assigned_team_head_email
from public.claim_batches b;

alter view public.claim_batches_with_team_head set (security_invoker = on);
grant select on public.claim_batches_with_team_head to authenticated;
