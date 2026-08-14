-- Per-user module access (Settings -> Users): which app modules the user can
-- see/use — 'card' (credit-card recon), 'bank' (bank recon), 'claims'.
-- Default = all three, so nothing changes until an admin unticks something.
-- Note: bank pages remain owner/admin-only at route level AND bank data RLS
-- stays super-only; this column additionally narrows nav/pages per user.
-- Applied live 2026-08-14.
alter table public.user_profiles
  add column if not exists modules text[] not null default array['card','bank','claims']::text[];

alter table public.user_profiles drop constraint if exists user_profiles_modules_check;
alter table public.user_profiles add constraint user_profiles_modules_check
  check (modules <@ array['card','bank','claims']::text[]);
