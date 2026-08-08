-- ============================================================================
-- NetSuite sync support RPCs, used only by the `netsuite-post-journal` Edge
-- Function (which runs with the service_role key). The actual TBA credentials
-- and account id live in Supabase Vault (ns_tba_consumer_key,
-- ns_tba_consumer_secret, ns_tba_token_id, ns_tba_token_secret, ns_account_id)
-- and are NOT in this repo — set them once per environment with
-- vault.create_secret(...).
-- ============================================================================

-- Return the NetSuite config from Vault. SECURITY DEFINER so it can read the
-- vault schema; locked to service_role so no client/user can pull the secrets.
create or replace function public.ns_get_config()
returns jsonb language plpgsql security definer set search_path = public, vault as $$
declare r jsonb;
begin
  select jsonb_object_agg(name, decrypted_secret) into r
  from vault.decrypted_secrets
  where name in ('ns_tba_consumer_key','ns_tba_consumer_secret','ns_tba_token_id','ns_tba_token_secret','ns_account_id');
  return coalesce(r, '{}'::jsonb);
end $$;
revoke all on function public.ns_get_config() from anon, authenticated, public;
grant execute on function public.ns_get_config() to service_role;

-- Mark a claim batch exported after a successful NetSuite post. SECURITY
-- DEFINER + a super-user jwt context so the claim state-machine trigger
-- (enforce_claim_batch_transition) permits the approved -> exported move.
create or replace function public.ns_mark_batch_exported(p_batch_id uuid, p_je text)
returns text language plpgsql security definer set search_path = public as $$
declare v_admin uuid; v_status text;
begin
  select status into v_status from public.claim_batches where id = p_batch_id;
  if v_status is null then return 'batch_not_found'; end if;
  select user_id into v_admin from public.user_profiles
    where role in ('owner','admin') order by role limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin::text, 'role','authenticated')::text, true);
  update public.claim_batches
     set netsuite_journal_no = p_je, status = 'exported', exported_at = now(), exported_by_user_id = v_admin
   where id = p_batch_id;
  perform set_config('request.jwt.claims', '', true);
  return 'ok';
end $$;
revoke all on function public.ns_mark_batch_exported(uuid,text) from anon, authenticated, public;
grant execute on function public.ns_mark_batch_exported(uuid,text) to service_role;
