-- migration_claim_system.sql
-- 目的：建立 Claim Form 系統 (Expenses + Transportation)
--      4 張 table + team_head_assignments + RLS
-- ============================================================
-- 設計重點：
--   1. 兩種 claim 共用同一套 table，用 claim_type 區分
--   2. charge_to_code 為 single source of truth（同 CardRecon 一樣）
--   3. 3 層 approval: claimant → team_head → final_approver
--   4. 全 web flow，無 Excel upload/download
--   5. NetSuite 用 Journal CSV 出 (Phase 2 implement)
-- ============================================================

-- ============================================================
-- 0. Ensure helper functions exist (idempotent — 如果之前未 run migration_user_roles.sql 都有)
-- ============================================================
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.user_profiles WHERE user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.current_user_entity_scope()
RETURNS TEXT[]
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT entity_scope FROM public.user_profiles WHERE user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.is_super_user()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_id = auth.uid()
      AND role IN ('owner', 'admin')
  )
$$;

CREATE OR REPLACE FUNCTION public.user_can_see_entity(p_entity TEXT)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.is_super_user()
    OR (
      p_entity IS NOT NULL
      AND p_entity = ANY(public.current_user_entity_scope())
    )
$$;

-- ============================================================
-- 1. team_head_assignments — Team Head 分配表（空表，Alex 後補 data）
-- ============================================================
CREATE TABLE IF NOT EXISTS team_head_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_head_user_id UUID NOT NULL REFERENCES user_profiles(user_id) ON DELETE CASCADE,
  charge_to_code TEXT NOT NULL,  -- match ns_departments.charge_to
  entity_code TEXT,              -- optional cache for filtering (NULL = derive from charge_to)
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (team_head_user_id, charge_to_code)
);

CREATE INDEX IF NOT EXISTS idx_team_head_assignments_charge_to ON team_head_assignments(charge_to_code);
CREATE INDEX IF NOT EXISTS idx_team_head_assignments_user ON team_head_assignments(team_head_user_id);

-- ============================================================
-- 2. claim_batches — 一張 claim form (= 一個 batch)
-- ============================================================
CREATE TABLE IF NOT EXISTS claim_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_no TEXT UNIQUE,  -- auto-generated e.g. CLM-202506-0001

  -- Claim type
  claim_type TEXT NOT NULL CHECK (claim_type IN ('expenses', 'transportation')),

  -- Claimant info
  claimant_user_id UUID NOT NULL REFERENCES user_profiles(user_id) ON DELETE RESTRICT,
  full_name TEXT,
  nick_name TEXT,
  department TEXT,
  submit_date DATE,
  period_month TEXT,  -- YYYY-MM (for filtering / grouping)

  -- Charge to (single source of truth)
  charge_to_code TEXT NOT NULL,
  entity_code TEXT,                  -- derived from ns_departments
  subsidiary_full_name TEXT,         -- derived
  department_name TEXT,              -- derived from ns_departments.name

  -- Workflow status
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft',                  -- claimant 仲填緊
    'submitted',              -- 提交咗，等 team head
    'team_head_approved',     -- team head sign 咗，等 final
    'approved',               -- final approver approve 咗
    'exported',               -- 已 export 去 NetSuite
    'rejected'                -- 被退（會記低 reject 原因，可改回 draft）
  )),

  -- Team head approval
  team_head_user_id UUID REFERENCES user_profiles(user_id),
  team_head_signed_at TIMESTAMPTZ,
  team_head_comment TEXT,

  -- Final approval
  approver_user_id UUID REFERENCES user_profiles(user_id),
  approved_at TIMESTAMPTZ,
  approver_comment TEXT,

  -- Reject
  rejected_by_user_id UUID REFERENCES user_profiles(user_id),
  rejected_at TIMESTAMPTZ,
  reject_reason TEXT,

  -- Total (cached, 由 trigger 更新)
  total_hkd NUMERIC(14, 2) DEFAULT 0,
  line_count INTEGER DEFAULT 0,

  -- NetSuite export
  netsuite_journal_no TEXT,
  exported_at TIMESTAMPTZ,
  exported_by_user_id UUID REFERENCES user_profiles(user_id),

  -- Audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claim_batches_claimant ON claim_batches(claimant_user_id);
CREATE INDEX IF NOT EXISTS idx_claim_batches_status ON claim_batches(status);
CREATE INDEX IF NOT EXISTS idx_claim_batches_type ON claim_batches(claim_type);
CREATE INDEX IF NOT EXISTS idx_claim_batches_charge_to ON claim_batches(charge_to_code);
CREATE INDEX IF NOT EXISTS idx_claim_batches_entity ON claim_batches(entity_code);
CREATE INDEX IF NOT EXISTS idx_claim_batches_period ON claim_batches(period_month);

