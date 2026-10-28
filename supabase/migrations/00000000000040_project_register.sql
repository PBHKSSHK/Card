-- Project Code Register — sales 自助取 project code，按 project 性質 (type) 規則
-- 驗證；狀態自動更新 (Active → Expiring → Closed)；出 code 即 email 通知；
-- 已關閉 / 唔存在嘅 code 喺 CardRecon (claims、付款申請、card recon) 一律 ban；
-- Xero invoice / bill 每晚由 xero-project-check 檢查，錯 code 記入違規清單 + email。
--
-- Code 格式：P + YY + 公司碼 + '-' + 類型 + 4 位流水號 [+ '-' + 合約完結年 YY]
--   P26SS-C0012（campaign）  P26SS-R0003-27（retainer 2027 完結；續約 → -28）
-- 舊 NetSuite code（P2610001397）保留喺 ns_project_codes，照用到完結。
--
-- 新 code 同時寫入 ns_project_codes（internal_id = null），所以現有 claims /
-- 付款申請 / recon 嘅 project picker 即刻見到；狀態變 Closed / Cancelled 時
-- is_active = false，picker 唔再出，trigger 亦拒絕再用。

-- ---------------------------------------------------------------------------
-- 0. 模組：user_profiles.modules 加 'projects'，所有現有用戶預設開通
-- ---------------------------------------------------------------------------
alter table public.user_profiles drop constraint if exists user_profiles_modules_check;
alter table public.user_profiles add constraint user_profiles_modules_check
  check (modules <@ array['card','bank','claims','projects']::text[]);
alter table public.user_profiles
  alter column modules set default array['card','bank','claims','projects']::text[];
update public.user_profiles
   set modules = modules || array['projects']::text[]
 where not ('projects' = any(modules));

-- ---------------------------------------------------------------------------
-- 1. 公司對照
-- ---------------------------------------------------------------------------
create table if not exists public.project_companies (
  entity_code   text primary key,          -- = user_profiles.entity_scope / ns_subsidiaries.short_code
  code_letters  text not null unique check (code_letters ~ '^[A-Z]{2}$'), -- project code / Xero 單號用
  charge_to     text not null,             -- ns_project_codes.charge_to
  legal_name    text not null,
  xero_tenant_id text,
  is_active     boolean not null default true,
  sort_order    int not null default 0
);
insert into public.project_companies (entity_code, code_letters, charge_to, legal_name, sort_order) values
  ('SSHK', 'SS', 'SS',  'Social Strategy Hong Kong Limited', 1),
  ('PBHK', 'PB', 'PB',  'Photoblog.hk Limited', 2),
  ('704',  'PR', '704', '704 Production Limited', 3),
  ('JM',   'JM', 'JM',  'Jervois M Limited', 4),
  ('CLS',  'CG', 'CLS', 'CLS GARAGE', 5)
on conflict (entity_code) do nothing;
-- Xero 檢查：邊間公司嘅 sales invoice / bill 一定要有 project code
-- （CLS POS 零售單唔使 project；bill 預設唔強制，因為租金水電等日常開支冇 project）
alter table public.project_companies add column if not exists require_code_invoice boolean not null default true;
alter table public.project_companies add column if not exists require_code_bill boolean not null default false;
update public.project_companies set require_code_invoice = false where entity_code = 'CLS';

-- ---------------------------------------------------------------------------
-- 2. Project 性質規則（Settings 可改）
-- ---------------------------------------------------------------------------
create table if not exists public.project_type_rules (
  type_code            text primary key check (type_code ~ '^[A-Z]$'),
  name_zh              text not null,
  name_en              text not null,
  description          text,
  requires_quote       boolean not null default true,   -- 要填 Xero quote 號
  requires_amount      boolean not null default true,   -- 要填報價金額
  requires_end_date    boolean not null default true,   -- 要填完結日（用嚟自動 close）
  requires_monthly_fee boolean not null default false,  -- retainer 每月收費
  period_suffix        boolean not null default false,  -- code 尾加合約完結年，續約換尾碼
  max_months           int check (max_months is null or max_months > 0), -- 一個 code 最長幾多個月
  expiring_days        int not null default 30,         -- 完結前幾日轉 Expiring + email
  close_after_days     int not null default 60,         -- 完結後幾日自動 Closed（留時間收尾單）
  admin_only           boolean not null default false,  -- 只限 owner/admin 開
  is_active            boolean not null default true,
  sort_order           int not null default 0,
  updated_at           timestamptz not null default now()
);
insert into public.project_type_rules
  (type_code, name_zh, name_en, description, requires_quote, requires_amount, requires_end_date,
   requires_monthly_fee, period_suffix, max_months, expiring_days, close_after_days, admin_only, sort_order)
