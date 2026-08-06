-- ============================================================
-- DIAGNOSE_batch_no.sql
-- ============================================================
-- 跑呢條 SQL,將 4 個結果 paste 返俾 Alex
-- ============================================================

-- [1] 而家 trigger function 嘅源碼(verify advisory lock 有冇 apply)
SELECT
  proname,
  pg_get_function_identity_arguments(oid) AS args,
  LEFT(prosrc, 200) AS first_200_chars,
  POSITION('pg_advisory_xact_lock' IN prosrc) > 0 AS has_advisory_lock,
  POSITION('hashtextextended' IN prosrc) > 0 AS has_hashtext
FROM pg_proc
WHERE proname = 'set_claim_batch_no';

-- [2] Trigger 真係 bind 緊 claim_batches?
SELECT
  tgname,
  tgenabled,
  pg_get_triggerdef(oid) AS def
FROM pg_trigger
WHERE tgrelid = 'public.claim_batches'::regclass
  AND tgname = 'trg_set_claim_batch_no';

-- [3] 而家 db 有幾多 batch,有冇怪嘅 batch_no
SELECT
  COUNT(*) AS total_rows,
  COUNT(batch_no) AS rows_with_batch_no,
  COUNT(*) FILTER (WHERE batch_no IS NULL) AS null_batch_no,
  COUNT(DISTINCT batch_no) AS distinct_batch_no
FROM claim_batches;

-- [4] 列出最近 10 條 batch_no(睇有冇 duplicate / 跳號)
SELECT
  id, batch_no, claim_type, status, claimant_user_id,
  submit_date, created_at
FROM claim_batches
ORDER BY created_at DESC
LIMIT 10;

-- [5] 同一個月有冇 duplicate batch_no(理論上 UNIQUE 應該阻止,但 sanity check)
SELECT
  batch_no, COUNT(*) AS cnt
FROM claim_batches
WHERE batch_no IS NOT NULL
GROUP BY batch_no
HAVING COUNT(*) > 1;
