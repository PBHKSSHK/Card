-- ============================================================
-- migration_claim_privacy_tighten.sql
-- ============================================================
-- 目的：收窄 claim_batches SELECT 權限
--
-- 問題：之前個 policy 容許 `user_can_see_entity(entity_code)` —
--       即 BU user A 同 BU user B 同係 SSHK scope，A 可以見 B 嘅 claim。
--       Claim form 屬私隱資料（薪酬類）不應同 entity 內所有人見到。
--
-- 新規則：
--   1. owner / admin → 見全部 (is_super_user())
--   2. claimant 自己 → 見自己嘅
--   3. team_head_user_id = me → 已經 sign 過嘅
--   4. team_head_assignments 對應 charge_to → 被分配做 TH 嘅
--   5. ❌ 刪走 entity_code → user_can_see_entity 呢個 path
--
-- claim_lines / claim_attachments / claim_audit_log 都係透過
-- EXISTS claim_batches join — 只要 claim_batches 收窄,其他表自動跟。
-- ============================================================

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

-- 順手檢查同收窄 claim_lines / attachments / audit_log
-- (現有 policy 已經透過 EXISTS claim_batches 引用，所以自動跟新規則 — 唔需改)

-- ============================================================
-- 同步收窄 storage.objects "documents" bucket 嘅 SELECT 權限
-- ============================================================
-- 注意：呢 part 可能需要視乎現時 bucket policy 而定，如果你有 receipt
-- 上傳到 documents bucket，又用 signed URL 開，咁 signed URL 已經
-- bypass RLS — 但人哋要先 SELECT claim_attachments 先攞到 path。
-- 而 claim_attachments 嘅 RLS 已經 join claim_batches → 自動收窄。

-- ============================================================
-- 驗證: 跑呢條 query 確認 policy
-- ============================================================
-- SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr
-- FROM pg_policy
-- WHERE polrelid = 'public.claim_batches'::regclass
--   AND polcmd = 'r';
