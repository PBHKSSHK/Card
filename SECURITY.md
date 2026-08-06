# Security remediation — required manual follow-ups

This branch removes credential leaks and the anon-key backdoor from the
codebase, but three steps can only be done by a project admin. Do them in
this order.

## 1. Rotate the 13 leaked passwords (do this first)

`supabase/migration_seed_users_with_passwords.sql` (now deleted) and the old
`passwords.json` contained the plaintext passwords of all 13 user accounts,
and both are still recoverable from git history. Treat every one of those
passwords as compromised — especially the 4 `owner` and 2 `admin` accounts.

For each user, in Supabase Dashboard → Authentication → Users, either set a
new random password or use "Send password recovery" so they choose their own.
If anyone reused their password elsewhere, tell them to change it there too.

## 2. Purge the leaked files from git history

Deleting the files only removes them from the latest commit. To remove them
from history (after this branch is merged):

```bash
pip install git-filter-repo
git clone --mirror https://github.com/hmkaibot-bot/cardrecon.git
cd cardrecon.git
git filter-repo --invert-paths \
  --path passwords.json \
  --path supabase/migration_seed_users_with_passwords.sql
git push --force --mirror https://github.com/hmkaibot-bot/cardrecon.git
```

Everyone with a local clone must re-clone afterwards. Note: even after the
purge, anyone who already had repo access may have seen the passwords —
rotation (step 1) is what actually closes the hole; the purge just stops
future readers.

## 3. Apply the database fix and redeploy the edge function

```bash
# Drop the anon full-access policies (run in Supabase SQL editor, or:)
supabase db execute -f supabase/migration_security_drop_anon_policies.sql

# Deploy the consolidated, auth-protected parse-document function
supabase functions deploy parse-document
```

Deploy the edge function and the client (Vercel) together: the new function
returns 401 to anon-key calls, and the new client always sends the user's
session token, so a half-deployed state would break document parsing for
users who are not logged in (which is now intentional).

Also confirm in Vercel that `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
are set — the client no longer falls back to a hardcoded project URL.

## What changed in code

- Deleted `supabase/migration_seed_users_with_passwords.sql` (plaintext
  passwords; re-running it would also have reset users' changed passwords
  back to the leaked ones). Seed users via Supabase Dashboard invites or the
  Admin API instead — never commit credentials.
- Deleted the stale duplicate `edge-function-parse-document.ts`;
  `supabase/functions/parse-document/index.ts` is now the single source of
  truth, updated with auto-classify support and JWT verification: only a
  signed-in user can invoke it (previously anyone with the public anon key
  could burn the project's OpenAI quota), plus payload size limits.
- Added `supabase/migration_security_drop_anon_policies.sql`, which drops
  every `FOR ALL TO anon USING (true)` policy (11 business tables + 7
  NetSuite reference tables) and revokes anon table privileges. The
  `CREATE POLICY ... TO anon` lines were also removed from
  `02_migration_auth_notes_storage.sql`, `06_netsuite_reference_data.sql`
  and `06a_ddl.sql` so re-running those scripts cannot reintroduce them.
- Client: `supabase.ts` fails fast instead of falling back to a hardcoded
  project URL; `document-parser.ts` requires a signed-in session.

## Known remaining risks (not in this fix)

- RLS still lets users self-promote (`users_update_own_profile` allows
  updating `role`) and claimants self-approve claims — needs a separate
  RLS/trigger fix.
- The per-user LLM API key is stored in `localStorage` and sent in the
  request body; consider moving per-user keys server-side.
