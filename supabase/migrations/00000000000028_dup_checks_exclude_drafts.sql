-- 查重規則唔應該計 DRAFT：
-- 提交失敗/double-click 會留低草稿，如果草稿都當「已申報」，正式提交嗰張
-- 反而會被自己嘅孖生草稿擋住 (實例: PAY-202608-0001/0002 同一發票兩張 draft
-- 互相封鎖)。改成只對照已入審批流程嘅單 (submitted 之後)；兩張草稿邊張先
-- 提交邊張贏，第二張提交時先至被擋 — 行為正確。
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
    -- 同一供應商 + 同一發票號 唔可以重複 (只計已提交嘅單；draft / 退回單唔計)
    select b.batch_no into v_dup_no
    from public.claim_batches b
    where b.id <> new.id
      and b.claim_type = 'payment'
      and b.status not in ('rejected', 'draft')
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

  -- 2b. 同一員工其他 claim 已申報過同日期+金額+描述 (draft / 退回單唔計)
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
    and b.status not in ('rejected', 'draft')
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
