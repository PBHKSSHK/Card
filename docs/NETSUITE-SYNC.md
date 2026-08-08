# NetSuite Journal Sync

App-native NetSuite integration: a Supabase Edge Function posts approved claim
batches to NetSuite as Journal Entries, using **Token-Based Authentication
(TBA / OAuth 1.0a HMAC-SHA256)**. It does not depend on Claude or any MCP —
it's a normal server-to-server integration that runs 24/7.

## Pieces

- **Edge Function** `supabase/functions/netsuite-post-journal/index.ts`
  (deployed; `verify_jwt = true`).
- **RPCs** `supabase/migrations/00000000000012_netsuite_sync_rpcs.sql`
  — `ns_get_config()` (reads Vault, service_role only) and
  `ns_mark_batch_exported()` (writes back the NetSuite id + status).
- **Secrets** in Supabase Vault (NOT in the repo):
  `ns_tba_consumer_key`, `ns_tba_consumer_secret`, `ns_tba_token_id`,
  `ns_tba_token_secret`, `ns_account_id`.

## Mapping (all resolved to NetSuite internal IDs)

| CardRecon | NetSuite | Source |
|-----------|----------|--------|
| `batch.entity_code` / `subsidiary_full_name` | `subsidiary.id` | `ns_subsidiaries.internal_id` |
| `batch.charge_to_code` | line `department.id` | `ns_departments.internal_id` |
| line `expense_category_code` → account no. | line `account.id` (DR) | `expense_categories` → `ns_chart_of_accounts.internal_id` |
| Accounts Payable `33000010` | CR `account.id` | `ns_chart_of_accounts.internal_id` |
| `batch.batch_no` | `externalId` | — (duplicate guard) |

One JE per batch: CR Accounts Payable for the total, DR one line per approved
claim line. Always balanced.

## How to post a batch

Call the function with an **owner/admin** Supabase JWT (or the service-role
key):

```
POST https://<project>.supabase.co/functions/v1/netsuite-post-journal
Authorization: Bearer <super-user access token>
apikey: <anon key>
Content-Type: application/json

{ "batch_no": "CLM-202607-0010" }        // or { "batch_id": "<uuid>" }
{ "batch_no": "CLM-202607-0010", "dry_run": true }   // build payload only
```

Success → `{ ok, netsuite_id, batch_no, total }`, and the batch is set to
`exported` with `netsuite_journal_no = NS-<id>`.

## Safety / correctness

- **Human checkpoint** — the JE is created `approved: false`, i.e. an
  *unapproved* draft that a person approves inside NetSuite before it hits the
  ledger.
- **No double-posting** — two guards: `externalId = batch_no` (NetSuite rejects
  duplicates) and the function refuses any batch that already has
  `netsuite_journal_no`.
- **Only finally-approved batches** — status must be `approved` (or already
  `exported`); `team_head_approved` is not eligible.
- **Least privilege** — only owner/admin (or the backend service role) can
  invoke it; the TBA secrets never leave Vault / the edge runtime.

## Rotating credentials

Update any secret in place, e.g.:

```sql
delete from vault.secrets where name = 'ns_tba_token_secret';
select vault.create_secret('<new value>', 'ns_tba_token_secret', 'NetSuite TBA token secret');
```

No redeploy needed — the function reads Vault on each call.

## First live post (verified)

`CLM-202607-0010` (Alex Lo, PBHK, HKD 4,000) posted as NetSuite JE
`GL26PB-10009070` (internal id 67753), unapproved draft — end-to-end verified
on both sides.
