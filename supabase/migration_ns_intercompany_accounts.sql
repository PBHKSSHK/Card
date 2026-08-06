-- ============================================================
-- Migration: ns_intercompany_accounts
-- Purpose: Store NetSuite intercompany AR/AP mapping for PBHK paying on behalf
-- Source: Google Sheet "entities" tab (Helmet King CardRecon)
-- ============================================================

-- 1) Table
CREATE TABLE IF NOT EXISTS public.ns_intercompany_accounts (
  id BIGSERIAL PRIMARY KEY,
  entity_code TEXT NOT NULL UNIQUE,           -- 704, CLS, JM, SSHK, GoAsia, JS, PBHK
  entity_name TEXT NOT NULL,
  -- IC Receivable side: in PBHK ledger (PBHK 應收子公司)
  ar_account_code TEXT,                       -- e.g. 25000025
  ar_account_name TEXT,                       -- e.g. Amount Due From 704 Production (To PB)
  ar_customer_code TEXT,                      -- e.g. C10000321
  pbhk_subsidiary_path TEXT,                  -- e.g. Photoblog.hk Limited
  -- IC Payable side: in subsidiary ledger (子公司 應付 PBHK) - NULL if no payable side
  ap_account_code TEXT,                       -- e.g. 35002023
  ap_account_name TEXT,                       -- e.g. Amt Due To Photoblog (from 704)
  ap_vendor_code TEXT,                        -- e.g. V10000662
  sub_subsidiary_path TEXT,                   -- e.g. Photoblog.hk Limited : 704 Production Limited
  -- Pattern flag
  has_payable_side BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ic_accounts_entity ON public.ns_intercompany_accounts(entity_code);

-- 2) RLS
ALTER TABLE public.ns_intercompany_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ic_accounts_read_all" ON public.ns_intercompany_accounts;
CREATE POLICY "ic_accounts_read_all" ON public.ns_intercompany_accounts
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "ic_accounts_write_admin" ON public.ns_intercompany_accounts;
CREATE POLICY "ic_accounts_write_admin" ON public.ns_intercompany_accounts
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role IN ('owner','admin'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role IN ('owner','admin'))
  );

-- 3) Seed data (from Google Sheet entities tab)

-- PBHK self (no IC mapping needed, but record for completeness)
INSERT INTO public.ns_intercompany_accounts
  (entity_code, entity_name, pbhk_subsidiary_path, has_payable_side, notes)
VALUES
  ('PBHK', 'Photoblog.hk Limited', 'Photoblog.hk Limited', FALSE,
   'Cardholder entity. No IC needed for own expenses.')
ON CONFLICT (entity_code) DO UPDATE SET
  entity_name = EXCLUDED.entity_name,
  pbhk_subsidiary_path = EXCLUDED.pbhk_subsidiary_path,
  has_payable_side = EXCLUDED.has_payable_side,
  notes = EXCLUDED.notes,
  updated_at = NOW();

-- 704 Production (full IC: both AR and AP sides)
INSERT INTO public.ns_intercompany_accounts
  (entity_code, entity_name,
   ar_account_code, ar_account_name, ar_customer_code, pbhk_subsidiary_path,
   ap_account_code, ap_account_name, ap_vendor_code, sub_subsidiary_path,
   has_payable_side)
VALUES
  ('704', '704 Production Limited',
   '25000025', 'Amount Due From 704 Production (To PB)', 'C10000321', 'Photoblog.hk Limited',
   '35002023', 'Amt Due To Photoblog (from 704)', 'V10000662', 'Photoblog.hk Limited : 704 Production Limited',
   TRUE)
ON CONFLICT (entity_code) DO UPDATE SET
  entity_name = EXCLUDED.entity_name,
  ar_account_code = EXCLUDED.ar_account_code,
  ar_account_name = EXCLUDED.ar_account_name,
  ar_customer_code = EXCLUDED.ar_customer_code,
  pbhk_subsidiary_path = EXCLUDED.pbhk_subsidiary_path,
  ap_account_code = EXCLUDED.ap_account_code,
  ap_account_name = EXCLUDED.ap_account_name,
  ap_vendor_code = EXCLUDED.ap_vendor_code,
  sub_subsidiary_path = EXCLUDED.sub_subsidiary_path,
  has_payable_side = EXCLUDED.has_payable_side,
  updated_at = NOW();

-- CLS Garage
INSERT INTO public.ns_intercompany_accounts
  (entity_code, entity_name,
   ar_account_code, ar_account_name, ar_customer_code, pbhk_subsidiary_path,
   ap_account_code, ap_account_name, ap_vendor_code, sub_subsidiary_path,
   has_payable_side)
VALUES
  ('CLS', 'CLS Garage',
   '25000022', 'Amount Due From CLS Garage (To PB)', 'C10000305', 'Photoblog.hk Limited',
   '35002016', 'Amt Due To Photoblog (from CLS)', 'V10000556', 'Photoblog.hk Limited : CLS GARAGE',
   TRUE)
ON CONFLICT (entity_code) DO UPDATE SET
  entity_name = EXCLUDED.entity_name,
  ar_account_code = EXCLUDED.ar_account_code,
  ar_account_name = EXCLUDED.ar_account_name,
  ar_customer_code = EXCLUDED.ar_customer_code,
  pbhk_subsidiary_path = EXCLUDED.pbhk_subsidiary_path,
  ap_account_code = EXCLUDED.ap_account_code,
  ap_account_name = EXCLUDED.ap_account_name,
  ap_vendor_code = EXCLUDED.ap_vendor_code,
  sub_subsidiary_path = EXCLUDED.sub_subsidiary_path,
  has_payable_side = EXCLUDED.has_payable_side,
  updated_at = NOW();

