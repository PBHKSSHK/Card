-- Claim Forms 批號加公司 initials: CLM-XX-YYYYMM-nnnn
--   CG  = CLS Garage (entity CLS)
--   PB  = Photoblog.hk (PBHK)
--   SS  = Social Strategy (SSHK)
--   JM  = Jervois M Limited
--   704 = 704 Production Limited
-- 公司由 charge_to_code → ns_departments.entity_code 推導；其他 entity
-- (JS / EXT / GoAsia…) 直接用 entity code 做 initials。
-- 每間公司每月獨立 sequence (CLM-PB-202608-0001, CLM-CG-202608-0001…)。
-- 草稿未揀 charge_to 時暫時唔派號 (batch_no NULL)，補返 charge_to 嗰陣
-- 由 UPDATE trigger 派 — 所以 trg_set_claim_batch_no 加埋 update 事件。
-- payment 照舊 PAY-YYYYMM-nnnn；舊 CLM-YYYYMM-nnnn 號碼保留唔變。

create or replace function public.set_claim_batch_no()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_co text;
  v_entity text;
  v_yyyymm text;
  v_prefix text;   -- 號碼前綴，例如 CLM-PB-202608 / PAY-202608
  v_key text;
  v_seq_name text;
  v_seq_val bigint;
  v_lock_key bigint;
begin
  if new.batch_no is not null then
    return new;
  end if;

  v_yyyymm := to_char(coalesce(new.submit_date, current_date), 'YYYYMM');

  if new.claim_type = 'payment' then
    v_prefix := 'PAY-' || v_yyyymm;
    v_key := v_prefix;
    v_seq_name := 'claim_batch_seq_pay_' || v_yyyymm;
  else
    -- 公司 initial 由 charge_to → entity_code (trg_claim_batches_derive 已
    -- 喺呢個 trigger 之前跑，但 insert 冇 charge_to 時 entity_code 係 null)
    v_entity := new.entity_code;
    if v_entity is null and new.charge_to_code is not null then
      select entity_code into v_entity
        from public.ns_departments
        where charge_to = new.charge_to_code
        limit 1;
    end if;
    if v_entity is null then
      -- 草稿未揀 charge_to — 未派號，補返 charge_to 時先派
      return new;
    end if;
    v_co := case v_entity
      when 'CLS'  then 'CG'
      when 'PBHK' then 'PB'
      when 'SSHK' then 'SS'
      when 'JM'   then 'JM'
      when '704'  then '704'
      else regexp_replace(upper(v_entity), '[^A-Z0-9]', '', 'g')
    end;
    v_prefix := 'CLM-' || v_co || '-' || v_yyyymm;
    v_key := v_prefix;
    v_seq_name := 'claim_batch_seq_' || lower(v_co) || '_' || v_yyyymm;
  end if;

  v_lock_key := hashtextextended('claim_batch_seq:' || v_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  if not exists (select 1 from public.claim_batch_sequences where yyyymm = v_key) then
    execute format(
      'create sequence if not exists public.%I start with %s',
      v_seq_name,
      greatest(
        1,
        coalesce(
          (select max(cast(substring(batch_no from v_prefix || '-(\d+)$') as integer))
           from public.claim_batches
           where batch_no like v_prefix || '-%'),
          0
        ) + 1
      )
    );
    insert into public.claim_batch_sequences (yyyymm, sequence_name)
      values (v_key, v_seq_name)
      on conflict (yyyymm) do nothing;
  end if;

  execute format('select nextval(%L)', 'public.' || v_seq_name) into v_seq_val;

  new.batch_no := v_prefix || '-' || lpad(v_seq_val::text, 4, '0');

  return new;
end;
$$;

alter function public.set_claim_batch_no() owner to postgres;

-- insert-only → insert or update (草稿補 charge_to 時派號)。
-- update 時 batch_no 已有值就即刻 return，唔會重派。
drop trigger if exists trg_set_claim_batch_no on public.claim_batches;
create trigger trg_set_claim_batch_no
  before insert or update on public.claim_batches
  for each row execute function public.set_claim_batch_no();
