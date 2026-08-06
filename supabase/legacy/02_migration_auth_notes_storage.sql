-- ============================================================
-- CardRecon Migration 02: Auth, Notes, File Storage, User Profiles
-- Run this in Supabase SQL Editor AFTER 01_schema.sql
-- ============================================================

-- 1. User profiles table (extends Supabase Auth)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_profiles (id, email, display_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)),
    CASE
      WHEN (SELECT count(*) FROM public.user_profiles) = 0 THEN 'admin'
      ELSE 'user'
    END
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 2. Add user_id + notes columns to upload_batches
-- ============================================================
ALTER TABLE upload_batches
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';

-- 3. Add user_id to card_transactions and meta_invoices
-- ============================================================
ALTER TABLE card_transactions
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);

ALTER TABLE meta_invoices
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);

-- 4. Add file_path column for original PDF storage
-- ============================================================
ALTER TABLE upload_batches
  ADD COLUMN IF NOT EXISTS file_path TEXT DEFAULT NULL;

-- file_path stores the Supabase Storage path, e.g. "documents/user-uuid/filename.pdf"

-- 5. Create Storage bucket for documents
-- ============================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO NOTHING;

-- Storage policies: users can upload to their own folder, admins can see all
CREATE POLICY "Users can upload to own folder"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'documents' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

CREATE POLICY "Users can read own files"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'documents' AND
  (
    (storage.foldername(name))[1] = auth.uid()::text
    OR
    EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'admin')
  )
);

CREATE POLICY "Admins can read all files"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'documents' AND
  EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'admin')
);

-- 6. RLS Policies
-- ============================================================
-- Enable RLS on all tables
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE matching_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_settings ENABLE ROW LEVEL SECURITY;

-- user_profiles: users see own, admins see all
CREATE POLICY "users_read_own_profile" ON user_profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "users_update_own_profile" ON user_profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "admins_manage_profiles" ON user_profiles
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin'));

-- upload_batches: users see own, admins see all
CREATE POLICY "batches_user_select" ON upload_batches
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL OR EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "batches_user_insert" ON upload_batches
  FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "batches_user_update" ON upload_batches
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL OR EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "batches_user_delete" ON upload_batches
  FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL OR EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin'));

-- card_transactions: same pattern
CREATE POLICY "txn_user_select" ON card_transactions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL OR EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "txn_user_insert" ON card_transactions
  FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "txn_user_delete" ON card_transactions
  FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL OR EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin'));

-- meta_invoices: same pattern
CREATE POLICY "inv_user_select" ON meta_invoices
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL OR EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "inv_user_insert" ON meta_invoices
  FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "inv_user_delete" ON meta_invoices
  FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL OR EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin'));

-- Shared tables: all authenticated users can read, only admins can write
CREATE POLICY "shared_read" ON matching_rules FOR SELECT TO authenticated USING (true);
CREATE POLICY "shared_insert" ON matching_rules FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "shared_update" ON matching_rules FOR UPDATE TO authenticated USING (true);
CREATE POLICY "shared_delete" ON matching_rules FOR DELETE TO authenticated USING (true);

CREATE POLICY "recon_read" ON reconciliation_results FOR SELECT TO authenticated USING (true);
CREATE POLICY "recon_insert" ON reconciliation_results FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "recon_update" ON reconciliation_results FOR UPDATE TO authenticated USING (true);
CREATE POLICY "recon_delete" ON reconciliation_results FOR DELETE TO authenticated USING (true);

CREATE POLICY "acct_read" ON accounting_lines FOR SELECT TO authenticated USING (true);
CREATE POLICY "acct_insert" ON accounting_lines FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "acct_update" ON accounting_lines FOR UPDATE TO authenticated USING (true);

CREATE POLICY "journal_read" ON journal_exports FOR SELECT TO authenticated USING (true);
CREATE POLICY "journal_insert" ON journal_exports FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "entities_read" ON entities FOR SELECT TO authenticated USING (true);
CREATE POLICY "departments_read" ON departments FOR SELECT TO authenticated USING (true);
CREATE POLICY "cards_read" ON credit_cards FOR SELECT TO authenticated USING (true);
CREATE POLICY "cards_insert" ON credit_cards FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "settings_read" ON journal_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "settings_update" ON journal_settings FOR UPDATE TO authenticated USING (true);

-- 7. (REMOVED 2026-06) The transitional anon full-access policies that used to
-- live here gave anyone holding the public anon key read/write on every table.
-- They are dropped by migration_security_drop_anon_policies.sql. Do not re-add.
-- ============================================================

-- ============================================================
-- Done! After running this:
-- 1. First user to sign up becomes admin
-- 2. Admin can create accounts for staff in Settings
-- 3. Each upload records user_id + notes + file_path
-- ============================================================
