-- migration_statement_date.sql
-- 目的：upload_batches 加 statement_date 欄位
--      Journal Export 改用 statement_date 而唔係每條 txn_date
--
-- Statement Date 定義 (Alex confirmed)：
--   = Statement Closing Date / Billing Date（出單嗰日，e.g. 2026-01-31）
--   一張月結單 = 一個 batch = 一個 statement_date
--   所有屬於呢張單嘅 transactions 出 journal 時都用同一個 statement_date

-- ============================================================
-- 1. upload_batches 加欄位
-- ============================================================
ALTER TABLE upload_batches ADD COLUMN IF NOT EXISTS statement_date DATE;
ALTER TABLE upload_batches ADD COLUMN IF NOT EXISTS statement_due_date DATE;  -- 找數日（optional）

CREATE INDEX IF NOT EXISTS idx_upload_batches_statement_date ON upload_batches(statement_date);

COMMENT ON COLUMN upload_batches.statement_date IS 'Statement closing/billing date (出單日)';
COMMENT ON COLUMN upload_batches.statement_due_date IS 'Statement payment due date (找數日)';

-- ============================================================
-- 2. Backfill: 舊 batch 未有 statement_date
--    Fallback rule: 用 statement_period (YYYY-MM) 嘅月底
--    如果 statement_period 都冇 → 用 batch 入面最 late 嘅 txn_date
-- ============================================================
UPDATE upload_batches b
SET statement_date = (
  CASE
    -- 用 statement_period 嘅月底
    WHEN b.statement_period ~ '^\d{4}-\d{2}'
      THEN (DATE_TRUNC('month', (SUBSTRING(b.statement_period, 1, 7) || '-01')::DATE) + INTERVAL '1 month - 1 day')::DATE
    -- 否則用 transactions 最 late 嗰個 txn_date
    ELSE (
      SELECT MAX(t.txn_date)
      FROM card_transactions t
      WHERE t.batch_id = b.id
    )
  END
)
WHERE b.statement_date IS NULL
  AND b.module = 'cc';

-- ============================================================
-- 3. Verify
-- ============================================================
SELECT
  id,
  file_name,
  statement_period,
  statement_date,
  statement_total
FROM upload_batches
WHERE module = 'cc'
ORDER BY statement_date DESC NULLS LAST
LIMIT 20;