values
  ('C', 'Campaign／一次性', 'Campaign / one-off', '一次性項目，完成後收尾單即關閉',
   true, true, true, false, false, 12, 14, 90, false, 1),
  ('R', 'Retainer（月費）', 'Retainer', '按月收費合約；每一期合約一個 code，續約要按 Renew 出新 code',
   true, true, true, true, true, 12, 30, 60, false, 2),
  ('E', 'Event 活動', 'Event', '活動／展覽；完結日 = 活動最後一日',
   true, true, true, false, false, 6, 7, 60, false, 3),
  ('I', '集團內部', 'Internal / inter-company', '集團公司之間收費或內部項目',
   false, false, false, false, false, null, 30, 60, true, 4)
on conflict (type_code) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Register 主表 + 流水號 + 事件 log
-- ---------------------------------------------------------------------------
create table if not exists public.project_register (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  entity_code    text not null references public.project_companies(entity_code),
  type_code      text not null references public.project_type_rules(type_code),
  stem           text not null,            -- 例：P26SS-R0003（續約共用）
  seq            int not null,
  period_suffix  text,                     -- 例：27
  title          text not null check (length(trim(title)) >= 3),
  customer_name  text not null check (length(trim(customer_name)) >= 2),
  quote_no       text,
  quoted_amount  numeric(14,2) check (quoted_amount is null or quoted_amount >= 0),
  monthly_fee    numeric(14,2) check (monthly_fee is null or monthly_fee >= 0),
  start_date     date not null,
  end_date       date,
  status         text not null default 'Active'
                 check (status in ('Active','Expiring','Completed','Closed','Cancelled')),
  status_reason  text,
  parent_id      uuid references public.project_register(id),
  sales_user_id  uuid references auth.users(id),
  sales_name     text not null,
  sales_email    text,
  notes          text,
  created_by     uuid references auth.users(id) default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  closed_at      timestamptz,
  check (end_date is null or end_date >= start_date)
);
create index if not exists idx_project_register_entity on public.project_register (entity_code, status);
create index if not exists idx_project_register_sales on public.project_register (sales_user_id);
create index if not exists idx_project_register_stem on public.project_register (stem);
create unique index if not exists ux_project_register_quote
  on public.project_register (entity_code, upper(trim(quote_no)))
  where quote_no is not null and trim(quote_no) <> '' and status <> 'Cancelled';

create table if not exists public.project_code_sequences (
  entity_code text not null,
  type_code   text not null,
  yy          text not null,
  last_no     int not null default 0,
  primary key (entity_code, type_code, yy)
);

