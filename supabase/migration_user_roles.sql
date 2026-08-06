-- migration_user_roles.sql
-- 目的：建立 user roles (owner / admin / bu_user) 同 entity scope，並寫 RLS policies
-- 適用於：meta_invoices, meta_invoice_splits, transactions, statements,
--        accounting_lines, reconciliation_results, documents (storage)
--
-- Role 定義：
--   owner    — 4 位老闆 (alex@sshk, nok@sshk, rex@pbhk, kenneth@clsgarage)
--              full access 所有 entity + 可以管理 user
--   admin    — Yannese (yannese.lo@pbhk.info)
--              同 owner 一樣 full access + 可以管理 user
--   bu_user  — BU 同事，只可見/改自己 entity scope 嘅 invoice
--
-- Entity scope mapping：
--   CLS:  kitman.choi, mabel.tan  →  ['CLS']
--   PBHK: maggie.kwan             →  ['PBHK', '704']  (704 同 PBHK 一齊)
--   SSHK: fornia.lung, to.fok     →  ['SSHK']
--   JM:   alex.lee, tracy.tsang   →  ['JM']

-- ============================================================
-- 1. user_profiles 表 — 儲 role + entity scope
-- ============================================================
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'bu_user')),
  entity_scope TEXT[] NOT NULL DEFAULT '{}',  -- e.g. ['CLS'] 或 ['PBHK','704']；owner/admin 為空 = 全部
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_email ON user_profiles(email);
CREATE INDEX IF NOT EXISTS idx_user_profiles_role ON user_profiles(role);

-- ============================================================
-- 2. Helper functions — RLS policies 用
-- ============================================================

-- 取得當前 user 嘅 role
CREATE OR REPLACE FUNCTION current_user_role()
RETURNS TEXT
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM user_profiles WHERE user_id = auth.uid()
$$;

-- 取得當前 user 嘅 entity scope
CREATE OR REPLACE FUNCTION current_user_entity_scope()
RETURNS TEXT[]
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT entity_scope FROM user_profiles WHERE user_id = auth.uid()
$$;

-- 當前 user 係咪 super (owner / admin)
CREATE OR REPLACE FUNCTION is_super_user()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_profiles
    WHERE user_id = auth.uid()
      AND role IN ('owner', 'admin')
  )
$$;

-- 判斷某 entity_code 是否屬於當前 user 嘅 scope
CREATE OR REPLACE FUNCTION user_can_see_entity(p_entity TEXT)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    -- super user 見曬
    is_super_user()
    OR
    -- BU user 必須個 entity 喺 scope 內 (NULL/空當作 owner only)
    (
      p_entity IS NOT NULL
      AND p_entity = ANY(current_user_entity_scope())
    )
$$;

-- ============================================================
-- 3. user_profiles 自身 RLS
-- ============================================================
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_profiles_self_read" ON user_profiles;
CREATE POLICY "user_profiles_self_read" ON user_profiles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR is_super_user());

DROP POLICY IF EXISTS "user_profiles_admin_write" ON user_profiles;
CREATE POLICY "user_profiles_admin_write" ON user_profiles
  FOR ALL TO authenticated
  USING (is_super_user())
  WITH CHECK (is_super_user());

-- ============================================================
-- 4. meta_invoices RLS
-- ============================================================
ALTER TABLE meta_invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "meta_invoices_select" ON meta_invoices;
CREATE POLICY "meta_invoices_select" ON meta_invoices
  FOR SELECT TO authenticated
  USING (
    is_super_user()
    OR user_can_see_entity(charge_to_entity)
    OR charge_to_entity IS NULL  -- 未分類 invoice BU user 都可以見到（自己 upload 緊唔知 entity）
  );

DROP POLICY IF EXISTS "meta_invoices_insert" ON meta_invoices;
CREATE POLICY "meta_invoices_insert" ON meta_invoices
  FOR INSERT TO authenticated
  WITH CHECK (
    is_super_user()
    OR charge_to_entity IS NULL
    OR user_can_see_entity(charge_to_entity)
  );

