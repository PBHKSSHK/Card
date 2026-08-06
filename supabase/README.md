# Supabase setup

## Fresh install

1. Create a new Supabase project.
2. Run every file in `migrations/` **in filename order** — either:
   - `supabase link --project-ref <ref> && supabase db push`, or
   - paste each file into the SQL Editor, in order (`00000000000001_extensions.sql`
     through `00000000000009_security_hardening.sql`).
3. Deploy the OCR edge function:
   ```bash
   supabase functions deploy parse-document
   supabase secrets set OPENAI_API_KEY=sk-... # or leave unset if every user supplies their own key in Settings
   ```
4. Create a Storage bucket named `documents` — migration `00000000000007_storage.sql`
   creates it automatically via `INSERT INTO storage.buckets`, so this step
   is usually a no-op; only needed if you ran the migrations through a tool
   that doesn't have Storage admin rights.
5. Invite your first user (Supabase Dashboard → Authentication → Users →
   Invite). Whether they land as `owner`/`admin`/`bu_user` is decided by
   `handle_new_user()` in `migrations/00000000000002_auth_and_rbac.sql` — see
   that file's `CASE` statement. Anyone not on that list signs up as an
   unscoped `bu_user`; promote them via Settings → User Management (as an
   owner/admin) once they've signed in.
6. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in your `.env.local`
   (dev) or Vercel project settings (prod) — see the root `README.md`.
7. Populate `ns_departments.charge_to` / `entity_code` / `subsidiary_name`
   for each department via Settings → Reference Data. This mapping comes
   from an external NetSuite/Google Sheet sync that was never captured in
   any committed migration in the original project (see the comment at the
   top of `migrations/00000000000005_ns_reference_seed_data.sql`), so it
   ships empty and must be filled in once per deployment.
8. Add matching rules (Settings → Matching Rules) and expense categories
   (Settings → Reference Data) — both start empty by design; see
   `docs/recon-system-skill/SKILL.md`, lesson 3 ("manual operation is
   intentional").

## Layout

- `migrations/` — the current schema, consolidated to its final state and
  verified against a real Postgres instance. Apply these to a fresh project.
- `legacy/` — the original 32 hand-run patch files from the source project,
  kept for historical/audit reference only. See `legacy/README.md`.
- `functions/parse-document/` — the OCR edge function (PDF/image → AI →
  structured JSON). Requires the caller to be signed in (JWT-verified); the
  anon key alone is rejected.
