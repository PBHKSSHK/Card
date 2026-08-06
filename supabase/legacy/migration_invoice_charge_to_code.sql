-- migration_invoice_charge_to_code.sql
-- 目的：擴展 meta_invoices 加 charge_to_code 欄位，俾用戶可以揀「charge to 表」入面
--      sub-department (e.g. "PB-IT", "704-Mgt", "SS-Prod") 而非淨係 entity (PBHK/704/SSHK).
-- 同時為 accounting_lines.ns_charge_to 加 index/comment.

ALTER TABLE meta_invoices
  ADD COLUMN IF NOT EXISTS charge_to_code TEXT;

COMMENT ON COLUMN meta_invoices.charge_to_code IS
  '指向 ns_departments.charge_to (e.g. "PB-IT", "704-Mgt"). 用嚟 emit NetSuite Department + Subsidiary (parent:child)';

-- Backfill：根據 charge_to_entity 推導 default charge_to_code
-- PBHK 預設 → PB-AccSer; 704 → 704; CLS → CLS; SSHK → SS; JM → JM
UPDATE meta_invoices SET charge_to_code = 'PB-AccSer' WHERE charge_to_entity = 'PBHK' AND charge_to_code IS NULL;
UPDATE meta_invoices SET charge_to_code = '704'       WHERE charge_to_entity = '704'  AND charge_to_code IS NULL;
UPDATE meta_invoices SET charge_to_code = 'CLS'       WHERE charge_to_entity = 'CLS'  AND charge_to_code IS NULL;
UPDATE meta_invoices SET charge_to_code = 'SS'        WHERE charge_to_entity = 'SSHK' AND charge_to_code IS NULL;
UPDATE meta_invoices SET charge_to_code = 'JM'        WHERE charge_to_entity = 'JM'   AND charge_to_code IS NULL;
UPDATE meta_invoices SET charge_to_code = 'Ext'       WHERE charge_to_entity = 'EXT'  AND charge_to_code IS NULL;
UPDATE meta_invoices SET charge_to_code = 'JS'        WHERE charge_to_entity = 'JS'   AND charge_to_code IS NULL;

-- Verify
SELECT charge_to_entity, charge_to_code, COUNT(*)
FROM meta_invoices
GROUP BY 1, 2
ORDER BY 1, 2;
