-- ============================================================================
-- Auth + role-based access control foundation.
-- Every other table's RLS policy depends on is_super_user()/user_can_see_entity(),
-- so this must be the first real schema migration after extensions.
-- ============================================================================

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  role text not null check (role in ('owner', 'admin', 'bu_user')),
  entity_scope text[] default '{}',  -- e.g. ['CLS'] or ['PBHK','704']; owner/admin = '{}' (all)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_profiles_email on public.user_profiles(email);
create index if not exists idx_user_profiles_role on public.user_profiles(role);

alter table public.user_profiles enable row level security;

-- ---- Helper functions (SECURITY DEFINER: bypass RLS internally, avoid recursion) ----

create or replace function public.current_user_role()
returns text
language sql stable security definer
set search_path = public
as $$
  select role from public.user_profiles where user_id = auth.uid()
$$;

create or replace function public.current_user_entity_scope()
returns text[]
language sql stable security definer
set search_path = public
as $$
  select entity_scope from public.user_profiles where user_id = auth.uid()
$$;

create or replace function public.is_super_user()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_profiles
    where user_id = auth.uid()
      and role in ('owner', 'admin')
  )
$$;

-- Back-compat alias: some policies/older code refer to is_admin(); keep it as
-- a thin wrapper over is_super_user() rather than a second role check.
create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.is_super_user()
$$;

create or replace function public.user_can_see_entity(p_entity text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select
    public.is_super_user()
    or (
      p_entity is not null
      and p_entity = any(public.current_user_entity_scope())
    )
$$;

-- ---- Auto-create profile on signup ----
-- Named accounts get their real role/entity_scope; anyone else signs up as an
-- unscoped bu_user awaiting an admin to assign their entity_scope.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_role text;
  v_scope text[];
begin
  case new.email
    when 'alex@sshk.ltd'              then v_role := 'owner';   v_scope := '{}';
    when 'nok@sshk.ltd'               then v_role := 'owner';   v_scope := '{}';
    when 'rex@pbhk.info'              then v_role := 'owner';   v_scope := '{}';
    when 'kenneth@clsgarage.com'      then v_role := 'owner';   v_scope := '{}';
    when 'yannese.lo@pbhk.info'       then v_role := 'admin';   v_scope := '{}';
    when 'susanna.lam@photoblog.hk'   then v_role := 'admin';   v_scope := '{}';
    when 'kitman.choi@clsgarage.com'  then v_role := 'bu_user'; v_scope := array['CLS'];
    when 'mabel.tan@clsgarage.com'    then v_role := 'bu_user'; v_scope := array['CLS'];
    when 'maggie.kwan@pbhk.info'      then v_role := 'bu_user'; v_scope := array['PBHK','704'];
    when 'fornia.lung@sshk.ltd'       then v_role := 'bu_user'; v_scope := array['SSHK'];
    when 'to.fok@sshk.ltd'            then v_role := 'bu_user'; v_scope := array['SSHK'];
    when 'alex.lee@jervoism.com'      then v_role := 'bu_user'; v_scope := array['JM'];
    when 'tracy.tsang@jervoism.com'   then v_role := 'bu_user'; v_scope := array['JM'];
    else v_role := 'bu_user'; v_scope := '{}';
  end case;

  insert into public.user_profiles (user_id, email, role, entity_scope)
  values (new.id, new.email, v_role, v_scope)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---- RLS policies ----

create policy "user_profiles_self_read" on public.user_profiles
  for select to authenticated
  using (user_id = auth.uid() or public.is_super_user());

create policy "user_profiles_self_update_name" on public.user_profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "user_profiles_admin_write" on public.user_profiles
  for all to authenticated
  using (public.is_super_user())
  with check (public.is_super_user());

-- Guard against self-promotion: a non-super-user can update their own row
-- (e.g. full_name) but may not change their own role or entity_scope — that
-- was a known gap in the original app (see SECURITY.md "Known remaining
-- risks"). Admins/owners changing OTHER users' profiles via
-- user_profiles_admin_write are unaffected (auth.uid() <> the row's user_id,
-- or the actor is already a super user).
create or replace function public.guard_user_profiles_self_promotion()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_super_user()
     and new.user_id = auth.uid()
     and (new.role is distinct from old.role or new.entity_scope is distinct from old.entity_scope)
  then
    raise exception 'user_profiles: cannot change your own role or entity_scope';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_user_profiles_self_promotion on public.user_profiles;
create trigger trg_guard_user_profiles_self_promotion
  before update on public.user_profiles
  for each row execute function public.guard_user_profiles_self_promotion();

-- One-time backfill for any auth.users rows that already exist (e.g. users
-- invited before this migration ran). Safe/idempotent to re-run — it always
-- reflects the named-account mapping above, so it will NOT clobber a role an
-- admin manually changed afterwards for anyone NOT in this list.
insert into public.user_profiles (user_id, email, role, entity_scope)
select
  u.id,
  u.email,
  case u.email
    when 'alex@sshk.ltd'              then 'owner'
    when 'nok@sshk.ltd'               then 'owner'
    when 'rex@pbhk.info'              then 'owner'
    when 'kenneth@clsgarage.com'      then 'owner'
    when 'yannese.lo@pbhk.info'       then 'admin'
    when 'susanna.lam@photoblog.hk'   then 'admin'
    else 'bu_user'
  end as role,
  case u.email
    when 'kitman.choi@clsgarage.com'  then array['CLS']
    when 'mabel.tan@clsgarage.com'    then array['CLS']
    when 'maggie.kwan@pbhk.info'      then array['PBHK','704']
    when 'fornia.lung@sshk.ltd'       then array['SSHK']
    when 'to.fok@sshk.ltd'            then array['SSHK']
    when 'alex.lee@jervoism.com'      then array['JM']
    when 'tracy.tsang@jervoism.com'   then array['JM']
    else '{}'::text[]
  end as entity_scope
from auth.users u
on conflict (user_id) do nothing;

-- Prevent anonymous/PUBLIC callers from invoking these SECURITY DEFINER
-- functions directly via PostgREST RPC (final state per
-- migration_security_revoke_anon_exec_and_audit_rls.sql).
revoke execute on function public.current_user_role() from anon, public;
revoke execute on function public.current_user_entity_scope() from anon, public;
revoke execute on function public.is_super_user() from anon, public;
revoke execute on function public.is_admin() from anon, public;
revoke execute on function public.user_can_see_entity(text) from anon, public;
revoke execute on function public.handle_new_user() from anon, public;