-- ============================================================
-- 3. claim_lines — 每行明細
-- ============================================================
CREATE TABLE IF NOT EXISTS claim_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES claim_batches(id) ON DELETE CASCADE,

  -- 共通欄
  item_no INTEGER NOT NULL,
  line_date DATE,
  project_code TEXT,         -- match ns_project_codes.code
  description TEXT,
  has_receipt BOOLEAN DEFAULT FALSE,

  -- Expenses 專用
  client_name TEXT,
  currency TEXT,                       -- HKD / USD / JPY / etc
  original_amount NUMERIC(14, 2),
  fx_rate NUMERIC(14, 6),              -- user 自己填，唔重算
  hkd_amount NUMERIC(14, 2),           -- user 自己填，唔重算
  billable_to_client_hkd NUMERIC(14, 2) DEFAULT 0,
  expense_category_code TEXT,          -- match expense_categories.code

  -- Transportation 專用
  means_of_transport TEXT,             -- TAXI / UBER / MTR / BUS / TRAM / FERRY / OTHER
  taxi_reason TEXT,                    -- 點解坐 taxi/uber
  location_from TEXT,
  destination TEXT,
  -- amount_hkd 用上面 hkd_amount

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (batch_id, item_no)
);

CREATE INDEX IF NOT EXISTS idx_claim_lines_batch ON claim_lines(batch_id);
CREATE INDEX IF NOT EXISTS idx_claim_lines_project ON claim_lines(project_code);
CREATE INDEX IF NOT EXISTS idx_claim_lines_date ON claim_lines(line_date);

