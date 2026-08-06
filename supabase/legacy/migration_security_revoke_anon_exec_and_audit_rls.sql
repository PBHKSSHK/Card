-- migration_security_revoke_anon_exec_and_audit_rls.sql
-- SECURITY FIX (2026-06): follow-up to migration_security_drop_anon_policies.sql.
--
-- After the anon table policies/grants were removed, the Supabase security
-- advisor still flagged two things that let the public anon key reach more
-- than it should:
--
--   1. anon could EXECUTE several SECURITY DEFINER helper functions via
--      PostgREST (/rest/v1/rpc/...). These functions had EXECUTE granted to
--      anon and to PUBLIC. They are only ever needed by logged-in users
--      (they back the RLS policies) or run as triggers, so anon/PUBLIC have
--      no business calling them. We REVOKE EXECUTE from anon and PUBLIC.
--      authenticated and service_role keep their own explicit EXECUTE grants,
--      so the RLS policies that call is_admin()/is_super_user()/etc. keep
--      working and triggers (handle_new_user) are unaffected.
--
--   2. public.audit_log had RLS disabled. The table is unused (0 rows, no
--      function or trigger writes to it; the app uses claim_audit_log), so we
--      simply ENABLE ROW LEVEL SECURITY. With no policies and no anon grants,
--      it is inaccessible to anon/authenticated via the API — the secure
--      default for an audit table.
--
-- Safe to re-run (idempotent). Already applied to prod on 2026-06-13.

-- 1) Revoke anon/PUBLIC EXECUTE on the SECURITY DEFINER helper functions.
--    Loops over whatever overloads exist so it never errors on a missing one.
DO $$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN (
        'current_user_entity_scope',
        'current_user_role',
        'handle_new_user',
        'is_admin',
        'is_super_user',
        'refresh_claim_batch_line_summary',
        'user_can_see_entity'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, public', fn.sig);
    RAISE NOTICE 'Revoked anon/public EXECUTE on %', fn.sig;
  END LOOP;
END $$;

-- 2) Enable RLS on the unused audit_log table (guarded so it is a no-op if the
--    table is absent in some environment).
DO $$
BEGIN
  IF to_regclass('public.audit_log') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY';
    RAISE NOTICE 'Enabled RLS on public.audit_log';
  END IF;
END $$;

-- Verify: none of these should list anon or PUBLIC as an EXECUTE grantee.
SELECT p.oid::regprocedure::text AS func,
       (SELECT array_agg(coalesce(r.rolname, 'PUBLIC') ORDER BY 1)
          FROM aclexplode(p.proacl) a
          LEFT JOIN pg_roles r ON r.oid = a.grantee
          WHERE a.privilege_type = 'EXECUTE') AS execute_grantees
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN (
    'current_user_entity_scope', 'current_user_role', 'handle_new_user',
    'is_admin', 'is_super_user', 'refresh_claim_batch_line_summary', 'user_can_see_entity'
  )
ORDER BY 1;

-- Verify: audit_log RLS should be enabled (rls_enabled = true).
SELECT relname AS table_name, relrowsecurity AS rls_enabled
FROM pg_class
WHERE oid = 'public.audit_log'::regclass;
