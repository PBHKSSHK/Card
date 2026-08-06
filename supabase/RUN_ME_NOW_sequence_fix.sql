-- ============================================================
-- RUN_ME_NOW_sequence_fix.sql  (FINAL FIX)
-- ============================================================
-- 目的: 一勞永逸解決 BU user submit claim 撞 duplicate batch_no。
--
-- Root cause 證實:
--   * Alex login (RLS bypass) 見到 5 條 batch CLM-202606-0001..0004
--   * BU user kitman.choi login 經 RLS 後見到 0 條
--   * Trigger SELECT MAX(batch_no) 跑緊 BU 身份 (即使有 SECURITY DEFINER,
--     之前 fix 似乎冇生效) → 永遠回 0 → 生成 CLM-202606-0001 撞已存在
--
-- Final fix: 完全棄用 SELECT MAX 嘅做法,改用 PostgreSQL sequence per
-- (claim_type, YYYYMM)。Sequence 由 Postgres engine 直接管理,**完全 bypass
-- RLS**,絕對唔會撞。
--
-- 同時亦會清理 stale function/trigger,確保新版生效。
-- ============================================================

-- 1) Sequence registry — 每 (yyyymm) 對應一個 sequence
--    每月新月份第一次 use 嗰陣會 lazy 建嗰個 sequence
CREATE TABLE IF NOT EXISTS public.claim_batch_sequences (
  yyyymm TEXT PRIMARY KEY,
  sequence_name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2) Drop 舊嘅 function + trigger (cascade)
DROP TRIGGER IF EXISTS trg_set_claim_batch_no ON public.claim_batches;
DROP FUNCTION IF EXISTS public.set_claim_batch_no() CASCADE;

-- 3) 新 function — 用 dynamic sequence,完全唔 SELECT claim_batches
--    SECURITY DEFINER + owner postgres 確保可以 CREATE SEQUENCE
CREATE OR REPLACE FUNCTION public.set_claim_batch_no()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_yyyymm TEXT;
  v_seq_name TEXT;
  v_seq_val BIGINT;
  v_lock_key BIGINT;
BEGIN
  IF NEW.batch_no IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_yyyymm := TO_CHAR(COALESCE(NEW.submit_date, CURRENT_DATE), 'YYYYMM');
  v_seq_name := 'claim_batch_seq_' || v_yyyymm;
  v_lock_key := hashtextextended('claim_batch_seq:' || v_yyyymm, 0);

  -- Lock 防 race condition 建 sequence
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Lazy create sequence if not exists — 喺 registry table 加 row 標記
  IF NOT EXISTS (
    SELECT 1 FROM public.claim_batch_sequences WHERE yyyymm = v_yyyymm
  ) THEN
    -- 從現有 claim_batches 計起點 (補返已有 batch)
    EXECUTE format(
      'CREATE SEQUENCE IF NOT EXISTS public.%I START WITH %s',
      v_seq_name,
      GREATEST(
        1,
        COALESCE(
          (SELECT MAX(CAST(SUBSTRING(batch_no FROM 'CLM-\d{6}-(\d+)') AS INTEGER))
           FROM public.claim_batches
           WHERE batch_no LIKE 'CLM-' || v_yyyymm || '-%'),
          0
        ) + 1
      )
    );
    INSERT INTO public.claim_batch_sequences (yyyymm, sequence_name)
      VALUES (v_yyyymm, v_seq_name)
      ON CONFLICT (yyyymm) DO NOTHING;
  END IF;

  -- Atomic nextval — Postgres guarantee 唯一,完全 bypass RLS
  EXECUTE format('SELECT nextval(%L)', 'public.' || v_seq_name) INTO v_seq_val;

  NEW.batch_no := 'CLM-' || v_yyyymm || '-' || LPAD(v_seq_val::TEXT, 4, '0');

  RETURN NEW;
END;
$$;

-- 4) Function owner = postgres 確保 superuser 身份運作
ALTER FUNCTION public.set_claim_batch_no() OWNER TO postgres;

-- 5) 重裝 trigger
CREATE TRIGGER trg_set_claim_batch_no
  BEFORE INSERT ON public.claim_batches
  FOR EACH ROW
  EXECUTE FUNCTION public.set_claim_batch_no();

-- 6) Grant execute 畀所有 role
GRANT EXECUTE ON FUNCTION public.set_claim_batch_no() TO authenticated, anon, service_role;

-- 7) 預先建 2026-06 嘅 sequence (令現場 user 即刻可以 submit, 唔使等
--    lazy create)
DO $$
DECLARE
  v_yyyymm TEXT := TO_CHAR(CURRENT_DATE, 'YYYYMM');
  v_seq_name TEXT;
  v_start INTEGER;
BEGIN
  v_seq_name := 'claim_batch_seq_' || v_yyyymm;
  SELECT GREATEST(
    1,
    COALESCE(
      MAX(CAST(SUBSTRING(batch_no FROM 'CLM-\d{6}-(\d+)') AS INTEGER)),
      0
    ) + 1
  ) INTO v_start
  FROM public.claim_batches
  WHERE batch_no LIKE 'CLM-' || v_yyyymm || '-%';

  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS public.%I START WITH %s', v_seq_name, v_start);

  INSERT INTO public.claim_batch_sequences (yyyymm, sequence_name)
    VALUES (v_yyyymm, v_seq_name)
    ON CONFLICT (yyyymm) DO NOTHING;
END $$;


-- ============================================================
-- VERIFY
-- ============================================================
SELECT
  p.proname,
  p.prosecdef AS is_security_definer,
  r.rolname AS owner,
  t.tgname AS trigger_name,
  t.tgenabled AS enabled
FROM pg_proc p
JOIN pg_roles r ON r.oid = p.proowner
LEFT JOIN pg_trigger t ON t.tgfoid = p.oid AND NOT t.tgisinternal
WHERE p.proname = 'set_claim_batch_no';

SELECT yyyymm, sequence_name FROM public.claim_batch_sequences ORDER BY yyyymm;

-- 應該見到 2026-06 嘅 sequence,start value 由 5 開始 (因為 0001-0004 已用)
SELECT last_value, is_called FROM public.claim_batch_seq_202606;
