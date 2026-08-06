-- ============================================================
-- RUN_ME_NOW_fix_security_definer.sql
-- ============================================================
-- 目的:修真正 root cause — set_claim_batch_no trigger 喺 SECURITY INVOKER
--      模式下跑,被 RLS filter 走其他人嘅 claim,令 SELECT MAX 永遠由 0 開始
--      → 同事 login submit 一定撞返你已佔住嘅 batch_no。
--
-- Fix: function 加 SECURITY DEFINER + SET search_path = public 防 hijack。
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_claim_batch_no()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER       -- ✅ 重點:用 owner 身份跑,bypass RLS,可以見全部 batch
SET search_path = public, pg_temp
AS $$
DECLARE
  v_yyyymm TEXT;
  v_seq INTEGER;
  v_lock_key BIGINT;
  v_attempt INTEGER := 0;
  v_max_attempts CONSTANT INTEGER := 5;
BEGIN
  IF NEW.batch_no IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_yyyymm := TO_CHAR(COALESCE(NEW.submit_date, CURRENT_DATE), 'YYYYMM');
  v_lock_key := hashtextextended('claim_batch_no:' || v_yyyymm, 0);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  LOOP
    v_attempt := v_attempt + 1;
    SELECT COALESCE(MAX(CAST(SUBSTRING(batch_no FROM 'CLM-\d{6}-(\d+)') AS INTEGER)), 0) + 1
      INTO v_seq
      FROM claim_batches
      WHERE batch_no LIKE 'CLM-' || v_yyyymm || '-%';
    NEW.batch_no := 'CLM-' || v_yyyymm || '-' || LPAD(v_seq::TEXT, 4, '0');

    IF NOT EXISTS (SELECT 1 FROM claim_batches WHERE batch_no = NEW.batch_no) THEN
      EXIT;
    END IF;

    IF v_attempt >= v_max_attempts THEN
      RAISE EXCEPTION 'Failed to generate unique batch_no after % attempts (last try: %)',
        v_max_attempts, NEW.batch_no;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

-- Trigger 唔需要重新建,只係 function body 更新

-- ============================================================
-- 驗證
-- ============================================================
-- SELECT proname, prosecdef AS is_security_definer
-- FROM pg_proc WHERE proname = 'set_claim_batch_no';
-- → is_security_definer 應該係 true
