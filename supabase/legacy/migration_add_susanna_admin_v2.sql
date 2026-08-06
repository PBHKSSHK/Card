-- migration_add_susanna_admin_v2.sql
-- 修復：原本 migration_add_susanna_admin.sql 失敗，因為 user_profiles 表
--      可能仍係舊 schema (用 'id' 而非 'user_id', 仲有 display_name/is_active)。
--
-- 呢個 migration 會：
--   1) 檢測 user_profiles 嘅 schema，自動 rename id → user_id, 加 entity_scope, role 升級
--   2) 將舊 admin/user role 轉做 owner/admin/bu_user
--   3) 加 Susanna 做 admin
--
-- 安全：所有 ALTER 都用 IF NOT EXISTS / IF EXISTS，可以重複 run

-- ============================================================
-- Step 1: schema migration (舊 user_profiles → 新 schema)
-- ============================================================
DO $$
BEGIN
  -- 如果有 id column 但冇 user_id，rename
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_profiles' AND column_name = 'id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_profiles' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE user_profiles RENAME COLUMN id TO user_id;
  END IF;
END $$;

-- 加新 columns (idempotent)
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS entity_scope TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS full_name TEXT;

-- 如果有舊 display_name column，copy 入 full_name
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_profiles' AND column_name = 'display_name'
  ) THEN
    UPDATE user_profiles SET full_name = display_name WHERE full_name IS NULL;
  END IF;
END $$;

-- ============================================================
-- Step 2: role enum 升級 — 舊 'admin'/'user' → 新 'owner'/'admin'/'bu_user'
-- ============================================================

-- 移除舊 CHECK constraint (如果有)
DO $$
DECLARE
  v_constraint TEXT;
BEGIN
  FOR v_constraint IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'user_profiles'::regclass AND contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE user_profiles DROP CONSTRAINT %I', v_constraint);
  END LOOP;
END $$;

-- 將舊 role 值升級
UPDATE user_profiles SET role = 'owner' WHERE email IN (
  'alex@sshk.ltd', 'nok@sshk.ltd', 'rex@pbhk.info', 'kenneth@clsgarage.com'
);

UPDATE user_profiles SET role = 'admin' WHERE email IN (
  'yannese.lo@pbhk.info', 'susanna.lam@photoblog.hk'
);

UPDATE user_profiles SET role = 'bu_user', entity_scope = ARRAY['CLS']
  WHERE email IN ('kitman.choi@clsgarage.com', 'mabel.tan@clsgarage.com');
UPDATE user_profiles SET role = 'bu_user', entity_scope = ARRAY['PBHK','704']
  WHERE email = 'maggie.kwan@pbhk.info';
UPDATE user_profiles SET role = 'bu_user', entity_scope = ARRAY['SSHK']
  WHERE email IN ('fornia.lung@sshk.ltd', 'to.fok@sshk.ltd');
UPDATE user_profiles SET role = 'bu_user', entity_scope = ARRAY['JM']
  WHERE email IN ('alex.lee@jervoism.com', 'tracy.tsang@jervoism.com');

-- 任何剩餘嘅舊 'user' role 改成 bu_user (default scope = empty)
UPDATE user_profiles SET role = 'bu_user' WHERE role = 'user';

-- 加返新 CHECK constraint
ALTER TABLE user_profiles
  ADD CONSTRAINT user_profiles_role_check
  CHECK (role IN ('owner', 'admin', 'bu_user'));

-- ============================================================
-- Step 3: 確保 user_id 有 FK 同 PK
-- ============================================================
DO $$
BEGIN
  -- 如果 user_id 未係 PRIMARY KEY，加
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'user_profiles' AND constraint_type = 'PRIMARY KEY'
  ) THEN
    ALTER TABLE user_profiles ADD PRIMARY KEY (user_id);
  END IF;
END $$;

-- ============================================================
-- Step 4: 確保 trigger 同 helper functions 正確
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_scope TEXT[];
BEGIN
  CASE NEW.email
    WHEN 'alex@sshk.ltd'              THEN v_role := 'owner';   v_scope := '{}';
    WHEN 'nok@sshk.ltd'               THEN v_role := 'owner';   v_scope := '{}';
    WHEN 'rex@pbhk.info'              THEN v_role := 'owner';   v_scope := '{}';
    WHEN 'kenneth@clsgarage.com'      THEN v_role := 'owner';   v_scope := '{}';
    WHEN 'yannese.lo@pbhk.info'       THEN v_role := 'admin';   v_scope := '{}';
    WHEN 'susanna.lam@photoblog.hk'   THEN v_role := 'admin';   v_scope := '{}';
    WHEN 'kitman.choi@clsgarage.com'  THEN v_role := 'bu_user'; v_scope := ARRAY['CLS'];
    WHEN 'mabel.tan@clsgarage.com'    THEN v_role := 'bu_user'; v_scope := ARRAY['CLS'];
    WHEN 'maggie.kwan@pbhk.info'      THEN v_role := 'bu_user'; v_scope := ARRAY['PBHK','704'];
    WHEN 'fornia.lung@sshk.ltd'       THEN v_role := 'bu_user'; v_scope := ARRAY['SSHK'];
    WHEN 'to.fok@sshk.ltd'            THEN v_role := 'bu_user'; v_scope := ARRAY['SSHK'];
    WHEN 'alex.lee@jervoism.com'      THEN v_role := 'bu_user'; v_scope := ARRAY['JM'];
    WHEN 'tracy.tsang@jervoism.com'   THEN v_role := 'bu_user'; v_scope := ARRAY['JM'];
    ELSE v_role := 'bu_user'; v_scope := '{}';
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
-- Step 5: backfill 已存在嘅 auth.users (例如 Susanna 已 sign up 過)
-- ============================================================
INSERT INTO user_profiles (user_id, email, role, entity_scope)
SELECT
  u.id,
  u.email,
  CASE u.email
    WHEN 'alex@sshk.ltd'              THEN 'owner'
    WHEN 'nok@sshk.ltd'               THEN 'owner'
    WHEN 'rex@pbhk.info'              THEN 'owner'
    WHEN 'kenneth@clsgarage.com'      THEN 'owner'
    WHEN 'yannese.lo@pbhk.info'       THEN 'admin'
    WHEN 'susanna.lam@photoblog.hk'   THEN 'admin'
    ELSE 'bu_user'
  END AS role,
  CASE u.email
    WHEN 'kitman.choi@clsgarage.com'  THEN ARRAY['CLS']
    WHEN 'mabel.tan@clsgarage.com'    THEN ARRAY['CLS']
    WHEN 'maggie.kwan@pbhk.info'      THEN ARRAY['PBHK','704']
    WHEN 'fornia.lung@sshk.ltd'       THEN ARRAY['SSHK']
    WHEN 'to.fok@sshk.ltd'            THEN ARRAY['SSHK']
    WHEN 'alex.lee@jervoism.com'      THEN ARRAY['JM']
    WHEN 'tracy.tsang@jervoism.com'   THEN ARRAY['JM']
    ELSE '{}'::TEXT[]
  END AS entity_scope
FROM auth.users u
ON CONFLICT (user_id) DO UPDATE
  SET role = EXCLUDED.role,
      entity_scope = EXCLUDED.entity_scope,
      email = EXCLUDED.email,
      updated_at = NOW();

-- ============================================================
-- Verify
-- ============================================================
SELECT email, role, entity_scope, full_name
FROM user_profiles
ORDER BY
  CASE role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,
  email;
