-- Payment Requisition (付款申請): 同事申請付款俾 supplier / 自由工作者。
-- 重用 claims 成套審批流程 (draft → submitted → team_head_approved → approved
-- → exported / rejected)、附件、audit log、RLS — 只加一個新 claim_type
-- 'payment' + batch 級收款人/付款資料欄位；batch no 用 PAY- prefix 獨立排號。

-- 1. claim_type 加 'payment'
alter table public.claim_batches
  drop constraint if exists claim_batches_claim_type_check;
alter table public.claim_batches
  add constraint claim_batches_claim_type_check
  check (claim_type in ('expenses', 'transportation', 'payment'));

-- 2. 收款人 + 付款資料 (batch 級；非 payment 類保持 NULL)
alter table public.claim_batches
  add column if not exists payee_name text,
  add column if not exists payee_type text
    check (payee_type in ('supplier', 'freelancer')),
  add column if not exists payment_method text
    check (payment_method in ('bank_transfer', 'cheque', 'fps', 'autopay', 'other')),
  add column if not exists payee_bank text,
  add column if not exists payee_bank_account text,
  add column if not exists payee_account_name text,
  add column if not exists payee_fps_id text,
  add column if not exists payment_due_date date,
  add column if not exists supplier_invoice_no text;

comment on column public.claim_batches.payee_name is '收款人 (supplier / freelancer 名稱) — payment requisition 專用';
comment on column public.claim_batches.supplier_invoice_no is '供應商 invoice / 報價單編號';

-- 提交咗嘅 payment requisition 一定要有收款人
alter table public.claim_batches
  drop constraint if exists claim_batches_payment_must_have_payee;
alter table public.claim_batches
  add constraint claim_batches_payment_must_have_payee
  check (status = 'draft' or claim_type <> 'payment' or payee_name is not null);

-- 3. batch no: payment 用 PAY-YYYYMM-nnnn (每月獨立 sequence)；其他類型照舊
--    CLM-（沿用原有 sequence key，計數不中斷）。
create or replace function public.set_claim_batch_no()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prefix text;
  v_yyyymm text;
  v_key text;
  v_seq_name text;
  v_seq_val bigint;
  v_lock_key bigint;
begin
  if new.batch_no is not null then
    return new;
  end if;

  v_prefix := case when new.claim_type = 'payment' then 'PAY' else 'CLM' end;
  v_yyyymm := to_char(coalesce(new.submit_date, current_date), 'YYYYMM');
  -- CLM 保留舊 key / sequence 名（現有 counter 延續）；PAY 用自己嘅。
  v_key := case when v_prefix = 'CLM' then v_yyyymm else 'PAY-' || v_yyyymm end;
  v_seq_name := case when v_prefix = 'CLM'
    then 'claim_batch_seq_' || v_yyyymm
    else 'claim_batch_seq_pay_' || v_yyyymm end;
  v_lock_key := hashtextextended('claim_batch_seq:' || v_key, 0);

  perform pg_advisory_xact_lock(v_lock_key);

  if not exists (select 1 from public.claim_batch_sequences where yyyymm = v_key) then
    execute format(
      'create sequence if not exists public.%I start with %s',
      v_seq_name,
      greatest(
        1,
        coalesce(
          (select max(cast(substring(batch_no from v_prefix || '-\d{6}-(\d+)') as integer))
           from public.claim_batches
           where batch_no like v_prefix || '-' || v_yyyymm || '-%'),
          0
        ) + 1
      )
    );
    insert into public.claim_batch_sequences (yyyymm, sequence_name)
      values (v_key, v_seq_name)
      on conflict (yyyymm) do nothing;
  end if;

  execute format('select nextval(%L)', 'public.' || v_seq_name) into v_seq_val;

  new.batch_no := v_prefix || '-' || v_yyyymm || '-' || lpad(v_seq_val::text, 4, '0');

  return new;
end;
$$;

alter function public.set_claim_batch_no() owner to postgres;

-- 4. b.* 喺 view 建立時已固定欄位 — claim_batches 新加嘅 payee 欄位唔會自動
--    出現，要 drop + recreate 先見到 (create or replace 會因欄位位置改變而失敗)。
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
