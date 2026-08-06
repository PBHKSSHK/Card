-- migration_subsidiary_full_name.sql
-- 目的：align Subsidiary 同 Department 欄位嘅 emit format 跟真 NetSuite export 一致
--
-- 真 NetSuite 格式：
--   Subsidiary = "Photoblog.hk Limited : 704 Production Limited"  (parent : child)
--   Subsidiary = "Photoblog.hk Limited"                            (parent only for PBHK)
--   Department = "Production" / "Management" / "ePR Team" ...     (descriptive 名稱, 唔係 charge_to code)
--
-- 來源：Google Sheet "charge to" worksheet Col C (Subsidiary) + Col D (Department)
--
-- 1) 加 subsidiary_full_name column 去 ns_departments
-- 2) 按 Sheet 內容 populate
-- 3) 為「短 subsidiary_name」（child only）建 lookup → full path

ALTER TABLE ns_departments
  ADD COLUMN IF NOT EXISTS subsidiary_full_name TEXT;

COMMENT ON COLUMN ns_departments.subsidiary_full_name IS
  'Full NetSuite subsidiary hierarchical path used in CSV exports, e.g. "Photoblog.hk Limited : 704 Production Limited"';

-- 來源 Sheet 內容（charge_to → subsidiary_full_name, name）
-- 704 Production Limited 是 PBHK 下既 child
UPDATE ns_departments SET subsidiary_full_name = 'Photoblog.hk Limited : 704 Production Limited'
  WHERE charge_to IN ('704', '704-Admin', '704-Mgt');

-- CLS GARAGE 是 PBHK 下既 child
UPDATE ns_departments SET subsidiary_full_name = 'Photoblog.hk Limited : CLS GARAGE'
  WHERE charge_to IN ('CLS', 'CLS-Admin', 'CLS-Mgt');

-- Jervois M Limited 是 PBHK 下既 child
UPDATE ns_departments SET subsidiary_full_name = 'Photoblog.hk Limited : Jervois M Limited'
  WHERE charge_to IN ('JM', 'JM-Admin', 'JM-Mgt');

-- Social Strategy Hong Kong Limited 是 PBHK 下既 child
UPDATE ns_departments SET subsidiary_full_name = 'Photoblog.hk Limited : Social Strategy Hong Kong Limited'
  WHERE charge_to IN ('SS', 'SS-Admin', 'SS-Mgt', 'SS-JM', 'SS-Prod', 'SS-JS');

-- Photoblog.hk Limited 是 parent
UPDATE ns_departments SET subsidiary_full_name = 'Photoblog.hk Limited'
  WHERE charge_to IN ('PB-AccSer', 'PB-Admin', 'PB-IT', 'PB-Mgt', 'PB-Prod', 'PB-ePR', 'Ext', 'JS');

-- 確保 ns_subsidiaries 都有埋（用作 dropdown 顯示）
ALTER TABLE ns_subsidiaries
  ADD COLUMN IF NOT EXISTS full_name TEXT;

UPDATE ns_subsidiaries SET full_name = 'Photoblog.hk Limited' WHERE name = 'Photoblog.hk Limited';
UPDATE ns_subsidiaries SET full_name = 'Photoblog.hk Limited : 704 Production Limited' WHERE name = '704 Production Limited';
UPDATE ns_subsidiaries SET full_name = 'Photoblog.hk Limited : CLS GARAGE' WHERE name = 'CLS GARAGE';
UPDATE ns_subsidiaries SET full_name = 'Photoblog.hk Limited : Jervois M Limited' WHERE name = 'Jervois M Limited';
UPDATE ns_subsidiaries SET full_name = 'Photoblog.hk Limited : Social Strategy Hong Kong Limited' WHERE name = 'Social Strategy Hong Kong Limited';

-- Verify
SELECT charge_to, name AS dept_name, subsidiary_name AS sub_short, subsidiary_full_name AS sub_full
FROM ns_departments
WHERE subsidiary_full_name IS NOT NULL
ORDER BY entity_code, charge_to;
