-- migration_accounting_lines_delete_policy.sql
-- ---------------------------------------------------------------------------
-- FIX: accounting_lines could be INSERTed but not DELETEd by the app's role.
--
-- 02_migration_auth_notes_storage.sql created acct_read (SELECT), acct_insert
-- (INSERT, WITH CHECK true) and acct_update (UPDATE) for `authenticated`, but NO
-- DELETE policy. migration_user_roles.sql's "accounting_lines_all" (FOR ALL) is
-- entity-scoped (user_can_see_entity), so a user who can INSERT a line (insert is
-- unconditionally allowed) may still be unable to DELETE it.
--
-- With RLS enabled, a DELETE that matches no permitted rows affects 0 rows and
-- returns NO error. AssignModal / SplitModal replace a transaction's lines via
-- delete-then-insert; the delete silently no-op'd and the insert stacked a
-- duplicate, so accounting_lines ACCUMULATED. One HK$5,200 charge ended up with
-- 6 lines (HK$15,600), doubling the debit and unbalancing that company's journal.
--
-- Add a DELETE policy as permissive as the existing INSERT/UPDATE so the
-- delete-then-insert replace actually works. (SELECT/INSERT/UPDATE are already
-- `USING/​WITH CHECK true` for authenticated, so this does not widen exposure
-- beyond what already exists.)
-- ---------------------------------------------------------------------------

ALTER TABLE public.accounting_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "acct_delete" ON public.accounting_lines;
CREATE POLICY "acct_delete" ON public.accounting_lines
  FOR DELETE TO authenticated
  USING (true);

-- Verify (run after): should list acct_delete among the policies.
-- SELECT policyname, cmd FROM pg_policies WHERE tablename = 'accounting_lines' ORDER BY cmd;
