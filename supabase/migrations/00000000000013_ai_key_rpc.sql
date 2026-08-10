-- ============================================================================
-- AI API key accessor for the parse-document Edge Function.
-- The key itself (OpenAI sk-... or OpenRouter sk-or-...) lives in Supabase
-- Vault under the name `ai_api_key` and is NOT in this repo — set it once per
-- environment with:
--   select vault.create_secret('<key>', 'ai_api_key', 'AI key for parse-document');
-- parse-document reads OPENAI_API_KEY env first, then falls back to this RPC.
-- ============================================================================
create or replace function public.get_ai_api_key()
returns text language plpgsql security definer set search_path = public, vault as $$
declare v text;
begin
  select decrypted_secret into v from vault.decrypted_secrets where name = 'ai_api_key';
  return v;
end $$;
revoke all on function public.get_ai_api_key() from anon, authenticated, public;
grant execute on function public.get_ai_api_key() to service_role;
