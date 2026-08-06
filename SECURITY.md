# Security notes

## Current state

- No anon-key access anywhere: every business table, NetSuite reference
  table, and SECURITY DEFINER helper function has `anon` explicitly revoked
  (`supabase/migrations/00000000000009_security_hardening.sql`, plus
  per-function revokes alongside each function's own migration file). All
  data access requires a signed-in session.
- The `parse-document` Edge Function verifies the caller's JWT and rejects
  anonymous requests (`supabase/functions/parse-document/index.ts`) — the
  anon key alone cannot burn the project's OpenAI/OpenRouter quota.
- `user_profiles` self-promotion is blocked: a user can update their own row
  (e.g. `full_name`), but a trigger (`guard_user_profiles_self_promotion` in
  `supabase/migrations/00000000000002_auth_and_rbac.sql`) rejects any
  attempt to change their own `role` or `entity_scope`. Only an
  `owner`/`admin` can promote another user, via the
  `user_profiles_admin_write` policy.
- Claim self-approval is blocked: `enforce_claim_batch_transition()`
  (`supabase/migrations/00000000000006_claims_system.sql`) rejects a
  claimant moving their own claim to `team_head_approved`/`approved`/
  `exported`, even if they also happen to be the assigned team head for
  their own charge-to code.
- No plaintext credentials are committed anywhere in this repo or its
  history — this repo was created fresh from a port of the upstream
  project, after upstream's own credential-leak remediation.

## Known limitations (by design, not oversights)

- **Per-user LLM API key** (Settings → AI/API) is stored in the browser's
  `localStorage` and sent in the OCR request body; it is not moved
  server-side. If you need centralized key management, set the
  `OPENAI_API_KEY` Supabase secret instead — the Edge Function falls back to
  it when no per-user key is supplied.
- **NetSuite/matching reference data starts empty or partially seeded** —
  see `supabase/README.md` steps 7–8. This is intentional (see
  `docs/recon-system-skill/SKILL.md`, "manual operation is intentional"),
  not a security gap, but an unconfigured `ns_departments.charge_to` mapping
  means claim routing won't work until an admin fills it in.

## Reporting

If you find a security issue in this app, do not open a public GitHub issue.
Contact a project owner/admin directly.
