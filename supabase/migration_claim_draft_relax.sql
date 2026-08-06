-- migration_claim_draft_relax.sql
-- 放寬 claim_batches 對 draft 嘅限制：
--   1. charge_to_code 可以 NULL（draft 時可以未填）
--   2. claim_lines.batch_id 已有 FK CASCADE，draft 同提交都用同一張表
--
-- Idempotent — 可重覆 run

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
