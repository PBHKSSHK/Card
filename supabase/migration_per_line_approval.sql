-- ============================================================
-- Per-line approval + 事後補 receipt
-- ============================================================
-- 1. claim_lines 加 line_status / line_reject_reason / approved_by_user_id / approved_at
-- 2. Backfill 現有 line: status='approved' (因為過往係 batch-level approve, 隱含全部 OK)
-- 3. claim_batches 加 partial_rejected flag (記低係部分 reject 嘅 batch)
-- 4. claim_attachments RLS 放寬: submitted / team_head_approved / approved 都可以加 receipt
--    (但只可以 INSERT,唔可以 UPDATE/DELETE 已有 attachment)
-- ============================================================

BEGIN;

-- ============================================================
-- 1. claim_lines: per-line status
-- ============================================================
ALTER TABLE claim_lines
  ADD COLUMN IF NOT EXISTS line_status TEXT NOT NULL DEFAULT 'approved'
    CHECK (line_status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS line_reject_reason TEXT,
  ADD COLUMN IF NOT EXISTS line_approved_by_user_id UUID REFERENCES user_profiles(user_id),
  ADD COLUMN IF NOT EXISTS line_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS line_rejected_by_user_id UUID REFERENCES user_profiles(user_id),
  ADD COLUMN IF NOT EXISTS line_rejected_at TIMESTAMPTZ;

-- ============================================================
-- 2. Backfill existing lines
-- ============================================================
-- 對於已 submit / approved / exported 嘅 batch,line 預設 approved
-- 對於 draft 嘅 batch,line 預設 pending(未審)
UPDATE claim_lines cl
SET line_status = CASE
  WHEN cb.status IN ('approved', 'team_head_approved', 'exported') THEN 'approved'
  WHEN cb.status = 'rejected' THEN 'rejected'
  ELSE 'pending'
END
FROM claim_batches cb
WHERE cl.batch_id = cb.id
  AND cl.line_status = 'approved'; -- 只 update default 嘅,唔覆蓋已 manual set

-- ============================================================
-- 3. claim_batches: partial_rejected flag + 一個 line_summary view
-- ============================================================
ALTER TABLE claim_batches
  ADD COLUMN IF NOT EXISTS has_rejected_lines BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS approved_line_count INTEGER,
  ADD COLUMN IF NOT EXISTS rejected_line_count INTEGER,
  ADD COLUMN IF NOT EXISTS approved_total_hkd NUMERIC(14, 2);

-- ============================================================
-- 4. Trigger: 每次 line update 後重計 batch 嘅 approved_line_count / approved_total_hkd
-- ============================================================
CREATE OR REPLACE FUNCTION refresh_claim_batch_line_summary() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch_id UUID;
BEGIN
  v_batch_id := COALESCE(NEW.batch_id, OLD.batch_id);
  UPDATE claim_batches cb
  SET
    approved_line_count = (
      SELECT COUNT(*) FROM claim_lines WHERE batch_id = v_batch_id AND line_status = 'approved'
    ),
    rejected_line_count = (
      SELECT COUNT(*) FROM claim_lines WHERE batch_id = v_batch_id AND line_status = 'rejected'
    ),
    approved_total_hkd = (
      SELECT COALESCE(SUM(hkd_amount), 0) FROM claim_lines WHERE batch_id = v_batch_id AND line_status = 'approved'
    ),
    has_rejected_lines = (
      SELECT EXISTS (SELECT 1 FROM claim_lines WHERE batch_id = v_batch_id AND line_status = 'rejected')
    )
  WHERE id = v_batch_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_refresh_batch_summary ON claim_lines;
CREATE TRIGGER trg_refresh_batch_summary
  AFTER INSERT OR UPDATE OR DELETE ON claim_lines
  FOR EACH ROW EXECUTE FUNCTION refresh_claim_batch_line_summary();

-- Initial run: fill counts for all existing batches
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM claim_batches LOOP
    UPDATE claim_batches cb
    SET
      approved_line_count = (SELECT COUNT(*) FROM claim_lines WHERE batch_id = r.id AND line_status = 'approved'),
      rejected_line_count = (SELECT COUNT(*) FROM claim_lines WHERE batch_id = r.id AND line_status = 'rejected'),
      approved_total_hkd = (SELECT COALESCE(SUM(hkd_amount), 0) FROM claim_lines WHERE batch_id = r.id AND line_status = 'approved'),
      has_rejected_lines = (SELECT EXISTS (SELECT 1 FROM claim_lines WHERE batch_id = r.id AND line_status = 'rejected'))
    WHERE id = r.id;
  END LOOP;
END $$;

-- ============================================================
-- 5. claim_attachments RLS: 放寬 INSERT
-- ============================================================
-- 原來只有 draft 可以加 attachment (見 migration_claim_system.sql)
-- 現在: claimant / admin / owner 可以喺 draft / submitted / team_head_approved / approved 狀態加 attachment
-- 但 UPDATE / DELETE 仍然限制在 draft / rejected
-- ============================================================

-- Drop old INSERT policy if exists
DROP POLICY IF EXISTS "claim_attachments_insert" ON claim_attachments;
DROP POLICY IF EXISTS "claim_attachments_insert_draft" ON claim_attachments;
DROP POLICY IF EXISTS "claim_attachments_insert_open" ON claim_attachments;

CREATE POLICY "claim_attachments_insert_open" ON claim_attachments
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM claim_batches cb
    WHERE cb.id = claim_attachments.batch_id
      AND cb.status IN ('draft', 'submitted', 'team_head_approved', 'approved')
      AND (
        cb.claimant_user_id = auth.uid()  -- claimant 自己
        OR EXISTS (
          SELECT 1 FROM user_profiles up
          WHERE up.user_id = auth.uid()
            AND up.role IN ('admin', 'owner')
        )
      )
  )
);

-- DELETE 政策(仍然只係 draft / rejected)
DROP POLICY IF EXISTS "claim_attachments_delete" ON claim_attachments;
DROP POLICY IF EXISTS "claim_attachments_delete_draft" ON claim_attachments;

CREATE POLICY "claim_attachments_delete_draft" ON claim_attachments
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM claim_batches cb
    WHERE cb.id = claim_attachments.batch_id
      AND cb.status IN ('draft', 'rejected')
      AND (
        cb.claimant_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM user_profiles up
          WHERE up.user_id = auth.uid()
            AND up.role IN ('admin', 'owner')
        )
      )
  )
);

-- ============================================================
-- 6. Audit log: 加 'line_approved' / 'line_rejected' 兩個新 action
-- ============================================================
-- 已有 audit_log 表, action 係 free text, 唔需要 alter

COMMIT;

-- ============================================================
-- 驗證
-- ============================================================
SELECT
  'claim_lines status counts:' AS check,
  line_status,
  COUNT(*) AS cnt
FROM claim_lines
GROUP BY line_status
ORDER BY line_status;

SELECT
  'batch summary:' AS check,
  status,
  COUNT(*) AS batch_cnt,
  SUM(approved_line_count) AS approved_lines,
  SUM(rejected_line_count) AS rejected_lines
FROM claim_batches
GROUP BY status
ORDER BY status;
