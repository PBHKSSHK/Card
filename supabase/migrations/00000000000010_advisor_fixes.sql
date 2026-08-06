-- ============================================================================
-- Fixes for issues raised by the Supabase security advisor after the initial
-- migration chain was applied to a live project:
--
--   1. Postgres views default to SECURITY DEFINER semantics (they run with
--      the view owner's RLS, not the querying user's). Migrations 6 and 8
--      only set security_invoker on claim_batches_with_team_head — switch
--      the remaining three views over too.
--   2. The trigger helper functions written without an explicit search_path
--      (set_updated_at & co.) had a role-mutable search_path.
--   3. Supabase's default privileges grant EXECUTE on newly created
--      functions to anon/authenticated, which exposes trigger-only
--      functions via PostgREST's /rest/v1/rpc/ endpoint. They can't do
--      damage when called directly (no OLD/NEW row context), but there is
--      no reason for them to be callable at all.
--
-- The remaining advisor notices are intentional: claim_batch_sequences has
-- RLS enabled with no policies (deny-all — only the SECURITY DEFINER batch-
-- numbering trigger touches it), and the is_admin / is_super_user /
-- current_user_role / current_user_entity_scope / user_can_see_entity
-- helpers stay callable by authenticated because they only ever reveal the
-- caller's own role/scope.
-- ============================================================================

alter view public.claim_lines_with_attachment_count set (security_invoker = on);
alter view public.v_transactions_full set (security_invoker = on);
alter view public.v_bu_summary set (security_invoker = on);

alter function public.set_updated_at() set search_path = public;
alter function public.derive_claim_charge_to_fields() set search_path = public;
alter function public.recalc_claim_batch_totals() set search_path = public;

revoke execute on function public.guard_user_profiles_self_promotion() from anon, authenticated, public;
revoke execute on function public.handle_new_user() from anon, authenticated, public;
revoke execute on function public.enforce_claim_batch_transition() from anon, authenticated, public;
revoke execute on function public.set_claim_batch_no() from anon, authenticated, public;
revoke execute on function public.refresh_claim_batch_line_summary() from anon, authenticated, public;
revoke execute on function public.set_updated_at() from anon, authenticated, public;
revoke execute on function public.derive_claim_charge_to_fields() from anon, authenticated, public;
revoke execute on function public.recalc_claim_batch_totals() from anon, authenticated, public;
