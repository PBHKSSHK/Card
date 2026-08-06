-- ============================================================
-- CardRecon Migration 06: NetSuite Reference Data
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. NetSuite Chart of Accounts
CREATE TABLE IF NOT EXISTS public.ns_chart_of_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  internal_id INTEGER,
  account_number TEXT NOT NULL UNIQUE,
  account_name TEXT NOT NULL,
  full_name TEXT,  -- parent:child format e.g. "81000000 - Department Cost:81000027 - Computer"
  account_type TEXT,
  description TEXT,
  currency TEXT DEFAULT 'HKD',
  parent_number TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. NetSuite Subsidiaries
CREATE TABLE IF NOT EXISTS public.ns_subsidiaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  internal_id INTEGER UNIQUE,
  name TEXT NOT NULL UNIQUE,
  short_code TEXT,  -- PBHK, SSHK, CLS, JM, 704, GoAsia
  intercompany_ar_account TEXT,  -- "Amount Due From X (To PB)" account number
  intercompany_ap_account TEXT,  -- "Amt Due To PB (from X)" account number
  intercompany_ar_customer TEXT, -- Customer code for AR e.g. C10000190
  intercompany_ap_vendor TEXT,   -- Vendor code for AP e.g. V10000353
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. NetSuite Departments
CREATE TABLE IF NOT EXISTS public.ns_departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  internal_id INTEGER UNIQUE,
  name TEXT NOT NULL UNIQUE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. NetSuite Employees
CREATE TABLE IF NOT EXISTS public.ns_employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  internal_id INTEGER,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  subsidiary TEXT,
  department TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(code, subsidiary)
);

-- 5. NetSuite Vendors
CREATE TABLE IF NOT EXISTS public.ns_vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_intercompany BOOLEAN DEFAULT false,
  related_subsidiary TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 6. NetSuite Customers
CREATE TABLE IF NOT EXISTS public.ns_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  project_code TEXT,
  project_name TEXT,
  subsidiary TEXT,
  is_intercompany BOOLEAN DEFAULT false,
  related_subsidiary TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 7. Credit Card → NetSuite Account mapping
CREATE TABLE IF NOT EXISTS public.ns_credit_card_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_number TEXT NOT NULL UNIQUE,
  account_name TEXT NOT NULL,
  full_account_name TEXT, -- "34001000 - Business credit card:34001012 - 4150 - HSBC Credit Card (Rex) - PBHK"
  cardholder_name TEXT,
  cardholder_employee_code TEXT,
  card_identifier TEXT,  -- pattern to match from parsed card (e.g. "Rex", "Alex", "Nok", "Kenneth")
  bank TEXT,
  subsidiary TEXT DEFAULT 'Photoblog.hk Limited',
  department TEXT DEFAULT 'Management',
  currency TEXT DEFAULT 'HKD',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 8. Add intercompany fields to matching_rules
ALTER TABLE matching_rules
  ADD COLUMN IF NOT EXISTS is_intercompany BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS intercompany_account TEXT,
  ADD COLUMN IF NOT EXISTS subsidiary_name TEXT,
  ADD COLUMN IF NOT EXISTS ns_department TEXT,
  ADD COLUMN IF NOT EXISTS ns_name_field TEXT,
  ADD COLUMN IF NOT EXISTS ns_class TEXT DEFAULT '- No Class -';

-- 9. RLS: all authenticated can read, anon can read
ALTER TABLE ns_chart_of_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ns_subsidiaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ns_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ns_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE ns_vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE ns_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ns_credit_card_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ns_coa_read" ON ns_chart_of_accounts FOR SELECT TO authenticated USING (true);
CREATE POLICY "ns_coa_write" ON ns_chart_of_accounts FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "ns_sub_read" ON ns_subsidiaries FOR SELECT TO authenticated USING (true);
CREATE POLICY "ns_sub_write" ON ns_subsidiaries FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "ns_dept_read" ON ns_departments FOR SELECT TO authenticated USING (true);
CREATE POLICY "ns_dept_write" ON ns_departments FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "ns_emp_read" ON ns_employees FOR SELECT TO authenticated USING (true);
CREATE POLICY "ns_emp_write" ON ns_employees FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "ns_vend_read" ON ns_vendors FOR SELECT TO authenticated USING (true);
CREATE POLICY "ns_vend_write" ON ns_vendors FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "ns_cust_read" ON ns_customers FOR SELECT TO authenticated USING (true);
CREATE POLICY "ns_cust_write" ON ns_customers FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "ns_cc_read" ON ns_credit_card_accounts FOR SELECT TO authenticated USING (true);
CREATE POLICY "ns_cc_write" ON ns_credit_card_accounts FOR ALL TO authenticated USING (true) WITH CHECK (true);