-- JM (Jervois M)
INSERT INTO public.ns_intercompany_accounts
  (entity_code, entity_name,
   ar_account_code, ar_account_name, ar_customer_code, pbhk_subsidiary_path,
   ap_account_code, ap_account_name, ap_vendor_code, sub_subsidiary_path,
   has_payable_side)
VALUES
  ('JM', 'Jervois M Limited',
   '25000024', 'Amount Due From Jervois M (To PB)', 'C10000306', 'Photoblog.hk Limited',
   '35002022', 'Amt Due To Photoblog (from JM)', 'V10000615', 'Photoblog.hk Limited : Jervois M Limited',
   TRUE)
ON CONFLICT (entity_code) DO UPDATE SET
  entity_name = EXCLUDED.entity_name,
  ar_account_code = EXCLUDED.ar_account_code,
  ar_account_name = EXCLUDED.ar_account_name,
  ar_customer_code = EXCLUDED.ar_customer_code,
  pbhk_subsidiary_path = EXCLUDED.pbhk_subsidiary_path,
  ap_account_code = EXCLUDED.ap_account_code,
  ap_account_name = EXCLUDED.ap_account_name,
  ap_vendor_code = EXCLUDED.ap_vendor_code,
  sub_subsidiary_path = EXCLUDED.sub_subsidiary_path,
  has_payable_side = EXCLUDED.has_payable_side,
  updated_at = NOW();

-- SSHK (Social Strategy HK)
INSERT INTO public.ns_intercompany_accounts
  (entity_code, entity_name,
   ar_account_code, ar_account_name, ar_customer_code, pbhk_subsidiary_path,
   ap_account_code, ap_account_name, ap_vendor_code, sub_subsidiary_path,
   has_payable_side)
VALUES
  ('SSHK', 'Social Strategy Hong Kong Limited',
   '25000015', 'Amount Due From SSHK (To PB)', 'C10000190', 'Photoblog.hk Limited',
   '35002014', 'Amt Due To Photoblog (from SSHK)', 'V10000353', 'Photoblog.hk Limited : Social Strategy Hong Kong Limited',
   TRUE)
ON CONFLICT (entity_code) DO UPDATE SET
  entity_name = EXCLUDED.entity_name,
  ar_account_code = EXCLUDED.ar_account_code,
  ar_account_name = EXCLUDED.ar_account_name,
  ar_customer_code = EXCLUDED.ar_customer_code,
  pbhk_subsidiary_path = EXCLUDED.pbhk_subsidiary_path,
  ap_account_code = EXCLUDED.ap_account_code,
  ap_account_name = EXCLUDED.ap_account_name,
  ap_vendor_code = EXCLUDED.ap_vendor_code,
  sub_subsidiary_path = EXCLUDED.sub_subsidiary_path,
  has_payable_side = EXCLUDED.has_payable_side,
  updated_at = NOW();

-- GoAsia (AR only, no payable side - same subsidiary = Photoblog.hk Limited)
INSERT INTO public.ns_intercompany_accounts
  (entity_code, entity_name,
   ar_account_code, ar_account_name, ar_customer_code, pbhk_subsidiary_path,
   has_payable_side, notes)
VALUES
  ('GoAsia', 'Go Asia Plus Travel',
   '25000031', 'Amount Due From Go Asia Plus Travel (To PB)', 'C10000533', 'Photoblog.hk Limited',
   FALSE,
   'Not a separate ledger entity. PBHK ledger only - DR AR, CR CC.')
ON CONFLICT (entity_code) DO UPDATE SET
  entity_name = EXCLUDED.entity_name,
  ar_account_code = EXCLUDED.ar_account_code,
  ar_account_name = EXCLUDED.ar_account_name,
  ar_customer_code = EXCLUDED.ar_customer_code,
  pbhk_subsidiary_path = EXCLUDED.pbhk_subsidiary_path,
  has_payable_side = EXCLUDED.has_payable_side,
  notes = EXCLUDED.notes,
  updated_at = NOW();

-- JS (uses general AR 23001010, no payable side)
INSERT INTO public.ns_intercompany_accounts
  (entity_code, entity_name,
   ar_account_code, ar_account_name, ar_customer_code, pbhk_subsidiary_path,
   has_payable_side, notes)
VALUES
  ('JS', 'JS',
   '23001010', 'Accounts Receivable - General', 'C10000434', 'Photoblog.hk Limited',
   FALSE,
   'Uses general AR, not separate IC account. PBHK ledger only - DR AR, CR CC.')
ON CONFLICT (entity_code) DO UPDATE SET
  entity_name = EXCLUDED.entity_name,
  ar_account_code = EXCLUDED.ar_account_code,
  ar_account_name = EXCLUDED.ar_account_name,
  ar_customer_code = EXCLUDED.ar_customer_code,
  pbhk_subsidiary_path = EXCLUDED.pbhk_subsidiary_path,
  has_payable_side = EXCLUDED.has_payable_side,
  notes = EXCLUDED.notes,
  updated_at = NOW();

-- ============================================================
-- Verify
-- ============================================================
SELECT entity_code, entity_name, ar_account_code, ap_account_code, has_payable_side
FROM public.ns_intercompany_accounts
ORDER BY entity_code;