-- ============================================================
-- 4. claim_attachments — Receipt 圖片 / PDF
-- ============================================================
CREATE TABLE IF NOT EXISTS claim_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES claim_batches(id) ON DELETE CASCADE,
  line_id UUID REFERENCES claim_lines(id) ON DELETE CASCADE,  -- NULL = batch-level
  storage_path TEXT NOT NULL,           -- Supabase Storage path
  file_name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  uploaded_by_user_id UUID REFERENCES user_profiles(user_id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claim_attachments_batch ON claim_attachments(batch_id);
CREATE INDEX IF NOT EXISTS idx_claim_attachments_line ON claim_attachments(line_id);

-- ============================================================
-- 5. claim_audit_log — 追蹤 status 流轉
-- ============================================================
CREATE TABLE IF NOT EXISTS claim_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES claim_batches(id) ON DELETE CASCADE,
  action TEXT NOT NULL,        -- created / updated / submitted / team_head_approved / approved / rejected / exported / line_added / line_deleted
  from_status TEXT,
  to_status TEXT,
  actor_user_id UUID REFERENCES user_profiles(user_id),
  comment TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claim_audit_batch ON claim_audit_log(batch_id);
CREATE INDEX IF NOT EXISTS idx_claim_audit_action ON claim_audit_log(action);

-- ============================================================
-- 6. Triggers — 自動更新 total_hkd, line_count, batch_no
-- ============================================================

-- Auto-generate batch_no (CLM-YYYYMM-NNNN)
CREATE OR REPLACE FUNCTION public.set_claim_batch_no()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_yyyymm TEXT;
  v_seq INTEGER;
BEGIN
  IF NEW.batch_no IS NULL THEN
    v_yyyymm := TO_CHAR(COALESCE(NEW.submit_date, CURRENT_DATE), 'YYYYMM');
    SELECT COALESCE(MAX(CAST(SUBSTRING(batch_no FROM 'CLM-\d{6}-(\d+)') AS INTEGER)), 0) + 1
      INTO v_seq
      FROM claim_batches
      WHERE batch_no LIKE 'CLM-' || v_yyyymm || '-%';
    NEW.batch_no := 'CLM-' || v_yyyymm || '-' || LPAD(v_seq::TEXT, 4, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_claim_batch_no ON claim_batches;
CREATE TRIGGER trg_set_claim_batch_no
  BEFORE INSERT ON claim_batches
  FOR EACH ROW EXECUTE FUNCTION public.set_claim_batch_no();

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_claim_batches_updated ON claim_batches;
CREATE TRIGGER trg_claim_batches_updated
  BEFORE UPDATE ON claim_batches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_claim_lines_updated ON claim_lines;
CREATE TRIGGER trg_claim_lines_updated
  BEFORE UPDATE ON claim_lines
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_team_head_updated ON team_head_assignments;
CREATE TRIGGER trg_team_head_updated
  BEFORE UPDATE ON team_head_assignments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Re-calc total_hkd 同 line_count
CREATE OR REPLACE FUNCTION public.recalc_claim_batch_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch_id UUID;
BEGIN
  v_batch_id := COALESCE(NEW.batch_id, OLD.batch_id);
  UPDATE claim_batches
    SET total_hkd = (SELECT COALESCE(SUM(hkd_amount), 0) FROM claim_lines WHERE batch_id = v_batch_id),
        line_count = (SELECT COUNT(*) FROM claim_lines WHERE batch_id = v_batch_id),
        updated_at = NOW()
    WHERE id = v_batch_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_claim_lines_recalc ON claim_lines;
CREATE TRIGGER trg_claim_lines_recalc
  AFTER INSERT OR UPDATE OR DELETE ON claim_lines
  FOR EACH ROW EXECUTE FUNCTION public.recalc_claim_batch_totals();

-- Auto-derive entity_code / subsidiary_full_name / department_name from charge_to_code
CREATE OR REPLACE FUNCTION public.derive_claim_charge_to_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_entity TEXT;
  v_sub TEXT;
  v_name TEXT;
BEGIN
  IF NEW.charge_to_code IS NOT NULL THEN
    SELECT entity_code, subsidiary_full_name, name
      INTO v_entity, v_sub, v_name
      FROM ns_departments
      WHERE charge_to = NEW.charge_to_code
      LIMIT 1;
    NEW.entity_code := v_entity;
    NEW.subsidiary_full_name := v_sub;
    NEW.department_name := v_name;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_claim_batches_derive ON claim_batches;
CREATE TRIGGER trg_claim_batches_derive
  BEFORE INSERT OR UPDATE OF charge_to_code ON claim_batches
  FOR EACH ROW EXECUTE FUNCTION public.derive_claim_charge_to_fields();

-- ============================================================
-- 7. Helper view — claim batch + team_head info
-- ============================================================
CREATE OR REPLACE VIEW claim_batches_with_team_head AS
SELECT
  b.*,
  -- 邊個係呢個 charge_to 嘅 team_head
  (
    SELECT u.user_id
    FROM team_head_assignments tha
    JOIN user_profiles u ON u.user_id = tha.team_head_user_id
    WHERE tha.charge_to_code = b.charge_to_code
    LIMIT 1
  ) AS assigned_team_head_user_id,
  (
    SELECT u.full_name
    FROM team_head_assignments tha
    JOIN user_profiles u ON u.user_id = tha.team_head_user_id
    WHERE tha.charge_to_code = b.charge_to_code
    LIMIT 1
  ) AS assigned_team_head_name,
  (
    SELECT u.email
    FROM team_head_assignments tha
    JOIN user_profiles u ON u.user_id = tha.team_head_user_id
    WHERE tha.charge_to_code = b.charge_to_code
    LIMIT 1
  ) AS assigned_team_head_email
FROM claim_batches b;

-- ============================================================
-- 8. RLS — team_head_assignments
-- ============================================================
ALTER TABLE team_head_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "team_head_assignments_select" ON team_head_assignments;
CREATE POLICY "team_head_assignments_select" ON team_head_assignments
  FOR SELECT TO authenticated
  USING (true);  -- 所有 user 可見（要查邊個係 team head）

DROP POLICY IF EXISTS "team_head_assignments_write" ON team_head_assignments;
CREATE POLICY "team_head_assignments_write" ON team_head_assignments
  FOR ALL TO authenticated
  USING (public.is_super_user())
  WITH CHECK (public.is_super_user());

-- ============================================================
-- 9. RLS — claim_batches
-- ============================================================
ALTER TABLE claim_batches ENABLE ROW LEVEL SECURITY;

-- SELECT: super user 見全部；claimant 見自己；team head 見指派俾佢嘅
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
    OR (entity_code IS NOT NULL AND public.user_can_see_entity(entity_code))
  );

-- INSERT: 任何 authenticated user 可以新建（自己嘅 claim）
DROP POLICY IF EXISTS "claim_batches_insert" ON claim_batches;
CREATE POLICY "claim_batches_insert" ON claim_batches
  FOR INSERT TO authenticated
  WITH CHECK (
    claimant_user_id = auth.uid()
    OR public.is_super_user()
  );

-- UPDATE: claimant 只可改 draft / rejected 嘅；team head 可 sign；super user 全部
DROP POLICY IF EXISTS "claim_batches_update" ON claim_batches;
CREATE POLICY "claim_batches_update" ON claim_batches
  FOR UPDATE TO authenticated
  USING (
    public.is_super_user()
    OR (claimant_user_id = auth.uid() AND status IN ('draft', 'rejected'))
    OR (
      -- team head 可 update 自己負責 charge_to 嘅 submitted batch
      status = 'submitted'
      AND EXISTS (
        SELECT 1 FROM team_head_assignments tha
        WHERE tha.team_head_user_id = auth.uid()
          AND tha.charge_to_code = claim_batches.charge_to_code
      )
    )
  )
  WITH CHECK (
    public.is_super_user()
    OR claimant_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM team_head_assignments tha
      WHERE tha.team_head_user_id = auth.uid()
        AND tha.charge_to_code = claim_batches.charge_to_code
    )
  );

