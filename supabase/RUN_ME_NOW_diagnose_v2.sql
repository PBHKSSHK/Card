-- ============================================================
-- RUN_ME_NOW_diagnose_v2.sql
-- ============================================================
-- 目的: 同事 login submit claim 仍然 duplicate batch_no error。
-- 之前嘅 SECURITY DEFINER fix 跑咗但 error 仲喺。
-- 呢個 script:
--   A) Diagnose — print 真實 DB state (trigger / function / unique idx / 現有 batch_no)
--   B) Force-reapply 個 function (security definer) + 再裝 trigger
--   C) Print 最終 state 確認 fix 已生效
-- ============================================================

\echo '═══════════════════════════════════════════════════════'
\echo 'A) DIAGNOSE — current state'
\echo '═══════════════════════════════════════════════════════'

-- A1. 個 function 點樣?
SELECT
  proname,
  prosecdef AS is_security_definer,
  pronargs,
  prosrc LIKE '%advisory_xact_lock%' AS has_lock,
  prosrc LIKE '%SECURITY DEFINER%' AS body_mentions_definer,
  length(prosrc) AS src_len
FROM pg_proc
WHERE proname IN ('set_claim_batch_no', 'generate_claim_batch_no');

-- A2. claim_batches 表上嘅 trigger 有邊啲?
SELECT
  tgname AS trigger_name,
  tgenabled AS enabled,
  proname AS function_called,
  pg_get_triggerdef(t.oid) AS trigger_def
FROM pg_trigger t
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE t.tgrelid = 'public.claim_batches'::regclass
  AND NOT t.tgisinternal;

-- A3. UNIQUE / index 上 batch_no 嘅
SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'claim_batches'
  AND indexdef ILIKE '%batch_no%';

-- A4. 現有 batch_no 分佈 — 睇下實際幾多條
SELECT
  TO_CHAR(submit_date, 'YYYYMM') AS yyyymm,
  COUNT(*) AS count,
  MIN(batch_no) AS min_no,
  MAX(batch_no) AS max_no,
  string_agg(batch_no, ', ' ORDER BY batch_no) AS all_batches
FROM claim_batches
GROUP BY TO_CHAR(submit_date, 'YYYYMM')
ORDER BY yyyymm;

-- A5. RLS policy on claim_batches (INSERT 有冇 block?)
SELECT
  polname,
  polcmd,
  polpermissive,
  pg_get_expr(polqual, polrelid) AS using_expr,
  pg_get_expr(polwithcheck, polrelid) AS check_expr
FROM pg_policy
WHERE polrelid = 'public.claim_batches'::regclass
ORDER BY polcmd, polname;


\echo ''
\echo '═══════════════════════════════════════════════════════'
\echo 'B) FORCE RE-APPLY — drop & recreate function + trigger'
\echo '═══════════════════════════════════════════════════════'

-- B1. 完全 drop function (cascade trigger) 再重建 — 確保新版本生效
DROP FUNCTION IF EXISTS public.set_claim_batch_no() CASCADE;

CREATE OR REPLACE FUNCTION public.set_claim_batch_no()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_yyyymm TEXT;
  v_seq INTEGER;
  v_lock_key BIGINT;
  v_attempt INTEGER := 0;
  v_max_attempts CONSTANT INTEGER := 10;
BEGIN
  IF NEW.batch_no IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_yyyymm := TO_CHAR(COALESCE(NEW.submit_date, CURRENT_DATE), 'YYYYMM');
  v_lock_key := hashtextextended('claim_batch_no:' || v_yyyymm, 0);

  -- Transaction-level advisory lock — 同 statement 排隊
  PERFORM pg_advisory_xact_lock(v_lock_key);

  LOOP
    v_attempt := v_attempt + 1;

    -- SECURITY DEFINER + bypass RLS — 見晒所有 user 嘅 batch_no
    SELECT COALESCE(MAX(CAST(SUBSTRING(batch_no FROM 'CLM-\d{6}-(\d+)') AS INTEGER)), 0) + 1
      INTO v_seq
      FROM public.claim_batches
      WHERE batch_no LIKE 'CLM-' || v_yyyymm || '-%';

    NEW.batch_no := 'CLM-' || v_yyyymm || '-' || LPAD(v_seq::TEXT, 4, '0');

    -- 再 check 一次冇撞 (paranoia / 預防 race)
    IF NOT EXISTS (
      SELECT 1 FROM public.claim_batches WHERE batch_no = NEW.batch_no
    ) THEN
      EXIT;
    END IF;

    IF v_attempt >= v_max_attempts THEN
      RAISE EXCEPTION 'set_claim_batch_no: cannot find unique batch_no after % attempts (last tried: %)',
        v_max_attempts, NEW.batch_no;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

-- B2. 確保 function owner 係 postgres (bypass RLS 要超級 role)
ALTER FUNCTION public.set_claim_batch_no() OWNER TO postgres;

-- B3. 重裝 trigger
DROP TRIGGER IF EXISTS trg_set_claim_batch_no ON public.claim_batches;
CREATE TRIGGER trg_set_claim_batch_no
  BEFORE INSERT ON public.claim_batches
  FOR EACH ROW
  EXECUTE FUNCTION public.set_claim_batch_no();

-- B4. Grant — function execute 畀 authenticated
GRANT EXECUTE ON FUNCTION public.set_claim_batch_no() TO authenticated, anon, service_role;


\echo ''
\echo '═══════════════════════════════════════════════════════'
\echo 'C) VERIFY — final state'
\echo '═══════════════════════════════════════════════════════'

SELECT
  p.proname,
  p.prosecdef AS is_security_definer,
  r.rolname AS function_owner,
  t.tgname AS trigger_name,
  t.tgenabled AS trigger_enabled
FROM pg_proc p
JOIN pg_roles r ON r.oid = p.proowner
LEFT JOIN pg_trigger t ON t.tgfoid = p.oid
WHERE p.proname = 'set_claim_batch_no';

-- 應該 print:
--   set_claim_batch_no | t (security_definer) | postgres | trg_set_claim_batch_no | O (enabled)
