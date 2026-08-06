import { z } from "zod";

// ---- Database Types ----

export interface Entity {
  id: string;
  code: string;
  name: string;
  created_at: string;
}

export interface Department {
  id: string;
  entity_id: string;
  code: string;
  name: string;
  dr_account: string;
  created_at: string;
}

export interface CreditCard {
  id: string;
  bank: string;
  last4: string;
  card_name: string | null;
  currency: string;
  is_active: boolean;
  created_at: string;
}

export interface JournalSettings {
  id: string;
  cr_account: string;
  default_currency: string;
  date_tolerance_days: number;
  fuzzy_threshold: number;
  amount_tolerance_pct: number;
  updated_at: string;
}

export interface UploadBatch {
  id: string;
  file_name: string;
  upload_type: 'cc_statement' | 'meta_invoice' | 'matching_rules' | 'bank_statement';
  status: 'uploaded' | 'processing' | 'processed' | 'error' | 'archived';
  row_count: number;
  error_message: string | null;
  uploaded_at: string;
  processed_at: string | null;
  statement_total: number | null;
  ai_parsed_total: number | null;
  bank: string | null;
  card_last4: string | null;
  statement_period: string | null;
  user_id: string | null;
  notes: string | null;
  file_path: string | null;
  period_month: string | null;
  subsidiary: string | null;
  bank_account: string | null;
  previous_balance: number | null;
  module: string | null;
}

