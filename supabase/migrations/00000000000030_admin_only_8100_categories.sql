-- 供應商付款申請：Admin/Owner 申請時 Category 增加 8100 a/c 選擇。
-- expense_categories 加 admin_only flag — true 嘅 rows 只喺供應商付款申請
-- (owner/admin) 嘅 Category dropdown 出現；credit card recon / 一般 claims 唔會見到。
-- Label 顯示 / 審批 inbox / Bills posting (category → account → COA internal id)
-- 全部行現有邏輯，唔使改。
alter table public.expense_categories
  add column if not exists admin_only boolean not null default false;

-- 補上未 map 嘅 active 8100 系列 COA 科目 (其餘 11 個 8100 科目已有對應 category)
insert into public.expense_categories
  (category_key, label_zh, label_en, ns_account_number, sort_order, is_active, admin_only)
values
  ('ac_81000021', '商業登記費',    'Business Registration Fee',      '81000021', 101, true, true),
  ('ac_81000030', '消耗品',        'Consumable Stores',              '81000030', 102, true, true),
  ('ac_81000054', '保險',          'Insurance',                      '81000054', 103, true, true),
  ('ac_81000060', '車輛開支',      'Motor Vehicle Running Expenses', '81000060', 104, true, true),
  ('ac_81000066', '郵費 / 速遞',   'Postage and Courier',            '81000066', 105, true, true),
  ('ac_81000068', '製作管理費',    'Production Management Fee',      '81000068', 106, true, true),
  ('ac_81000075', '維修保養',      'Repairs and Maintenance',        '81000075', 107, true, true),
  ('ac_81000077', '樣品費',        'Sample Fee',                     '81000077', 108, true, true),
  ('ac_81000093', '電話 / 傳真',   'Telephone and Fax',              '81000093', 109, true, true),
  ('ac_81000100', 'Warranty 保養', 'Warranty',                       '81000100', 110, true, true)
on conflict (category_key) do update
  set ns_account_number = excluded.ns_account_number,
      admin_only = true,
      is_active = true;
