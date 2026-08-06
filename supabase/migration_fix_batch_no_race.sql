-- ============================================================
-- migration_fix_batch_no_race.sql
-- ============================================================
-- 目的：修 `claim_batches_batch_no_key` UNIQUE constraint duplicate error
--
-- Root cause: `set_claim_batch_no` trigger 用 SELECT MAX(...) + 1，
--   兩個 concurrent INSERT 同時讀到同一個 MAX → 兩個 INSERT 撞 batch_no。
--
-- Fix: 用 pg_advisory_xact_lock 將同月份嘅 batch_no generation serialize。
--   Hash key = hashtext('claim_batch_no:' || YYYYMM)，per-month lock，
--   唔會 block 其他月份嘅 INSERT。
--   再加 retry loop 防止罕見嘅 trigger AFTER advisory lock 中間 race。
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_claim_batch_no()
RETURNS TRIGGER
LANGUAGE plpgsql
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
  -- Per-month advisory lock (transaction-scoped, auto-released on commit/rollback)
  v_lock_key := hashtextextended('claim_batch_no:' || v_yyyymm, 0);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Retry loop in case of pathological race (e.g. lock released between txns)
  LOOP
    v_attempt := v_attempt + 1;
    SELECT COALESCE(MAX(CAST(SUBSTRING(batch_no FROM 'CLM-\d{6}-(\d+)') AS INTEGER)), 0) + 1
      INTO v_seq
      FROM claim_batches
      WHERE batch_no LIKE 'CLM-' || v_yyyymm || '-%';
    NEW.batch_no := 'CLM-' || v_yyyymm || '-' || LPAD(v_seq::TEXT, 4, '0');

    -- Probe 是否已存在
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

-- Trigger 本身唔變,只係重新 bind function
DROP TRIGGER IF EXISTS trg_set_claim_batch_no ON claim_batches;
CREATE TRIGGER trg_set_claim_batch_no
  BEFORE INSERT ON claim_batches
  FOR EACH ROW EXECUTE FUNCTION public.set_claim_batch_no();

-- ============================================================
-- 驗證
-- ============================================================
-- 1. 同時 INSERT 多條 (例如 from psql / Supabase):
--    INSERT INTO claim_batches (claim_type, claimant_user_id) VALUES ('expenses', '<your-uid>') RETURNING batch_no;
--    應該每次都唔同 sequence,冇 UNIQUE error。
--
-- 2. 檢視函數定義:
--    \df+ public.set_claim_batch_no
