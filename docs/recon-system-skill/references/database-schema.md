# Database Schema Reference

Complete Supabase PostgreSQL schema for a financial reconciliation system.

## Core Tables

### upload_batches
Tracks every file upload (CC statement, invoice, matching rules).

```sql
CREATE TABLE upload_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name TEXT NOT NULL,
  upload_type TEXT NOT NULL CHECK (upload_type IN ('cc_statement', 'meta_invoice', 'matching_rules', 'bank_statement', 'expense_claim')),
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'processing', 'processed', 'error', 'archived')),
  row_count INT DEFAULT 0,
  error_message TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ,
  statement_total NUMERIC(14,2),
  ai_parsed_total NUMERIC(14,2),
  bank TEXT,
  card_last4 TEXT,             -- stores cardholder name, not card digits
  statement_period TEXT,
  user_id UUID REFERENCES auth.users(id),
  notes TEXT,
  file_path TEXT,
  period_month TEXT             -- e.g. '2026-01' for grouping
);
```

### card_transactions
One row per credit card statement line.

```sql
CREATE TABLE card_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID REFERENCES upload_batches(id),
  card_id UUID,
  txn_date DATE NOT NULL,
  post_date DATE,
  merchant TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL,        -- original currency
  amount_hkd NUMERIC(14,2),             -- HKD equivalent (same as amount if HKD)
  currency TEXT DEFAULT 'HKD',
  fx_rate NUMERIC(10,6) DEFAULT 1,
  reference TEXT,
  description TEXT,
  card_last4 TEXT,                       -- cardholder name for CC account mapping
  user_id UUID REFERENCES auth.users(id),
  period_month TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### bank_transactions (for Bank Rec)
One row per bank statement line.

```sql
CREATE TABLE bank_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID REFERENCES upload_batches(id),
  txn_date DATE NOT NULL,
  value_date DATE,
  description TEXT NOT NULL,
  debit NUMERIC(14,2),
  credit NUMERIC(14,2),
  balance NUMERIC(14,2),
  reference TEXT,
  bank_account TEXT,                     -- bank account identifier
  currency TEXT DEFAULT 'HKD',
  user_id UUID REFERENCES auth.users(id),
  period_month TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### meta_invoices
Vendor invoices. Supports parent/child hierarchy.

```sql
CREATE TABLE meta_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID REFERENCES upload_batches(id),
  invoice_number TEXT NOT NULL,
  billing_period TEXT,
  amount NUMERIC(14,2) NOT NULL,
  currency TEXT DEFAULT 'HKD',
  invoice_date DATE,
  account_name TEXT,                     -- vendor/account name
  account_id TEXT,
  description TEXT,
  is_matched BOOLEAN DEFAULT false,      -- MUST sync with reconciliation_results
  user_id UUID REFERENCES auth.users(id),
  period_month TEXT,
  parent_invoice_id UUID REFERENCES meta_invoices(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### reconciliation_results
Junction table linking transactions to invoices.

```sql
CREATE TABLE reconciliation_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES card_transactions(id) ON DELETE CASCADE,
  invoice_id UUID REFERENCES meta_invoices(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('matched', 'pending', 'unmatched', 'exception', 'manual')),
  match_type TEXT CHECK (match_type IN ('exact', 'fuzzy', 'near_date', 'split', 'manual')),
  confidence INT,
  matched_at TIMESTAMPTZ,
  matched_by TEXT,                       -- 'engine' or 'manual'
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### matching_rules
Keyword → account code mapping for auto-classification.