DROP POLICY IF EXISTS "meta_invoices_update" ON meta_invoices;
CREATE POLICY "meta_invoices_update" ON meta_invoices
  FOR UPDATE TO authenticated
  USING (
    is_super_user()
    OR user_can_see_entity(charge_to_entity)
    OR charge_to_entity IS NULL
  )
  WITH CHECK (
    is_super_user()
    OR user_can_see_entity(charge_to_entity)
  );

DROP POLICY IF EXISTS "meta_invoices_delete" ON meta_invoices;
CREATE POLICY "meta_invoices_delete" ON meta_invoices
  FOR DELETE TO authenticated
  USING (
    is_super_user()
    OR user_can_see_entity(charge_to_entity)
  );

-- ============================================================
-- 5. meta_invoice_splits RLS — 跟 parent invoice
-- ============================================================
ALTER TABLE meta_invoice_splits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "meta_invoice_splits_all" ON meta_invoice_splits;
CREATE POLICY "meta_invoice_splits_all" ON meta_invoice_splits
  FOR ALL TO authenticated
  USING (
    is_super_user()
    OR EXISTS (
      SELECT 1 FROM meta_invoices mi
      WHERE mi.id = meta_invoice_splits.invoice_id
        AND (user_can_see_entity(mi.charge_to_entity) OR mi.charge_to_entity IS NULL)
    )
  )
  WITH CHECK (
    is_super_user()
    OR EXISTS (
      SELECT 1 FROM meta_invoices mi
      WHERE mi.id = meta_invoice_splits.invoice_id
        AND (user_can_see_entity(mi.charge_to_entity) OR mi.charge_to_entity IS NULL)
    )
  );

-- ============================================================
-- 6. transactions / statements — BU 可 read，唔可寫
-- ============================================================
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "transactions_select" ON transactions;
CREATE POLICY "transactions_select" ON transactions
  FOR SELECT TO authenticated
  USING (true);  -- 全部 authenticated user 可見 (reconcile 時要睇)

DROP POLICY IF EXISTS "transactions_write" ON transactions;
CREATE POLICY "transactions_write" ON transactions
  FOR ALL TO authenticated
  USING (is_super_user())
  WITH CHECK (is_super_user());

ALTER TABLE statements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "statements_select" ON statements;
CREATE POLICY "statements_select" ON statements
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "statements_write" ON statements;
CREATE POLICY "statements_write" ON statements
  FOR ALL TO authenticated
  USING (is_super_user())
  WITH CHECK (is_super_user());

-- ============================================================
-- 7. reconciliation_results — BU 可 update (match invoice)
-- ============================================================
ALTER TABLE reconciliation_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "recon_results_select" ON reconciliation_results;
CREATE POLICY "recon_results_select" ON reconciliation_results
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "recon_results_write" ON reconciliation_results;
CREATE POLICY "recon_results_write" ON reconciliation_results
  FOR ALL TO authenticated
  USING (
    is_super_user()
    OR (
      invoice_id IS NULL
      OR EXISTS (
        SELECT 1 FROM meta_invoices mi
        WHERE mi.id = reconciliation_results.invoice_id
          AND (user_can_see_entity(mi.charge_to_entity) OR mi.charge_to_entity IS NULL)
      )
    )
  )
  WITH CHECK (
    is_super_user()
    OR (
      invoice_id IS NULL
      OR EXISTS (
        SELECT 1 FROM meta_invoices mi
        WHERE mi.id = reconciliation_results.invoice_id
          AND (user_can_see_entity(mi.charge_to_entity) OR mi.charge_to_entity IS NULL)
      )
    )
  );

-- ============================================================
-- 8. accounting_lines — 跟 invoice scope
-- ============================================================
ALTER TABLE accounting_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "accounting_lines_all" ON accounting_lines;
CREATE POLICY "accounting_lines_all" ON accounting_lines
  FOR ALL TO authenticated
  USING (
    is_super_user()
    OR ns_entity_code IS NULL
    OR user_can_see_entity(ns_entity_code)
  )
  WITH CHECK (
    is_super_user()
    OR ns_entity_code IS NULL
    OR user_can_see_entity(ns_entity_code)
  );

