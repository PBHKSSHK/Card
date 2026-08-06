-- migration_add_susanna_admin.sql
-- 目的：加 susanna.lam@photoblog.hk 做 admin
-- 1) 更新 trigger handle_new_user() 喺 seed list 加埋佢
-- 2) 如果佢已經 login 過，backfill profile

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

-- 如果 Susanna 已經 login 過：backfill / 升級為 admin
INSERT INTO user_profiles (user_id, email, role, entity_scope)
SELECT u.id, u.email, 'admin', '{}'::TEXT[]
FROM auth.users u
WHERE u.email = 'susanna.lam@photoblog.hk'
ON CONFLICT (user_id) DO UPDATE
  SET role = 'admin',
      entity_scope = '{}'::TEXT[],
      email = EXCLUDED.email,
      updated_at = NOW();

-- Verify
SELECT email, role, entity_scope FROM user_profiles
WHERE email IN ('yannese.lo@pbhk.info', 'susanna.lam@photoblog.hk')
ORDER BY email;
