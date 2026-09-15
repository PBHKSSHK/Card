-- NetSuite OneWorld：vendor 屬於一個 primary subsidiary (+ 可選 secondary)，
-- bill 只可以開喺呢啲 subsidiary，否則 400 "Invalid combination of entity and subsidiary"
-- (PAY-202609-0003 Wisers 只屬 PBHK/JM，張單係 SSHK)。
-- mirror vendor 所屬 subsidiaries 落 ns_vendor_directory，等付款申請表格即刻警告、
-- Export preview 擋住。由 netsuite-sync-vendors (v4) 填。
alter table public.ns_vendor_directory
  add column if not exists subsidiary_ids integer[] not null default '{}',
  add column if not exists subsidiary_codes text[] not null default '{}';
comment on column public.ns_vendor_directory.subsidiary_codes is
  'NetSuite vendor 所屬 subsidiaries (primary + secondary) 嘅 short code，例如 {PBHK,JM}；bill 只可以開喺呢啲 subsidiary';