-- ============================================================
-- 9. Seed users — 預設 14 個 account
-- ============================================================
-- 注意：auth.users 由 Supabase Auth 處理。呢度只係 prepare profiles。
-- 用戶第一次 login (magic link / password) 時，會自動 trigger insert (見下面 trigger)。

-- Trigger：auth.users 新增時自動 create user_profiles（如果 email 喺 seed list）
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_scope TEXT[];
BEGIN
  -- 預設 mapping
  CASE NEW.email
    WHEN 'alex@sshk.ltd'       THEN v_role := 'owner';   v_scope := '{}';
    WHEN 'nok@sshk.ltd'        THEN v_role := 'owner';   v_scope := '{}';
    WHEN 'rex@pbhk.info'       THEN v_role := 'owner';   v_scope := '{}';
    WHEN 'kenneth@clsgarage.com' THEN v_role := 'owner'; v_scope := '{}';
    WHEN 'yannese.lo@pbhk.info' THEN v_role := 'admin';  v_scope := '{}';
    WHEN 'susanna.lam@photoblog.hk' THEN v_role := 'admin'; v_scope := '{}';
    WHEN 'kitman.choi@clsgarage.com' THEN v_role := 'bu_user'; v_scope := ARRAY['CLS'];
    WHEN 'mabel.tan@clsgarage.com'   THEN v_role := 'bu_user'; v_scope := ARRAY['CLS'];
    WHEN 'maggie.kwan@pbhk.info'     THEN v_role := 'bu_user'; v_scope := ARRAY['PBHK','704'];
    WHEN 'fornia.lung@sshk.ltd'      THEN v_role := 'bu_user'; v_scope := ARRAY['SSHK'];
    WHEN 'to.fok@sshk.ltd'           THEN v_role := 'bu_user'; v_scope := ARRAY['SSHK'];
    WHEN 'alex.lee@jervoism.com'     THEN v_role := 'bu_user'; v_scope := ARRAY['JM'];
    WHEN 'tracy.tsang@jervoism.com'  THEN v_role := 'bu_user'; v_scope := ARRAY['JM'];
    ELSE v_role := 'bu_user'; v_scope := '{}';  -- 新 user 預設 BU 無 scope (待 admin 分配)
  END CASE;

  INSERT INTO public.user_profiles (user_id, email, role, entity_scope)
  VALUES (NEW.id, NEW.email, v_role, v_scope)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- 10. 為已存在嘅 auth.users 補 profile (如果有 user 已經 login 過)
-- ============================================================
INSERT INTO user_profiles (user_id, email, role, entity_scope)
SELECT
  u.id,
  u.email,
  CASE u.email
    WHEN 'alex@sshk.ltd'        THEN 'owner'
    WHEN 'nok@sshk.ltd'         THEN 'owner'
    WHEN 'rex@pbhk.info'        THEN 'owner'
    WHEN 'kenneth@clsgarage.com' THEN 'owner'
    WHEN 'yannese.lo@pbhk.info'  THEN 'admin'
    WHEN 'susanna.lam@photoblog.hk' THEN 'admin'
    ELSE 'bu_user'
  END AS role,
  CASE u.email
    WHEN 'kitman.choi@clsgarage.com' THEN ARRAY['CLS']
    WHEN 'mabel.tan@clsgarage.com'   THEN ARRAY['CLS']
    WHEN 'maggie.kwan@pbhk.info'     THEN ARRAY['PBHK','704']
    WHEN 'fornia.lung@sshk.ltd'      THEN ARRAY['SSHK']
    WHEN 'to.fok@sshk.ltd'           THEN ARRAY['SSHK']
    WHEN 'alex.lee@jervoism.com'     THEN ARRAY['JM']
    WHEN 'tracy.tsang@jervoism.com'  THEN ARRAY['JM']
    ELSE '{}'::TEXT[]
  END AS entity_scope
FROM auth.users u
ON CONFLICT (user_id) DO UPDATE
  SET role = EXCLUDED.role,
      entity_scope = EXCLUDED.entity_scope,
      email = EXCLUDED.email,
      updated_at = NOW();

-- Verify
SELECT email, role, entity_scope FROM user_profiles ORDER BY role, email;