create table if not exists public.project_events (
  id          bigserial primary key,
  project_id  uuid not null references public.project_register(id) on delete cascade,
  action      text not null,   -- created / renewed / status / edited
  from_status text,
  to_status   text,
  detail      jsonb,
  actor       uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists idx_project_events_project on public.project_events (project_id, created_at);

-- 設定（單行）
create table if not exists public.project_register_settings (
  id             int primary key default 1 check (id = 1),
  notify_emails  text[] not null default array['accounts@pbhk.info']::text[],
  notify_sales   boolean not null default true,  -- 同時 cc 開 code 嘅 sales
  xero_check_enabled boolean not null default true,
  updated_at     timestamptz not null default now()
);
insert into public.project_register_settings (id) values (1) on conflict (id) do nothing;

-- Email outbox（edge function project-code-notify 發送）
create table if not exists public.project_notifications (
  id          bigserial primary key,
  project_id  uuid references public.project_register(id) on delete set null,
  kind        text not null,   -- created / renewed / expiring / closed / violations
  recipients  text[] not null,
  subject     text not null,
  body_html   text not null,
  status      text not null default 'pending' check (status in ('pending','sent','failed')),
  attempts    int not null default 0,
  error       text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create index if not exists idx_project_notifications_pending on public.project_notifications (status) where status = 'pending';

-- Xero 連線（token 只有 service role 讀得到）
create table if not exists public.xero_connections (
  tenant_id     text primary key,
  tenant_name   text,
  entity_code   text references public.project_companies(entity_code),
  refresh_token text not null,
  access_token  text,
  expires_at    timestamptz,
  connected_by  uuid,
  updated_at    timestamptz not null default now(),
  last_checked_at timestamptz
);
create table if not exists public.xero_oauth_states (
  state      text primary key,
  user_id    uuid not null,
  created_at timestamptz not null default now()
);

-- Xero 違規清單
create table if not exists public.project_code_violations (
  id           bigserial primary key,
  entity_code  text,
  tenant_id    text,
  doc_type     text not null,  -- ACCREC (invoice) / ACCRECCREDIT / ACCPAY (bill) / ACCPAYCREDIT
  doc_id       text not null,
  doc_number   text,
  reference    text,
  contact_name text,
  doc_date     date,
  total        numeric(14,2),
  doc_status   text,
  codes_found  text[],
  rule         text not null,  -- missing / unknown / closed / wrong_company / outside_period / multiple
  message      text not null,
  xero_url     text,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  resolved_at  timestamptz,
  notified_at  timestamptz,
  unique (doc_id, rule)
);
create index if not exists idx_pcv_open on public.project_code_violations (entity_code) where resolved_at is null;

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------
alter table public.project_companies enable row level security;
alter table public.project_type_rules enable row level security;
alter table public.project_register enable row level security;
alter table public.project_code_sequences enable row level security;
alter table public.project_events enable row level security;
alter table public.project_register_settings enable row level security;
alter table public.project_notifications enable row level security;
alter table public.xero_connections enable row level security;
alter table public.xero_oauth_states enable row level security;
alter table public.project_code_violations enable row level security;

drop policy if exists project_companies_read on public.project_companies;
create policy project_companies_read on public.project_companies for select to authenticated using (true);
drop policy if exists project_companies_write on public.project_companies;
create policy project_companies_write on public.project_companies for all to authenticated
  using (public.is_super_user()) with check (public.is_super_user());

drop policy if exists project_type_rules_read on public.project_type_rules;
create policy project_type_rules_read on public.project_type_rules for select to authenticated using (true);
drop policy if exists project_type_rules_write on public.project_type_rules;
create policy project_type_rules_write on public.project_type_rules for all to authenticated
  using (public.is_super_user()) with check (public.is_super_user());

-- 所有人睇得到自己公司嘅 project（揀 code 要用）；寫入只經 RPC
drop policy if exists project_register_read on public.project_register;
create policy project_register_read on public.project_register for select to authenticated
  using (public.user_can_see_entity(entity_code) or sales_user_id = auth.uid());

drop policy if exists project_events_read on public.project_events;
create policy project_events_read on public.project_events for select to authenticated
  using (exists (select 1 from public.project_register p where p.id = project_id
                 and (public.user_can_see_entity(p.entity_code) or p.sales_user_id = auth.uid())));

drop policy if exists project_register_settings_rw on public.project_register_settings;
create policy project_register_settings_rw on public.project_register_settings for all to authenticated
  using (public.is_super_user()) with check (public.is_super_user());

drop policy if exists project_notifications_read on public.project_notifications;
create policy project_notifications_read on public.project_notifications for select to authenticated
  using (public.is_super_user());

drop policy if exists project_code_violations_read on public.project_code_violations;
create policy project_code_violations_read on public.project_code_violations for select to authenticated
  using (public.is_super_user());
drop policy if exists project_code_violations_update on public.project_code_violations;
create policy project_code_violations_update on public.project_code_violations for update to authenticated
  using (public.is_super_user()) with check (public.is_super_user());
-- project_code_sequences / xero_connections / xero_oauth_states：無 policy = 只有 service role / security definer

-- ---------------------------------------------------------------------------
-- 5. Helper functions
-- ---------------------------------------------------------------------------
create or replace function public.pr_can_use_entity(p_entity text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_profiles u
     where u.user_id = auth.uid()
       and 'projects' = any(u.modules)
       and (u.role in ('owner','admin') or p_entity = any(coalesce(u.entity_scope, '{}')))
  )
$$;

create or replace function public.pr_status_for(p_type text, p_end date)
returns text language sql stable set search_path = public as $$
  select case
    when p_end is null then 'Active'
    when p_end + (r.close_after_days || ' days')::interval < current_date then 'Closed'
    when p_end - (r.expiring_days || ' days')::interval <= current_date then 'Expiring'
    else 'Active' end
  from public.project_type_rules r where r.type_code = p_type
$$;

create or replace function public.pr_h(p text)
returns text language sql immutable as $$
  select replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
$$;

create or replace function public.pr_fmt_money(p numeric)
returns text language sql immutable as $$
  select case when p is null then '—' else 'HK$' || to_char(p, 'FM999,999,999,990.00') end
$$;

-- 排 email：settings.notify_emails + (可選) sales
create or replace function public.pr_queue_email(p_project uuid, p_kind text, p_subject text, p_body text, p_include_sales boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare s record; p record; rcpt text[];
begin
  select * into s from public.project_register_settings where id = 1;
  select * into p from public.project_register where id = p_project;
  rcpt := coalesce(s.notify_emails, '{}');
  if p_include_sales and s.notify_sales and p.sales_email is not null and not (p.sales_email = any(rcpt)) then
    rcpt := rcpt || p.sales_email;
  end if;
  if array_length(rcpt, 1) is null then return; end if;
  insert into public.project_notifications (project_id, kind, recipients, subject, body_html)
  values (p_project, p_kind, rcpt, p_subject, p_body);
end $$;

create or replace function public.pr_email_body(p_id uuid, p_headline text)
returns text language sql stable security definer set search_path = public as $$
  select format(
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">'
    '<p>%s</p>'
    '<p style="font-size:22px;font-weight:bold;letter-spacing:1px;margin:12px 0">%s</p>'
    '<table cellpadding="4" style="border-collapse:collapse;font-size:13px">'
    '<tr><td style="color:#666">公司</td><td>%s</td></tr>'
    '<tr><td style="color:#666">性質</td><td>%s</td></tr>'
    '<tr><td style="color:#666">項目名稱</td><td>%s</td></tr>'
    '<tr><td style="color:#666">客戶</td><td>%s</td></tr>'
    '<tr><td style="color:#666">Quote</td><td>%s</td></tr>'
    '<tr><td style="color:#666">報價金額</td><td>%s</td></tr>'
    '<tr><td style="color:#666">每月收費</td><td>%s</td></tr>'
    '<tr><td style="color:#666">合約期</td><td>%s 至 %s</td></tr>'
    '<tr><td style="color:#666">狀態</td><td>%s</td></tr>'
    '<tr><td style="color:#666">Sales</td><td>%s</td></tr>'
    '</table>'
    '<p style="color:#666;font-size:12px">Xero invoice / bill 嘅 Reference 請寫：<b>%s / %s</b>。'
    '所有收入、成本、報銷、付款申請都要用同一個 code。</p></div>',
    public.pr_h(p_headline), p.code, c.legal_name, r.name_zh, public.pr_h(p.title), public.pr_h(p.customer_name),
    public.pr_h(coalesce(p.quote_no, '—')), public.pr_fmt_money(p.quoted_amount), public.pr_fmt_money(p.monthly_fee),
    to_char(p.start_date, 'YYYY-MM-DD'), coalesce(to_char(p.end_date, 'YYYY-MM-DD'), '—'),
    p.status, public.pr_h(p.sales_name), p.code, public.pr_h(p.sales_name))
  from public.project_register p
  join public.project_companies c on c.entity_code = p.entity_code
  join public.project_type_rules r on r.type_code = p.type_code
  where p.id = p_id
$$;

-- 同步去 ns_project_codes（picker 用）
create or replace function public.pr_sync_picker(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare p record; c record; sub text;
begin
  select * into p from public.project_register where id = p_id;
  select * into c from public.project_companies where entity_code = p.entity_code;
  select coalesce(full_name, name) into sub from public.ns_subsidiaries where short_code = p.entity_code limit 1;
  update public.ns_project_codes
     set project_name = p.title, customer_name = p.customer_name,
         is_active = p.status not in ('Closed','Cancelled')
   where project_id = p.code and internal_id is null;
  if not found then
    insert into public.ns_project_codes (entity_name, charge_to, project_id, project_name, customer_name, subsidiary, is_active)
    values (c.legal_name, c.charge_to, p.code, p.title, p.customer_name, coalesce(sub, c.legal_name),
            p.status not in ('Closed','Cancelled'));
  end if;
end $$;

-- 共用驗證
create or replace function public.pr_validate(
  p_type text, p_quote text, p_amount numeric, p_monthly numeric, p_start date, p_end date)
returns public.project_type_rules language plpgsql stable security definer set search_path = public as $$
declare r public.project_type_rules;
begin
  select * into r from public.project_type_rules where type_code = p_type and is_active;
  if r is null then raise exception '未知或已停用嘅 project 性質：%', p_type; end if;
  if r.admin_only and not public.is_super_user() then
    raise exception '「%」只可以由會計／admin 開', r.name_zh;
  end if;
  if p_start is null then raise exception '要填開始日期'; end if;
  if r.requires_quote and coalesce(trim(p_quote), '') = '' then
    raise exception '「%」要填 Xero quote 號（客人接受咗嘅報價單）', r.name_zh;
  end if;
  if r.requires_amount and coalesce(p_amount, 0) <= 0 then
    raise exception '「%」要填報價金額', r.name_zh;
  end if;
  if r.requires_monthly_fee and coalesce(p_monthly, 0) <= 0 then
    raise exception '「%」要填每月收費', r.name_zh;
  end if;
  if r.requires_end_date and p_end is null then
    raise exception '「%」要填完結日期', r.name_zh;
  end if;
  if p_end is not null and p_end < p_start then raise exception '完結日期唔可以早過開始日期'; end if;
  if r.max_months is not null and p_end is not null
     and p_end >= (p_start + (r.max_months || ' months')::interval)::date then
    raise exception '「%」一個 code 最長 % 個月；長過就分期，續約再開新 code', r.name_zh, r.max_months;
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------------
-- 6. RPC：開 code
-- ---------------------------------------------------------------------------
create or replace function public.project_register_create(
  p_entity text, p_type text, p_title text, p_customer text,
  p_quote_no text default null, p_quoted_amount numeric default null, p_monthly_fee numeric default null,
  p_start date default current_date, p_end date default null,
  p_sales_name text default null, p_notes text default null)
returns public.project_register
language plpgsql security definer set search_path = public as $$
declare
  r public.project_type_rules; c record; me record;
  v_yy text; v_seq int; v_stem text; v_suffix text; v_code text; v_row public.project_register;
begin
  if auth.uid() is null then raise exception '請先登入'; end if;
  if not public.pr_can_use_entity(p_entity) then
    raise exception '你冇權為 % 開 project code', p_entity;
  end if;
  select * into c from public.project_companies where entity_code = p_entity and is_active;
  if c is null then raise exception '未知公司：%', p_entity; end if;
  r := public.pr_validate(p_type, p_quote_no, p_quoted_amount, p_monthly_fee, p_start, p_end);
  select * into me from public.user_profiles where user_id = auth.uid();

  if coalesce(trim(p_quote_no), '') <> '' and exists (
      select 1 from public.project_register x
       where x.entity_code = p_entity and upper(trim(x.quote_no)) = upper(trim(p_quote_no))
         and x.status <> 'Cancelled') then
    raise exception 'Quote % 已經開過 project code，唔好重複開（續約請用 Renew）', p_quote_no;
  end if;

  if public.pr_status_for(p_type, p_end) = 'Closed' then
    raise exception '完結日期 % 已經過咗收尾期，唔可以開新 code（舊項目請聯絡會計）', p_end;
  end if;

  v_yy := to_char(current_date, 'YY');
  insert into public.project_code_sequences (entity_code, type_code, yy, last_no)
  values (p_entity, p_type, v_yy, 1)
  on conflict (entity_code, type_code, yy) do update set last_no = project_code_sequences.last_no + 1
  returning last_no into v_seq;

  v_stem := 'P' || v_yy || c.code_letters || '-' || p_type || lpad(v_seq::text, 4, '0');
  v_suffix := case when r.period_suffix then to_char(p_end, 'YY') end;
  v_code := v_stem || coalesce('-' || v_suffix, '');

  insert into public.project_register (code, entity_code, type_code, stem, seq, period_suffix, title,
      customer_name, quote_no, quoted_amount, monthly_fee, start_date, end_date, status,
      sales_user_id, sales_name, sales_email, notes)
  values (v_code, p_entity, p_type, v_stem, v_seq, v_suffix, trim(p_title), trim(p_customer),
      nullif(trim(p_quote_no), ''), p_quoted_amount, p_monthly_fee, p_start, p_end,
      public.pr_status_for(p_type, p_end),
      auth.uid(), coalesce(nullif(trim(p_sales_name), ''), me.full_name, me.email), me.email, p_notes)
  returning * into v_row;

  insert into public.project_events (project_id, action, to_status, detail)
  values (v_row.id, 'created', v_row.status, jsonb_build_object('code', v_code));
  perform public.pr_sync_picker(v_row.id);
  perform public.pr_queue_email(v_row.id, 'created',
    '[Project code] ' || v_code || ' — ' || v_row.title || '（' || v_row.customer_name || '）',
    public.pr_email_body(v_row.id, v_row.sales_name || ' 開咗新 project code：'));
  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- 7. RPC：續約（只限 period_suffix 類型，例如 retainer）
-- ---------------------------------------------------------------------------
create or replace function public.project_register_renew(
  p_parent uuid, p_quote_no text, p_quoted_amount numeric, p_monthly_fee numeric,
  p_start date, p_end date, p_notes text default null)
returns public.project_register
language plpgsql security definer set search_path = public as $$
declare par public.project_register; r public.project_type_rules; me record;
        v_code text; v_suffix text; v_row public.project_register;
begin
  select * into par from public.project_register where id = p_parent;
  if par is null then raise exception '搵唔到原 project'; end if;
  if not public.pr_can_use_entity(par.entity_code) then raise exception '你冇權續呢個 project'; end if;
  r := public.pr_validate(par.type_code, p_quote_no, p_quoted_amount, p_monthly_fee, p_start, p_end);
  if not r.period_suffix then raise exception '「%」唔使續約，請開新 project code', r.name_zh; end if;
  if par.status in ('Cancelled') then raise exception '已取消嘅 project 唔可以續約'; end if;
  if par.end_date is not null and p_start <= par.end_date then
    raise exception '新一期要喺 % 之後開始', par.end_date;
  end if;
  if exists (select 1 from public.project_register x where x.parent_id = p_parent and x.status <> 'Cancelled') then
    raise exception '% 已經續過約', par.code;
  end if;
  if coalesce(trim(p_quote_no), '') <> '' and exists (
      select 1 from public.project_register x where x.entity_code = par.entity_code
         and upper(trim(x.quote_no)) = upper(trim(p_quote_no)) and x.status <> 'Cancelled') then
    raise exception 'Quote % 已經用過', p_quote_no;
  end if;
  select * into me from public.user_profiles where user_id = auth.uid();
  v_suffix := to_char(p_end, 'YY');
  v_code := par.stem || '-' || v_suffix;
  if exists (select 1 from public.project_register where code = v_code) then
    raise exception '% 已存在（同一年完結嘅合約只可以有一個 code）', v_code;
  end if;

  insert into public.project_register (code, entity_code, type_code, stem, seq, period_suffix, title,
      customer_name, quote_no, quoted_amount, monthly_fee, start_date, end_date, status, parent_id,
      sales_user_id, sales_name, sales_email, notes)
  values (v_code, par.entity_code, par.type_code, par.stem, par.seq, v_suffix, par.title, par.customer_name,
      nullif(trim(p_quote_no), ''), p_quoted_amount, p_monthly_fee, p_start, p_end,
      public.pr_status_for(par.type_code, p_end), p_parent,
      auth.uid(), coalesce(me.full_name, par.sales_name), coalesce(me.email, par.sales_email), p_notes)
  returning * into v_row;

  insert into public.project_events (project_id, action, to_status, detail)
  values (v_row.id, 'renewed', v_row.status, jsonb_build_object('from', par.code, 'code', v_code));
  insert into public.project_events (project_id, action, detail)
  values (par.id, 'renewed_to', jsonb_build_object('code', v_code));
  perform public.pr_sync_picker(v_row.id);
  perform public.pr_queue_email(v_row.id, 'renewed',
    '[Project code 續約] ' || par.code || ' → ' || v_code || ' — ' || par.title,
    public.pr_email_body(v_row.id, v_row.sales_name || ' 續約：' || par.code || ' 嘅新一期 code：'));
  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- 8. RPC：改狀態
--   Sales（自己嘅 project）：Completed
--   Owner/Admin：任何狀態（Closed / Cancelled / 重開 Active）
-- ---------------------------------------------------------------------------
create or replace function public.project_register_set_status(p_id uuid, p_status text, p_reason text default null)
returns public.project_register
language plpgsql security definer set search_path = public as $$
declare p public.project_register; v_row public.project_register;
begin
  select * into p from public.project_register where id = p_id;
  if p is null then raise exception '搵唔到 project'; end if;
  if p_status not in ('Active','Expiring','Completed','Closed','Cancelled') then
    raise exception '未知狀態 %', p_status;
  end if;
  if not public.is_super_user() then
    if not (p.sales_user_id = auth.uid() and p_status = 'Completed' and p.status in ('Active','Expiring')) then
      raise exception '只有會計／admin 可以改做 %', p_status;
    end if;
  end if;
  if p_status = 'Cancelled' and coalesce(trim(p_reason), '') = '' then
    raise exception '取消要寫原因';
  end if;
  if p_status = 'Active' then
    p_status := public.pr_status_for(p.type_code, p.end_date);
    if p_status = 'Closed' then p_status := 'Active'; end if; -- 會計手動重開
  end if;
  update public.project_register
     set status = p_status, status_reason = nullif(trim(p_reason), ''), updated_at = now(),
         closed_at = case when p_status in ('Closed','Cancelled') then now() else null end
   where id = p_id returning * into v_row;
  insert into public.project_events (project_id, action, from_status, to_status, detail)
  values (p_id, 'status', p.status, p_status, jsonb_build_object('reason', p_reason));
  perform public.pr_sync_picker(p_id);
  return v_row;
end $$;

-- 會計改資料（名稱、客、金額、日期）
create or replace function public.project_register_update(
  p_id uuid, p_title text, p_customer text, p_quote_no text, p_quoted_amount numeric,
  p_monthly_fee numeric, p_start date, p_end date, p_notes text)
returns public.project_register
language plpgsql security definer set search_path = public as $$
declare p public.project_register; v_row public.project_register;
begin
  if not public.is_super_user() then raise exception '只有會計／admin 可以修改'; end if;
  select * into p from public.project_register where id = p_id;
  if p is null then raise exception '搵唔到 project'; end if;
  perform public.pr_validate(p.type_code, p_quote_no, p_quoted_amount, p_monthly_fee, p_start, p_end);
  if p.period_suffix is not null and to_char(p_end, 'YY') <> p.period_suffix then
    raise exception '完結年份要同 code 尾碼 -% 一致；跨年請續約開新 code', p.period_suffix;
  end if;
  update public.project_register set title = trim(p_title), customer_name = trim(p_customer),
         quote_no = nullif(trim(p_quote_no), ''), quoted_amount = p_quoted_amount, monthly_fee = p_monthly_fee,
         start_date = p_start, end_date = p_end, notes = p_notes, updated_at = now()
   where id = p_id returning * into v_row;
  insert into public.project_events (project_id, action, detail)
  values (p_id, 'edited', jsonb_build_object('before', to_jsonb(p) - 'id', 'after', to_jsonb(v_row) - 'id'));
  perform public.pr_sync_picker(p_id);
  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- 9. 每日自動更新狀態（pg_cron 03:30 HKT）
-- ---------------------------------------------------------------------------
create or replace function public.project_register_refresh_statuses()
returns jsonb language plpgsql security definer set search_path = public as $$
declare p record; n_exp int := 0; n_closed int := 0; v_new text;
begin
  for p in select x.*, r.name_zh from public.project_register x
             join public.project_type_rules r on r.type_code = x.type_code
            where x.status in ('Active','Expiring','Completed') and x.end_date is not null loop
    v_new := public.pr_status_for(p.type_code, p.end_date);
    if p.status = 'Completed' and v_new <> 'Closed' then continue; end if;
    if v_new = p.status then continue; end if;
    if v_new = 'Active' then continue; end if;  -- 唔自動倒退
    update public.project_register set status = v_new, updated_at = now(),
           closed_at = case when v_new = 'Closed' then now() else closed_at end
     where id = p.id;
    insert into public.project_events (project_id, action, from_status, to_status, detail, actor)
    values (p.id, 'status', p.status, v_new, jsonb_build_object('auto', true), null);
    perform public.pr_sync_picker(p.id);
    if v_new = 'Expiring' then
      n_exp := n_exp + 1;
      perform public.pr_queue_email(p.id, 'expiring',
        '[Project 即將完結] ' || p.code || ' — ' || p.title || '（' || to_char(p.end_date, 'YYYY-MM-DD') || '）',
        public.pr_email_body(p.id, case when p.type_code = 'R'
          then 'Retainer 即將到期。如客戶續約，請喺 CardRecon → Project Codes 按 Renew 開新一期 code：'
          else 'Project 即將完結，請準備收尾 invoice / bill：' end));
    elsif v_new = 'Closed' then
      n_closed := n_closed + 1;
      perform public.pr_queue_email(p.id, 'closed',
        '[Project 已關閉] ' || p.code || ' — ' || p.title,
        public.pr_email_body(p.id, 'Project 已自動關閉，之後唔可以再用呢個 code 入數：'), false);
    end if;
  end loop;
  return jsonb_build_object('expiring', n_exp, 'closed', n_closed);
end $$;

-- ---------------------------------------------------------------------------
-- 10. 查 code（Xero 檢查 + UI 用）
-- ---------------------------------------------------------------------------
create or replace function public.project_code_lookup(p_code text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object('found', true, 'source', 'register', 'code', p.code, 'entity_code', p.entity_code,
            'status', p.status, 'start_date', p.start_date, 'end_date', p.end_date,
            'close_after_days', r.close_after_days, 'title', p.title, 'customer_name', p.customer_name,
            'type_code', p.type_code)
       from public.project_register p join public.project_type_rules r on r.type_code = p.type_code
      where p.code = upper(trim(p_code))),
    (select jsonb_build_object('found', true, 'source', 'legacy', 'code', n.project_id,
            'entity_code', (select entity_code from public.project_companies c where c.charge_to = split_part(n.charge_to, '-', 1) limit 1),
            'status', case when n.is_active then 'Active' else 'Closed' end,
            'title', n.project_name, 'customer_name', n.customer_name)
       from public.ns_project_codes n where n.project_id = upper(trim(p_code)) order by n.is_active desc limit 1),
    jsonb_build_object('found', false, 'code', upper(trim(p_code))))
$$;

-- ---------------------------------------------------------------------------
-- 11. Ban：CardRecon 入面用 project code 一律檢查（只喺改 code 時檢查，舊紀錄唔受影響）
-- ---------------------------------------------------------------------------
create or replace function public.enforce_project_code()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_col text := tg_argv[0]; v_new text; v_old text; v_reg record;
begin
  v_new := nullif(trim(to_jsonb(new) ->> v_col), '');
  if tg_op = 'UPDATE' then v_old := nullif(trim(to_jsonb(old) ->> v_col), ''); end if;
  if v_new is null or v_new is not distinct from v_old then return new; end if;
  select code, status into v_reg from public.project_register where code = upper(v_new);
  if v_reg.code is not null and v_reg.status in ('Closed','Cancelled') then
    raise exception 'Project code % 已%，唔可以再用。如需重開請聯絡會計。', v_new,
      case v_reg.status when 'Closed' then '關閉' else '取消' end
      using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.ns_project_codes where project_id = v_new and is_active) then
    raise exception 'Project code % 唔存在或已停用 — 請喺 Project Codes 頁面取 code。', v_new
      using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists trg_enforce_project_code on public.claim_lines;
create trigger trg_enforce_project_code before insert or update of project_code on public.claim_lines
  for each row execute function public.enforce_project_code('project_code');
drop trigger if exists trg_enforce_project_code on public.meta_invoices;
create trigger trg_enforce_project_code before insert or update of project_code on public.meta_invoices
  for each row execute function public.enforce_project_code('project_code');
drop trigger if exists trg_enforce_project_code on public.meta_invoice_splits;
create trigger trg_enforce_project_code before insert or update of project_code on public.meta_invoice_splits
  for each row execute function public.enforce_project_code('project_code');
drop trigger if exists trg_enforce_project_code on public.accounting_lines;
create trigger trg_enforce_project_code before insert or update of ns_project_code on public.accounting_lines
  for each row execute function public.enforce_project_code('ns_project_code');

-- ---------------------------------------------------------------------------
-- 12. 權限
-- ---------------------------------------------------------------------------
revoke all on function public.pr_can_use_entity(text) from anon, public;
revoke all on function public.pr_queue_email(uuid, text, text, text, boolean) from anon, authenticated, public;
revoke all on function public.pr_email_body(uuid, text) from anon, authenticated, public;
revoke all on function public.pr_sync_picker(uuid) from anon, authenticated, public;
revoke all on function public.pr_validate(text, text, numeric, numeric, date, date) from anon, public;
revoke all on function public.project_register_refresh_statuses() from anon, authenticated, public;
revoke all on function public.project_register_create(text, text, text, text, text, numeric, numeric, date, date, text, text) from anon, public;
revoke all on function public.project_register_renew(uuid, text, numeric, numeric, date, date, text) from anon, public;
revoke all on function public.project_register_set_status(uuid, text, text) from anon, public;
revoke all on function public.project_register_update(uuid, text, text, text, numeric, numeric, date, date, text) from anon, public;
revoke all on function public.project_code_lookup(text) from anon, public;
grant execute on function public.pr_can_use_entity(text) to authenticated;
grant execute on function public.pr_validate(text, text, numeric, numeric, date, date) to authenticated;
grant execute on function public.project_register_create(text, text, text, text, text, numeric, numeric, date, date, text, text) to authenticated;
grant execute on function public.project_register_renew(uuid, text, numeric, numeric, date, date, text) to authenticated;
grant execute on function public.project_register_set_status(uuid, text, text) to authenticated;
grant execute on function public.project_register_update(uuid, text, text, text, numeric, numeric, date, date, text) to authenticated;
grant execute on function public.project_code_lookup(text) to authenticated, service_role;
grant execute on function public.project_register_refresh_statuses() to service_role;
grant execute on function public.pr_queue_email(uuid, text, text, text, boolean) to service_role;

-- Xero 連線清單（唔露 token）
create or replace function public.xero_connections_list()
returns table (tenant_id text, tenant_name text, entity_code text, updated_at timestamptz, last_checked_at timestamptz)
language sql stable security definer set search_path = public as $$
  select tenant_id, tenant_name, entity_code, updated_at, last_checked_at
    from public.xero_connections where public.is_super_user()
$$;
revoke all on function public.xero_connections_list() from anon, public;
grant execute on function public.xero_connections_list() to authenticated;

create or replace function public.xero_connection_set_entity(p_tenant text, p_entity text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super_user() then raise exception 'admin only'; end if;
  update public.xero_connections set entity_code = p_entity where tenant_id = p_tenant;
  update public.project_companies set xero_tenant_id = p_tenant where entity_code = p_entity;
end $$;
revoke all on function public.xero_connection_set_entity(text, text) from anon, public;
grant execute on function public.xero_connection_set_entity(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 13. pg_cron
--   03:30 HKT 更新狀態；每 10 分鐘送 email；04:00 HKT Xero 檢查
-- ---------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from cron.job where jobname = 'project-register-status-daily') then
    perform cron.unschedule('project-register-status-daily'); end if;
  if exists (select 1 from cron.job where jobname = 'project-code-notify-10min') then
    perform cron.unschedule('project-code-notify-10min'); end if;
  if exists (select 1 from cron.job where jobname = 'xero-project-check-daily') then
    perform cron.unschedule('xero-project-check-daily'); end if;
end $$;

select cron.schedule('project-register-status-daily', '30 19 * * *',
  $cron$ select public.project_register_refresh_statuses(); $cron$);

select cron.schedule('project-code-notify-10min', '*/10 * * * *', $cron$
  select net.http_post(
    url := 'https://nyooltqhmrdnippfikes.supabase.co/functions/v1/project-code-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55b29sdHFobXJkbmlwcGZpa2VzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwMDg3NDMsImV4cCI6MjEwMTU4NDc0M30.QLzGYDOfuQEvgXauxHcazEbnMIFrelBt0QhD7p9BWZU',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_sync_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  )
  where exists (select 1 from public.project_notifications where status = 'pending');
$cron$);

select cron.schedule('xero-project-check-daily', '0 20 * * *', $cron$
  select net.http_post(
    url := 'https://nyooltqhmrdnippfikes.supabase.co/functions/v1/xero-project-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55b29sdHFobXJkbmlwcGZpa2VzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwMDg3NDMsImV4cCI6MjEwMTU4NDc0M30.QLzGYDOfuQEvgXauxHcazEbnMIFrelBt0QhD7p9BWZU',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_sync_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
$cron$);
