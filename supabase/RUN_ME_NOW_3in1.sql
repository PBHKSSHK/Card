-- ============================================================
-- RUN_ME_NOW_3in1.sql — 一次過跑 3 條 migration
-- ============================================================
-- 包含：
--   [1/3] migration_claim_draft_relax.sql
--         放寬 claim_batches.charge_to_code NOT NULL → 容許 draft 唔填
--   [2/3] migration_fix_batch_no_race.sql
--         修 batch_no UNIQUE duplicate (race condition)
--   [3/3] migration_claim_privacy_tighten.sql
--         收窄 claim_batches SELECT — 同事互相見唔到對方 claim
--
-- 全部 idempotent — 可以重複跑無問題。
-- ============================================================


-- ============================================================
-- [1/3] migration_claim_draft_relax.sql
-- ============================================================
-- 放寬 claim_batches 對 draft 嘅限制:
--   1. charge_to_code 可以 NULL (draft 時可以未填)
--   2. claim_lines.batch_id 已有 FK CASCADE,draft 同提交都用同一張表

-- Allow draft batches without charge_to_code
ALTER TABLE claim_batches
  ALTER COLUMN charge_to_code DROP NOT NULL;

-- (Optional) ensure status default still 'draft'
ALTER TABLE claim_batches
  ALTER COLUMN status SET DEFAULT 'draft';

-- 確保 submitted 之後一定有 charge_to_code 同 full_name
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'claim_batches_submitted_must_have_charge_to'
  ) THEN
    ALTER TABLE claim_batches
      ADD CONSTRAINT claim_batches_submitted_must_have_charge_to
      CHECK (
        status = 'draft'
        OR (charge_to_code IS NOT NULL AND full_name IS NOT NULL)
      );
  END IF;
END $$;


-- ============================================================
-- [2/3] migration_fix_batch_no_race.sql
-- ============================================================
-- 目的:修 `claim_batches_batch_no_key` UNIQUE constraint duplicate error
--
-- Root cause: `set_claim_batch_no` trigger 用 SELECT MAX(...) + 1,
--   兩個 concurrent INSERT 同時讀到同一個 MAX → 兩個 INSERT 撞 batch_no。
--
-- Fix: 用 pg_advisory_xact_lock 將同月份嘅 batch_no generation serialize。
--   Hash key = hashtextextended('claim_batch_no:' || YYYYMM),per-month lock,
--   唔會 block 其他月份嘅 INSERT。
--   再加 retry loop 防止罕見嘅 trigger AFTER advisory lock 中間 race。

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

DROP TRIGGER IF EXISTS trg_set_claim_batch_no ON claim_batches;
CREATE TRIGGER trg_set_claim_batch_no
  BEFORE INSERT ON claim_batches
  FOR EACH ROW EXECUTE FUNCTION public.set_claim_batch_no();


-- ============================================================
-- [3/3] migration_claim_privacy_tighten.sql
-- ============================================================
-- 目的:收窄 claim_batches SELECT 權限
--
-- 問題:之前個 policy 容許 `user_can_see_entity(entity_code)` —
--       即 BU user A 同 BU user B 同係 SSHK scope,A 可以見 B 嘅 claim。
--       Claim form 屬私隱資料(薪酬類)不應同 entity 內所有人見到。
--
-- 新規則:
--   1. owner / admin → 見全部 (is_super_user())
--   2. claimant 自己 → 見自己嘅
--   3. team_head_user_id = me → 已經 sign 過嘅
--   4. team_head_assignments 對應 charge_to → 被分配做 TH 嘅
--   5. ❌ 刪走 entity_code → user_can_see_entity 呢個 path
--
-- claim_lines / claim_attachments / claim_audit_log 都係透過
-- EXISTS claim_batches join — 只要 claim_batches 收窄,其他表自動跟。

DROP POLICY IF EXISTS "claim_batches_select" ON claim_batches;
CREATE POLICY "claim_batches_select" ON claim_batches
  FOR SELECT TO authenticated
  USING (
    public.is_super_user()
    OR claimant_user_id = auth.uid()
    OR team_head_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM team_head_assignments tha
      WHERE tha.team_head_user_id = auth.uid()
        AND tha.charge_to_code = claim_batches.charge_to_code
    )
  );


-- ============================================================
-- 完成 ✅ — 全部 3 條 migration 已 apply
-- ============================================================
-- 驗證:
--
-- [1/3] charge_to_code 可 NULL:
--   SELECT is_nullable FROM information_schema.columns
--   WHERE table_name = 'claim_batches' AND column_name = 'charge_to_code';
--   → 應該係 'YES'
--
-- [2/3] batch_no trigger 有 pg_advisory_xact_lock:
--   SELECT prosrc FROM pg_proc WHERE proname = 'set_claim_batch_no';
--   → 應該見到 'pg_advisory_xact_lock'
--
-- [3/3] SELECT policy 冇咗 user_can_see_entity:
--   SELECT polname, pg_get_expr(polqual, polrelid) AS using_expr
--   FROM pg_policy
--   WHERE polrelid = 'public.claim_batches'::regclass AND polcmd = 'r';
--   → using_expr 入面唔應該見到 'user_can_see_entity'
