import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Download, ChevronDown, ChevronRight, AlertCircle, Package, Loader2, CloudUpload } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { csvText, csvAmount } from "@/lib/csv";
import { round2, sum2 } from "@/lib/money";
import JSZip from "jszip";

// FX guard — a foreign-currency txn with no HKD amount would otherwise be booked
// at its raw foreign number labelled HKD. We surface it instead of guessing a rate.
const FX_MISSING_WARNING = "FX txn missing HKD amount — set it in Recon Queue before export";

interface NsCcAccount {
  account_number: string;
  account_name: string;
  cardholder_name: string;
  cardholder_employee_code: string;
  card_identifier: string;
  card_last4: string | null;
  bank: string;
  subsidiary: string;
}

// ⭐ Intercompany account mapping: entity_code → IC AR account in cardholder's ledger
// PBHK 卡 pay for 704/CLS/JM/SSHK/GoAsia/JS → DR Due From (AR) account
// has_payable_side = false (GoAsia / JS) 表示 沒独立 sub ledger，但 PBHK 側 emit 同樣 (DR AR / CR CC)
interface NsIntercompanyAccount {
  entity_code: string;
  entity_name: string;
  ar_account_code: string | null;
  ar_account_name: string | null;
  ar_customer_code: string | null;
  pbhk_subsidiary_path: string | null;
  // IC Payable side (counterparty's own ledger) — used to emit the "Due To PB" leg
  ap_account_code: string | null;
  ap_account_name: string | null;
  ap_vendor_code: string | null;
  sub_subsidiary_path: string | null;
  has_payable_side: boolean;
}

interface AccountingLine {
  transaction_id: string;
  amount_hkd: number;
  split_pct: number | null;
  ns_entity_code: string | null;
  ns_charge_to: string | null;
  ns_subsidiary_name: string | null;
  ns_dept_name: string | null;
  ns_account_number: string | null;
  ns_account_name: string | null;
  // Optional — only present after project_code migration is run
  ns_project_code?: string | null;
  ns_project_name?: string | null;
  description: string | null;
}

// ⭐ entity_code mapping (卡 subsidiary → PBHK / 704 / ... entity_code)
// 用來比較卡 entity vs charge_to entity 決定什並入 IC 還係 expense
const SUBSIDIARY_TO_ENTITY_CODE: Record<string, string> = {
  // short name → entity_code
  "Photoblog.hk Limited": "PBHK",
  "PBHK": "PBHK",
  "704 Production Limited": "704",
  "704": "704",
  "CLS GARAGE": "CLS",
  "CLS Garage": "CLS",
  "CLS": "CLS",
  "CLS Production Limited": "CLS",
  "Jervois M Limited": "JM",
  "JM": "JM",
  "Social Strategy Hong Kong Limited": "SSHK",
  "SSHK": "SSHK",
  "Go Asia Plus Travel": "GoAsia",
  "GoAsia": "GoAsia",
  "JS": "JS",
};

interface TxnRow {
  id: string;
  txn_date: string;
  // ⭐ Statement closing date (一張卡單同一個日期) — 出 journal 用來當記賬日期
  statement_date: string | null;
  statement_file: string | null;
  batch_id: string | null;
  merchant: string;
  amount: number;
  amount_hkd: number | null;
  currency: string;
  fx_rate: number;
  card_last4: string;
  description: string | null;
  reference: string | null;
  period_month: string | null;
  match_status: string | null;
  invoice_number: string | null;
  invoice_amount: number | null;
  batch_notes: string | null;
  // Invoice categorization fallback (from meta_invoices when no accounting_lines split)
  inv_charge_to_entity: string | null;
  inv_charge_to_code: string | null;
  inv_project_code: string | null;
  inv_ns_account_number: string | null;
  inv_ns_account_name: string | null;
  inv_expense_category: string | null;
  // Invoice 備註 (Upload Centre note) → journal Line memo (front)
  inv_notes: string | null;
  // Uploader → "code name" (email fallback) → Employee column on expense lines
  inv_employee: string | null;
}

interface JournalEntry {
  entry_no: number;
  date: string;
  account: string;
  currency: string;
  debit: number | null;
  credit: number | null;
  memo: string;
  subsidiary: string;
  department: string;
  class_project: string;
  name: string;
  employee?: string;
  // UI helpers
  is_credit_line: boolean;
  cardholder: string;
  mapped: boolean;
  warning?: string;
}

// ⭐ Point 1 — a single expense that must be mirrored in the counterparty's ledger.
// Collected while building the payer (PBHK) side, then emitted as separate
// single-subsidiary journal entries appended after the payer entries.
interface IcNeed {
  cardLabel: string;
  journalDate: string;   // the card statement's journal date (used for the Due-To line)
  ic: NsIntercompanyAccount;
  expenseAccount: string | null;  // the REAL GL expense account (not the AR account)
  amount: number;                 // absolute HKD
  isReversal: boolean;            // rebate / reversal → CR instead of DR
  date: string;                   // per-transaction date
  dept: string;
  project: string;
  memo: string;
  mapped: boolean;
  employee?: string;        // invoice-backed → uploader
  cardholderEmp?: string;   // statement fallback → cardholder (Due-To leg uses this)
}

