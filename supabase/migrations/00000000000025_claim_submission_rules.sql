-- Claim Forms (expenses / transportation) 提交限制：
--   1. 60 天限制 — 由 submit date 向前計，明細日期早過 60 天不可申報
--   2. 防重複 — 同一員工 + 同日期 + 同金額 + 同描述 不可申報
--      (查其他未被退回嘅 claim + 同一張表入面都唔可以有重複行)
-- 喺 draft/rejected → submitted 嗰下 enforce (client 嗰時 lines 已寫晒入 DB)。
-- 付款申請 (payment) 唔受呢兩條規限。
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
  if new.claim_type not in ('expenses', 'transportation') then
    return new;
  end if;
  if not (new.status = 'submitted' and old.status in ('draft', 'rejected')) then
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

drop trigger if exists trg_claim_submission_rules on public.claim_batches;
create trigger trg_claim_submission_rules
  before update on public.claim_batches
  for each row execute function public.enforce_claim_submission_rules();