export interface UserProfile {
  id: string;
  email: string;
  display_name: string;
  role: 'admin' | 'user';
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface MatchingRule {
  id: string;
  batch_id: string | null;
  keyword: string;
  account_name: string | null;
  dr_account_code: string | null;
  cr_account_code: string | null;
  target_entity: string | null;
  dept_code: string | null;
  customer: string | null;
  vendor: string | null;
  netsuite_account: string | null;
  project_code: string | null;
  notes: string | null;
  priority: number;
  is_active: boolean;
  is_intercompany: boolean;
  intercompany_account: string | null;
  subsidiary_name: string | null;
  ns_department: string | null;
  ns_name_field: string | null;
  ns_class: string | null;
  module: string | null;
  created_at: string;
}

export interface MetaInvoice {
  id: string;
  batch_id: string | null;
  invoice_number: string;
  billing_period: string | null;
  amount: number;
  currency: string;
  amount_hkd: number | null;
  fx_rate: number | null;
  invoice_date: string | null;
  account_name: string | null;
  account_id: string | null;
  description: string | null;
  is_matched: boolean;
  user_id: string | null;
  period_month: string | null;
  parent_invoice_id: string | null;
  charge_to_entity: string | null;
  // 細項 charge_to (e.g. "PB-IT", "704-Mgt", "SS-Prod") — 指向 ns_departments.charge_to
  // 用嚟 emit NetSuite Department + Subsidiary (parent:child) 正確格式
  charge_to_code: string | null;
  project_code: string | null;
  expense_category: string | null;
  ns_account_number: string | null;
  ns_account_name: string | null;
  card_last4: string | null;
  created_at: string;
}

export interface CardTransaction {
  id: string;
  batch_id: string | null;
  card_id: string | null;
  txn_date: string;
  post_date: string | null;
  merchant: string;
  amount: number;
  amount_hkd: number | null;
  currency: string;
  fx_rate: number;
  reference: string | null;
  description: string | null;
  card_last4: string | null;
  user_id: string | null;
  period_month: string | null;
  created_at: string;
}

export interface ReconciliationResult {
  id: string;
  transaction_id: string;
  invoice_id: string | null;
  status: MatchStatus;
  match_type: MatchType | null;
  confidence: number | null;
  matched_at: string | null;
  matched_by: string | null;
  notes: string | null;
  created_at: string;
}

export interface AccountingLine {
  id: string;
  transaction_id: string;
  entity_id: string;
  department_id: string;
  amount_hkd: number;
  split_pct: number;
  dr_account: string;
  cr_account: string;
  description: string | null;
  is_confirmed: boolean;
  created_at: string;
}

export interface JournalExport {
  id: string;
  export_name: string;
  row_count: number;
  include_unmatched: boolean;
  exported_at: string;
  exported_by: string | null;
}

// ---- NetSuite Reference Data ----

export interface NsChartOfAccount {
  id: string;
  account_number: string;
  account_name: string;
  full_name: string;
  account_type: string | null;
  subsidiary: string | null;
  entity_code: string | null;
  is_active: boolean;
  created_at: string;
}

export interface NsSubsidiary {
  id: string;
  internal_id: number;
  name: string;
  short_code: string;
  intercompany_ar_account: string | null;
  intercompany_ap_account: string | null;
  intercompany_ar_customer: string | null;
  intercompany_ap_vendor: string | null;
  created_at: string;
}

export interface NsDepartment {
  id: string;
  internal_id: number;
  name: string;
  entity_code: string | null;
  charge_to: string | null;
  subsidiary_name: string | null;
  ns_subsidiary: string | null;
  created_at: string;
}

export interface NsEmployee {
  id: string;
  internal_id: number;
  code: string;
  employee_id: string | null;
  name: string;
  email: string | null;
  login_access: boolean;
  subsidiary: string;
  department: string | null;
  charge_to: string | null;
  created_at: string;
}

export interface ExpenseCategory {
  id: string;
  category_key: string;
  label_zh: string;
  label_en: string;
  ns_account_number: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
}

export interface MetaInvoiceSplit {
  id: string;
  invoice_id: string;
  project_code: string | null;
  amount_hkd: number;
  note: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface NsProjectCode {
  id: string;
  entity_name: string;
  charge_to: string | null;
  project_id: string;
  project_name: string;
  customer_name: string | null;
  subsidiary: string | null;
  created_at: string;
}

/**
 * Entity code (SSHK/PBHK/etc) → ns_project_codes.charge_to prefixes.
 * NetSuite data uses different short codes (SS, PB-Admin, etc) than user-facing entity codes.
 */
export const ENTITY_CHARGE_TO_PREFIXES: Record<string, string[]> = {
  SSHK: ["SS", "SSHK"],          // SS, SS-JM, SSHK-*
  PBHK: ["PB", "PBHK"],          // PB-Admin, PB-Prod, PBHK-*
  JM:   ["JM"],
  CLS:  ["CLS"],                  // CLS, CLS GARAGE
  "704": ["704", "7-04"],
  EXT:  ["EXT", "EX"],            // Extravelism — short prefix
  JS:   ["JS"],
};

/** Entity code -> exact entity_name strings used in NetSuite project records */
export const ENTITY_NAME_MAP: Record<string, string[]> = {
  SSHK: ["SOCIAL STRATEGY HONG KONG"],
  PBHK: ["PHOTOBLOG.HK LIMITED", "PHOTOBLOG.HK LIMITED."],
  JM:   ["JERVOIS M LIMITED"],
  CLS:  ["CLS GARAGE", "CLS PRODUCTION"],
  "704": ["704 PRODUCTION"],
  EXT:  ["EXTRAVELISM"],
  JS:   ["JERVOIS SOLUTION"],
};

/** Returns true if a project belongs to the given entity (matches by charge_to, entity_name, or subsidiary). */
export function projectMatchesEntity(project: Pick<NsProjectCode, "charge_to" | "entity_name" | "subsidiary">, entity: string | null): boolean {
  if (!entity) return true;
  const prefixes = ENTITY_CHARGE_TO_PREFIXES[entity] || [entity];
  const names = ENTITY_NAME_MAP[entity] || [];
  const ct = (project.charge_to || "").toUpperCase();
  const en = (project.entity_name || "").toUpperCase();

  // 1) charge_to prefix match (most reliable for SS/PB/JM/CLS/704)
  for (const p of prefixes) {
    const up = p.toUpperCase();
    if (ct === up || ct.startsWith(up + "-") || ct.startsWith(up + " ")) return true;
  }

  // 2) entity_name match against ENTITY_NAME_MAP (NetSuite’s actual entity_name string).
  //    We deliberately do NOT match against "subsidiary" anymore — NetSuite stores subsidiary as
  //    a hierarchy path like "Photoblog.hk Limited : Social Strategy Hong Kong Limited", which
  //    would falsely match PBHK for every SS project.
  for (const nm of names) {
    if (en.includes(nm)) return true;
  }

  return false;
}

/** Returns true if a credit card's subsidiary (company name) belongs to the given entity code. */
export function entityMatchesCardSubsidiary(entity: string | null, subsidiary: string | null | undefined): boolean {
  if (!entity) return true;
  if (!subsidiary) return false;
  const sub = subsidiary.toUpperCase();
  const entUpper = entity.toUpperCase();
  if (sub.includes(entUpper)) return true;
  const nameHints: Record<string, string[]> = {
    SSHK: ["SOCIAL STRATEGY"],
    PBHK: ["PHOTOBLOG"],
    JM:   ["JERVOIS M"],
    CLS:  ["CLS"],
    "704": ["704"],
    EXT:  ["EXTRAVEL"],
    JS:   ["JERVOIS SOLUTION"],
  };
  for (const hint of nameHints[entity] || []) {
    if (sub.includes(hint)) return true;
  }
  return false;
}

export interface NsVendor {
  id: string;
  code: string;
  name: string;
  is_intercompany: boolean;
  related_subsidiary: string | null;
  created_at: string;
}

export interface NsCustomer {
  id: string;
  code: string;
  name: string;
  is_intercompany: boolean;
  related_subsidiary: string | null;
  created_at: string;
}

export interface NsCreditCardAccount {
  id: string;
  account_number: string;
  account_name: string;
  full_account_name: string | null;
  cardholder_name: string;
  cardholder_employee_code: string;
  card_identifier: string;
  card_last4: string | null;
  bank: string;
  subsidiary: string;
  created_at: string;
}

// ---- Bank Reconciliation Types ----

export interface BankTransaction {
  id: string;
  batch_id: string | null;
  subsidiary: string;
  bank_name: string;
  bank_account: string | null;
  txn_date: string;
  description: string;
  reference: string | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
  currency: string;
  period_month: string | null;
  user_id: string | null;
  created_at: string;
}

export interface NsGlEntry {
  id: string;
  subsidiary: string;
  account: string;
  entry_type: string | null;
  txn_date: string;
  transaction_number: string | null;
  document_number: string | null;
  entity_name: string | null;
  description: string | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
  vendor_invoice_number: string | null;
  department: string | null;
  employee: string | null;
  client: string | null;
  project: string | null;
  campaign_name: string | null;
  item_type: string | null;
  memo: string | null;
  period_month: string | null;
  is_matched: boolean;
  created_at: string;
}

export interface BankReconResult {
  id: string;
  module: string;
  source_type: 'bank_transaction';
  source_id: string;
  target_type: string | null;
  target_id: string | null;
  status: MatchStatus;
  match_type: MatchType | 'hs_fee' | 'rule' | null;
  confidence: number | null;
  matched_at: string | null;
  matched_by: string | null;
  notes: string | null;
  created_at: string;
}

// ---- Enums ----

export type MatchStatus = 'matched' | 'pending' | 'unmatched' | 'exception' | 'manual';
export type MatchType = 'exact' | 'fuzzy' | 'near_date' | 'split' | 'manual';
export type UploadType = 'cc_statement' | 'meta_invoice' | 'matching_rules' | 'bank_statement';
export type UploadStatus = 'uploaded' | 'processing' | 'processed' | 'error' | 'archived';

// ---- View Types ----

export interface TransactionFull {
  transaction_id: string;
  txn_date: string;
  post_date: string | null;
  merchant: string;
  amount: number;
  amount_hkd: number | null;
  currency: string;
  fx_rate: number;
  reference: string | null;
  description: string | null;
  card_last4: string | null;
  card_bank: string | null;
  card_name: string | null;
  match_status: MatchStatus | null;
  match_type: MatchType | null;
  confidence: number | null;
  matched_at: string | null;
  match_notes: string | null;
  invoice_number: string | null;
  billing_period: string | null;
  invoice_amount: number | null;
  source_file: string | null;
  batch_id: string | null;
  created_at: string;
}

export interface JournalLine {
  date: string;
  entity: string;
  department: string;
  dr_account: string;
  cr_account: string;
  amount_hkd: number;
  currency: string;
  fx_rate: number;
  description: string;
  ref: string | null;
  card_last4: string | null;
  match_status: MatchStatus | null;
  split_pct: number;
  is_confirmed: boolean;
  transaction_id: string;
  line_id: string;
}

export interface BuSummary {
  entity_code: string;
  entity_name: string;
  department_code: string;
  department_name: string;
  line_count: number;
  total_amount: number;
  confirmed_count: number;
  confirmed_amount: number;
}

// ---- Zod Schemas ----

// Mapping table XLSX column headers (Chinese + English)
// 識別條件 → keyword, 會計科目名稱 → account_name, 借方科目代碼 → dr_account_code,
// 貸方科目代碼 → cr_account_code, 所屬公司 → target_entity, 部門代碼 → dept_code,
// Customer → customer, Vendor → vendor, NetSuite account code → netsuite_account
export const MAPPING_TABLE_COLUMN_MAP: Record<string, string> = {
  '識別條件 (keyword/category)': 'keyword',
  '識別條件': 'keyword',
  'keyword': 'keyword',
  'merchant_pattern': 'keyword',
  '會計科目名稱 (account name)': 'account_name',
  '會計科目名稱': 'account_name',
  'account name': 'account_name',
  'account_name': 'account_name',
  '借方科目代碼 (dr account code)': 'dr_account_code',
  '借方科目代碼': 'dr_account_code',
  'dr account code': 'dr_account_code',
  'dr_account_code': 'dr_account_code',
  '貸方科目代碼 (cr account code)': 'cr_account_code',
  '貸方科目代碼': 'cr_account_code',
  'cr account code': 'cr_account_code',
  'cr_account_code': 'cr_account_code',
  '所屬公司 (target entity)': 'target_entity',
  '所屬公司': 'target_entity',
  'target entity': 'target_entity',
  'entity_code': 'target_entity',
  '部門代碼 (dept code)': 'dept_code',
  '部門代碼': 'dept_code',
  'dept code': 'dept_code',
  'department_code': 'dept_code',
  'customer': 'customer',
  'vendor': 'vendor',
  'netsuite account code': 'netsuite_account',
  'ns account': 'netsuite_account',
  'netsuite_account': 'netsuite_account',
  'project code': 'project_code',
  '項目代碼': 'project_code',
  '項目代碼 (project code)': 'project_code',
  'project_code': 'project_code',
  'notes': 'notes',
  '備註': 'notes',
};
