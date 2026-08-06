---
name: recon-system
description: >-
  Build a financial reconciliation web application (credit card reconciliation, bank reconciliation,
  expense claim processing). Triggered when user says "build recon system", "對帳系統", "reconciliation app",
  "bank rec", "credit card matching", "expense claim system". Generates a React + Supabase + Vercel
  full-stack app with PDF/image OCR parsing, AI-powered transaction matching, ERP journal export,
  and reference data management. Supports NetSuite and D365 Business Central as ERP targets.
metadata:
  author: alex-lo
  version: '2.0'
---

# Financial Reconciliation System Builder

Build production-grade financial reconciliation web applications. This skill provides the complete
architecture, database schema, matching engine, and OCR pipeline for:

- **Credit Card Reconciliation** — Match CC statement transactions against vendor invoices
- **Bank Reconciliation** — Match bank statement entries against GL entries in ERP
- **Expense Claim Processing** — Parse employee receipts, match against claims, generate journal entries

## When to Use This Skill

Use when the user asks to:
- Build a credit card or bank reconciliation system
- Create an expense claim / reimbursement workflow
- Match financial transactions against invoices or GL entries
- Generate ERP journal entries (NetSuite CSV / D365 BC General Journal)
- Parse PDF bank/CC statements via OCR

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (React + Tailwind + shadcn/ui)                │
│  ├── Dashboard — KPIs, unmatched lists, drill-down      │
│  ├── Upload Centre — PDF/image upload → AI parse        │
│  ├── Recon Queue — Run matching, review results         │
│  ├── Journal Export — Generate ERP-format CSV/journal    │
│  ├── Settings — Matching rules, reference data, API     │
│  └── Exceptions — Manual resolution of edge cases       │
├─────────────────────────────────────────────────────────┤
│  Supabase (PostgreSQL + Auth + Storage + Edge Fn)       │
│  ├── Tables: transactions, invoices, recon_results      │
│  ├── Reference: chart_of_accounts, subsidiaries, etc.   │
│  ├── Edge Function: PDF → AI OCR → structured JSON      │
│  └── RLS: user-scoped data access                       │
├─────────────────────────────────────────────────────────┤
│  External                                               │
│  ├── OpenRouter API (Claude Sonnet) for OCR             │
│  ├── ERP (NetSuite / D365 BC) for reference data        │
│  └── Vercel for hosting                                 │
└─────────────────────────────────────────────────────────┘
```

## Instructions

### Step 1: Gather Requirements

Before building, clarify with the user:

1. **Reconciliation type(s)**: Credit card, bank, expense claims, or combination?
2. **ERP target**: NetSuite, D365 Business Central, Xero, or custom?
3. **Input documents**: PDF statements (OCR needed), CSV/Excel exports, or API feeds?
4. **Multi-entity?**: Single company or multi-subsidiary with intercompany transactions?
5. **Currency**: Single currency (HKD) or multi-currency with FX conversion?
6. **Bank(s)**: Which banks? HSBC, AE, Standard Chartered? (affects PDF parsing prompts)

### Step 2: Database Schema

Read `references/database-schema.md` for the complete Supabase schema. Key design decisions:

- **`card_transactions`** — One row per CC statement line. Stores original currency + HKD equivalent.
- **`meta_invoices`** — Vendor invoices (e.g. Meta Ads, Google Ads). Supports parent/child hierarchy — ONE parent line item per invoice for matching, expandable children for detail.
- **`reconciliation_results`** — Junction table: transaction → invoice. Stores match status, type, confidence.
- **`matching_rules`** — Keyword → account mapping. Used by the matching engine to auto-classify merchants.
- **`ns_*` / `bc_*` reference tables** — Chart of accounts, subsidiaries, departments, employees, vendors, customers, credit card accounts. Imported from ERP.

**Critical design principles:**
- `is_matched` on invoices MUST be updated whenever reconciliation_results changes to `matched`
- Parent/child invoices: parent stores aggregate amount for matching, children store line-item detail
- `card_last4` field stores **cardholder name** (not last 4 digits) — maps to credit card account

### Step 3: Edge Function (OCR Pipeline)

Read `references/ocr-pipeline.md` for the Edge Function code. Key design:

- Accepts PDF/image uploads via Supabase Storage
- Converts to base64, sends to OpenRouter (Claude Sonnet) with structured prompt
- Returns JSON array of parsed transactions
- Supports CC statements AND vendor invoices with different prompts
- **FX handling**: Prompt explicitly asks for `amount_hkd`, `fx_rate`, `currency` per transaction

### Step 4: Matching Engine

Read `references/matching-engine.md` for the client-side matching algorithm:

1. **Exact match** — amount + currency + date identical
2. **Near date** — amount + currency match, date within tolerance (default 5 days)
3. **Fuzzy match** — Levenshtein similarity on merchant name + amount within tolerance %
4. **Rule match** — Merchant keyword pattern matches a matching_rule (no invoice needed)
5. **Unmatched** — Falls through all stages

**Settings** (configurable):
- `date_tolerance_days`: 5
- `fuzzy_threshold`: 0.6
- `amount_tolerance_pct`: 5

### Step 5: Journal Export

The export generates ERP-format CSV/journals from matched transactions:

**NetSuite format**: `Entry No., Date, Account, Currency, Debit, Credit, Line: Memo, Subsidiary, Department, Name`

**D365 BC format**: `Journal Template Name, Journal Batch Name, Line No., Posting Date, Document Type, Document No., Account Type, Account No., Description, Amount, Bal. Account Type, Bal. Account No.`

Journal entry logic per credit card:
- 1 CR line (credit card liability account, total amount)
- N DR lines (one per transaction, expense/intercompany account from matching rules)

### Step 6: Frontend Pages

Read `references/frontend-pages.md` for component specifications. Pages:

| Page | Purpose | Key Features |
|------|---------|-------------|
| Dashboard | Overview KPIs | 4 stat cards, unmatched CC/Invoice split lists with drill-down |
| Upload Centre | PDF → parse → store | Drag-drop, AI progress, batch management, period selector |
| Recon Queue | Run matching engine | Auto-classify button, status filters, click-to-expand matched pair |
| Journal Export | Generate ERP CSV | Period filter, card-grouped preview, DR/CR balance check, CSV export |
| Settings | Config management | Matching rules, journal settings, reference data tabs, API keys |
| Exceptions | Manual fixes | Override match, reassign, split transactions |

### Step 7: Deploy

1. Build: `npm run build`
2. Git push: `git add -A && git commit && git push`
3. Vercel deploy: `npx vercel --prod --yes`

## Adapting for Different ERPs

### NetSuite
- Reference tables prefixed `ns_*`
- Journal CSV format with Entry No., Subsidiary, Department, Name columns
- Intercompany: AR/AP accounts + customer/vendor codes per subsidiary

### D365 Business Central
- Reference tables prefixed `bc_*`
- Use BC connector to read: Chart of Accounts, G/L Entries, Bank Account Ledger Entries, Vendors, Customers, Dimensions
- General Journal format with Journal Template, Batch, Line No., Posting Date
- Bank Rec: match bank statement lines against Bank Account Ledger Entries
- Expense Claims: parse receipts → match against posted Purchase Invoices or Employee Ledger Entries
- Dimensions replace NetSuite's subsidiary/department model

### Adding Bank Reconciliation

Bank rec follows the same pattern but with different source/target:
- **Source**: Bank statement PDF (parsed via OCR) or CSV export
- **Target**: GL bank account entries from ERP (via API or manual export)
- **Matching**: Amount + date + reference number (check numbers, wire references)
- **Output**: Matched pairs + outstanding items list

### Adding Expense Claims

Expense claim workflow:
- **Source**: Employee-submitted receipts (PDF/photo)
- **Target**: Approved expense claims in ERP
- **Matching**: Employee + amount + date + category
- **Output**: Journal entries crediting employee payable, debiting expense accounts

## Key Lessons from CardRecon v1

1. **Always sync `is_matched`** — When reconciliation_results.status = 'matched', IMMEDIATELY update the corresponding invoice's `is_matched = true`. Do NOT gate this behind entity/department resolution.

2. **Parent/child invoices** — "大數一條用來matching，但按下去可以看細entries" — One big number for matching, expandable children underneath.

3. **Manual operation is intentional** — Many parts need manual operation (e.g., fixing OCR errors, reassigning matches). Don't over-automate.

4. **Card identifier ≠ last 4 digits** — Use cardholder name as the card identifier for mapping to ERP credit card accounts.

5. **FX must be explicit** — OCR prompt must explicitly ask for original currency, FX rate, and HKD equivalent. Upload logic must calculate `amount_hkd` from these fields.

6. **Use Claude Sonnet for OCR** — Better accuracy than GPT-4o for financial document parsing, especially for Chinese/bilingual statements.
