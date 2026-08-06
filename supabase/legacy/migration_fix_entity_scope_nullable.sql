-- migration_fix_entity_scope_nullable.sql
-- 修復：entity_scope 有 NOT NULL constraint，但 owner/admin 應該係 NULL (代表 full access)
-- 之前 migration 漏咗 drop 呢個 constraint
--
-- 跑完之後，重新 run migration_seed_users_with_passwords.sql 就會成功

-- 1) Drop NOT NULL on entity_scope (owner/admin 可以係 NULL = full access)
ALTER TABLE user_profiles
  ALTER COLUMN entity_scope DROP NOT NULL;

-- 2) 順便確保 full_name 都係 nullable (因為新 seed 唔一定有名)
ALTER TABLE user_profiles
  ALTER COLUMN full_name DROP NOT NULL;

-- 3) 同時 confirm role CHECK constraint 啱
DO $$
BEGIN
  -- Drop 舊嘅 CHECK constraint 如果存在
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname LIKE 'user_profiles_role_check%'
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE user_profiles DROP CONSTRAINT ' || conname
      FROM pg_constraint
      WHERE conname LIKE 'user_profiles_role_check%'
      LIMIT 1
    );
  END IF;
END $$;

-- 重新加 CHECK constraint
ALTER TABLE user_profiles
  ADD CONSTRAINT user_profiles_role_check
  CHECK (role IN ('owner', 'admin', 'bu_user'));

-- 驗證 schema
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name = 'user_profiles'
ORDER BY ordinal_position;
