-- 自動同步 NetSuite 參考資料 (project codes + 對應 customer 名 + vendors)。
-- credit card / claims / payments 三個 module 嘅 project picker 都讀
-- ns_project_codes；payments 收款人 picker 讀 ns_vendor_directory。
--
-- 1. ns_project_codes 加 is_active + synced_at + unique(internal_id) —
--    netsuite-sync-projects Edge Function 用嚟 upsert，NetSuite 已停用嘅
--    projects 收起 (is_active=false)，pickers 唔再顯示但歷史紀錄保留。
-- 2. cron_sync_secret vault secret + ns_get_cron_secret() RPC — pg_cron
--    排程 call Edge Functions 時做 app-level auth (anon JWT 過 gateway，
--    x-cron-secret header 過 function 自己嘅 auth check)。
-- 3. pg_cron + pg_net：每日 19:00 / 19:10 UTC (= 03:00 / 03:10 HKT)
--    自動 call netsuite-sync-projects / netsuite-sync-vendors。

alter table public.ns_project_codes add column if not exists is_active boolean not null default true;
alter table public.ns_project_codes add column if not exists synced_at timestamptz;
create unique index if not exists ns_project_codes_internal_id_key on public.ns_project_codes (internal_id);

-- cron secret — 只喺未有先生成 (rerun-safe)
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'cron_sync_secret') then
    perform vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'cron_sync_secret');
  end if;
end $$;

-- Edge Function 用 service role 讀返個 secret 對 header
create or replace function public.ns_get_cron_secret()
returns text language plpgsql security definer set search_path = public, vault as $$
declare r text;
begin
  select decrypted_secret into r from vault.decrypted_secrets where name = 'cron_sync_secret';
  return r;
end $$;
revoke all on function public.ns_get_cron_secret() from anon, authenticated, public;
grant execute on function public.ns_get_cron_secret() to service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- rerun-safe：舊 job 先除
do $$
begin
  if exists (select 1 from cron.job where jobname = 'netsuite-sync-projects-daily') then
    perform cron.unschedule('netsuite-sync-projects-daily');
  end if;
  if exists (select 1 from cron.job where jobname = 'netsuite-sync-vendors-daily') then
    perform cron.unschedule('netsuite-sync-vendors-daily');
  end if;
end $$;

-- 每日 03:00 HKT sync projects/customers；03:10 HKT sync vendors。
-- Authorization 用公開 anon key (過 gateway JWT check)，真正授權靠 x-cron-secret。
select cron.schedule('netsuite-sync-projects-daily', '0 19 * * *', $cron$
  select net.http_post(
    url := 'https://nyooltqhmrdnippfikes.supabase.co/functions/v1/netsuite-sync-projects',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55b29sdHFobXJkbmlwcGZpa2VzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwMDg3NDMsImV4cCI6MjEwMTU4NDc0M30.QLzGYDOfuQEvgXauxHcazEbnMIFrelBt0QhD7p9BWZU',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_sync_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$cron$);

select cron.schedule('netsuite-sync-vendors-daily', '10 19 * * *', $cron$
  select net.http_post(
    url := 'https://nyooltqhmrdnippfikes.supabase.co/functions/v1/netsuite-sync-vendors',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55b29sdHFobXJkbmlwcGZpa2VzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwMDg3NDMsImV4cCI6MjEwMTU4NDc0M30.QLzGYDOfuQEvgXauxHcazEbnMIFrelBt0QhD7p9BWZU',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_sync_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$cron$);
