-- ============================================================================
-- Reference-data seed: NetSuite chart of accounts, subsidiaries, departments,
-- employees, vendors, customers, and CC-account mapping, all scoped to the
-- Photoblog.hk Limited group (PBHK, SSHK, CLS Garage, Jervois M, 704
-- Production, Go Asia). Copied verbatim from the source repo's production
-- reference data (supabase/06b_data.sql + migration_ns_intercompany_accounts.sql).
--
-- NOTE: ns_departments.charge_to (the per-entity department code like
-- "PB-IT"/"704-Mgt"/"SS-Prod") was populated by hand from an external Google
-- Sheet and was never captured in any committed migration in the source repo
-- (acknowledged gap — see migration_security_integrity_fixes.sql FIX6). Only
-- (internal_id, name) is seeded below; charge_to/entity_code/subsidiary_name
-- must be filled in via Settings → Reference Data after a NetSuite resync.
-- ============================================================================

-- ---- Chart of Accounts ----
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (630, '11010011', 'Computer Equipments - Cost', '', 'Fixed Asset', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (632, '11010021', 'Furniture and Fixtures - Cost', '', 'Fixed Asset', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (636, '11010041', 'Office Equipment - Cost', '', 'Fixed Asset', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (841, '22005010', 'Prepaid Expenses', '', 'Other Current Asset', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (534, '23001010', 'Accounts Receivable - General', '23000000 - Accounts Receivable:23001010 - Accounts Receivable - General', 'Accounts Receivable', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (843, '24002010', 'Temporary Account', '', 'Other Current Asset', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (844, '25000010', 'Amount Due From Others', '', 'Other Current Asset', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (648, '25000015', 'Amount Due From Social Strategy Hong Kong Ltd. (To PB)', '25000013 - Amount Due From Grouped Company (To PB):25000015 - Amount Due From Social Strategy Hong Kong Ltd. (To PB)', 'Accounts Receivable', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (1168, '25000022', 'Amount Due From CLS Garage (To PB)', '25000013 - Amount Due From Grouped Company (To PB):25000022 - Amount Due From CLS Garage (To PB)', 'Accounts Receivable', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (1169, '25000024', 'Amount Due From Jervois M (To PB)', '25000013 - Amount Due From Grouped Company (To PB):25000024 - Amount Due From Jervois M (To PB)', 'Accounts Receivable', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (1170, '25000025', 'Amount Due From 704 Production (To PB)', '25000013 - Amount Due From Grouped Company (To PB):25000025 - Amount Due From 704 Production (To PB)', 'Accounts Receivable', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (1208, '25000030', 'Amount Due From Jervois Solution', '', 'Other Current Asset', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (1231, '25000031', 'Amount Due From Go Asia Plus Travel (To PB)', '25000013 - Amount Due From Grouped Company (To PB):25000031 - Amount Due From Go Asia Plus Travel (To PB)', 'Accounts Receivable', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (114, '33000010', 'Accounts Payable', '', 'Accounts Payable', 'Unpaid or unapplied vendor bills or credits', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (681, '34001012', '4150 - HSBC Credit Card (Rex) - PBHK', '34001000 - Business credit card:34001012 - 4150 - HSBC Credit Card (Rex) - PBHK', 'Credit Card', 'Rex Wong', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (686, '34001017', '92003 - AE Credit Card (Alex) - PBHK', '34001000 - Business credit card:34001017 - 92003 - AE Credit Card (Alex) - PBHK', 'Credit Card', 'Alex Lo', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (1167, '34001018', 'HSBC Credit Card (Kenneth) - CLS Garage', '34001000 - Business credit card:34001018 - HSBC Credit Card (Kenneth) - CLS Garage', 'Credit Card', 'Kenneth Yung', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (1197, '34001020', 'HSBC Credit Card (Alex) - CLS Garage', '34001000 - Business credit card:34001020 - HSBC Credit Card (Alex) - CLS Garage', 'Credit Card', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (1207, '34001021', '02003 - AE Credit Card (Nok) - PBHK', '34001000 - Business credit card:34001021 - 02003 - AE Credit Card (Nok) - PBHK', 'Credit Card', 'Nok', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (687, '35002014', 'Amt Due To Photoblog.hk Limited (from SSHK)', '35002010 - Amount Due To Photoblog.hk Limited:35002014 - Amt Due To Photoblog.hk Limited (from SSHK)', 'Accounts Payable', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (690, '35002016', 'Amt Due To Photoblog.hk Limited (from CLS Garage)', '35002010 - Amount Due To Photoblog.hk Limited:35002016 - Amt Due To Photoblog.hk Limited (from CLS Garage)', 'Accounts Payable', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (1179, '35002022', 'Amt Due To Photoblog.hk Limited (from JM)', '35002010 - Amount Due To Photoblog.hk Limited:35002022 - Amt Due To Photoblog.hk Limited (from JM)', 'Accounts Payable', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (1184, '35002023', 'Amt Due To Photoblog.hk Limited (from 704 Production)', '35002010 - Amount Due To Photoblog.hk Limited:35002023 - Amt Due To Photoblog.hk Limited (from 704 Production)', 'Accounts Payable', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (1232, '35002024', 'Amt Due To Photoblog.hk Limited (from Go Asia)', '', 'Accounts Payable', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (866, '37001010', 'Accrued Expenses -General', '', 'Other Current Liability', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (314, '64000009', 'Other Income', '', 'Other Income', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (735, '70000012', 'Cost - Advertisement', '70000008 - Cost of Services:70000012 - Cost - Advertisement', 'Cost of Goods Sold', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (737, '70000020', 'Cost - Copywriting &Translation', '', 'Cost of Goods Sold', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (739, '70000028', 'Cost - Make Up & Hair', '', 'Cost of Goods Sold', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (740, '70000032', 'Cost - Others', '70000008 - Cost of Services:70000032 - Cost - Others', 'Cost of Goods Sold', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (741, '70000036', 'Cost - Social Media Management', '', 'Cost of Goods Sold', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (744, '70000048', 'Cost - Travel & Transportation', '70000008 - Cost of Services:70000048 - Cost - Travel & Transportation', 'Cost of Goods Sold', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (746, '70000056', 'Cost - Venue Rental', '', 'Cost of Goods Sold', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (747, '70000060', 'Cost - Photographic & Video Making', '', 'Cost of Goods Sold', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (567, '81000009', 'Advertising & Marketing', '81000000 - Department Cost:81000009 - Advertising & Marketing', 'Expense', 'Advertising, marketing, graphic design', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (571, '81000021', 'Business Registration Fee', '', 'Expense', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (573, '81000027', 'Computer & Computer Accessories', '81000000 - Department Cost:81000027 - Computer & Computer Accessories', 'Expense', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (574, '81000030', 'Consumable Stores', '81000000 - Department Cost:81000030 - Consumable Stores', 'Expense', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (580, '81000048', 'Entertainment', '', 'Expense', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (584, '81000060', 'Motor Vehicle Running Expenses', '', 'Expense', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (1213, '81000064', 'Overseas Travelling', '', 'Expense', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (586, '81000066', 'Postage and Courier', '', 'Expense', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (1158, '81000068', 'Production Management Fee', '', 'Expense', 'Production Management Fee', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (587, '81000069', 'Professional Fee', '', 'Expense', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (589, '81000075', 'Repairs and Maintenance', '', 'Expense', 'Incidental repairs and maintenance of business assets', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (591, '81000081', 'Staff Messing, Training, Welfare', '81000000 - Department Cost:81000081 - Staff Messing, Training, Welfare', 'Expense', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (593, '81000087', 'Stationery and Printing', '81000000 - Department Cost:81000087 - Stationery and Printing', 'Expense', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (594, '81000090', 'Sundry Expenses', '', 'Expense', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (595, '81000093', 'Telephone and Fax', '81000000 - Department Cost:81000093 - Telephone and Fax', 'Expense', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (596, '81000096', 'Travelling & Transportation', '81000000 - Department Cost:81000096 - Travelling & Transportation', 'Expense', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (597, '81000099', 'Website', '81000000 - Department Cost:81000099 - Website', 'Expense', '', 'HKD') on conflict (account_number) do nothing;
insert into ns_chart_of_accounts (internal_id, account_number, account_name, full_name, account_type, description, currency) values (601, '85000002', 'Bank Charges', '', 'Other Expense', '', 'HKD') on conflict (account_number) do nothing;

-- ---- Subsidiaries ----
insert into ns_subsidiaries (internal_id, name, short_code, intercompany_ar_account, intercompany_ap_account, intercompany_ar_customer, intercompany_ap_vendor) values (1, 'Photoblog.hk Limited', 'PBHK', NULL, NULL, NULL, NULL) on conflict (name) do nothing;
insert into ns_subsidiaries (internal_id, name, short_code, intercompany_ar_account, intercompany_ap_account, intercompany_ar_customer, intercompany_ap_vendor) values (2, 'Social Strategy Hong Kong Limited', 'SSHK', '25000015', '35002014', 'C10000190', 'V10000353') on conflict (name) do nothing;
insert into ns_subsidiaries (internal_id, name, short_code, intercompany_ar_account, intercompany_ap_account, intercompany_ar_customer, intercompany_ap_vendor) values (5, 'CLS GARAGE', 'CLS', '25000022', '35002016', 'C10000305', 'V10000556') on conflict (name) do nothing;
insert into ns_subsidiaries (internal_id, name, short_code, intercompany_ar_account, intercompany_ap_account, intercompany_ar_customer, intercompany_ap_vendor) values (7, 'Jervois M Limited', 'JM', '25000024', '35002022', 'C10000306', 'V10000615') on conflict (name) do nothing;
insert into ns_subsidiaries (internal_id, name, short_code, intercompany_ar_account, intercompany_ap_account, intercompany_ar_customer, intercompany_ap_vendor) values (8, '704 Production Limited', '704', '25000025', '35002023', 'C10000321', 'V10000662') on conflict (name) do nothing;
insert into ns_subsidiaries (internal_id, name, short_code, intercompany_ar_account, intercompany_ap_account, intercompany_ar_customer, intercompany_ap_vendor) values (99, 'Go Asia Plus Travel & Tours Co. Limited', 'GoAsia', '25000031', '35002024', 'C10000533', NULL) on conflict (name) do nothing;

update ns_subsidiaries set full_name = 'Photoblog.hk Limited' where name = 'Photoblog.hk Limited';
update ns_subsidiaries set full_name = 'Photoblog.hk Limited : 704 Production Limited' where name = '704 Production Limited';
update ns_subsidiaries set full_name = 'Photoblog.hk Limited : CLS GARAGE' where name = 'CLS GARAGE';
update ns_subsidiaries set full_name = 'Photoblog.hk Limited : Jervois M Limited' where name = 'Jervois M Limited';
update ns_subsidiaries set full_name = 'Photoblog.hk Limited : Social Strategy Hong Kong Limited' where name = 'Social Strategy Hong Kong Limited';

-- ---- Departments (generic names only — see file header note on charge_to) ----
insert into ns_departments (internal_id, name) values (3, 'Account Servicing') on conflict (name) do nothing;
insert into ns_departments (internal_id, name) values (6, 'Admin, Finance, HR') on conflict (name) do nothing;
insert into ns_departments (internal_id, name) values (13, 'Commercial Team') on conflict (name) do nothing;
insert into ns_departments (internal_id, name) values (14, 'Creative Team') on conflict (name) do nothing;
insert into ns_departments (internal_id, name) values (10, 'Editorial') on conflict (name) do nothing;
insert into ns_departments (internal_id, name) values (12, 'ePR Team') on conflict (name) do nothing;
insert into ns_departments (internal_id, name) values (11, 'IT Department') on conflict (name) do nothing;
insert into ns_departments (internal_id, name) values (15, 'JM Team') on conflict (name) do nothing;
insert into ns_departments (internal_id, name) values (9, 'Management') on conflict (name) do nothing;
insert into ns_departments (internal_id, name) values (7, 'Monitoring and Seeding') on conflict (name) do nothing;
insert into ns_departments (internal_id, name) values (2, 'Production') on conflict (name) do nothing;
insert into ns_departments (internal_id, name) values (8, 'Sales') on conflict (name) do nothing;
insert into ns_departments (internal_id, name) values (16, 'Travel Agency') on conflict (name) do nothing;

-- Activates once charge_to is populated via Settings → Reference Data (see header note).
update ns_departments set subsidiary_full_name = 'Photoblog.hk Limited : 704 Production Limited'
  where charge_to in ('704', '704-Admin', '704-Mgt');
update ns_departments set subsidiary_full_name = 'Photoblog.hk Limited : CLS GARAGE'
  where charge_to in ('CLS', 'CLS-Admin', 'CLS-Mgt');
update ns_departments set subsidiary_full_name = 'Photoblog.hk Limited : Jervois M Limited'
  where charge_to in ('JM', 'JM-Admin', 'JM-Mgt');
update ns_departments set subsidiary_full_name = 'Photoblog.hk Limited : Social Strategy Hong Kong Limited'
  where charge_to in ('SS', 'SS-Admin', 'SS-Mgt', 'SS-JM', 'SS-Prod', 'SS-JS');
update ns_departments set subsidiary_full_name = 'Photoblog.hk Limited'
  where charge_to in ('PB-AccSer', 'PB-Admin', 'PB-IT', 'PB-Mgt', 'PB-Prod', 'PB-ePR', 'Ext', 'JS');

-- ---- Employees ----
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (1868, 'PBL0008', 'Lam, Suk Man Susanna', 'susanna.lam@pbhk.info', 'Photoblog.hk Limited', 'Admin, Finance, HR') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (2937, 'PBT0004', 'Tam, Suet Yee C', '', 'Photoblog.hk Limited', 'Admin, Finance, HR') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (4154, 'PBL0014', 'Lo, Tsz Ching Yannese', 'yannese.lo@pbhk.info', 'Photoblog.hk Limited', 'Admin, Finance, HR') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (106, 'PBC0002', 'Chan, Wai Nok', 'nok@sshk.ltd', 'Photoblog.hk Limited', 'Management') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (122, 'PBW0001', 'Wong, Chi Fung', 'rex@pbhk.info', 'Photoblog.hk Limited', 'Management') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (122, 'PBW0001', 'Wong, Chi Fung', 'rex@sshk.ltd', 'Photoblog.hk Limited : Social Strategy Hong Kong Limited', 'Management') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (122, 'PBW0001', 'Wong, Chi Fung', 'rex@704production.com', 'Photoblog.hk Limited : 704 Production Limited', 'Management') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (116, 'PBL0006', 'Lo, King Yip Alex', 'alex@sshk.ltd', 'Photoblog.hk Limited', 'Management') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (124, 'PBY0002', 'Yung, Hon Yi Kenneth', 'kenneth@clsgarage.com', 'Photoblog.hk Limited', 'Management') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (3647, 'PBY0004', 'Yeung, Wing Chi Gigi', '', 'Photoblog.hk Limited', 'Production') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (3758, 'PBC0009', 'Chan, Ka Yiu Isaac', '', 'Photoblog.hk Limited', 'Production') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (3583, 'PBK0001', 'Kwan, Pui In Maggie', '', 'Photoblog.hk Limited', 'Production') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (111, 'PBL0001', 'Lee, Mei Ching Bella', '', 'Photoblog.hk Limited', 'Production') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (3240, 'CLS0003', 'Ng, Wai Ching Kathy', '', 'Photoblog.hk Limited : CLS GARAGE', 'Sales') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (4642, 'CLC0004', 'Choi, KIT MAN', '', 'Photoblog.hk Limited : CLS GARAGE', 'Sales') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (3043, 'CLS0001', 'Yung, Hon Yi Kenneth', '', 'Photoblog.hk Limited : CLS GARAGE', 'Sales') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (3768, 'CLT0001', 'Tan, Mei Po Mabel', '', 'Photoblog.hk Limited : CLS GARAGE', 'Sales') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (2113, 'PTH0001', 'Ha, Wai Yu', '', 'Photoblog.hk Limited : Jervois M Limited', 'JM Team') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (2869, 'JMT0001', 'Tsang, Yuk Ying Tracy', 'tracy.tsang@sshk.ltd', 'Photoblog.hk Limited : Jervois M Limited', 'JM Team') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (136, 'JML0002', 'Lee, Ka Lun Alex', 'alex.lee@sshk.ltd', 'Photoblog.hk Limited : Jervois M Limited', 'JM Team') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (4307, 'JMH0001', 'Huang, Na Min A', 'ashlee.huang@sshk.ltd', 'Photoblog.hk Limited : Jervois M Limited', 'JM Team') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (4640, 'JML0008', 'LIU, AILIN KIARA', 'ailin.liu@sshk.ltd', 'Photoblog.hk Limited : Jervois M Limited', 'JM Team') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (4641, 'JMG0001', 'Guo, Qian Ying', 'cherry.guo@sshk.ltd', 'Photoblog.hk Limited : Jervois M Limited', 'JM Team') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (3912, 'JMC0003', 'Chung, Ka Lun L', 'larry.chung@sshk.ltd', 'Photoblog.hk Limited : Jervois M Limited', 'JM Team') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (3473, 'JML0006', 'Lui, Hei Man M', '', 'Photoblog.hk Limited : Jervois M Limited', 'Sales') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (3472, 'JMY0002', 'Yeung, Chau Yung Y', '', 'Photoblog.hk Limited : Jervois M Limited', 'Sales') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (2418, 'SSF0001', 'FOK, CHI TO', 'to.fok@sshk.ltd', 'Photoblog.hk Limited : Social Strategy Hong Kong Limited', 'ePR Team') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (3627, 'SSL0031', 'Lung, Yuen Ki Fornia', 'fornia.lung@sshk.ltd', 'Photoblog.hk Limited : Social Strategy Hong Kong Limited', 'ePR Team') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (3598, 'SSL0030', 'Lam, Hing Man', '', 'Photoblog.hk Limited : Social Strategy Hong Kong Limited', 'ePR Team') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (130, 'SSC0003', 'Cheung, Wai Leong', '', 'Photoblog.hk Limited : Social Strategy Hong Kong Limited', 'ePR Team') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (4038, 'SSL0035', 'Leung, Kwai Chun, Jan', '', 'Photoblog.hk Limited : Social Strategy Hong Kong Limited', 'ePR Team') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (4301, 'SSC0019', 'Chu, Kin Keung Teddy', '', 'Photoblog.hk Limited : Social Strategy Hong Kong Limited', 'ePR Team') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (3536, 'SSC0020', 'Cheung, Hei Man, Jamie', '', 'Photoblog.hk Limited : Social Strategy Hong Kong Limited', 'ePR Team') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (4638, 'SSS0002', 'So, Ho Ying, Esther', '', 'Photoblog.hk Limited : Social Strategy Hong Kong Limited', 'ePR Team') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (4639, 'SSY0009', 'Yeh, Hau Suet, Michelle', '', 'Photoblog.hk Limited : Social Strategy Hong Kong Limited', 'ePR Team') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (3535, 'SSL0026', 'Lee, Cheuk Fung, Tomy', 'tomy.lee@sshk.ltd', 'Photoblog.hk Limited : Social Strategy Hong Kong Limited', 'ePR Team') on conflict (code, subsidiary) do nothing;
insert into ns_employees (internal_id, code, name, email, subsidiary, department) values (3756, 'SSP0002', 'Poon, Ho Wan Lionel', '', 'Photoblog.hk Limited : Social Strategy Hong Kong Limited', 'ePR Team') on conflict (code, subsidiary) do nothing;

-- ---- Vendors ----
insert into ns_vendors (code, name, is_intercompany, related_subsidiary) values ('V10000014', 'Adobe Systems Software Ireland Ltd', false, NULL) on conflict (code) do nothing;
insert into ns_vendors (code, name, is_intercompany, related_subsidiary) values ('V10000249', 'Shutterstock', false, NULL) on conflict (code) do nothing;
insert into ns_vendors (code, name, is_intercompany, related_subsidiary) values ('V10000353', 'A/P to PB from SSHK', true, 'Social Strategy Hong Kong Limited') on conflict (code) do nothing;
insert into ns_vendors (code, name, is_intercompany, related_subsidiary) values ('V10000373', 'HSBC business card', false, NULL) on conflict (code) do nothing;
insert into ns_vendors (code, name, is_intercompany, related_subsidiary) values ('V10000399', 'Microsoft', false, NULL) on conflict (code) do nothing;
insert into ns_vendors (code, name, is_intercompany, related_subsidiary) values ('V10000556', 'A/P to PB from CLS Garage', true, 'CLS GARAGE') on conflict (code) do nothing;
insert into ns_vendors (code, name, is_intercompany, related_subsidiary) values ('V10000571', 'Hong Kong Domain Name Registration Company Limited', false, NULL) on conflict (code) do nothing;
insert into ns_vendors (code, name, is_intercompany, related_subsidiary) values ('V10000615', 'A/P to PB from JM', true, 'Jervois M Limited') on conflict (code) do nothing;
insert into ns_vendors (code, name, is_intercompany, related_subsidiary) values ('V10000662', 'A/P to PB from 704 Production', true, '704 Production Limited') on conflict (code) do nothing;

-- ---- Intercompany customers ----
insert into ns_customers (code, name, is_intercompany, related_subsidiary) values ('C10000190', 'A/R to PB from SSHK', true, 'Social Strategy Hong Kong Limited') on conflict (code) do nothing;
insert into ns_customers (code, name, is_intercompany, related_subsidiary) values ('C10000305', 'A/R to PB from CLS Garage', true, 'CLS GARAGE') on conflict (code) do nothing;
insert into ns_customers (code, name, is_intercompany, related_subsidiary) values ('C10000306', 'A/R to PB from Jervois M', true, 'Jervois M Limited') on conflict (code) do nothing;
insert into ns_customers (code, name, is_intercompany, related_subsidiary) values ('C10000321', 'A/R to PB from 704 Production', true, '704 Production Limited') on conflict (code) do nothing;
insert into ns_customers (code, name, is_intercompany, related_subsidiary) values ('C10000533', 'A/R to PB from Go Asia', true, 'Go Asia Plus Travel & Tours Co. Limited') on conflict (code) do nothing;
insert into ns_customers (code, name, is_intercompany, related_subsidiary) values ('C10000526', 'Go Asia Plus Travel & Tours Co. Limited', false, NULL) on conflict (code) do nothing;

-- ---- Credit card account mapping ----
insert into ns_credit_card_accounts (account_number, account_name, full_account_name, cardholder_name, cardholder_employee_code, card_identifier, bank, subsidiary) values ('34001012', '4150 - HSBC Credit Card (Rex) - PBHK', '34001000 - Business credit card:34001012 - 4150 - HSBC Credit Card (Rex) - PBHK', 'Wong, Chi Fung', 'PBW0001', 'Rex', 'HSBC', 'Photoblog.hk Limited') on conflict (account_number) do nothing;
insert into ns_credit_card_accounts (account_number, account_name, full_account_name, cardholder_name, cardholder_employee_code, card_identifier, bank, subsidiary) values ('34001017', '92003 - AE Credit Card (Alex) - PBHK', '34001000 - Business credit card:34001017 - 92003 - AE Credit Card (Alex) - PBHK', 'Lo, King Yip Alex', 'PBL0006', 'Alex Lo', 'American Express', 'Photoblog.hk Limited') on conflict (account_number) do nothing;
insert into ns_credit_card_accounts (account_number, account_name, full_account_name, cardholder_name, cardholder_employee_code, card_identifier, bank, subsidiary) values ('34001018', 'HSBC Credit Card (Kenneth) - CLS Garage', '34001000 - Business credit card:34001018 - HSBC Credit Card (Kenneth) - CLS Garage', 'Yung, Hon Yi Kenneth', 'PBY0002', 'Kenneth', 'HSBC', 'Photoblog.hk Limited') on conflict (account_number) do nothing;
insert into ns_credit_card_accounts (account_number, account_name, full_account_name, cardholder_name, cardholder_employee_code, card_identifier, bank, subsidiary) values ('34001020', 'HSBC Credit Card (Alex) - CLS Garage', '34001000 - Business credit card:34001020 - HSBC Credit Card (Alex) - CLS Garage', 'Lo, King Yip Alex', 'PBL0006', 'Alex CLS', 'HSBC', 'Photoblog.hk Limited') on conflict (account_number) do nothing;
insert into ns_credit_card_accounts (account_number, account_name, full_account_name, cardholder_name, cardholder_employee_code, card_identifier, bank, subsidiary) values ('34001021', '02003 - AE Credit Card (Nok) - PBHK', '34001000 - Business credit card:34001021 - 02003 - AE Credit Card (Nok) - PBHK', 'Chan, Wai Nok', 'PBC0002', 'Nok', 'American Express', 'Photoblog.hk Limited') on conflict (account_number) do nothing;

-- ---- Intercompany accounts (from migration_ns_intercompany_accounts.sql) ----

insert into public.ns_intercompany_accounts
  (entity_code, entity_name, pbhk_subsidiary_path, has_payable_side, notes)
values
  ('PBHK', 'Photoblog.hk Limited', 'Photoblog.hk Limited', FALSE,
   'Cardholder entity. No IC needed for own expenses.')
on conflict (entity_code) do update set
  entity_name = excluded.entity_name,
  pbhk_subsidiary_path = excluded.pbhk_subsidiary_path,
  has_payable_side = excluded.has_payable_side,
  notes = excluded.notes,
  updated_at = now();

insert into public.ns_intercompany_accounts
  (entity_code, entity_name,
   ar_account_code, ar_account_name, ar_customer_code, pbhk_subsidiary_path,
   ap_account_code, ap_account_name, ap_vendor_code, sub_subsidiary_path,
   has_payable_side)
values
  ('704', '704 Production Limited',
   '25000025', 'Amount Due From 704 Production (To PB)', 'C10000321', 'Photoblog.hk Limited',
   '35002023', 'Amt Due To Photoblog (from 704)', 'V10000662', 'Photoblog.hk Limited : 704 Production Limited',
   TRUE)
on conflict (entity_code) do update set
  entity_name = excluded.entity_name, ar_account_code = excluded.ar_account_code,
  ar_account_name = excluded.ar_account_name, ar_customer_code = excluded.ar_customer_code,
  pbhk_subsidiary_path = excluded.pbhk_subsidiary_path, ap_account_code = excluded.ap_account_code,
  ap_account_name = excluded.ap_account_name, ap_vendor_code = excluded.ap_vendor_code,
  sub_subsidiary_path = excluded.sub_subsidiary_path, has_payable_side = excluded.has_payable_side,
  updated_at = now();

insert into public.ns_intercompany_accounts
  (entity_code, entity_name,
   ar_account_code, ar_account_name, ar_customer_code, pbhk_subsidiary_path,
   ap_account_code, ap_account_name, ap_vendor_code, sub_subsidiary_path,
   has_payable_side)
values
  ('CLS', 'CLS Garage',
   '25000022', 'Amount Due From CLS Garage (To PB)', 'C10000305', 'Photoblog.hk Limited',
   '35002016', 'Amt Due To Photoblog (from CLS)', 'V10000556', 'Photoblog.hk Limited : CLS GARAGE',
   TRUE)
on conflict (entity_code) do update set
  entity_name = excluded.entity_name, ar_account_code = excluded.ar_account_code,
  ar_account_name = excluded.ar_account_name, ar_customer_code = excluded.ar_customer_code,
  pbhk_subsidiary_path = excluded.pbhk_subsidiary_path, ap_account_code = excluded.ap_account_code,
  ap_account_name = excluded.ap_account_name, ap_vendor_code = excluded.ap_vendor_code,
  sub_subsidiary_path = excluded.sub_subsidiary_path, has_payable_side = excluded.has_payable_side,
  updated_at = now();

insert into public.ns_intercompany_accounts
  (entity_code, entity_name,
   ar_account_code, ar_account_name, ar_customer_code, pbhk_subsidiary_path,
   ap_account_code, ap_account_name, ap_vendor_code, sub_subsidiary_path,
   has_payable_side)
values
  ('JM', 'Jervois M Limited',
   '25000024', 'Amount Due From Jervois M (To PB)', 'C10000306', 'Photoblog.hk Limited',
   '35002022', 'Amt Due To Photoblog (from JM)', 'V10000615', 'Photoblog.hk Limited : Jervois M Limited',
   TRUE)
on conflict (entity_code) do update set
  entity_name = excluded.entity_name, ar_account_code = excluded.ar_account_code,
  ar_account_name = excluded.ar_account_name, ar_customer_code = excluded.ar_customer_code,
  pbhk_subsidiary_path = excluded.pbhk_subsidiary_path, ap_account_code = excluded.ap_account_code,
  ap_account_name = excluded.ap_account_name, ap_vendor_code = excluded.ap_vendor_code,
  sub_subsidiary_path = excluded.sub_subsidiary_path, has_payable_side = excluded.has_payable_side,
  updated_at = now();

insert into public.ns_intercompany_accounts
  (entity_code, entity_name,
   ar_account_code, ar_account_name, ar_customer_code, pbhk_subsidiary_path,
   ap_account_code, ap_account_name, ap_vendor_code, sub_subsidiary_path,
   has_payable_side)
values
  ('SSHK', 'Social Strategy Hong Kong Limited',
   '25000015', 'Amount Due From SSHK (To PB)', 'C10000190', 'Photoblog.hk Limited',
   '35002014', 'Amt Due To Photoblog (from SSHK)', 'V10000353', 'Photoblog.hk Limited : Social Strategy Hong Kong Limited',
   TRUE)
on conflict (entity_code) do update set
  entity_name = excluded.entity_name, ar_account_code = excluded.ar_account_code,
  ar_account_name = excluded.ar_account_name, ar_customer_code = excluded.ar_customer_code,
  pbhk_subsidiary_path = excluded.pbhk_subsidiary_path, ap_account_code = excluded.ap_account_code,
  ap_account_name = excluded.ap_account_name, ap_vendor_code = excluded.ap_vendor_code,
  sub_subsidiary_path = excluded.sub_subsidiary_path, has_payable_side = excluded.has_payable_side,
  updated_at = now();

insert into public.ns_intercompany_accounts
  (entity_code, entity_name,
   ar_account_code, ar_account_name, ar_customer_code, pbhk_subsidiary_path,
   has_payable_side, notes)
values
  ('GoAsia', 'Go Asia Plus Travel',
   '25000031', 'Amount Due From Go Asia Plus Travel (To PB)', 'C10000533', 'Photoblog.hk Limited',
   FALSE,
   'Not a separate ledger entity. PBHK ledger only - DR AR, CR CC.')
on conflict (entity_code) do update set
  entity_name = excluded.entity_name, ar_account_code = excluded.ar_account_code,
  ar_account_name = excluded.ar_account_name, ar_customer_code = excluded.ar_customer_code,
  pbhk_subsidiary_path = excluded.pbhk_subsidiary_path, has_payable_side = excluded.has_payable_side,
  notes = excluded.notes, updated_at = now();

insert into public.ns_intercompany_accounts
  (entity_code, entity_name,
   ar_account_code, ar_account_name, ar_customer_code, pbhk_subsidiary_path,
   has_payable_side, notes)
values
  ('JS', 'JS',
   '23001010', 'Accounts Receivable - General', 'C10000434', 'Photoblog.hk Limited',
   FALSE,
   'Uses general AR, not separate IC account. PBHK ledger only - DR AR, CR CC.')
on conflict (entity_code) do update set
  entity_name = excluded.entity_name, ar_account_code = excluded.ar_account_code,
  ar_account_name = excluded.ar_account_name, ar_customer_code = excluded.ar_customer_code,
  pbhk_subsidiary_path = excluded.pbhk_subsidiary_path, has_payable_side = excluded.has_payable_side,
  notes = excluded.notes, updated_at = now();
