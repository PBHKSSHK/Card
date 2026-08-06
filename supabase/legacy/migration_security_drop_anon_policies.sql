-- migration_security_drop_anon_policies.sql
-- SECURITY FIX (2026-06): remove the "transition period" anon backdoor.
--
-- 02_migration_auth_notes_storage.sql and 06_netsuite_reference_data.sql created
-- FOR ALL TO anon USING (true) policies on every business table. Because RLS
-- policies are permissive (OR'd), anyone holding the public anon key — which is
-- shipped inside the client JS bundle — could read/write/delete all card
-- transactions, invoices, accounting lines and NetSuite reference data without
-- logging in. Those CREATE POLICY lines have been deleted from the old scripts;
-- this migration removes the policies from the live database.
--
-- Safe to re-run (idempotent).

DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname, roles
    FROM pg_policies
    WHERE schemaname = 'public'
      AND 'anon' = ANY (roles)
  LOOP
    IF pol.roles = ARRAY['anon']::name[] THEN
      EXECUTE format('DROP POLICY %I ON %I.%I',
                     pol.policyname, pol.schemaname, pol.tablename);
      RAISE NOTICE 'Dropped anon policy % on %.%',
                   pol.policyname, pol.schemaname, pol.tablename;
    ELSE
      -- Policy grants to anon AND other roles — don't drop blindly,
      -- flag it for manual review instead.
      RAISE WARNING 'Policy % on %.% grants to anon alongside other roles (%) — review manually',
                    pol.policyname, pol.schemaname, pol.tablename, pol.roles;
    END IF;
  END LOOP;
END $$;

-- Belt and braces: anon should keep no direct table privileges either.
-- (With RLS enabled and no anon policies this is already inert, but it makes
-- the intent explicit and protects tables created with RLS disabled.)
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;

-- Verify: should return 0 rows.
SELECT schemaname, tablename, policyname, roles
FROM pg_policies
WHERE schemaname = 'public' AND 'anon' = ANY (roles);
