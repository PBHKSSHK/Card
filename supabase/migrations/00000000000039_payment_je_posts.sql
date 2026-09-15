-- 預付款 / 應計 JE 合併：同一次入數、同 subsidiary、同日期、同類 (accrual / prepaid)
-- 嘅明細行合成一張 JE (例如 PAY-0010/0011/0012 每月攤銷同日 → 一張 JE 三組 transaction)。
-- 幂等靠呢張表：記低每張單每個日期已經入咗邊張 JE，重按只會補漏，唔會重複入。
create table if not exists public.payment_je_posts (
  batch_id     uuid not null references public.claim_batches(id) on delete cascade,
  je_date      date not null,
  kind         text not null check (kind in ('accrual', 'prepaid')),
  external_id  text not null,
  netsuite_id  text,
  amount       numeric(14, 2),
  posted_at    timestamptz not null default now(),
  posted_by_user_id uuid,
  primary key (batch_id, je_date, kind)
);
create index if not exists idx_payment_je_posts_external on public.payment_je_posts (external_id);
alter table public.payment_je_posts enable row level security;
drop policy if exists "payment_je_posts_read" on public.payment_je_posts;
create policy "payment_je_posts_read" on public.payment_je_posts
  for select to authenticated using (public.is_super_user());
-- 寫入只由 Edge Function (service role) 做
