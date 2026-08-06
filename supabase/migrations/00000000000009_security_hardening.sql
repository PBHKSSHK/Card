-- ============================================================================
-- Final hardening pass. Every table/function above was already written with
-- its final (non-anon) RLS policies and EXECUTE grants directly — this file
-- only adds the broad, schema-wide belt-and-braces revokes so no future
-- table/sequence/function accidentally inherits anon access by default.
--
-- (The original repo briefly shipped `FOR ALL TO anon USING (true)` policies
-- on every business table plus an unauthenticated Edge Function — anyone
-- holding the public anon key could read/write/delete all data and burn the
-- project's AI budget. Both were fixed before this rebuild; see SECURITY.md
-- and supabase/functions/parse-document/index.ts's JWT check. Nothing here
-- reintroduces them.)
--
-- public.audit_log (from the original repo) is intentionally NOT reproduced
-- here — it was confirmed unused (zero rows, nothing in the app writes to
-- it) and superseded by claim_audit_log.
-- ============================================================================

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
