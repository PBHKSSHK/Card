-- 批號嘅 YYYYMM 改為跟 Period (period_month)，唔再跟 submit date —
-- Period 揀 2026-07，批號就係 CLM-XX-202607-nnnn (payment 同樣 PAY-202607-nnnn)。
-- 冇填 period 先 fallback submit_date / 今日。
--
-- 另外：張單仲係草稿時改咗 Period 或者 Charge To，個批號唔再對 —
-- 會自動重派新號 (舊號作廢留 gap)；提交咗之後個號鎖死唔會變。

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
  v_prefix text;   -- 號碼前綴，例如 CLM-PB-202607 / PAY-202607
  v_key text;
  v_seq_name text;
  v_seq_val bigint;
  v_lock_key bigint;
begin
  -- month 跟 Period；冇 period 先用 submit_date / 今日
  if new.period_month ~ '^\d{4}-\d{2}$' then
    v_yyyymm := replace(new.period_month, '-', '');
  else
    v_yyyymm := to_char(coalesce(new.submit_date, current_date), 'YYYYMM');
  end if;

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
      -- 未揀 charge_to：未有號就遲啲先派；有號就照留
      return new;
    end if;
    v_co := case upper(v_entity)
      when 'CLS'    then 'CG'
      when 'PBHK'   then 'PB'
      when 'SSHK'   then 'SS'
      when 'JM'     then 'JM'
      when '704'    then '704'
      when 'JS'     then 'PB'   -- Jervois Solution → PB
      when 'EXT'    then 'PB'   -- ExtravelIsm → PB
      when 'GOASIA' then 'PB'   -- GoAsia → PB
      else regexp_replace(upper(v_entity), '[^A-Z0-9]', '', 'g')
    end;
    v_prefix := 'CLM-' || v_co || '-' || v_yyyymm;
    v_key := v_prefix;
    v_seq_name := 'claim_batch_seq_' || lower(v_co) || '_' || v_yyyymm;
  end if;

  if new.batch_no is not null then
    if TG_OP = 'UPDATE' and new.status = 'draft'
       and new.batch_no not like v_prefix || '-%' then
      -- 草稿改咗 Period / Charge To → 批號個月/公司唔再對 → 重派
      new.batch_no := null;
    else
      return new;
    end if;
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
