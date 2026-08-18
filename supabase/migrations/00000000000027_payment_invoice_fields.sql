-- 付款申請發票欄位 + 多行 department 拆分 + 預付款標記。
-- 必填 (提交時 trigger enforce)：供應商、發票號 (同一供應商不可重複)、
-- 發票日期、金額；付款條款/幣別/附件由表格 enforce。

-- 1. claim_batches 發票欄位
alter table public.claim_batches
  add column if not exists invoice_date date,
  add column if not exists payment_terms text,
  add column if not exists invoice_amount numeric(14,2),
  add column if not exists invoice_currency text default 'HKD',
  add column if not exists is_prepayment boolean not null default false;

comment on column public.claim_batches.invoice_date is '供應商發票日期';
comment on column public.claim_batches.payment_terms is '付款條款 (COD / Net 30 …)';
comment on column public.claim_batches.invoice_amount is '發票總額 (原幣)';
comment on column public.claim_batches.is_prepayment is '預付款/按金 — 唔係一般費用，NetSuite 用 Vendor Prepayment / 預付科目入數';

-- 2. 一張發票拆多個 project / department：明細行可以有自己嘅 charge to
--    (NULL = 跟表頭 charge_to_code)
alter table public.claim_lines
  add column if not exists line_charge_to text;

-- 3. b.* view 再 recreate 令新欄出現
drop view if exists public.claim_batches_with_team_head;
create view public.claim_batches_with_team_head as
select
  b.*,
  (
    select u.user_id from public.team_head_assignments tha
    join public.user_profiles u on u.user_id = tha.team_head_user_id
    where tha.charge_to_code = b.charge_to_code limit 1
  ) as assigned_team_head_user_id,
  (
    select u.full_name from public.team_head_assignments tha
    join public.user_profiles u on u.user_id = tha.team_head_user_id
    where tha.charge_to_code = b.charge_to_code limit 1
  ) as assigned_team_head_name,
  (
    select u.email from public.team_head_assignments tha
    join public.user_profiles u on u.user_id = tha.team_head_user_id
    where tha.charge_to_code = b.charge_to_code limit 1
  ) as assigned_team_head_email
from public.claim_batches b;
alter view public.claim_batches_with_team_head set (security_invoker = on);
grant select on public.claim_batches_with_team_head to authenticated;

-- 4. 提交規則 trigger 加 payment 分支：
--    必填發票號/日期/金額 + 同一供應商發票號 app 內唔可以重複
create or replace function public.enforce_claim_submission_rules()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bad int;
  v_dup_no text;
  v_dup_date date;
  v_dup_amt numeric;
begin
  if not (new.status = 'submitted' and old.status in ('draft', 'rejected')) then
    return new;
  end if;

  -- ===== payment (付款申請) =====
  if new.claim_type = 'payment' then
    if new.supplier_invoice_no is null or btrim(new.supplier_invoice_no) = '' then
      raise exception '付款申請必須填供應商發票號';
    end if;
    if new.invoice_date is null then
      raise exception '付款申請必須填發票日期';
    end if;
    if new.invoice_amount is null or new.invoice_amount <= 0 then
      raise exception '付款申請必須填發票總額';
    end if;
    -- 同一供應商 + 同一發票號 唔可以重複 (任何同事開嘅都計，退回單除外)
    select b.batch_no into v_dup_no
    from public.claim_batches b
    where b.id <> new.id
      and b.claim_type = 'payment'
      and b.status <> 'rejected'
      and lower(btrim(coalesce(b.payee_name, ''))) = lower(btrim(coalesce(new.payee_name, '')))
      and lower(btrim(coalesce(b.supplier_invoice_no, ''))) = lower(btrim(new.supplier_invoice_no))
    limit 1;
    if v_dup_no is not null then
      raise exception '重複發票：% 已用咗同一供應商嘅發票號 %', v_dup_no, new.supplier_invoice_no;
    end if;
    return new;
  end if;

  -- ===== expenses / transportation (Claim Forms) =====
  if new.claim_type not in ('expenses', 'transportation') then
    return new;
  end if;

  -- 1. 60 天限制
  select count(*) into v_bad
  from public.claim_lines l
  where l.batch_id = new.id
    and l.line_status <> 'rejected'
    and l.line_date is not null
    and l.line_date < coalesce(new.submit_date, current_date) - 60;
  if v_bad > 0 then
    raise exception '有 % 行明細日期超過 60 天（由 submit date % 向前計），不可申報', v_bad, coalesce(new.submit_date, current_date);
  end if;

  -- 2a. 同一張表入面唔可以有重複行 (同日期+金額+描述)
  select count(*) into v_bad
  from (
    select 1
    from public.claim_lines
    where batch_id = new.id
      and line_status <> 'rejected'
      and coalesce(hkd_amount, 0) <> 0
    group by line_date, hkd_amount, coalesce(lower(btrim(description)), '')
    having count(*) > 1
  ) dup;
  if v_bad > 0 then
    raise exception '呢張 claim 入面有 % 組重複明細（同日期+金額+描述）', v_bad;
  end if;

  -- 2b. 同一員工其他 claim (未被退回) 已申報過同日期+金額+描述
  select b.batch_no, l.line_date, l.hkd_amount
    into v_dup_no, v_dup_date, v_dup_amt
  from public.claim_lines me
  join public.claim_lines l
    on l.line_date = me.line_date
   and l.hkd_amount = me.hkd_amount
   and coalesce(lower(btrim(l.description)), '') = coalesce(lower(btrim(me.description)), '')
   and l.batch_id <> me.batch_id
   and l.line_status <> 'rejected'
  join public.claim_batches b on b.id = l.batch_id
  where me.batch_id = new.id
    and me.line_status <> 'rejected'
    and coalesce(me.hkd_amount, 0) <> 0
    and b.claimant_user_id = new.claimant_user_id
    and b.status <> 'rejected'
    and b.claim_type in ('expenses', 'transportation')
  limit 1;
  if v_dup_date is not null then
    raise exception '重複申報：% 已有相同日期/金額/描述嘅明細（% · HK$%）',
      coalesce(v_dup_no, '另一張 claim'), v_dup_date, v_dup_amt;
  end if;

  return new;
end;
$$;

alter function public.enforce_claim_submission_rules() owner to postgres;
