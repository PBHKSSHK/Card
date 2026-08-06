-- ============================================================
-- Fix: infinite recursion in user_profiles RLS policy
-- The admin check was querying user_profiles FROM user_profiles policy = recursion
-- Solution: use auth.jwt() to check role from the JWT token instead
-- ============================================================

-- Drop the problematic policies on user_profiles
DROP POLICY IF EXISTS "users_read_own_profile" ON user_profiles;
DROP POLICY IF EXISTS "users_update_own_profile" ON user_profiles;
DROP POLICY IF EXISTS "admins_manage_profiles" ON user_profiles;

-- Recreate without self-referencing subquery
-- Users can always read their own profile
CREATE POLICY "users_read_own_profile" ON user_profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

-- Admins can read ALL profiles — use a security definer function to avoid recursion
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE POLICY "admins_read_all_profiles" ON user_profiles
  FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE POLICY "users_update_own_profile" ON user_profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "admins_manage_profiles" ON user_profiles
  FOR ALL TO authenticated
  USING (public.is_admin());

-- Also fix the same recursion issue in other tables that reference user_profiles for admin check
-- Replace inline subqueries with the is_admin() function

-- upload_batches
DROP POLICY IF EXISTS "batches_user_select" ON upload_batches;
DROP POLICY IF EXISTS "batches_user_insert" ON upload_batches;
DROP POLICY IF EXISTS "batches_user_update" ON upload_batches;
DROP POLICY IF EXISTS "batches_user_delete" ON upload_batches;

CREATE POLICY "batches_user_select" ON upload_batches
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL OR public.is_admin());

CREATE POLICY "batches_user_insert" ON upload_batches
  FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "batches_user_update" ON upload_batches
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL OR public.is_admin());

CREATE POLICY "batches_user_delete" ON upload_batches
  FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL OR public.is_admin());

-- card_transactions
DROP POLICY IF EXISTS "txn_user_select" ON card_transactions;
DROP POLICY IF EXISTS "txn_user_insert" ON card_transactions;
DROP POLICY IF EXISTS "txn_user_delete" ON card_transactions;

CREATE POLICY "txn_user_select" ON card_transactions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL OR public.is_admin());

CREATE POLICY "txn_user_insert" ON card_transactions
  FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "txn_user_delete" ON card_transactions
  FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL OR public.is_admin());

-- meta_invoices
DROP POLICY IF EXISTS "inv_user_select" ON meta_invoices;
DROP POLICY IF EXISTS "inv_user_insert" ON meta_invoices;
DROP POLICY IF EXISTS "inv_user_delete" ON meta_invoices;

CREATE POLICY "inv_user_select" ON meta_invoices
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL OR public.is_admin());

CREATE POLICY "inv_user_insert" ON meta_invoices
  FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "inv_user_delete" ON meta_invoices
  FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL OR public.is_admin());

-- ============================================================
-- Done! The is_admin() function uses SECURITY DEFINER to bypass
-- RLS when checking the user's role, breaking the recursion.
-- ============================================================
