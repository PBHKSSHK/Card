-- migration_attachment_line_id.sql
-- 加 line_id 比 claim_attachments, 達成 "一行多張收據" 嘅 design
-- NULL = batch 級附件 (cover sheet / 統一上傳)
-- 有值 = 對應 claim_lines.id 嘅單行收據

ALTER TABLE public.claim_attachments
  ADD COLUMN IF NOT EXISTS line_id UUID NULL REFERENCES public.claim_lines(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_claim_attachments_line_id
  ON public.claim_attachments(line_id) WHERE line_id IS NOT NULL;

-- View 統計每行嘅收據數 (option, 方便 UI)
CREATE OR REPLACE VIEW public.claim_lines_with_attachment_count AS
SELECT
  l.*,
  COALESCE(att_count.cnt, 0) AS attachment_count
FROM public.claim_lines l
LEFT JOIN (
  SELECT line_id, COUNT(*) AS cnt
  FROM public.claim_attachments
  WHERE line_id IS NOT NULL
  GROUP BY line_id
) att_count ON att_count.line_id = l.id;

GRANT SELECT ON public.claim_lines_with_attachment_count TO authenticated;
