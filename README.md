# CardRecon

Financial reconciliation system for credit-card statements, bank statements,
and staff expense claims, with AI-assisted OCR parsing and NetSuite journal
export. This is a full rebuild of [hmkaibot-bot/cardrecon](https://github.com/hmkaibot-bot/cardrecon)
into this repository — see [What changed in this rebuild](#what-changed-in-this-rebuild)
below for exactly what that means.

## Modules

| Module | Purpose |
|---|---|
| **Credit Card Reconciliation** | Parse CC statements (HSBC, AE, Hang Seng, etc.), match transactions against vendor invoices (Meta/Google Ads, Uber, SaaS bills...), export NetSuite journal entries |
| **Bank Reconciliation** | Match bank statement lines against NetSuite GL entries per subsidiary |
| **Expense Claims** | Staff submit expense/transportation claims → team-head approval → final approval → NetSuite journal export, with per-line approve/reject |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Frontend — React 18 + TypeScript + Tailwind + shadcn/ui │
│  Dashboard · Upload Centre · Recon Queue · Bank Recon    │
│  Claims (submit/approve/export) · Journal Export         │
│  Settings (matching rules, reference data, API keys)      │
├─────────────────────────────────────────────────────────┤
│  Supabase — Postgres + Auth + Storage + Edge Function     │
│  RLS-scoped by role (owner/admin/bu_user) and entity_scope│
│  parse-document Edge Function: PDF/image → AI OCR → JSON  │
├─────────────────────────────────────────────────────────┤
│  External — OpenAI/OpenRouter (Claude Sonnet) for OCR,    │
│  NetSuite reference data (chart of accounts, subsidiaries,│
│  departments, employees, vendors, customers), Vercel      │
└─────────────────────────────────────────────────────────┘
```

The Express server in `server/` is intentionally minimal — it just serves
the built SPA in production (see `server/routes.ts`). All data access goes
directly from the browser to Supabase via `@supabase/supabase-js`, gated by
Row Level Security.

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in your Supabase project URL + anon key
npm run dev                  # http://localhost:5000
```

### Database

See [`supabase/README.md`](supabase/README.md) for the full setup sequence
(run the migrations, deploy the edge function, invite your first user,
populate reference data). In short:

```bash
supabase link --project-ref <ref>
supabase db push              # applies supabase/migrations/ in order
supabase functions deploy parse-document
```

### Build & deploy

```bash
npm run build     # vite build (client) + esbuild (server) → dist/
npm run check     # tsc --noEmit
```

Deployed on Vercel — `vercel.json` builds the client only
(`npx vite build` → `dist/public`); the Express server isn't used in
production since Vercel serves the SPA directly. Set `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` in the Vercel project's environment variables.

## Key design decisions

- **`card_transactions.card_last4` stores the cardholder's name**, not the
  card's last 4 digits — it's the join key to `ns_credit_card_accounts`.
- **Parent/child invoices**: one parent row per invoice carries the total
  for matching purposes; Meta Ads campaign line items are stored as child
  rows (`meta_invoices.parent_invoice_id`) and expand on demand.
- **FX is never fabricated**: if a statement doesn't show a real exchange
  rate, `fx_rate`/`amount_hkd` are left `NULL` rather than defaulting to a
  guessed rate.
- **Manual operation is intentional** — matching rules, expense categories,
  and NetSuite charge-to codes are configured through Settings, not
  auto-populated on install. See `docs/recon-system-skill/SKILL.md`.
- **Role model**: `owner`/`admin` (full access), `bu_user` (scoped to
  `entity_scope`, e.g. `['CLS']` or `['PBHK','704']`). Claims additionally
  use per-`charge_to_code` team-head assignments for approval routing.

## What changed in this rebuild

The source repo's Supabase schema was never checked in as a clean baseline —
table creation predated its earliest committed migration, and the 32 patch
files that followed (`02_*.sql` … `RUN_ME_NOW_*.sql`) frequently overlapped
or reverted each other. This rebuild:

- **Consolidated all 32 patch files into 9 ordered migrations**
  (`supabase/migrations/`) that bring a fresh Supabase project straight to
  the correct final state — reconstructed from `shared/schema.ts`, every
  `supabase.from()`/`.rpc()`/`.storage.from()` call in the client and
  server, and the patch files' own comments tracing what superseded what.
  Verified end-to-end against a real Postgres instance (schema apply, RLS
  policy behavior, the claim approval state machine, the batch-number
  generator under RLS). The originals are kept in `supabase/legacy/` for
  reference.
- **Fixed a known, documented security gap**: `user_profiles` RLS + a new
  guard trigger now block a user from changing their own `role` or
  `entity_scope` (previously anyone could self-promote to owner — see the
  old `SECURITY.md`'s "Known remaining risks").
- **Filled schema gaps surfaced by static analysis** that the original
  `shared/schema.ts` had drifted out of sync with (e.g. `card_transactions`'
  `cardholder_name` and `assigned_*` columns, `accounting_lines`' `ns_*`
  columns, `meta_invoices.notes`) — these were real columns the app already
  read and wrote at runtime; they just weren't reflected in the TS types,
  which caused `tsc` to fail. `npm run check` is now clean.
- Reference-data seed seeds `ns_departments` with `(internal_id, name)` only
  — the `charge_to`/`entity_code` mapping was hand-maintained in an external
  spreadsheet in the original project and was never committed anywhere; it
  must be filled in via Settings after a fresh install (see
  `supabase/README.md` step 7).
