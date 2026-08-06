-- ============================================================================
-- Expense claim / transportation claim workflow: submission, team-head
-- approval, final approval, per-line approval, and NetSuite journal export.
-- ============================================================================

create table if not exists public.team_head_assignments (
  id uuid primary key default gen_random_uuid(),
  team_head_user_id uuid not null references public.user_profiles(user_id) on delete cascade,
  charge_to_code text not null,   -- matches ns_departments.charge_to
  entity_code text,               -- optional cache for filtering (NULL = derive from charge_to)
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_head_user_id, charge_to_code)
);

create index if not exists idx_team_head_assignments_charge_to on public.team_head_assignments(charge_to_code);
create index if not exists idx_team_head_assignments_user on public.team_head_assignments(team_head_user_id);

create table if not exists public.claim_batches (
  id uuid primary key default gen_random_uuid(),
  batch_no text unique,  -- auto-generated e.g. CLM-202606-0001

  claim_type text not null check (claim_type in ('expenses', 'transportation')),

  claimant_user_id uuid not null references public.user_profiles(user_id) on delete restrict,
  full_name text,
  nick_name text,
  department text,
  submit_date date,
  period_month text,  -- YYYY-MM

  charge_to_code text,               -- required once non-draft (see CHECK below)
  entity_code text,                  -- derived from ns_departments
  subsidiary_full_name text,         -- derived
  department_name text,              -- derived from ns_departments.name

  status text not null default 'draft' check (status in (
    'draft', 'submitted', 'team_head_approved', 'approved', 'exported', 'rejected'
  )),

  team_head_user_id uuid references public.user_profiles(user_id),
  team_head_signed_at timestamptz,
  team_head_comment text,

  approver_user_id uuid references public.user_profiles(user_id),
  approved_at timestamptz,
  approver_comment text,

  rejected_by_user_id uuid references public.user_profiles(user_id),
  rejected_at timestamptz,
  reject_reason text,

  total_hkd numeric(14, 2) default 0,       -- kept current by trg_claim_lines_recalc
  line_count integer default 0,
  has_rejected_lines boolean not null default false,
  approved_line_count integer,
  rejected_line_count integer,
  approved_total_hkd numeric(14, 2),

  netsuite_journal_no text,
  exported_at timestamptz,
  exported_by_user_id uuid references public.user_profiles(user_id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint claim_batches_submitted_must_have_charge_to check (
    status = 'draft' or (charge_to_code is not null and full_name is not null)
  )
);

create index if not exists idx_claim_batches_claimant on public.claim_batches(claimant_user_id);
create index if not exists idx_claim_batches_status on public.claim_batches(status);
create index if not exists idx_claim_batches_type on public.claim_batches(claim_type);
create index if not exists idx_claim_batches_charge_to on public.claim_batches(charge_to_code);
create index if not exists idx_claim_batches_entity on public.claim_batches(entity_code);
create index if not exists idx_claim_batches_period on public.claim_batches(period_month);

create table if not exists public.claim_lines (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.claim_batches(id) on delete cascade,

  item_no integer not null,
  line_date date,
  project_code text,         -- matches ns_project_codes.project_id
  description text,
  has_receipt boolean default false,

  -- Expenses
  client_name text,
  currency text,
  original_amount numeric(14, 2),
  fx_rate numeric(14, 6),              -- user-entered, never recomputed
  hkd_amount numeric(14, 2),           -- user-entered, never recomputed
  billable_to_client_hkd numeric(14, 2) default 0,
  expense_category_code text,          -- matches expense_categories.category_key

  -- Transportation
  means_of_transport text,             -- TAXI / UBER / MTR / BUS / TRAM / FERRY / OTHER
  taxi_reason text,
  location_from text,
  destination text,

  line_status text not null default 'approved' check (line_status in ('pending', 'approved', 'rejected')),
  line_reject_reason text,
  line_approved_by_user_id uuid references public.user_profiles(user_id),
  line_approved_at timestamptz,
  line_rejected_by_user_id uuid references public.user_profiles(user_id),
  line_rejected_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (batch_id, item_no)
);

create index if not exists idx_claim_lines_batch on public.claim_lines(batch_id);
create index if not exists idx_claim_lines_project on public.claim_lines(project_code);
create index if not exists idx_claim_lines_date on public.claim_lines(line_date);

create table if not exists public.claim_attachments (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.claim_batches(id) on delete cascade,
  line_id uuid references public.claim_lines(id) on delete set null,  -- NULL = batch-level
  storage_path text not null,
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  uploaded_by_user_id uuid references public.user_profiles(user_id),
  uploaded_at timestamptz not null default now()
);

create index if not exists idx_claim_attachments_batch on public.claim_attachments(batch_id);
create index if not exists idx_claim_attachments_line on public.claim_attachments(line_id) where line_id is not null;

create table if not exists public.claim_audit_log (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.claim_batches(id) on delete cascade,
  action text not null,        -- created / updated / submitted / team_head_approved / approved / rejected / exported / line_added / line_deleted
  from_status text,
  to_status text,
  actor_user_id uuid references public.user_profiles(user_id),
  comment text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_claim_audit_batch on public.claim_audit_log(batch_id);
create index if not exists idx_claim_audit_action on public.claim_audit_log(action);

-- batch_no generation: a per-YYYYMM Postgres sequence, atomic and unaffected
-- by RLS (see migration history note at the end of this file for why this
-- replaced a naive SELECT MAX(...)+1 approach).
create table if not exists public.claim_batch_sequences (
  yyyymm text primary key,
  sequence_name text not null,
  created_at timestamptz default now()
);

-- Internal bookkeeping only, never queried by the app — locked down
-- entirely (RLS enabled, no policies) rather than left to inherit default
-- authenticated-role table privileges via PostgREST.
alter table public.claim_batch_sequences enable row level security;

-- ---- Functions ----

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.derive_claim_charge_to_fields()
returns trigger
language plpgsql
as $$
declare
  v_entity text;
  v_sub text;
  v_name text;
begin
  if new.charge_to_code is not null then
    select entity_code, subsidiary_full_name, name
      into v_entity, v_sub, v_name
      from public.ns_departments
      where charge_to = new.charge_to_code
      limit 1;
    new.entity_code := v_entity;
    new.subsidiary_full_name := v_sub;
    new.department_name := v_name;
  end if;
  return new;
end;
$$;

create or replace function public.recalc_claim_batch_totals()
returns trigger
language plpgsql
as $$
declare
  v_batch_id uuid;
begin
  v_batch_id := coalesce(new.batch_id, old.batch_id);
  update public.claim_batches
    set total_hkd = (select coalesce(sum(hkd_amount), 0) from public.claim_lines where batch_id = v_batch_id),
        line_count = (select count(*) from public.claim_lines where batch_id = v_batch_id),
        updated_at = now()
    where id = v_batch_id;
  return null;
end;
$$;

create or replace function public.refresh_claim_batch_line_summary()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch_id uuid;
begin
  v_batch_id := coalesce(new.batch_id, old.batch_id);
  update public.claim_batches cb
  set
    approved_line_count = (select count(*) from public.claim_lines where batch_id = v_batch_id and line_status = 'approved'),
    rejected_line_count = (select count(*) from public.claim_lines where batch_id = v_batch_id and line_status = 'rejected'),
    approved_total_hkd = (select coalesce(sum(hkd_amount), 0) from public.claim_lines where batch_id = v_batch_id and line_status = 'approved'),
    has_rejected_lines = (select exists (select 1 from public.claim_lines where batch_id = v_batch_id and line_status = 'rejected'))
  where id = v_batch_id;
  return null;
end;
$$;

-- Final batch-no strategy: lazily create a Postgres sequence per YYYYMM
-- (native atomic counter, immune to RLS) instead of `SELECT MAX(batch_no)+1`,
-- which raced under concurrency and, worse, was itself scoped by RLS so a
-- non-privileged submitter's own SELECT MAX only ever saw batches visible to
-- them — usually zero — causing repeated collisions with batches created by
-- other users/roles they could not see.
create or replace function public.set_claim_batch_no()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_yyyymm text;
  v_seq_name text;
  v_seq_val bigint;
  v_lock_key bigint;
begin
  if new.batch_no is not null then
    return new;
  end if;

  v_yyyymm := to_char(coalesce(new.submit_date, current_date), 'YYYYMM');
  v_seq_name := 'claim_batch_seq_' || v_yyyymm;
  v_lock_key := hashtextextended('claim_batch_seq:' || v_yyyymm, 0);

  perform pg_advisory_xact_lock(v_lock_key);

  if not exists (select 1 from public.claim_batch_sequences where yyyymm = v_yyyymm) then
    execute format(
      'create sequence if not exists public.%I start with %s',
      v_seq_name,
      greatest(
        1,
        coalesce(
          (select max(cast(substring(batch_no from 'CLM-\d{6}-(\d+)') as integer))
           from public.claim_batches
           where batch_no like 'CLM-' || v_yyyymm || '-%'),
          0
        ) + 1
      )
    );
    insert into public.claim_batch_sequences (yyyymm, sequence_name)
      values (v_yyyymm, v_seq_name)
      on conflict (yyyymm) do nothing;
  end if;

  execute format('select nextval(%L)', 'public.' || v_seq_name) into v_seq_val;

  new.batch_no := 'CLM-' || v_yyyymm || '-' || lpad(v_seq_val::text, 4, '0');

  return new;
end;
$$;

alter function public.set_claim_batch_no() owner to postgres;

-- Enforce the claim status state machine + separation-of-duties in the DB
-- layer — RLS alone cannot compare OLD vs NEW status.
create or replace function public.enforce_claim_batch_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid          uuid    := auth.uid();
  v_is_super     boolean := public.is_super_user();
  v_is_claimant  boolean;
  v_is_team_head boolean;
begin
  if TG_OP = 'INSERT' then
    if not v_is_super then
      if new.claimant_user_id is distinct from v_uid then
        raise exception 'claim: you can only create claims for yourself';
      end if;
      if new.status is distinct from 'draft' then
        raise exception 'claim: new claims must start in draft (got %)', new.status;
      end if;
      new.batch_no            := null;   -- regenerated by trg_set_claim_batch_no
      new.team_head_user_id   := null;
      new.team_head_signed_at := null;
      new.approver_user_id    := null;
      new.approved_at         := null;
      new.exported_at         := null;
      new.exported_by_user_id := null;
    end if;
    return new;
  end if;

  -- UPDATE
  if v_is_super then
    return new;
  end if;

  v_is_claimant  := (old.claimant_user_id = v_uid);
  v_is_team_head := exists (
    select 1 from public.team_head_assignments tha
    where tha.team_head_user_id = v_uid
      and tha.charge_to_code = old.charge_to_code
  );

  if v_is_claimant and new.status in ('team_head_approved', 'approved', 'exported') then
    raise exception 'claim: you cannot approve or export your own claim';
  end if;

  if v_is_claimant and old.status in ('draft', 'rejected') then
    if new.status not in ('draft', 'submitted') then
      raise exception 'claim: a draft/rejected claim can only move to submitted (got %)', new.status;
    end if;
    return new;
  end if;

  if v_is_team_head and old.status = 'submitted' then
    if new.status not in ('team_head_approved', 'rejected', 'submitted') then
      raise exception 'claim: a team head can only approve or reject a submitted claim';
    end if;
    return new;
  end if;

  raise exception 'claim: transition from % to % not permitted for this user', old.status, new.status;
end;
$$;

-- ---- Triggers ----

drop trigger if exists trg_set_claim_batch_no on public.claim_batches;
create trigger trg_set_claim_batch_no
  before insert on public.claim_batches
  for each row execute function public.set_claim_batch_no();

-- Name sorts before trg_set_claim_batch_no so the batch_no NULL-out on
-- INSERT (see enforce_claim_batch_transition) runs before batch_no is
-- (re)generated.
drop trigger if exists trg_enforce_claim_transition on public.claim_batches;
create trigger trg_enforce_claim_transition
  before insert or update on public.claim_batches
  for each row execute function public.enforce_claim_batch_transition();

drop trigger if exists trg_claim_batches_updated on public.claim_batches;
create trigger trg_claim_batches_updated
  before update on public.claim_batches
  for each row execute function public.set_updated_at();

drop trigger if exists trg_claim_batches_derive on public.claim_batches;
create trigger trg_claim_batches_derive
  before insert or update of charge_to_code on public.claim_batches
  for each row execute function public.derive_claim_charge_to_fields();

drop trigger if exists trg_claim_lines_updated on public.claim_lines;
create trigger trg_claim_lines_updated
  before update on public.claim_lines
  for each row execute function public.set_updated_at();

drop trigger if exists trg_claim_lines_recalc on public.claim_lines;
create trigger trg_claim_lines_recalc
  after insert or update or delete on public.claim_lines
  for each row execute function public.recalc_claim_batch_totals();

drop trigger if exists trg_refresh_batch_summary on public.claim_lines;
create trigger trg_refresh_batch_summary
  after insert or update or delete on public.claim_lines
  for each row execute function public.refresh_claim_batch_line_summary();

drop trigger if exists trg_team_head_updated on public.team_head_assignments;
create trigger trg_team_head_updated
  before update on public.team_head_assignments
  for each row execute function public.set_updated_at();

-- ---- Views ----

create or replace view public.claim_batches_with_team_head as
select
  b.*,
  (
    select u.user_id from public.team_head_assignments tha
    join public.user_profiles u on u.user_id = tha.team_head_user_id
    where tha.charge_to_code = b.charge_to_code
    limit 1
  ) as assigned_team_head_user_id,
  (
    select u.full_name from public.team_head_assignments tha
    join public.user_profiles u on u.user_id = tha.team_head_user_id
    where tha.charge_to_code = b.charge_to_code
    limit 1
  ) as assigned_team_head_name,
  (
    select u.email from public.team_head_assignments tha
    join public.user_profiles u on u.user_id = tha.team_head_user_id
    where tha.charge_to_code = b.charge_to_code
    limit 1
  ) as assigned_team_head_email
from public.claim_batches b;

-- Run with the querying user's own privileges (and RLS), not the view
-- owner's — otherwise every authenticated user could read every colleague's
-- claim through this view regardless of claim_batches' own RLS. Requires
-- Postgres 15+.
alter view public.claim_batches_with_team_head set (security_invoker = on);

create or replace view public.claim_lines_with_attachment_count as
select
  l.*,
  coalesce(att_count.cnt, 0) as attachment_count
from public.claim_lines l
left join (
  select line_id, count(*) as cnt
  from public.claim_attachments
  where line_id is not null
  group by line_id
) att_count on att_count.line_id = l.id;

grant select on public.claim_lines_with_attachment_count to authenticated;

-- ---- RLS ----

alter table public.team_head_assignments enable row level security;
alter table public.claim_batches enable row level security;
alter table public.claim_lines enable row level security;
alter table public.claim_attachments enable row level security;
alter table public.claim_audit_log enable row level security;

create policy "team_head_assignments_select" on public.team_head_assignments
  for select to authenticated using (true);  -- everyone needs to know who the team head is

create policy "team_head_assignments_write" on public.team_head_assignments
  for all to authenticated
  using (public.is_super_user())
  with check (public.is_super_user());

-- claim_batches: private by default — a claimant's own batches, the assigned
-- team head, or a super user. (The original app briefly also granted
-- entity-wide visibility to any BU user sharing the batch's entity_code;
-- that was reverted for being too broad for salary-adjacent data — see
-- migration_claim_privacy_tighten.sql — and is intentionally not reproduced.)
create policy "claim_batches_select" on public.claim_batches
  for select to authenticated
  using (
    public.is_super_user()
    or claimant_user_id = auth.uid()
    or team_head_user_id = auth.uid()
    or exists (
      select 1 from public.team_head_assignments tha
      where tha.team_head_user_id = auth.uid()
        and tha.charge_to_code = claim_batches.charge_to_code
    )
  );

create policy "claim_batches_insert" on public.claim_batches
  for insert to authenticated
  with check (
    claimant_user_id = auth.uid()
    or public.is_super_user()
  );

create policy "claim_batches_update" on public.claim_batches
  for update to authenticated
  using (
    public.is_super_user()
    or (claimant_user_id = auth.uid() and status in ('draft', 'rejected'))
    or (
      status = 'submitted'
      and exists (
        select 1 from public.team_head_assignments tha
        where tha.team_head_user_id = auth.uid()
          and tha.charge_to_code = claim_batches.charge_to_code
      )
    )
  )
  with check (
    public.is_super_user()
    or claimant_user_id = auth.uid()
    or exists (
      select 1 from public.team_head_assignments tha
      where tha.team_head_user_id = auth.uid()
        and tha.charge_to_code = claim_batches.charge_to_code
    )
  );

create policy "claim_batches_delete" on public.claim_batches
  for delete to authenticated
  using (
    public.is_super_user()
    or (claimant_user_id = auth.uid() and status = 'draft')
  );

-- claim_lines: broad SELECT (same visibility as the parent batch), narrower
-- ALL restricted to draft/rejected batches (claimant editing), and a
-- dedicated team-head UPDATE for per-line approve/reject on a submitted
-- batch. All three are separate policies rather than one broad FOR ALL
-- because FOR ALL's USING clause also governs SELECT, which would otherwise
-- hide submitted/approved lines from the very team head/claimant who needs
-- to review them.
create policy "claim_lines_select" on public.claim_lines
  for select to authenticated
  using (
    exists (select 1 from public.claim_batches b
            where b.id = claim_lines.batch_id
              and (public.is_super_user()
                   or b.claimant_user_id = auth.uid()
                   or b.team_head_user_id = auth.uid()
                   or exists (select 1 from public.team_head_assignments tha
                              where tha.team_head_user_id = auth.uid()
                                and tha.charge_to_code = b.charge_to_code)))
  );

create policy "claim_lines_all" on public.claim_lines
  for all to authenticated
  using (
    exists (select 1 from public.claim_batches b
            where b.id = claim_lines.batch_id
              and (public.is_super_user()
                   or (b.claimant_user_id = auth.uid() and b.status in ('draft', 'rejected'))))
  )
  with check (
    exists (select 1 from public.claim_batches b
            where b.id = claim_lines.batch_id
              and (public.is_super_user()
                   or (b.claimant_user_id = auth.uid() and b.status in ('draft', 'rejected'))))
  );

create policy "claim_lines_th_update" on public.claim_lines
  for update to authenticated
  using (
    exists (select 1 from public.claim_batches b
            where b.id = claim_lines.batch_id and b.status = 'submitted'
              and exists (select 1 from public.team_head_assignments tha
                          where tha.team_head_user_id = auth.uid()
                            and tha.charge_to_code = b.charge_to_code))
  )
  with check (
    exists (select 1 from public.claim_batches b
            where b.id = claim_lines.batch_id and b.status = 'submitted'
              and exists (select 1 from public.team_head_assignments tha
                          where tha.team_head_user_id = auth.uid()
                            and tha.charge_to_code = b.charge_to_code))
  );

create policy "claim_attachments_select" on public.claim_attachments
  for select to authenticated
  using (
    exists (
      select 1 from public.claim_batches b
      where b.id = claim_attachments.batch_id
        and (
          public.is_super_user()
          or b.claimant_user_id = auth.uid()
          or b.team_head_user_id = auth.uid()
          or exists (
            select 1 from public.team_head_assignments tha
            where tha.team_head_user_id = auth.uid()
              and tha.charge_to_code = b.charge_to_code
          )
        )
    )
  );

-- Governs UPDATE/DELETE (draft/rejected only); INSERT is broadened below by
-- claim_attachments_insert_open so receipts can still be attached while a
-- claim is under review (draft/submitted/team_head_approved/approved).
create policy "claim_attachments_write" on public.claim_attachments
  for all to authenticated
  using (
    exists (
      select 1 from public.claim_batches b
      where b.id = claim_attachments.batch_id
        and (
          public.is_super_user()
          or (b.claimant_user_id = auth.uid() and b.status in ('draft', 'rejected'))
        )
    )
  )
  with check (
    exists (
      select 1 from public.claim_batches b
      where b.id = claim_attachments.batch_id
        and (
          public.is_super_user()
          or (b.claimant_user_id = auth.uid() and b.status in ('draft', 'rejected'))
        )
    )
  );

create policy "claim_attachments_insert_open" on public.claim_attachments
  for insert to authenticated
  with check (
    exists (
      select 1 from public.claim_batches cb
      where cb.id = claim_attachments.batch_id
        and cb.status in ('draft', 'submitted', 'team_head_approved', 'approved')
        and (
          cb.claimant_user_id = auth.uid()
          or exists (
            select 1 from public.user_profiles up
            where up.user_id = auth.uid()
              and up.role in ('admin', 'owner')
          )
        )
    )
  );

create policy "claim_audit_log_select" on public.claim_audit_log
  for select to authenticated
  using (
    exists (
      select 1 from public.claim_batches b
      where b.id = claim_audit_log.batch_id
        and (
          public.is_super_user()
          or b.claimant_user_id = auth.uid()
          or b.team_head_user_id = auth.uid()
          or exists (
            select 1 from public.team_head_assignments tha
            where tha.team_head_user_id = auth.uid()
              and tha.charge_to_code = b.charge_to_code
          )
        )
    )
  );

-- Scoped so a user can only write an audit-log row for a batch they are
-- actually involved in (claimant/team head/super user) — an earlier version
-- of this policy allowed WITH CHECK (true), letting any authenticated user
-- forge an audit entry on any batch (see migration_security_integrity_fixes.sql
-- FIX5).
create policy "claim_audit_log_insert" on public.claim_audit_log
  for insert to authenticated
  with check (
    public.is_super_user()
    or exists (
      select 1 from public.claim_batches b
      where b.id = claim_audit_log.batch_id
        and (b.claimant_user_id = auth.uid()
             or b.team_head_user_id = auth.uid()
             or exists (select 1 from public.team_head_assignments tha
                        where tha.team_head_user_id = auth.uid()
                          and tha.charge_to_code = b.charge_to_code))
    )
  );

-- These SECURITY DEFINER functions must never be callable directly by anon
-- via PostgREST RPC — they only make sense fired by their own triggers.
revoke execute on function public.set_claim_batch_no() from anon, public;
revoke execute on function public.enforce_claim_batch_transition() from anon, public;
revoke execute on function public.refresh_claim_batch_line_summary() from anon, public;

-- ============================================================================
-- Migration-history note (why the final state above looks like this):
-- The original repo iterated through 12 separate patch files to reach this
-- point — a naive SELECT-MAX batch-no generator that raced and was RLS-blind,
-- a brief detour where the trigger self-approval/state-machine bug let
-- claimants approve their own claims, and a privacy leak where any BU user
-- in the same entity could read colleagues' claims through
-- claim_batches_select. All three are already fixed above; there is nothing
-- further to apply.
-- ============================================================================