-- DELETE: 只可 claimant 自己刪 draft；或 super user
DROP POLICY IF EXISTS "claim_batches_delete" ON claim_batches;
CREATE POLICY "claim_batches_delete" ON claim_batches
  FOR DELETE TO authenticated
  USING (
    public.is_super_user()
    OR (claimant_user_id = auth.uid() AND status = 'draft')
  );

-- ============================================================
-- 10. RLS — claim_lines (跟 batch)
-- ============================================================
ALTER TABLE claim_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "claim_lines_all" ON claim_lines;
CREATE POLICY "claim_lines_all" ON claim_lines
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM claim_batches b
      WHERE b.id = claim_lines.batch_id
        AND (
          public.is_super_user()
          OR b.claimant_user_id = auth.uid()
          OR b.team_head_user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM team_head_assignments tha
            WHERE tha.team_head_user_id = auth.uid()
              AND tha.charge_to_code = b.charge_to_code
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM claim_batches b
      WHERE b.id = claim_lines.batch_id
        AND (
          public.is_super_user()
          OR (b.claimant_user_id = auth.uid() AND b.status IN ('draft', 'rejected'))
        )
    )
  );

-- ============================================================
-- 11. RLS — claim_attachments (跟 batch)
-- ============================================================
ALTER TABLE claim_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "claim_attachments_select" ON claim_attachments;
CREATE POLICY "claim_attachments_select" ON claim_attachments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM claim_batches b
      WHERE b.id = claim_attachments.batch_id
        AND (
          public.is_super_user()
          OR b.claimant_user_id = auth.uid()
          OR b.team_head_user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM team_head_assignments tha
            WHERE tha.team_head_user_id = auth.uid()
              AND tha.charge_to_code = b.charge_to_code
          )
        )
    )
  );

DROP POLICY IF EXISTS "claim_attachments_write" ON claim_attachments;
CREATE POLICY "claim_attachments_write" ON claim_attachments
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM claim_batches b
      WHERE b.id = claim_attachments.batch_id
        AND (
          public.is_super_user()
          OR (b.claimant_user_id = auth.uid() AND b.status IN ('draft', 'rejected'))
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM claim_batches b
      WHERE b.id = claim_attachments.batch_id
        AND (
          public.is_super_user()
          OR (b.claimant_user_id = auth.uid() AND b.status IN ('draft', 'rejected'))
        )
    )
  );

-- ============================================================
-- 12. RLS — claim_audit_log
-- ============================================================
ALTER TABLE claim_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "claim_audit_log_select" ON claim_audit_log;
CREATE POLICY "claim_audit_log_select" ON claim_audit_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM claim_batches b
      WHERE b.id = claim_audit_log.batch_id
        AND (
          public.is_super_user()
          OR b.claimant_user_id = auth.uid()
          OR b.team_head_user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM team_head_assignments tha
            WHERE tha.team_head_user_id = auth.uid()
              AND tha.charge_to_code = b.charge_to_code
          )
        )
    )
  );

DROP POLICY IF EXISTS "claim_audit_log_insert" ON claim_audit_log;
CREATE POLICY "claim_audit_log_insert" ON claim_audit_log
  FOR INSERT TO authenticated
  WITH CHECK (true);  -- 任何 authenticated user 可寫 audit

-- ============================================================
-- 13. Verify
-- ============================================================
SELECT 'team_head_assignments' AS tbl, COUNT(*) AS row_count FROM team_head_assignments
UNION ALL
SELECT 'claim_batches', COUNT(*) FROM claim_batches
UNION ALL
SELECT 'claim_lines', COUNT(*) FROM claim_lines
UNION ALL
SELECT 'claim_attachments', COUNT(*) FROM claim_attachments
UNION ALL
SELECT 'claim_audit_log', COUNT(*) FROM claim_audit_log;