export default function JournalExport() {
  const [selectedPeriod, setSelectedPeriod] = useState<string>("all");
  const [selectedCard, setSelectedCard] = useState<string>("all"); // card_last4 filter for preview + Export CSV
  const [isPosting, setIsPosting] = useState(false);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [showUnmappedList, setShowUnmappedList] = useState(false);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLTableRowElement | null>>(new Map());
  const { toast } = useToast();

  // Fetch all transactions
  const { data: rawTxns, isLoading } = useQuery({
    queryKey: ["export-transactions-v2"],
    queryFn: async () => {
      const { data: txns, error: txnErr } = await supabase
        .from("card_transactions")
        .select("id, txn_date, merchant, amount, amount_hkd, currency, fx_rate, card_last4, description, reference, period_month, batch_id, upload_batches(notes, statement_date, statement_period, file_name)")
        .order("txn_date", { ascending: true });
      if (txnErr) throw txnErr;

      const { data: recons } = await supabase
        .from("reconciliation_results")
        .select("transaction_id, status, invoice_id, meta_invoices(invoice_number, amount, charge_to_entity, charge_to_code, project_code, ns_account_number, ns_account_name, expense_category)");

      const reconMap = new Map<string, any>();
      for (const r of (recons || [])) reconMap.set(r.transaction_id, r);

      // Invoice 備註 (Upload Centre note) → journal Line memo. Fetched SEPARATELY and
      // resiliently: the meta_invoices.notes column may not exist yet (pending migration),
      // and embedding a missing column would error the whole query and break the export.
      const invNotesById = new Map<string, string>();
      const { data: noteRows } = await supabase.from("meta_invoices").select("id, notes");
      for (const r of ((noteRows || []) as any[])) if (r?.notes) invNotesById.set(r.id, r.notes);

      // UPLOADER → Employee (expense lines). invoice.user_id → user_profiles.email →
      // ns_employees(code, name). Falls back to the uploader's email if no NS employee matches.
      const invUserById = new Map<string, string>();
      const { data: invUsers } = await supabase.from("meta_invoices").select("id, user_id");
      for (const r of ((invUsers || []) as any[])) if (r?.user_id) invUserById.set(r.id, r.user_id);
      const emailByUser = new Map<string, string>();
      const { data: profiles } = await supabase.from("user_profiles").select("user_id, email");
      for (const p of ((profiles || []) as any[])) if (p?.user_id) emailByUser.set(p.user_id, (p.email || "").toLowerCase());
      const empByEmail = new Map<string, string>();
      const { data: emps } = await supabase.from("ns_employees").select("employee_id, code, name, email");
      for (const e of ((emps || []) as any[])) if (e?.email) empByEmail.set((e.email || "").toLowerCase(), `${e.code || e.employee_id} ${e.name || ""}`.trim());
      const employeeByUser = new Map<string, string>();
      for (const [uid, email] of Array.from(emailByUser.entries())) employeeByUser.set(uid, (email && empByEmail.get(email)) || email || "");

      return (txns || []).map((t: any) => {
        const recon = reconMap.get(t.id);
        const invUid = recon?.invoice_id ? invUserById.get(recon.invoice_id) : null;
        return {
          ...t,
          _recon: recon,
          _inv_notes: recon?.invoice_id ? (invNotesById.get(recon.invoice_id) ?? null) : null,
          _inv_employee: invUid ? (employeeByUser.get(invUid) ?? null) : null,
          _batch_notes: t.upload_batches?.notes ?? null,
          // ⭐ Statement date 是 journal 號出單日，取代 txn_date
          _statement_date: t.upload_batches?.statement_date ?? null,
          _statement_file: t.upload_batches?.file_name ?? null,
        };
      });
    },
  });

  // Fetch ns_departments — charge_to (code) → name (descriptive dept) + subsidiary_full_name (parent:child)
  const { data: nsDepartments } = useQuery<{ entity_code: string; subsidiary_name: string; subsidiary_full_name: string | null; charge_to: string; name: string }[]>({
    queryKey: ["ns-departments-export"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_departments")
        .select("entity_code, subsidiary_name, subsidiary_full_name, charge_to, name");
      if (error) throw error;
      return data as { entity_code: string; subsidiary_name: string; subsidiary_full_name: string | null; charge_to: string; name: string }[];
    },
  });

  // Fetch ns_project_codes — for project_id → project_name lookup
  const { data: nsProjectCodes } = useQuery<{ project_id: string; project_name: string }[]>({
    queryKey: ["ns-project-codes-export"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_project_codes")
        .select("project_id, project_name");
      if (error) throw error;
      return data as { project_id: string; project_name: string }[];
    },
  });

  // Fetch credit card accounts
  const { data: ccAccounts } = useQuery<NsCcAccount[]>({
    queryKey: ["ns-cc-accounts-export"],
    queryFn: async () => {
      const { data, error } = await supabase.from("ns_credit_card_accounts").select("*");
      if (error) throw error;
      return data as NsCcAccount[];
    },
  });

  // Fetch ns_chart_of_accounts — for account_number → full_name lookup
  // (NetSuite import needs full hierarchical name e.g. '81000099 Department Cost : Website')
  const { data: nsChartAccounts } = useQuery<{ account_number: string; full_name: string | null; account_name: string }[]>({
    queryKey: ["ns-chart-of-accounts-export"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_chart_of_accounts")
        .select("account_number, full_name, account_name");
      if (error) throw error;
      return data as { account_number: string; full_name: string | null; account_name: string }[];
    },
  });

  // ⭐ Fetch ns_intercompany_accounts — IC AR/AP mapping per entity_code
  const { data: icAccounts } = useQuery<NsIntercompanyAccount[]>({
    queryKey: ["ns-intercompany-accounts-export"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_intercompany_accounts")
        .select("entity_code, entity_name, ar_account_code, ar_account_name, ar_customer_code, pbhk_subsidiary_path, ap_account_code, ap_account_name, ap_vendor_code, sub_subsidiary_path, has_payable_side");
      if (error) throw error;
      return data as NsIntercompanyAccount[];
    },
  });

  // entity_code → IC AR account row
  const icByEntity = useMemo(() => {
    const m = new Map<string, NsIntercompanyAccount>();
    (icAccounts || []).forEach((a) => m.set(a.entity_code, a));
    return m;
  }, [icAccounts]);

  // ns_employees (Settings → Employees) — code → "employee_id name" for the Export CSV
  // "Employee" column. The credit-card line's employee = the CARDHOLDER, resolved from
  // the card's cardholder_employee_code against this table.
  const { data: nsEmployees } = useQuery<{ employee_id: string; code: string; name: string }[]>({
    queryKey: ["ns-employees-export"],
    queryFn: async () => {
      const { data, error } = await supabase.from("ns_employees").select("employee_id, code, name");
      if (error) return [] as { employee_id: string; code: string; name: string }[];
      return (data || []) as { employee_id: string; code: string; name: string }[];
    },
    retry: false,
  });
  const employeeByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of (nsEmployees || [])) {
      const disp = `${e.code || e.employee_id} ${e.name || ""}`.trim();
      if (e.code) m.set(e.code, disp);
      if (e.employee_id) m.set(e.employee_id, disp);
    }
    return m;
  }, [nsEmployees]);

  // Fetch accounting_lines (split data)
  const { data: accountingLines } = useQuery<AccountingLine[]>({
    queryKey: ["accounting-lines-export"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("accounting_lines")
        .select("*");
      if (error) throw error;
      return data as AccountingLine[];
    },
  });

  // Index accounting_lines by transaction_id
  const linesByTxn = useMemo(() => {
    const map = new Map<string, AccountingLine[]>();
    (accountingLines || []).forEach((l) => {
      if (!map.has(l.transaction_id)) map.set(l.transaction_id, []);
      map.get(l.transaction_id)!.push(l);
    });
    return map;
  }, [accountingLines]);

  // Entity → subsidiary FULL name map (parent : child) — for NetSuite-compatible CSV emit
  // e.g. 704 → "Photoblog.hk Limited : 704 Production Limited", PBHK → "Photoblog.hk Limited"
  const entityToSubsidiary = useMemo(() => {
    const m = new Map<string, string>();
    (nsDepartments || []).forEach((d) => {
      if (d.entity_code && !m.has(d.entity_code)) {
        // 優先用 subsidiary_full_name；如果空就 fallback subsidiary_name
        const full = (d.subsidiary_full_name && d.subsidiary_full_name.trim())
          ? d.subsidiary_full_name.trim()
          : d.subsidiary_name;
        if (full) m.set(d.entity_code, full);
      }
    });
    return m;
  }, [nsDepartments]);

  // charge_to code → subsidiary FULL name (parent : child)
  // e.g. "704-Mgt" → "Photoblog.hk Limited : 704 Production Limited"
  const chargeToSubsidiary = useMemo(() => {
    const m = new Map<string, string>();
    (nsDepartments || []).forEach((d) => {
      if (!d.charge_to) return;
      const full = (d.subsidiary_full_name && d.subsidiary_full_name.trim())
        ? d.subsidiary_full_name.trim()
        : d.subsidiary_name;
      if (full) m.set(d.charge_to, full);
    });
    return m;
  }, [nsDepartments]);

  // charge_to code → department descriptive name
  // e.g. "704-Mgt" → "Management", "SS" → "ePR Team", "PB-IT" → "IT Department"
  const chargeToDeptName = useMemo(() => {
    const m = new Map<string, string>();
    (nsDepartments || []).forEach((d) => {
      if (d.charge_to && d.name) m.set(d.charge_to, d.name);
    });
    return m;
  }, [nsDepartments]);

  // Entity → default charge_to map (for invoice fallback when no specific charge_to picked).
  // Priority: (a) charge_to === entity_code exactly, (b) any charge_to for that entity (first one).
  // e.g. 704 → "704" (Production), CLS → "CLS" (Sales), JM → "JM" (JM Team), SSHK → "SS" (ePR), PBHK → first PB-* (e.g. PB-AccSer)
  // 注意：呢個 map 返回 charge_to code（內部用），唔係 NetSuite Department display name
  const entityToDefaultChargeTo = useMemo(() => {
    const m = new Map<string, string>();
    const all = nsDepartments || [];
    const byEntity = new Map<string, { charge_to: string; name: string }[]>();
    all.forEach((d) => {
      if (!d.entity_code || !d.charge_to) return;
      if (!byEntity.has(d.entity_code)) byEntity.set(d.entity_code, []);
      byEntity.get(d.entity_code)!.push({ charge_to: d.charge_to, name: d.name });
    });
    byEntity.forEach((depts, entity) => {
      // Prefer charge_to === entity_code
      const exact = depts.find(d => d.charge_to === entity);
      if (exact) {
        m.set(entity, exact.charge_to);
        return;
      }
      // Else first one (sorted alphabetically for determinism)
      const sorted = [...depts].sort((a, b) => a.charge_to.localeCompare(b.charge_to));
      if (sorted.length) m.set(entity, sorted[0].charge_to);
    });
    return m;
  }, [nsDepartments]);

  // Project code → project name map
  const projectIdToName = useMemo(() => {
    const m = new Map<string, string>();
    (nsProjectCodes || []).forEach((p) => {
      if (p.project_id) m.set(p.project_id, p.project_name);
    });
    return m;
  }, [nsProjectCodes]);

  // Account number → full hierarchical name map (e.g. '81000099' → '81000099 Department Cost : Website')
  // Falls back to '<num> <account_name>' if full_name not populated.
  const accountFullNameMap = useMemo(() => {
    const m = new Map<string, string>();
    (nsChartAccounts || []).forEach((a) => {
      if (a.account_number) {
        const display = a.full_name && a.full_name.trim()
          ? a.full_name.trim()
          : `${a.account_number} ${a.account_name || ""}`.trim();
        m.set(a.account_number, display);
      }
    });
    return m;
  }, [nsChartAccounts]);

  // Helper — resolve any account_number string to its full display name; falls back to raw number
  const resolveAccount = (num: string | null | undefined): string => {
    if (!num) return "";
    return accountFullNameMap.get(num) || num;
  };

  // ⭐ IC resolver — 接受 entity_code (e.g. "704") OR subsidiary name OR full path
  // 自動 normalize 轉化為 entity_code。反回 IC override (跨 sub) 或 null (同 sub)
  function normalizeToEntity(s: string | null | undefined): string | null {
    if (!s) return null;
    // 如果已係 entity_code (短字串)售長售 Map key
    if (icByEntity.has(s)) return s;
    // Direct map
    if (SUBSIDIARY_TO_ENTITY_CODE[s]) return SUBSIDIARY_TO_ENTITY_CODE[s];
    // Full path: "Photoblog.hk Limited : 704 Production Limited" → tail
    if (s.includes(":")) {
      const tail = s.split(":").pop()?.trim() || "";
      if (SUBSIDIARY_TO_ENTITY_CODE[tail]) return SUBSIDIARY_TO_ENTITY_CODE[tail];
    }
    return null;
  }

  function resolveICOverride(
    cardEntityCode: string,
    chargeToOrSubsidiary: string | null | undefined,
  ): { accountNumber: string; accountName: string | null; customerCode: string | null; ic: NsIntercompanyAccount } | null {
    const emitEntity = normalizeToEntity(chargeToOrSubsidiary);
    if (!emitEntity) return null;
    if (emitEntity === cardEntityCode) return null; // 同 sub → 不 override
    const ic = icByEntity.get(emitEntity);
    if (!ic || !ic.ar_account_code) return null;
    return {
      accountNumber: ic.ar_account_code,
      accountName: ic.ar_account_name,
      customerCode: ic.ar_customer_code,
      ic,
    };
  }

  // ⭐ Point 1 — emit the IC counterparty (other subsidiary) journal entries.
  // For each cross-sub expense whose entity has a payable side (has_payable_side),
  // book the mirror leg in that subsidiary's own ledger:
  //   DR real expense account  /  CR "Amt Due To Photoblog" (AP), Name = IC AP vendor.
  // Each entry is single-subsidiary and internally balanced (DR expenses vs one
  // aggregated Due-To line), so overall DR=CR is preserved. Grouped per (card, entity).
  function buildIcCounterpartyEntries(needs: IcNeed[], startEntryNo: number): { entries: JournalEntry[]; nextEntryNo: number } {
    const out: JournalEntry[] = [];
    let e = startEntryNo;
    const groups = new Map<string, IcNeed[]>();
    for (const n of needs) {
      const key = `${n.cardLabel}||${n.ic.entity_code}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(n);
    }
    for (const arr of Array.from(groups.values())) {
      const ic = arr[0].ic;
      const sub = ic.sub_subsidiary_path || ic.entity_name;
      const cpLabel = `IC ${ic.entity_name} ← ${arr[0].cardLabel}`;
      const apAccountDisplay = ic.ap_account_code
        ? (accountFullNameMap.get(ic.ap_account_code) || `${ic.ap_account_code}${ic.ap_account_name ? ` ${ic.ap_account_name}` : ""}`)
        : "UNMAPPED";
      // DR the real expense in the counterparty's books (net signed via isReversal)
      let net = 0;
      for (const n of arr) {
        net += n.isReversal ? -n.amount : n.amount;
        out.push({
          entry_no: e,
          // 同一個 entry no 所有 line 用同一日（NetSuite 一張 JE 一個日期）；
          // 實際簽帳日已經喺 memo 末端。
          date: arr[0].journalDate,
          account: n.expenseAccount ? resolveAccount(n.expenseAccount) : "UNMAPPED",
          currency: "HKD",
          debit: n.isReversal ? null : n.amount,
          credit: n.isReversal ? n.amount : null,
          memo: `${n.memo} [IC leg]`,
          employee: n.employee || arr[0].cardholderEmp || "",
          subsidiary: sub,
          department: n.dept,
          class_project: n.project,
          name: "",
          is_credit_line: n.isReversal,
          cardholder: cpLabel,
          mapped: n.mapped,
          warning: n.expenseAccount ? undefined : "IC counterparty expense account missing",
        });
      }
      // Balancing "Amt Due To Photoblog" line (AP) in the counterparty's books
      // Round the accumulated net so this line's cents match the summed per-line cents.
      net = round2(net);
      const dueToIsCR = net >= 0;
      out.push({
        entry_no: e,
        date: arr[0].journalDate,
        account: apAccountDisplay,
        currency: "HKD",
        debit: dueToIsCR ? null : Math.abs(net),
        credit: dueToIsCR ? Math.abs(net) : null,
        // Line memo mirrors the payer's Due-From: just the card·last4·month label.
        memo: `Credit card payment - ${arr[0].cardLabel}`,
        subsidiary: sub,
        department: "",
        class_project: "",
        name: ic.ap_vendor_code || "",
        employee: arr[0].cardholderEmp || "",
        is_credit_line: dueToIsCR,
        cardholder: cpLabel,
        mapped: !!ic.ap_account_code,
        warning: ic.ap_account_code ? undefined : `IC AP account missing for ${ic.entity_code}`,
      });
      e++;
    }
    return { entries: out, nextEntryNo: e };
  }

  // Auto-classify bank-generated transactions (rebate / annual fee / interest charges).
  // These never have invoices to match against, so we map by merchant keyword to the right GL account.
  // 返回 account; DR vs CR 以原始 amount 負數判斷——statement 負金額 (rebate / fee REV) → CR
  const classifyBankEntry = (merchant: string, description: string | null): { accountNumber: string | null } => {
    const text = `${merchant} ${description || ""}`.toUpperCase();
    // Cash rebate / cash reward → Other Income (64000009) —— 通常出 CR
    if (/CASH\s*(REBATE|REWARD)|REWARD\s*CASH|CREDIT\s*REWARD|\bREBATE\b/i.test(text)) {
      return { accountNumber: "64000009" };
    }
    // Annual fee REV (reversal) → Other Income (64000009) —— 出 CR
    if (/ANNUAL\s*FEE\s*REV/i.test(text)) {
      return { accountNumber: "64000009" };
    }
    // Annual fee → Bank Charges (85000002) —— 出 DR
    if (/A\/C\s*ANNUAL\s*FEE|ANNUAL\s*FEE/i.test(text)) {
      return { accountNumber: "85000002" };
    }
    // Interest / finance charge → Bank Charges (85000002) —— 出 DR (or CR if reversal)
    if (/INTEREST\s*CHARGE|FINANCE\s*CHARGE|LATE\s*CHARGE|INTEREST/i.test(text)) {
      return { accountNumber: "85000002" };
    }
    return { accountNumber: null };
  };

  // Process transactions
  const transactions: TxnRow[] = useMemo(() => {
    if (!rawTxns) return [];
    return (rawTxns as any[]).map((t) => {
      const recon = t._recon;
      const invoice = recon?.meta_invoices;
      return {
        id: t.id,
        txn_date: t.txn_date,
        statement_date: t._statement_date || null,
        statement_file: t._statement_file || null,
        batch_id: t.batch_id || null,
        merchant: t.merchant,
        amount: Number(t.amount),
        amount_hkd: t.amount_hkd ? Number(t.amount_hkd) : null,
        currency: t.currency,
        fx_rate: Number(t.fx_rate),
        card_last4: t.card_last4 || "",
        description: t.description,
        reference: t.reference,
        period_month: t.period_month,
        match_status: recon?.status || null,
        invoice_number: invoice?.invoice_number || null,
        invoice_amount: invoice?.amount ? Number(invoice.amount) : null,
        batch_notes: t._batch_notes || null,
        inv_charge_to_entity: invoice?.charge_to_entity || null,
        inv_charge_to_code: invoice?.charge_to_code || null,
        inv_project_code: invoice?.project_code || null,
        inv_ns_account_number: invoice?.ns_account_number || null,
        inv_ns_account_name: invoice?.ns_account_name || null,
        inv_expense_category: invoice?.expense_category || null,
        inv_notes: t._inv_notes ?? null,
        inv_employee: t._inv_employee ?? null,
      };
    });
  }, [rawTxns]);

  // The journal's "month" is ALWAYS the statement-closing month — the same basis used
  // for grouping, journal dates and the Bulk-by-Month split. period_month is the user's
  // billing-period label and is offset ~1 month, so filtering by it would slice a single
  // statement across two months and break per-company balance.
  const statementMonthOf = (t: TxnRow): string => (t.statement_date || t.txn_date || "").slice(0, 7);

  const periods = useMemo(() => {
    const set = new Set<string>();
    transactions.forEach((t) => {
      const m = statementMonthOf(t);
      if (m) set.add(m);
    });
    return Array.from(set).sort().reverse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions]);

  const filtered = useMemo(() => {
    let list = transactions;
    if (selectedPeriod !== "all") list = list.filter((t) => statementMonthOf(t) === selectedPeriod);
    if (selectedCard !== "all") list = list.filter((t) => (t.card_last4 || "Unknown") === selectedCard);
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, selectedPeriod, selectedCard]);

  // Distinct cards present in the data — labelled with the friendly card name
  // (Rex / Alex Lo …) from ns_credit_card_accounts when available.
  const cardOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: { last4: string; label: string }[] = [];
    for (const t of transactions) {
      const l4 = t.card_last4 || "Unknown";
      if (seen.has(l4)) continue;
      seen.add(l4);
      const acc = (ccAccounts || []).find((a) => a.card_last4 === l4);
      out.push({ last4: l4, label: acc ? `${acc.card_identifier} (····${l4})` : `····${l4}` });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [transactions, ccAccounts]);

  // === FIXED: match CC account by card_last4 (was: cardholder name) ===
  function findCcAccountByLast4(last4: string): NsCcAccount | undefined {
    if (!ccAccounts || !last4) return undefined;
    return ccAccounts.find((a) => a.card_last4 === last4);
  }

  // req#2 — canonical subsidiary for an entity_code. A CLS card is registered under
  // "CLS Production Limited" but must book to "Photoblog.hk Limited : CLS GARAGE".
  function subOfEntity(entityCode: string): string {
    if (entityCode === "PBHK") return "Photoblog.hk Limited";
    const ic = icByEntity.get(entityCode);
    if (ic) return ic.sub_subsidiary_path || ic.pbhk_subsidiary_path || ic.entity_name;
    return entityToSubsidiary.get(entityCode) || entityCode;
  }

  // req#3 — the 5 companies (everyone except GoAsia / JS) must carry a Department on
  // every dept-cost line; blank ones are flagged so a colleague fills them before import.
  const FIVE_ENTITY_CODES = new Set(["PBHK", "704", "CLS", "JM", "SSHK"]);
  const DEPT_ALERT = "需要填 Department（5 間公司必填，同事跟進）";
  const needsDeptAccount = (accountNumber: string): boolean =>
    !!accountNumber &&
    (accountNumber.startsWith("7") || accountNumber.startsWith("81") || accountNumber.startsWith("21000"));

  // ⭐ Shared journal generator — ONE code path for both the main CSV (all / one period)
  // and the per-month zip, so their output can never diverge. Per (card, statement-month)
  // [req#1]: books each card's own expenses in its subsidiary [req#2]; aggregates every
  // cross-sub charge into ONE Due-From line per counterparty [req#7]; emits the
  // counterparty (real expense + Due-To) legs as separate, independently-balanced entries;
  // uses Project ID only [req#4] and account codes for Name [req#5]; finally flags
  // dept-cost lines in the 5 companies that are missing a Department [req#3].
  function buildEntriesForTxns(txnSubset: TxnRow[]): JournalEntry[] {
    const grouped = new Map<string, TxnRow[]>();
    for (const t of txnSubset) {
      const key = `${t.card_last4 || "Unknown"}||${statementMonthOf(t)}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(t);
    }

    const entries: JournalEntry[] = [];
    const icNeeds: IcNeed[] = [];
    let entryNo = 1;

    for (const txns of Array.from(grouped.values())) {
      const last4 = txns[0].card_last4 || "Unknown";
      const month = statementMonthOf(txns[0]);
      const ccAccount = findCcAccountByLast4(last4);
      // req#1 — label carries the month so每張卡每個月係獨立 double entry。
      const cardholderLabel = ccAccount
        ? `${ccAccount.card_identifier} (····${last4}) · ${month}`
        : `····${last4} · ${month}`;
      // req#2 — the card's entity → its canonical subsidiary.
      const cardEntityCode = normalizeToEntity(ccAccount?.subsidiary) || "PBHK";
      const ccSubsidiary = subOfEntity(cardEntityCode);
      // Employee rule — 每條 line 只出一個人。Statement-derived lines (CC payment,
      // un-invoiced expenses, Due-From / Due-To / IC legs) carry the CARDHOLDER;
      // invoice-backed lines override with the UPLOADER (t.inv_employee) below.
      const cardholderEmp = ccAccount
        ? (employeeByCode.get(ccAccount.cardholder_employee_code) || `${ccAccount.cardholder_employee_code || ""} ${ccAccount.cardholder_name || ""}`.trim())
        : "";

      // sum2 rounds the aggregate so the CC-liability cents match the per-line cents.
      const totalHkd = sum2(txns.map((t) => t.amount_hkd ?? t.amount));
      const statementDates = Array.from(
        new Set(txns.map((t) => t.statement_date).filter((d): d is string => !!d))
      ).sort();
      const journalDate = statementDates.length > 0
        ? statementDates[statementDates.length - 1]
        : txns.reduce((max, t) => (t.txn_date > max ? t.txn_date : max), txns[0].txn_date);

      // CC liability line — CR normally; DR if the month is net-negative (rebates > spend).
      const ccLineIsCR = totalHkd >= 0;
      entries.push({
        entry_no: entryNo,
        date: journalDate,
        account: ccAccount ? resolveAccount(ccAccount.account_number) : "UNMAPPED",
        currency: "HKD",
        debit: ccLineIsCR ? null : Math.abs(totalHkd),
        credit: ccLineIsCR ? Math.abs(totalHkd) : null,
        memo: `Credit card payment - ${cardholderLabel}`,
        subsidiary: ccSubsidiary,
        department: "",
        class_project: "",
        name: "",
        employee: cardholderEmp,
        is_credit_line: ccLineIsCR,
        cardholder: cardholderLabel,
        mapped: !!ccAccount,
        warning: !ccAccount ? `No NS account for card ····${last4}` : undefined,
      });

      // req#7 — aggregate every cross-sub charge into ONE Due-From line per counterparty.
      const arAccum = new Map<string, { net: number; ic: NsIntercompanyAccount }>();

      for (const t of txns) {
        const lines = linesByTxn.get(t.id) || [];
        // Line memo order (req): 備註 (Upload Centre invoice note) → merchant → invoice no → date.
        // The Date column stays on the statement month (txnDate below) so each company still
        // balances per month; only the memo carries the actual charge date, placed at the END.
        // Aggregate lines (CC payment, Due-From, Due-To) keep "Credit card payment - card·month".
        const memoParts: string[] = [];
        if (t.inv_notes) memoParts.push(t.inv_notes);
        memoParts.push(t.merchant);
        if (t.invoice_number) memoParts.push(`INV ${t.invoice_number}`);
        // Memo 末端嘅實際簽帳日 — dd/mm/yyyy 格式
        const _memoIso = (t.txn_date || "").slice(0, 10);
        const _m = _memoIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const _memoDate = _m ? `${_m[3]}/${_m[2]}/${_m[1]}` : _memoIso;
        if (_memoDate) memoParts.push(_memoDate);
        const datedMemo = memoParts.join(" - ");

        const rawAmt = t.amount_hkd ?? t.amount;
        const isReversalLine = rawAmt < 0;
        // FX guard — foreign txn with no HKD amount: emit so totals balance, but flag it.
        const fxMissing = t.currency !== "HKD" && t.amount_hkd == null;
        const txnDate = t.statement_date || t.txn_date;

        if (lines.length > 0) {
          // SPLIT — one accounting_line per allocation.
          for (const l of lines) {
            // req: line memo 用返 Upload Centre 每一筆嘅備註。每份 piece 嘅備註存喺
            // accounting_lines.description（AssignModal/分拆配對寫入）；parent invoice
            // 冇備註，所以唔可以只靠 txn 層面嘅 inv_notes。
            // 順序照舊：備註 → merchant → INV → date。
            const lineNote = l.description && l.description !== t.merchant ? l.description : (t.inv_notes || null);
            const lineMemoParts: string[] = [];
            if (lineNote) lineMemoParts.push(lineNote);
            lineMemoParts.push(t.merchant);
            if (t.invoice_number) lineMemoParts.push(`INV ${t.invoice_number}`);
            if (_memoDate) lineMemoParts.push(_memoDate);
            const lineMemo = lineMemoParts.join(" - ");
            const projLabel = l.ns_project_code || ""; // req#4 — Project ID only
            const splitAmt = round2(Math.abs(Number(l.amount_hkd)));
            const splitEmitSub =
              (l.ns_charge_to && chargeToSubsidiary.get(l.ns_charge_to)) || l.ns_subsidiary_name || null;
            const lineEntity = l.ns_entity_code || normalizeToEntity(splitEmitSub);
            const icOverride = resolveICOverride(cardEntityCode, l.ns_entity_code || splitEmitSub);

            if (icOverride) {
              // Cross-sub: accumulate the Due-From; the real expense + Due-To are booked
              // in the counterparty's ledger (below), never on the payer side.
              const acc = arAccum.get(icOverride.ic.entity_code) || { net: 0, ic: icOverride.ic };
              acc.net += isReversalLine ? -splitAmt : splitAmt;
              arAccum.set(icOverride.ic.entity_code, acc);
              if (icOverride.ic.has_payable_side && icOverride.ic.ap_account_code) {
                icNeeds.push({
                  cardLabel: cardholderLabel, cardholderEmp, journalDate, ic: icOverride.ic,
                  expenseAccount: l.ns_account_number, amount: splitAmt, isReversal: isReversalLine,
                  date: journalDate,
                  dept: (l.ns_charge_to && chargeToDeptName.get(l.ns_charge_to)) || l.ns_dept_name || "",
                  project: projLabel, memo: lineMemo, mapped: !!l.ns_account_number, employee: t.inv_employee || cardholderEmp,
                });
              }
            } else {
              // Same-sub expense (or unroutable cross-sub → book in card sub + flag).
              const crossSubUnmapped = !!lineEntity && lineEntity !== cardEntityCode;
              entries.push({
                entry_no: entryNo,
                date: journalDate,
                account: resolveAccount(l.ns_account_number),
                currency: "HKD",
                debit: isReversalLine ? null : splitAmt,
                credit: isReversalLine ? splitAmt : null,
                memo: lines.length > 1 ? `${lineMemo} [${l.split_pct?.toFixed(0)}%]` : lineMemo,
                employee: t.inv_employee || cardholderEmp,
                subsidiary: ccSubsidiary,
                department: crossSubUnmapped
                  ? ""
                  : (l.ns_charge_to && chargeToDeptName.get(l.ns_charge_to)) || l.ns_dept_name || "",
                class_project: projLabel,
                name: "",
                is_credit_line: isReversalLine,
                cardholder: cardholderLabel,
                mapped: fxMissing || crossSubUnmapped ? false : !!l.ns_account_number,
                warning: fxMissing
                  ? FX_MISSING_WARNING
                  : crossSubUnmapped
                    ? `Charged to ${splitEmitSub} but no IC account — booked in ${ccSubsidiary}; add an intercompany mapping`
                    : !l.ns_account_number
                      ? "GL account not set"
                      : undefined,
              });
            }
          }
        } else if (t.inv_charge_to_entity || t.inv_charge_to_code || t.inv_ns_account_number || t.inv_project_code) {
          // FALLBACK — no accounting_lines, but the matched invoice carries categorization.
          const amt = t.amount_hkd ?? t.amount;
          const invChargeCode =
            t.inv_charge_to_code ||
            (t.inv_charge_to_entity ? entityToDefaultChargeTo.get(t.inv_charge_to_entity) : undefined);
          const projLabel = t.inv_project_code || ""; // req#4 — Project ID only
          const absAmt = round2(Math.abs(amt));
          const invEmitSub =
            (invChargeCode && chargeToSubsidiary.get(invChargeCode)) ||
            (t.inv_charge_to_entity && entityToSubsidiary.get(t.inv_charge_to_entity)) ||
            null;
          const lineEntity = t.inv_charge_to_entity || normalizeToEntity(invEmitSub);
          const icOverride = resolveICOverride(cardEntityCode, t.inv_charge_to_entity || invEmitSub);

          if (icOverride) {
            const acc = arAccum.get(icOverride.ic.entity_code) || { net: 0, ic: icOverride.ic };
            acc.net += isReversalLine ? -absAmt : absAmt;
            arAccum.set(icOverride.ic.entity_code, acc);
            if (icOverride.ic.has_payable_side && icOverride.ic.ap_account_code) {
              icNeeds.push({
                cardLabel: cardholderLabel, cardholderEmp, journalDate, ic: icOverride.ic,
                expenseAccount: t.inv_ns_account_number, amount: absAmt, isReversal: isReversalLine,
                date: journalDate,
                dept: invChargeCode ? chargeToDeptName.get(invChargeCode) || "" : "",
                project: projLabel, memo: datedMemo, mapped: !!t.inv_ns_account_number, employee: t.inv_employee || cardholderEmp,
              });
            }
          } else {
            const invCrossSubUnmapped = !!lineEntity && lineEntity !== cardEntityCode;
            entries.push({
              entry_no: entryNo,
              date: journalDate,
              account: resolveAccount(t.inv_ns_account_number),
              currency: "HKD",
              debit: isReversalLine ? null : absAmt,
              credit: isReversalLine ? absAmt : null,
              memo: datedMemo,
              employee: t.inv_employee || cardholderEmp,
              subsidiary: ccSubsidiary,
              department: invCrossSubUnmapped ? "" : invChargeCode ? chargeToDeptName.get(invChargeCode) || "" : "",
              class_project: projLabel,
              name: "",
              is_credit_line: isReversalLine,
              cardholder: cardholderLabel,
              mapped: fxMissing || invCrossSubUnmapped ? false : !!t.inv_ns_account_number,
              warning: fxMissing
                ? FX_MISSING_WARNING
                : invCrossSubUnmapped
                  ? `Charged to ${invEmitSub} but no IC account — booked in ${ccSubsidiary}; add an intercompany mapping`
                  : !t.inv_ns_account_number
                    ? "Invoice has entity/project but no GL account"
                    : undefined,
            });
          }
        } else {
          // No split, no invoice — try bank-generated classification (rebate/fee/interest).
          const amt = t.amount_hkd ?? t.amount;
          const bankClass = classifyBankEntry(t.merchant, t.description);
          const absAmt = round2(Math.abs(amt));
          entries.push({
            entry_no: entryNo,
            date: journalDate,
            account: bankClass.accountNumber ? resolveAccount(bankClass.accountNumber) : "",
            currency: "HKD",
            debit: isReversalLine ? null : absAmt,
            credit: isReversalLine ? absAmt : null,
            memo: datedMemo,
            employee: t.inv_employee || cardholderEmp,
            subsidiary: ccSubsidiary,
            department: "",
            class_project: "",
            name: "",
            is_credit_line: isReversalLine,
            cardholder: cardholderLabel,
            mapped: fxMissing ? false : !!bankClass.accountNumber,
            warning: fxMissing ? FX_MISSING_WARNING : bankClass.accountNumber ? undefined : "Not split / assigned",
          });
        }
      }

      // req#7 — one aggregated Due-From line per counterparty; equals its Due-To leg.
      for (const acc of Array.from(arAccum.values())) {
        const net = round2(acc.net);
        const dueFromIsDR = net >= 0;
        // GoAsia / JS 冇 NetSuite payable side — 唔會出 IC 對方分錄，係靠開
        // Debit Note 追數，所以 memo 末端註明。
        const debitNoteTag = (!acc.ic.has_payable_side && acc.ic.ar_account_code)
          ? " (will be issued Debit Note)" : "";
        entries.push({
          entry_no: entryNo,
          date: journalDate,
          account: resolveAccount(acc.ic.ar_account_code),
          currency: "HKD",
          debit: dueFromIsDR ? Math.abs(net) : null,
          credit: dueFromIsDR ? null : Math.abs(net),
          memo: `Credit card payment - ${cardholderLabel}${debitNoteTag}`,
          subsidiary: ccSubsidiary,
          department: "",
          class_project: "",
          name: acc.ic.ar_customer_code || "",
          employee: cardholderEmp,
          is_credit_line: !dueFromIsDR,
          cardholder: cardholderLabel,
          mapped: !!acc.ic.ar_account_code,
          warning: acc.ic.ar_account_code ? undefined : `IC AR account missing for ${acc.ic.entity_code}`,
        });
      }

      entryNo++;
    }

    // Counterparty (other-subsidiary) entries, continuing the Entry No. sequence.
    const cp = buildIcCounterpartyEntries(icNeeds, entryNo);
    entries.push(...cp.entries);

    // req#3 — flag dept-cost lines in the 5 companies that have no Department.
    for (const e of entries) {
      const acctNum = (e.account || "").split(" ")[0];
      const entCode = normalizeToEntity(e.subsidiary);
      if (needsDeptAccount(acctNum) && entCode && FIVE_ENTITY_CODES.has(entCode) && !e.department) {
        e.mapped = false;
        e.warning = e.warning || DEPT_ALERT;
      }
    }

    return entries;
  }

  // Main preview / single-CSV entries — the selected period (or all) via the shared path.
  const journalEntries = useMemo(
    () => buildEntriesForTxns(filtered),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, ccAccounts, linesByTxn, entityToSubsidiary, entityToDefaultChargeTo, chargeToSubsidiary, chargeToDeptName, accountFullNameMap, icByEntity, nsDepartments, employeeByCode]
  );

  // Group entries by cardholder for display
  const cardGroups = useMemo(() => {
    const map = new Map<string, JournalEntry[]>();
    for (const e of journalEntries) {
      if (!map.has(e.cardholder)) map.set(e.cardholder, []);
      map.get(e.cardholder)!.push(e);
    }
    return Array.from(map.entries());
  }, [journalEntries]);

  // ⭐ 列出哪 9 條 unmapped + locate key
  // key = `${cardholder}__${indexInCard}` (狨後畫來 row ref + scroll)
  const unmappedList = useMemo(() => {
    const list: Array<{ key: string; cardholder: string; idx: number; entry: JournalEntry }> = [];
    const counters = new Map<string, number>();
    for (const e of journalEntries) {
      const cur = counters.get(e.cardholder) ?? 0;
      counters.set(e.cardholder, cur + 1);
      if (!e.mapped || e.warning) {
        list.push({
          key: `${e.cardholder}__${cur}`,
          cardholder: e.cardholder,
          idx: cur,
          entry: e,
        });
      }
    }
    return list;
  }, [journalEntries]);

  // 点击 「跳到」→ expand 卡 + scroll + flash highlight
  const locateEntry = (key: string, cardholder: string) => {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      next.add(cardholder);
      return next;
    });
    setHighlightedKey(key);
    // wait next tick for expand to render
    setTimeout(() => {
      const el = rowRefs.current.get(key);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 100);
    // auto-clear highlight after 3s
    setTimeout(() => setHighlightedKey((k) => (k === key ? null : k)), 3500);
  };

  // Per-subsidiary balance — each subsidiary is treated as an independent company,
  // so its own debits must equal its own credits (DR == CR).
  const subsidiarySummary = useMemo(() => {
    const map = new Map<string, { dr: number; cr: number }>();
    for (const e of journalEntries) {
      const sub = e.subsidiary || "UNMAPPED";
      if (!map.has(sub)) map.set(sub, { dr: 0, cr: 0 });
      const s = map.get(sub)!;
      s.dr += e.debit || 0;
      s.cr += e.credit || 0;
    }
    return Array.from(map.entries())
      .map(([sub, s]) => ({
        sub,
        dr: round2(s.dr),
        cr: round2(s.cr),
        diff: round2(s.dr - s.cr),
        balanced: Math.abs(s.dr - s.cr) < 0.01,
      }))
      .sort((a, b) => (b.dr + b.cr) - (a.dr + a.cr));
  }, [journalEntries]);

  const allSubsBalanced = useMemo(
    () => subsidiarySummary.every((s) => s.balanced),
    [subsidiarySummary]
  );

  const toggleCard = (cardholder: string) => {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      next.has(cardholder) ? next.delete(cardholder) : next.add(cardholder);
      return next;
    });
  };

  // Export CSV
  const handleExport = () => {
    if (journalEntries.length === 0) return;
    // Non-blocking pre-flight warning — count lines with mapping/FX problems.
    const issueCount = journalEntries.filter(
      (e) => e.warning || !e.account || e.account === "UNMAPPED"
    ).length;
    if (issueCount > 0) {
      toast({
        title: "Review needed",
        description: `${issueCount} lines have mapping/FX issues — review before importing to NetSuite`,
        variant: "destructive",
      });
    }
    // Each subsidiary is an independent company — its books must balance.
    const unbalancedSubs = subsidiarySummary.filter((s) => !s.balanced);
    if (unbalancedSubs.length > 0) {
      toast({
        title: "⚠ Subsidiary not balanced",
        description: `${unbalancedSubs.map((s) => `${s.sub}: Δ${s.diff.toFixed(2)}`).join("; ")} — each company must balance before NetSuite import`,
        variant: "destructive",
      });
    }
    const headers = [
      "Entry No.",
      "Date",
      "Account",
      "Currency",
      "Debit",
      "Credit",
      "Line: Memo",
      "Subsidiary",
      "Department",
      "Class/Project",
      "Name",
      "Employee",
    ];
    const rows = [headers.join(",")];
    for (const e of journalEntries) {
      rows.push(
        [
          e.entry_no,
          csvText(e.date),
          csvText(e.account),
          csvText(e.currency),
          csvAmount(e.debit),
          csvAmount(e.credit),
          csvText(e.memo),
          csvText(e.subsidiary),
          csvText(e.department),
          csvText(e.class_project),
          csvText(e.name),
          csvText(e.employee || ""),
        ].join(",")
      );
    }
    const csv = rows.join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const period = selectedPeriod === "all" ? "all" : selectedPeriod;
    const cardTag = selectedCard === "all" ? "" : `_card${selectedCard}`;
    a.download = `netsuite_journal_${period}${cardTag}_${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Export complete", description: `${journalEntries.length} lines exported` });
  };

  // ===== Post the currently-filtered journal straight to NetSuite =====
  // Same entries as the CSV, posted as UNAPPROVED drafts (a human approves in
  // NetSuite before they hit the ledger). externalId per (card, month[, IC])
  // makes re-posting safe — duplicates are reported, not re-created.
  const handlePostToNetSuite = async () => {
    if (journalEntries.length === 0 || isPosting) return;
    const entryCount = new Set(journalEntries.map((e) => e.entry_no)).size;
    const issueCount = journalEntries.filter((e) => e.warning || !e.account || e.account === "UNMAPPED").length;
    const warn = issueCount > 0 ? `\n\n⚠ 有 ${issueCount} 條 line 有 mapping/FX 問題 — 呢啲 entry 會被跳過並報錯。` : "";
    if (!window.confirm(
      `將以目前篩選（${selectedPeriod === "all" ? "所有月份" : selectedPeriod} · ${selectedCard === "all" ? "所有卡" : "····" + selectedCard}）` +
      `post ${entryCount} 張 JE 上 NetSuite（unapproved draft，NetSuite 入面 approve 先入賬）。${warn}\n\n繼續？`
    )) return;

    setIsPosting(true);
    try {
      const payload = journalEntries.map((e) => ({
        entry_no: e.entry_no,
        date: e.date,
        account: e.account,
        currency: e.currency,
        debit: e.debit,
        credit: e.credit,
        memo: e.memo,
        subsidiary: e.subsidiary,
        department: e.department,
        class_project: e.class_project,
        name: e.name,
        cardholder: e.cardholder,
      }));
      const { data, error } = await supabase.functions.invoke("netsuite-post-card-journal", {
        body: { entries: payload },
      });
      if (error) throw new Error(error.message || String(error));
      const res = data as { created: number; duplicates: number; failed: number; results: any[] };
      const errs = (res.results || []).filter((r) => r.status === "error");
      if (errs.length > 0) console.warn("[NetSuite post] errors:", errs);
      toast({
        title: res.failed > 0 ? "部分完成" : "已 post 上 NetSuite",
        description: `新建 ${res.created} 張` +
          (res.duplicates ? ` · ${res.duplicates} 張之前已 post（跳過）` : "") +
          (res.failed ? ` · ${res.failed} 張失敗：${errs[0]?.error?.slice(0, 160) || ""}` : "") +
          (res.created ? " — 請入 NetSuite approve。" : ""),
        variant: res.failed > 0 ? "destructive" : undefined,
      });
    } catch (e: any) {
      toast({ title: "Post 失敗", description: String(e?.message || e).slice(0, 300), variant: "destructive" });
    } finally {
      setIsPosting(false);
    }
  };

  // ===== Bulk export by statement month (zip) =====
  // 使用 statement_date 取 YYYY-MM 作 key。沒 statement_date 反回 txn_date。
  const handleBulkExportByMonth = async () => {
    if (transactions.length === 0) return;

    // Re-generate entries for ALL transactions (ignore selectedPeriod), grouped per month
    // Group transactions by statement month first, then run same generation logic per month
    const monthGroups = new Map<string, TxnRow[]>();
    for (const t of transactions) {
      const dateForMonth = t.statement_date || t.txn_date;
      const monthKey = dateForMonth ? dateForMonth.slice(0, 7) : "unknown";
      if (!monthGroups.has(monthKey)) monthGroups.set(monthKey, []);
      monthGroups.get(monthKey)!.push(t);
    }

    if (monthGroups.size === 0) {
      toast({ title: "沒咩可 export", variant: "destructive" });
      return;
    }

    const zip = new JSZip();
    const headers = [
      "Entry No.", "Date", "Account", "Currency", "Debit", "Credit",
      "Line: Memo", "Subsidiary", "Department", "Class/Project", "Name", "Employee",
    ];

    // Per-month entries reuse the SAME shared generator as the main export
    // (buildEntriesForTxns) so the two outputs can never diverge.

    const sortedMonths = Array.from(monthGroups.keys()).sort();
    let totalLines = 0;
    let issueLines = 0;
    const unbalancedMonthSubs: string[] = [];

    for (const month of sortedMonths) {
      const monthTxns = monthGroups.get(month)!;
      const monthEntries = buildEntriesForTxns(monthTxns);
      if (monthEntries.length === 0) continue;

      const rows = [headers.join(",")];
      for (const e of monthEntries) {
        if (e.warning || !e.account || e.account === "UNMAPPED") issueLines++;
        rows.push([
          e.entry_no, csvText(e.date), csvText(e.account), csvText(e.currency),
          csvAmount(e.debit), csvAmount(e.credit),
          csvText(e.memo),
          csvText(e.subsidiary), csvText(e.department), csvText(e.class_project), csvText(e.name), csvText(e.employee || ""),
        ].join(","));
      }
      const csvContent = "\uFEFF" + rows.join("\n");
      zip.file(`netsuite_journal_${month}.csv`, csvContent);
      totalLines += monthEntries.length;

      // Per-subsidiary balance for THIS month's file \u2014 each company must balance.
      const monthSubBal = new Map<string, { dr: number; cr: number }>();
      for (const e of monthEntries) {
        const sub = e.subsidiary || "UNMAPPED";
        if (!monthSubBal.has(sub)) monthSubBal.set(sub, { dr: 0, cr: 0 });
        const s = monthSubBal.get(sub)!;
        s.dr += e.debit || 0;
        s.cr += e.credit || 0;
      }
      monthSubBal.forEach((s, sub) => {
        if (Math.abs(s.dr - s.cr) >= 0.01) unbalancedMonthSubs.push(`${month}/${sub}: \u0394${round2(s.dr - s.cr).toFixed(2)}`);
      });
    }

    // Non-blocking pre-flight warning across all months.
    if (issueLines > 0) {
      toast({
        title: "Review needed",
        description: `${issueLines} lines have mapping/FX issues \u2014 review before importing to NetSuite`,
        variant: "destructive",
      });
    }
    // Each subsidiary is an independent company \u2014 its books must balance in every month file.
    if (unbalancedMonthSubs.length > 0) {
      toast({
        title: "\u26a0 Subsidiary not balanced",
        description: `${unbalancedMonthSubs.join("; ")} \u2014 each company must balance before NetSuite import`,
        variant: "destructive",
      });
    }

    const zipBlob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `netsuite_journals_by_month_${new Date().toISOString().split("T")[0]}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Bulk export complete", description: `${sortedMonths.length} 個月 · ${totalLines} lines · ${sortedMonths[0]} → ${sortedMonths[sortedMonths.length - 1]}` });
  };

  if (isLoading) return <Skeleton className="h-96" />;

  const unmappedCount = journalEntries.filter((e) => !e.mapped).length;
  const totalDr = journalEntries.reduce((s, e) => s + (e.debit || 0), 0);
  const totalCr = journalEntries.reduce((s, e) => s + (e.credit || 0), 0);
  const isBalanced = Math.abs(totalDr - totalCr) < 0.01;

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">NetSuite Journal Export</h1>
          <p className="text-sm text-muted-foreground">
            {journalEntries.length} lines · DR {totalDr.toFixed(2)} / CR {totalCr.toFixed(2)}
            {!isBalanced && <span className="text-destructive ml-2">⚠ Unbalanced</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
            <SelectTrigger className="w-48" title="以月結單截數月份篩選（同 Bulk-by-Month 一致）">
              <SelectValue placeholder="Statement month" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statement months</SelectItem>
              {periods.map((p) => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={selectedCard} onValueChange={setSelectedCard}>
            <SelectTrigger className="w-52" title="揀一張信用卡淨係 preview / export 佢嘅 journal" data-testid="select-export-card">
              <SelectValue placeholder="Credit card" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All credit cards</SelectItem>
              {cardOptions.map((c) => (
                <SelectItem key={c.last4} value={c.last4}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={handleExport} disabled={journalEntries.length === 0}>
            <Download size={16} className="mr-2" /> Export CSV
          </Button>
          <Button onClick={handlePostToNetSuite} disabled={journalEntries.length === 0 || isPosting}
            variant="secondary" title="將目前篩選嘅 journal 直接 post 上 NetSuite 做 unapproved draft" data-testid="button-post-netsuite">
            {isPosting ? <Loader2 size={16} className="mr-2 animate-spin" /> : <CloudUpload size={16} className="mr-2" />}
            Post to NetSuite
          </Button>
          <Button onClick={handleBulkExportByMonth} disabled={transactions.length === 0} variant="outline" title="以 statement 月份分開打包 zip">
            <Package size={16} className="mr-2" /> Bulk by Month (zip)
          </Button>
        </div>
      </div>

      {/* Per-subsidiary balance — every company must balance independently */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Per-Subsidiary Balance
            {allSubsBalanced
              ? <span className="text-green-600 ml-2">✓ every company balances</span>
              : <span className="text-destructive ml-2">⚠ a company is unbalanced</span>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-1">Subsidiary</th>
                <th className="text-right py-1">DR</th>
                <th className="text-right py-1">CR</th>
                <th className="text-right py-1">Balance</th>
              </tr>
            </thead>
            <tbody>
              {subsidiarySummary.map((s) => (
                <tr key={s.sub} className={`border-b border-border/50 ${!s.balanced || s.sub === "UNMAPPED" ? "bg-destructive/5" : ""}`}>
                  <td className="py-1">{s.sub === "UNMAPPED" ? <span className="text-destructive">⚠ {s.sub}</span> : s.sub}</td>
                  <td className="text-right tabular-nums">{s.dr.toFixed(2)}</td>
                  <td className="text-right tabular-nums">{s.cr.toFixed(2)}</td>
                  <td className={`text-right tabular-nums ${s.balanced ? "text-green-600" : "text-destructive font-medium"}`}>
                    {s.balanced ? "✓" : `Δ ${s.diff.toFixed(2)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {unmappedCount > 0 && (
        <div className="bg-amber-50 border border-amber-300 text-amber-900 rounded-md text-sm">
          <button
            type="button"
            className="w-full text-left p-3 flex items-center gap-2 hover:bg-amber-100/50 rounded-t-md"
            onClick={() => setShowUnmappedList((v) => !v)}
          >
            <AlertCircle size={14} />
            <span className="flex-1">
              {unmappedCount} 條 entries 有 mapping 問題（未 split / 冇 GL account / 冇 CC account）。
              {!showUnmappedList && <span className="underline ml-1">點探看哪几條</span>}
            </span>
            {showUnmappedList ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          {showUnmappedList && (
            <div className="px-3 pb-3 space-y-1 border-t border-amber-200">
              {unmappedList.map((u) => (
                <div key={u.key} className="flex items-center gap-2 py-1.5 text-xs border-b border-amber-100 last:border-0">
                  <span className="text-amber-700 font-medium tabular-nums">#{u.idx + 1}</span>
                  <span className="text-amber-800">{u.cardholder}</span>
                  <span className="text-amber-900 truncate flex-1" title={u.entry.memo}>
                    {u.entry.memo}
                  </span>
                  <span className="text-amber-700 tabular-nums">
                    {u.entry.debit ? `DR ${u.entry.debit.toFixed(2)}` : `CR ${u.entry.credit?.toFixed(2) || ""}`}
                  </span>
                  <span className="text-red-700 italic" title={u.entry.warning}>
                    {u.entry.warning || "unmapped"}
                  </span>
                  <button
                    type="button"
                    onClick={() => locateEntry(u.key, u.cardholder)}
                    className="px-2 py-0.5 bg-amber-700 hover:bg-amber-800 text-white rounded text-xs"
                  >
                    跳到 →
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Per-card details */}
      {cardGroups.map(([cardholder, entries]) => {
        const expanded = expandedCards.has(cardholder);
        return (
          <Card key={cardholder}>
            <CardHeader className="pb-2 cursor-pointer" onClick={() => toggleCard(cardholder)}>
              <CardTitle className="text-sm flex items-center gap-2">
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {cardholder}
                <Badge variant="outline" className="text-xs">{entries.length} lines</Badge>
              </CardTitle>
            </CardHeader>
            {expanded && (
              <CardContent>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-1">Date</th>
                      <th className="text-left py-1">Account</th>
                      <th className="text-right py-1">DR</th>
                      <th className="text-right py-1">CR</th>
                      <th className="text-left py-1">Memo</th>
                      <th className="text-left py-1">Subsidiary</th>
                      <th className="text-left py-1">Dept</th>
                      <th className="text-left py-1">Project</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e, i) => {
                      const rowKey = `${cardholder}__${i}`;
                      const isHighlighted = highlightedKey === rowKey;
                      return (
                      <tr
                        key={i}
                        ref={(el) => { rowRefs.current.set(rowKey, el); }}
                        className={`border-b border-border/50 transition-colors duration-500 ${
                          isHighlighted
                            ? "bg-yellow-200 ring-2 ring-yellow-500"
                            : e.warning ? "bg-amber-50/30" : ""
                        }`}
                      >
                        <td className="py-1">{e.date}</td>
                        <td className="py-1 tabular-nums">{e.account || <span className="text-amber-700">—</span>}</td>
                        <td className="text-right tabular-nums">{e.debit?.toFixed(2) || ""}</td>
                        <td className="text-right tabular-nums">{e.credit?.toFixed(2) || ""}</td>
                        <td className="py-1 truncate max-w-xs" title={e.memo}>{e.memo}</td>
                        <td className="py-1">{e.subsidiary}</td>
                        <td className="py-1">{e.department || "—"}</td>
                        <td className="py-1">{e.class_project || "—"}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}