```sql
CREATE TABLE matching_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID REFERENCES upload_batches(id),
  keyword TEXT NOT NULL,                 -- merchant pattern to match
  account_name TEXT,
  dr_account_code TEXT,
  cr_account_code TEXT,
  target_entity TEXT,                    -- entity/company code
  dept_code TEXT,
  customer TEXT,
  vendor TEXT,
  netsuite_account TEXT,                 -- NS-specific
  project_code TEXT,
  notes TEXT,
  priority INT DEFAULT 100,
  is_active BOOLEAN DEFAULT true,
  -- NetSuite-specific intercompany fields
  is_intercompany BOOLEAN DEFAULT false,
  intercompany_account TEXT,
  subsidiary_name TEXT,
  ns_department TEXT,
  ns_name_field TEXT,
  ns_class TEXT,
  -- D365 BC-specific fields (add as needed)
  bc_dimension_1 TEXT,                   -- Global Dimension 1 (e.g. Department)
  bc_dimension_2 TEXT,                   -- Global Dimension 2 (e.g. Project)
  bc_bal_account_type TEXT,
  bc_bal_account_no TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### journal_settings
System-wide reconciliation parameters.

```sql
CREATE TABLE journal_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cr_account TEXT DEFAULT '2100',
  default_currency TEXT DEFAULT 'HKD',
  date_tolerance_days INT DEFAULT 5,
  fuzzy_threshold NUMERIC(3,2) DEFAULT 0.60,
  amount_tolerance_pct NUMERIC(5,2) DEFAULT 5.00,
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

## ERP Reference Tables

### NetSuite (ns_*) — see CardRecon implementation
- `ns_chart_of_accounts` — account_number, account_name, account_type
- `ns_subsidiaries` — name, short_code, intercompany AR/AP accounts
- `ns_departments` — internal_id, name
- `ns_employees` — code, name, email, subsidiary, department
- `ns_vendors` — code, name, is_intercompany, related_subsidiary
- `ns_customers` — code, name, is_intercompany, related_subsidiary
- `ns_credit_card_accounts` — account_number, cardholder_name, card_identifier, bank

### D365 Business Central (bc_*)
Pull these via the BC connector API:

```sql
-- Chart of Accounts from BC
CREATE TABLE bc_gl_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  no TEXT UNIQUE NOT NULL,               -- Account No.
  name TEXT NOT NULL,
  account_type TEXT,                     -- Posting, Heading, Total, etc.
  account_category TEXT,
  account_subcategory TEXT,
  debit_credit TEXT,
  direct_posting BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Bank Accounts from BC
CREATE TABLE bc_bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  no TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  bank_account_no TEXT,
  currency_code TEXT,
  balance NUMERIC(14,2),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Vendors from BC
CREATE TABLE bc_vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  no TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  balance NUMERIC(14,2),
  currency_code TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Employees from BC (for expense claims)
CREATE TABLE bc_employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  no TEXT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  department TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Dimensions from BC (replaces NS subsidiary/department)
CREATE TABLE bc_dimensions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  dimension_type TEXT,                   -- Department, Project, Costcenter, etc.
  created_at TIMESTAMPTZ DEFAULT now()
);
```

## Views

### v_transactions_full
Flattened view joining transactions with recon results and invoices.

```sql
CREATE VIEW v_transactions_full AS
SELECT
  ct.id AS transaction_id,
  ct.txn_date, ct.post_date, ct.merchant,
  ct.amount, ct.amount_hkd, ct.currency, ct.fx_rate,
  ct.reference, ct.description, ct.card_last4,
  rr.status AS match_status,
  rr.match_type, rr.confidence, rr.matched_at,
  rr.notes AS match_notes,
  mi.invoice_number, mi.billing_period, mi.amount AS invoice_amount,
  ub.file_name AS source_file,
  ct.batch_id, ct.created_at
FROM card_transactions ct
LEFT JOIN reconciliation_results rr ON rr.transaction_id = ct.id
LEFT JOIN meta_invoices mi ON rr.invoice_id = mi.id
LEFT JOIN upload_batches ub ON ct.batch_id = ub.id;
```

## Row Level Security

Enable RLS on all tables. Key pattern:

```sql
ALTER TABLE card_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own data" ON card_transactions
  FOR ALL USING (
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin')
  );
```

**Critical**: Avoid recursive RLS by NOT referencing RLS-enabled tables in other tables' policies.
Use a function to check admin status:

```sql
CREATE OR REPLACE FUNCTION is_admin() RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;
```

Then use `is_admin()` in policies instead of subqueries against user_profiles.
