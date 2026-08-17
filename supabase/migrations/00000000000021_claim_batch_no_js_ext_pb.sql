-- Charge To 揀 JS (Jervois Solution) / EXT (ExtravelIsm) 嘅 claim，
-- 批號一律用 PB (Photoblog) 做公司 initials — 同 PBHK 共用同一個
-- CLM-PB-YYYYMM sequence。
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
      when 'JS'   then 'PB'   -- Jervois Solution → 一律用 PB
      when 'EXT'  then 'PB'   -- ExtravelIsm → 一律用 PB
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
