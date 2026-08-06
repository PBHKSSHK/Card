-- ============================================================
-- CHECK_TRIGGER.sql — 30 秒驗證 batch_no trigger 已修正
-- ============================================================

SELECT
  proname,
  POSITION('pg_advisory_xact_lock' IN prosrc) > 0 AS has_lock,
  POSITION('hashtextextended' IN prosrc) > 0 AS has_hashtext
FROM pg_proc
WHERE proname = 'set_claim_batch_no';

-- 預期結果:
--   has_lock = true
--   has_hashtext = true
--
-- 如果其中一個係 false,即係 migration [2/3] 冇成功 apply,要再跑一次。
