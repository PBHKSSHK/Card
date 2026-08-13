import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Download, ChevronDown, ChevronRight, AlertCircle, Bus, Receipt } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { csvText, csvAmount } from "@/lib/csv";
import { round2, sum2 } from "@/lib/money";
import { todayHK, toHKDate } from "@/lib/hkdate";

interface NsIntercompanyAccount {
  entity_code: string;
  entity_name: string;
  ar_account_code: string | null;
  ar_account_name: string | null;
  ar_customer_code: string | null;
  pbhk_subsidiary_path: string | null;
  has_payable_side: boolean;
}

interface ClaimBatch {
  id: string;
  batch_no: string | null;
  claim_type: "expenses" | "transportation";
  claimant_user_id: string;
  full_name: string | null;
  department: string | null;
  submit_date: string | null;
  period_month: string | null;
  charge_to_code: string;
  entity_code: string | null;
  subsidiary_full_name: string | null;
  department_name: string | null;
  status: string;
  approved_at: string | null;
  exported_at?: string | null;
  total_hkd: number | null;
  line_count: number | null;
}

interface ClaimLine {
  id: string;
  batch_id: string;
  item_no: number;
  line_date: string | null;
  project_code: string | null;
  description: string | null;
  has_receipt: boolean | null;
  client_name: string | null;
  currency: string | null;
  original_amount: number | null;
  fx_rate: number | null;
  hkd_amount: number | null;
  billable_to_client_hkd: number | null;
  expense_category_code: string | null;
  means_of_transport: string | null;
  taxi_reason: string | null;
  location_from: string | null;
  destination: string | null;
}

interface ExpenseCategory {
  category_key: string;
  label_zh: string | null;
  label_en: string | null;
  ns_account_number: string | null;
}

interface NsEmployee {
  code: string;
  name: string | null;
  email: string | null;
  subsidiary: string | null;
  department: string | null;
  employee_id: string | null;
  charge_to: string | null;
}

interface NsVendor {
  code: string;
  name: string | null;
  is_intercompany: boolean | null;
  related_subsidiary: string | null;
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
  // UI helpers
  is_credit_line: boolean;
  claimant: string;
  batch_no: string;
  mapped: boolean;
  warning?: string;
}

// 同 JournalExport.tsx 一致 — short name / full path → entity_code
const SUBSIDIARY_TO_ENTITY_CODE: Record<string, string> = {
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

// Transportation default account: staff_transport (員工交通)
// 如果 line 有 project_code → 用 project_travel
const TRANSPORTATION_DEFAULT_KEY = "staff_transport";
const TRANSPORTATION_PROJECT_KEY = "project_travel";

const DEFAULT_REIMBURSEMENT_ACCOUNT = "33000010"; // Accounts Payable
const LS_REIMBURSEMENT_KEY = "claim_journal_reimbursement_account";

export default function ClaimJournalExport() {
  const [selectedPeriod, setSelectedPeriod] = useState<string>("all");
  const [selectedType, setSelectedType] = useState<"all" | "transportation" | "expenses">("all");
  const [expandedBatches, setExpandedBatches] = useState<Set<string>>(new Set());
  const [showUnmappedList, setShowUnmappedList] = useState(false);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const [reimbursementAccount, setReimbursementAccount] = useState<string>(() => {
    if (typeof window === "undefined") return DEFAULT_REIMBURSEMENT_ACCOUNT;
    const stored = localStorage.getItem(LS_REIMBURSEMENT_KEY);
    // Migrate: old default 37001010 → new default 33000010 (Accounts Payable)
    if (stored === "37001010") return DEFAULT_REIMBURSEMENT_ACCOUNT;
    return stored || DEFAULT_REIMBURSEMENT_ACCOUNT;
  });
  const rowRefs = useRef<Map<string, HTMLTableRowElement | null>>(new Map());
  const { toast } = useToast();

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(LS_REIMBURSEMENT_KEY, reimbursementAccount);
    }
  }, [reimbursementAccount]);

  // ---- Data fetching ----
  // Only approved / exported batches are eligible (similar to: approved cards ready for posting)
  const { data: rawBatches, isLoading: batchesLoading } = useQuery<ClaimBatch[]>({
    queryKey: ["claim-journal-batches"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_batches")
        .select("id,batch_no,claim_type,claimant_user_id,full_name,department,submit_date,period_month,charge_to_code,entity_code,subsidiary_full_name,department_name,status,approved_at,exported_at,total_hkd,line_count")
        // Only FINALLY-approved (or already-exported) batches are eligible.
        // team_head_approved is deliberately excluded: a team-head signature is
        // not final approval, and posting it would bypass the last human
        // checkpoint before NetSuite.
        .in("status", ["approved", "exported"])
        .order("approved_at", { ascending: false });
      if (error) throw error;
      return (data || []) as ClaimBatch[];
    },
  });

  const batchIds = useMemo(() => (rawBatches || []).map((b) => b.id), [rawBatches]);

  const { data: rawLines } = useQuery<ClaimLine[]>({
    queryKey: ["claim-journal-lines", batchIds.join(",")],
    enabled: batchIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_lines")
        .select("*")
        .in("batch_id", batchIds)
        .order("item_no", { ascending: true });
      if (error) throw error;
      // 仂包含 approved 或未設狀態 (legacy = approved) 那些；退回不出 journal
      const filtered = (data || []).filter((l: any) => l.line_status !== "rejected");
      return filtered as ClaimLine[];
    },
  });

  const { data: expenseCategories } = useQuery<ExpenseCategory[]>({
    queryKey: ["expense-categories-journal"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expense_categories")
        .select("category_key, label_zh, label_en, ns_account_number");
      if (error) throw error;
      return (data || []) as ExpenseCategory[];
    },
  });

  const { data: nsDepartments } = useQuery<{ entity_code: string; subsidiary_name: string; subsidiary_full_name: string | null; charge_to: string; name: string }[]>({
    queryKey: ["ns-departments-claim-export"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_departments")
        .select("entity_code, subsidiary_name, subsidiary_full_name, charge_to, name");
      if (error) throw error;
      return data as any;
    },
  });

  const { data: nsEmployees } = useQuery<NsEmployee[]>({
    queryKey: ["ns-employees-claim-export"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_employees")
        .select("code, name, email, subsidiary, department, employee_id, charge_to");
      if (error) throw error;
      return (data || []) as NsEmployee[];
    },
  });

  // user_profiles: claimant_user_id → email (super user only)
  const { data: userProfiles } = useQuery<{ user_id: string; email: string | null; full_name: string | null }[]>({
    queryKey: ["user-profiles-claim-export"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_profiles")
        .select("user_id, email, full_name");
      if (error) return [];
      return (data || []) as any;
    },
  });

  // ns_vendors — for IC vendor lookup when cross-sub claim
  const { data: nsVendors } = useQuery<NsVendor[]>({
    queryKey: ["ns-vendors-claim-export"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_vendors")
        .select("code, name, is_intercompany, related_subsidiary");
      if (error) throw error;
      return (data || []) as NsVendor[];
    },
  });

  const { data: nsChartAccounts } = useQuery<{ account_number: string; full_name: string | null; account_name: string }[]>({
    queryKey: ["ns-chart-of-accounts-claim-export"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_chart_of_accounts")
        .select("account_number, full_name, account_name");
      if (error) throw error;
      return data as any;
    },
  });

  const { data: icAccounts } = useQuery<NsIntercompanyAccount[]>({
    queryKey: ["ns-intercompany-claim-export"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_intercompany_accounts")
        .select("entity_code, entity_name, ar_account_code, ar_account_name, ar_customer_code, pbhk_subsidiary_path, has_payable_side");
      if (error) throw error;
      return (data || []) as NsIntercompanyAccount[];
    },
  });

  const { data: nsProjectCodes } = useQuery<{ project_id: string; project_name: string }[]>({
    queryKey: ["ns-project-codes-claim-export"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_project_codes")
        .select("project_id, project_name");
      if (error) throw error;
      return (data || []) as any;
    },
  });

  // ---- Indices / maps ----
  const linesByBatch = useMemo(() => {
    const m = new Map<string, ClaimLine[]>();
    (rawLines || []).forEach((l) => {
      if (!m.has(l.batch_id)) m.set(l.batch_id, []);
      m.get(l.batch_id)!.push(l);
    });
    return m;
  }, [rawLines]);

  const categoryByKey = useMemo(() => {
    const m = new Map<string, ExpenseCategory>();
    (expenseCategories || []).forEach((c) => m.set(c.category_key, c));
    return m;
  }, [expenseCategories]);

  // email → ns_employees (lowercase email key)
  const empByEmail = useMemo(() => {
    const m = new Map<string, NsEmployee>();
    (nsEmployees || []).forEach((e) => {
      if (e.email) m.set(e.email.toLowerCase().trim(), e);
    });
    return m;
  }, [nsEmployees]);

  // user_id → email (from user_profiles)
  const emailByUid = useMemo(() => {
    const m = new Map<string, string>();
    (userProfiles || []).forEach((p) => {
      if (p.user_id && p.email) m.set(p.user_id, p.email.toLowerCase().trim());
    });
    return m;
  }, [userProfiles]);

  // user_id → ns_employee
  const empByUid = useMemo(() => {
    const m = new Map<string, NsEmployee>();
    (userProfiles || []).forEach((p) => {
      if (!p.user_id || !p.email) return;
      const emp = empByEmail.get(p.email.toLowerCase().trim());
      if (emp) m.set(p.user_id, emp);
    });
    return m;
  }, [userProfiles, empByEmail]);

  // Format NetSuite "Name" column: "<code> <name>" e.g. "PBL0008 Lam, Suk Man Susanna"
  function formatEmployeeName(emp: NsEmployee | undefined): string {
    if (!emp) return "";
    if (emp.code && emp.name) return `${emp.code} ${emp.name}`;
    return emp.code || emp.name || "";
  }

  // Normalize subsidiary string to short / tail name (drop parent prefix)
  // e.g. "Photoblog.hk Limited : Social Strategy Hong Kong Limited" → "Social Strategy Hong Kong Limited"
  //      "Photoblog.hk Limited"                                     → "Photoblog.hk Limited"
  function tailSub(s: string | null | undefined): string {
    if (!s) return "";
    if (s.includes(":")) return s.split(":").pop()!.trim();
    return s.trim();
  }

  // entity_code → IC vendor (is_intercompany=true, related_subsidiary tail → entity_code)
  // e.g. CLS → V10000556 (A/P to PB from CLS Garage)
  //      SSHK → V10000353 (A/P to PB from SSHK)
  // ⚠️ Assumes payer = PBHK — only IC vendors of form "A/P to PB from XXX" exist currently
  const icVendorByEmployeeEntity = useMemo(() => {
    const m = new Map<string, NsVendor>();
    (nsVendors || []).forEach((v) => {
      if (!v.is_intercompany || !v.related_subsidiary) return;
      const tail = tailSub(v.related_subsidiary);
      const entity = SUBSIDIARY_TO_ENTITY_CODE[tail] || SUBSIDIARY_TO_ENTITY_CODE[v.related_subsidiary];
      if (entity) m.set(entity, v);
    });
    return m;
  }, [nsVendors]);

  // Format vendor name: "<code> <name>" e.g. "V10000353 A/P to PB from SSHK"
  function formatVendorName(v: NsVendor | undefined): string {
    if (!v) return "";
    if (v.code && v.name) return `${v.code} ${v.name}`;
    return v.code || v.name || "";
  }

  const chargeToSubsidiary = useMemo(() => {
    const m = new Map<string, string>();
    (nsDepartments || []).forEach((d) => {
      if (!d.charge_to) return;
      const full = (d.subsidiary_full_name && d.subsidiary_full_name.trim()) ? d.subsidiary_full_name.trim() : d.subsidiary_name;
      if (full) m.set(d.charge_to, full);
    });
    return m;
  }, [nsDepartments]);

  const chargeToDeptName = useMemo(() => {
    const m = new Map<string, string>();
    (nsDepartments || []).forEach((d) => {
      if (d.charge_to && d.name) m.set(d.charge_to, d.name);
    });
    return m;
  }, [nsDepartments]);

  const chargeToEntity = useMemo(() => {
    const m = new Map<string, string>();
    (nsDepartments || []).forEach((d) => {
      if (d.charge_to && d.entity_code) m.set(d.charge_to, d.entity_code);
    });
    return m;
  }, [nsDepartments]);

  const icByEntity = useMemo(() => {
    const m = new Map<string, NsIntercompanyAccount>();
    (icAccounts || []).forEach((a) => m.set(a.entity_code, a));
    return m;
  }, [icAccounts]);

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

  const projectIdToName = useMemo(() => {
    const m = new Map<string, string>();
    (nsProjectCodes || []).forEach((p) => {
      if (p.project_id) m.set(p.project_id, p.project_name);
    });
    return m;
  }, [nsProjectCodes]);

  const resolveAccount = (num: string | null | undefined): string => {
    if (!num) return "";
    return accountFullNameMap.get(num) || num;
  };

  function normalizeToEntity(s: string | null | undefined): string | null {
    if (!s) return null;
    if (icByEntity.has(s)) return s;
    if (SUBSIDIARY_TO_ENTITY_CODE[s]) return SUBSIDIARY_TO_ENTITY_CODE[s];
    if (s.includes(":")) {
      const tail = s.split(":").pop()?.trim() || "";
      if (SUBSIDIARY_TO_ENTITY_CODE[tail]) return SUBSIDIARY_TO_ENTITY_CODE[tail];
    }
    return null;
  }

  function resolveICOverride(
    payerEntityCode: string,
    chargeToOrSubsidiary: string | null | undefined,
  ): { accountNumber: string; accountName: string | null; customerCode: string | null } | null {
    const emitEntity = normalizeToEntity(chargeToOrSubsidiary);
    if (!emitEntity) return null;
    if (emitEntity === payerEntityCode) return null;
    const ic = icByEntity.get(emitEntity);
    if (!ic || !ic.ar_account_code) return null;
    return {
      accountNumber: ic.ar_account_code,
      accountName: ic.ar_account_name,
      customerCode: ic.ar_customer_code,
    };
  }

  // ---- Filtering ----
  const periods = useMemo(() => {
    const set = new Set<string>();
    (rawBatches || []).forEach((b) => { if (b.period_month) set.add(b.period_month); });
    return Array.from(set).sort().reverse();
  }, [rawBatches]);

  const filteredBatches = useMemo(() => {
    return (rawBatches || []).filter((b) => {
      if (selectedPeriod !== "all" && b.period_month !== selectedPeriod) return false;
      if (selectedType !== "all" && b.claim_type !== selectedType) return false;
      return true;
    });
  }, [rawBatches, selectedPeriod, selectedType]);

  // ---- Journal generation ----
  // 同 CC 一樣：1 journal = 1 subsidiary (payer's sub)
  // CR 1 line: Reimbursement Payable (in payer's sub)
  // DR N lines: expense / IC AR  per claim_line
  // payer subsidiary = 由 claim_batches.subsidiary_full_name 來定 (i.e. 公司付錢的那一邊)
  const journalEntries = useMemo(() => {
    if (!rawBatches || rawBatches.length === 0) return [];
    const result: JournalEntry[] = [];
    let entryNo = 1;

    for (const batch of filteredBatches) {
      const lines = linesByBatch.get(batch.id) || [];
      if (lines.length === 0) continue;

      // Payer subsidiary = whatever charge_to_code lookup yields, else entity_code
      const payerSubsidiary = batch.subsidiary_full_name
        || (batch.charge_to_code ? chargeToSubsidiary.get(batch.charge_to_code) : null)
        || (batch.entity_code ? batch.entity_code : "UNMAPPED");
      const payerEntityCode = batch.entity_code
        || (batch.charge_to_code ? chargeToEntity.get(batch.charge_to_code) : null)
        || SUBSIDIARY_TO_ENTITY_CODE[payerSubsidiary] || "PBHK";

      const payerDept = batch.department_name
        || (batch.charge_to_code ? chargeToDeptName.get(batch.charge_to_code) : "")
        || "";

      // Resolve employee (for NetSuite Name column) via claimant_user_id → email → ns_employees
      const claimantEmp = empByUid.get(batch.claimant_user_id);
      const claimantLabel = `${batch.full_name || claimantEmp?.name || "Unknown"}${batch.batch_no ? ` (${batch.batch_no})` : ""}`;
      const batchNoDisplay = batch.batch_no || batch.id.slice(0, 8);

      // Determine if cross-sub: employee's home sub vs payer's sub
      const employeeEntity = claimantEmp?.subsidiary ? normalizeToEntity(claimantEmp.subsidiary) : null;
      const payerEntityNormalized = normalizeToEntity(payerSubsidiary) || payerEntityCode;
      const isCrossSub = employeeEntity !== null && payerEntityNormalized !== null && employeeEntity !== payerEntityNormalized;

      // CR/DR "Name" field:
      //  - Same-sub: employee code (e.g. PBL0008 Lam, Suk Man Susanna)
      //  - Cross-sub: IC vendor code (e.g. V10000353 A/P to PB from SSHK)
      let employeeNameField = "";
      let nameWarning: string | undefined;
      if (isCrossSub && employeeEntity) {
        const icVendor = icVendorByEmployeeEntity.get(employeeEntity);
        if (icVendor) {
          employeeNameField = formatVendorName(icVendor);
        } else {
          nameWarning = `No IC vendor (V-code) for employee from ${employeeEntity} when payer is ${payerEntityNormalized}`;
        }
      } else {
        employeeNameField = formatEmployeeName(claimantEmp);
        if (!employeeNameField) {
          nameWarning = `No NS employee found for claimant (user_id: ${batch.claimant_user_id.slice(0,8)}...)`;
        }
      }

      // Journal date — approved_at fallback to submit_date, fallback to first line_date
      // approved_at is a timestamptz: convert to HK-local date, not a raw UTC slice
      let journalDate = batch.approved_at ? toHKDate(batch.approved_at) : (batch.submit_date || "");
      if (!journalDate) {
        const lineDates = lines.map(l => l.line_date).filter((d): d is string => !!d).sort();
        journalDate = lineDates.length ? lineDates[lineDates.length - 1] : todayHK();
      }

      // Compute total HKD (positive = company owes employee → DR expense / CR payable)
      // Net from per-line 2dp-rounded amounts so the CR total exactly equals the
      // signed DR total (no per-line vs total rounding drift).
      const totalHkd = sum2(lines.map((l) => round2(Number(l.hkd_amount) || 0)));
      if (totalHkd <= 0) continue; // skip empty / negative batches; should not happen

      // ----- DR lines -----
      const drLines: JournalEntry[] = [];
      for (const l of lines) {
        const amt = round2(Number(l.hkd_amount) || 0);
        if (amt === 0) continue;

        // Resolve DR account
        let accountNumber: string | null = null;
        let warning: string | undefined;
        if (batch.claim_type === "transportation") {
          // 有 project_code → project_travel, else staff_transport
          const key = l.project_code ? TRANSPORTATION_PROJECT_KEY : TRANSPORTATION_DEFAULT_KEY;
          const cat = categoryByKey.get(key);
          accountNumber = cat?.ns_account_number || null;
          if (!accountNumber) warning = `Transportation default category ${key} not configured`;
        } else {
          // expenses — must have expense_category_code
          if (!l.expense_category_code) {
            warning = "No expense category";
          } else {
            const cat = categoryByKey.get(l.expense_category_code);
            accountNumber = cat?.ns_account_number || null;
            if (!accountNumber) warning = `Account not configured for category ${l.expense_category_code}`;
          }
        }

        // IC override: claim DR line's emit subsidiary = payer's? (single charge_to per batch)
        // For now claim batch only has ONE charge_to (no per-line override) — IC override applies
        // only when claimant works in different entity than payer. claimant is currently the same as payer
        // (since charge_to_code drives both). So no IC override in current design.
        // However, if user wants cross-entity, they would pick different charge_to per BATCH (not per line).
        // No IC override needed within batch — but keep code path consistent.
        // (Project_code could imply different entity but we keep IC override out for v1)

        // Memo
        let memo = "";
        if (batch.claim_type === "transportation") {
          const parts = [];
          if (l.means_of_transport) parts.push(l.means_of_transport);
          if (l.location_from || l.destination) parts.push(`${l.location_from || "?"} → ${l.destination || "?"}`);
          if (l.description) parts.push(l.description);
          if (l.taxi_reason) parts.push(`(${l.taxi_reason})`);
          memo = parts.join(" - ") || `Transportation #${l.item_no}`;
        } else {
          const parts = [];
          if (l.client_name) parts.push(l.client_name);
          if (l.description) parts.push(l.description);
          if (l.currency && l.currency !== "HKD" && l.original_amount) {
            parts.push(`${l.currency} ${l.original_amount.toFixed(2)} @${l.fx_rate || ""}`);
          }
          memo = parts.join(" - ") || `Expense #${l.item_no}`;
        }
        memo = `[${claimantLabel}] ${memo}`;
        // 實際單據日期放 memo 末端（dd/mm/yyyy）— Date 欄統一用 journalDate，
        // 一個 entry no 一個日期（NetSuite 一張 JE 一個日期）。
        if (l.line_date) {
          const dm = l.line_date.match(/^(\d{4})-(\d{2})-(\d{2})/);
          memo += ` - ${dm ? `${dm[3]}/${dm[2]}/${dm[1]}` : l.line_date}`;
        }

        const projLabel = l.project_code
          ? (projectIdToName.get(l.project_code) ? `${l.project_code} · ${projectIdToName.get(l.project_code)}` : l.project_code)
          : "";

        // A negative line amount must not become a negative Debit cell. Emit it as
        // a positive Credit instead; the CR Accounts-Payable total already nets
        // signed amounts, so the entry stays balanced with no negative cell.
        const isNegative = amt < 0;
        drLines.push({
          entry_no: entryNo,
          date: journalDate,
          account: accountNumber ? resolveAccount(accountNumber) : "UNMAPPED",
          currency: "HKD",
          debit: isNegative ? null : amt,
          credit: isNegative ? Math.abs(amt) : null,
          memo,
          subsidiary: payerSubsidiary,
          department: payerDept,
          class_project: projLabel,
          name: employeeNameField,
          is_credit_line: false,
          claimant: claimantLabel,
          batch_no: batchNoDisplay,
          mapped: !!accountNumber,
          warning,
        });
      }

      // ----- CR line (Accounts Payable) -----
      const crEntry: JournalEntry = {
        entry_no: entryNo,
        date: journalDate,
        account: resolveAccount(reimbursementAccount) || reimbursementAccount,
        currency: "HKD",
        debit: null,
        credit: totalHkd,
        memo: `Accounts payable - ${claimantLabel}${isCrossSub ? ` (IC: ${employeeEntity}→${payerEntityNormalized})` : ""}`,
        subsidiary: payerSubsidiary,
        department: payerDept,
        class_project: "",
        name: employeeNameField,
        is_credit_line: true,
        claimant: claimantLabel,
        batch_no: batchNoDisplay,
        mapped: !!accountFullNameMap.get(reimbursementAccount) && !!employeeNameField,
        warning: !accountFullNameMap.get(reimbursementAccount)
          ? `AP account ${reimbursementAccount} not found in COA`
          : nameWarning,
      };

      // CR 排第一條，DR 緊隨其後
      result.push(crEntry);
      result.push(...drLines);
      entryNo++;
    }

    return result;
  }, [filteredBatches, linesByBatch, categoryByKey, chargeToSubsidiary, chargeToDeptName, chargeToEntity, icByEntity, accountFullNameMap, projectIdToName, reimbursementAccount, empByUid, icVendorByEmployeeEntity]);

  // Group by batch for UI display
  const groupedByBatch = useMemo(() => {
    const m = new Map<string, JournalEntry[]>();
    for (const e of journalEntries) {
      const key = e.batch_no;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(e);
    }
    return Array.from(m.entries());
  }, [journalEntries]);

  // Unmapped list
  const unmappedList = useMemo(() => {
    const list: Array<{ key: string; batch_no: string; idx: number; entry: JournalEntry }> = [];
    const counters = new Map<string, number>();
    for (const e of journalEntries) {
      const cur = counters.get(e.batch_no) ?? 0;
      counters.set(e.batch_no, cur + 1);
      if (!e.mapped || e.warning) {
        list.push({ key: `${e.batch_no}__${cur}`, batch_no: e.batch_no, idx: cur, entry: e });
      }
    }
    return list;
  }, [journalEntries]);

  const locateEntry = (key: string, batchNo: string) => {
    setExpandedBatches((prev) => {
      const next = new Set(prev);
      next.add(batchNo);
      return next;
    });
    setHighlightedKey(key);
    setTimeout(() => {
      const el = rowRefs.current.get(key);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
    setTimeout(() => setHighlightedKey((k) => (k === key ? null : k)), 3500);
  };

  // Per-subsidiary balance check
  const subsidiarySummary = useMemo(() => {
    const map = new Map<string, { dr: number; cr: number }>();
    for (const e of journalEntries) {
      const sub = e.subsidiary || "UNMAPPED";
      if (!map.has(sub)) map.set(sub, { dr: 0, cr: 0 });
      const s = map.get(sub)!;
      s.dr += e.debit || 0;
      s.cr += e.credit || 0;
    }
    return Array.from(map.entries()).sort((a, b) => (b[1].dr + b[1].cr) - (a[1].dr + a[1].cr));
  }, [journalEntries]);

  // Per-month balance check
  const monthSummary = useMemo(() => {
    const map = new Map<string, { dr: number; cr: number }>();
    for (const e of journalEntries) {
      const monthKey = e.date ? e.date.slice(0, 7) : "unknown";
      if (!map.has(monthKey)) map.set(monthKey, { dr: 0, cr: 0 });
      const s = map.get(monthKey)!;
      s.dr += e.debit || 0;
      s.cr += e.credit || 0;
    }
    return Array.from(map.entries()).sort();
  }, [journalEntries]);

  const totalDR = useMemo(() => journalEntries.reduce((s, e) => s + (e.debit || 0), 0), [journalEntries]);
  const totalCR = useMemo(() => journalEntries.reduce((s, e) => s + (e.credit || 0), 0), [journalEntries]);

  // ---- Export ----
  const handleExport = () => {
    if (journalEntries.length === 0) {
      toast({ title: "沒咩可 export", variant: "destructive" });
      return;
    }
    const headers = [
      "Entry No.", "Date", "Account", "Currency", "Debit", "Credit",
      "Line: Memo", "Subsidiary", "Department", "Class/Project", "Name",
    ];
    const rows = [headers.join(",")];
    for (const e of journalEntries) {
      // entry_no raw; Debit/Credit via csvAmount (2dp, no float artifacts);
      // all text columns via csvText (quoted, escaped, formula-injection-safe).
      rows.push([
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
      ].join(","));
    }
    const csv = rows.join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const period = selectedPeriod === "all" ? "all" : selectedPeriod;
    const type = selectedType === "all" ? "claims" : selectedType;
    a.download = `netsuite_${type}_journal_${period}_${todayHK()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Export complete", description: `${journalEntries.length} lines exported` });
  };

  const toggleBatch = (batchNo: string) => {
    setExpandedBatches((prev) => {
      const next = new Set(prev);
      next.has(batchNo) ? next.delete(batchNo) : next.add(batchNo);
      return next;
    });
  };

  // ---- Render ----
  if (batchesLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const balanceOK = Math.abs(totalDR - totalCR) < 0.01;
  const unmappedCount = unmappedList.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Claim Journal Export</h1>
          <p className="text-sm text-muted-foreground">
            交通費 + General Claim 自動產生 NetSuite Journal (CR Accounts Payable; Name = employee code 同 sub / IC vendor code 跨 sub)
          </p>
        </div>
        <Button onClick={handleExport} disabled={journalEntries.length === 0}>
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {/* Filters + Reimbursement account */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <Label className="text-xs">Period</Label>
              <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Periods</SelectItem>
                  {periods.map((p) => (<SelectItem key={p} value={p}>{p}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Claim Type</Label>
              <Select value={selectedType} onValueChange={(v: any) => setSelectedType(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="transportation">交通費 Transportation</SelectItem>
                  <SelectItem value="expenses">General Expenses</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <Label className="text-xs">Accounts Payable Account (CR)</Label>
              <Input
                value={reimbursementAccount}
                onChange={(e) => setReimbursementAccount(e.target.value)}
                placeholder="e.g. 33000010"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {accountFullNameMap.get(reimbursementAccount) || "⚠️ Account not in COA"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Balance summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Total Lines</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold">{journalEntries.length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Total DR</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold">{totalDR.toLocaleString("en-US", { minimumFractionDigits: 2 })}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Total CR</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold">{totalCR.toLocaleString("en-US", { minimumFractionDigits: 2 })}</div></CardContent>
        </Card>
        <Card className={balanceOK ? "border-green-500" : "border-red-500"}>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Balance</CardTitle></CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${balanceOK ? "text-green-600" : "text-red-600"}`}>
              {balanceOK ? "✓ OK" : `Δ ${(totalDR - totalCR).toFixed(2)}`}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Per-subsidiary + per-month balance */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-sm">Per-Subsidiary Balance</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1 text-sm">
              {subsidiarySummary.map(([sub, s]) => {
                const ok = Math.abs(s.dr - s.cr) < 0.01;
                return (
                  <div key={sub} className="flex justify-between">
                    <span className="font-mono">{sub}</span>
                    <span className={ok ? "text-green-600" : "text-red-600"}>
                      DR {s.dr.toFixed(2)} / CR {s.cr.toFixed(2)} {!ok && `(Δ ${(s.dr - s.cr).toFixed(2)})`}
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Per-Month Balance</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1 text-sm">
              {monthSummary.map(([month, s]) => {
                const ok = Math.abs(s.dr - s.cr) < 0.01;
                return (
                  <div key={month} className="flex justify-between">
                    <span className="font-mono">{month}</span>
                    <span className={ok ? "text-green-600" : "text-red-600"}>
                      DR {s.dr.toFixed(2)} / CR {s.cr.toFixed(2)} {!ok && `(Δ ${(s.dr - s.cr).toFixed(2)})`}
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Unmapped banner */}
      {unmappedCount > 0 && (
        <Card className="border-yellow-500 bg-yellow-50 dark:bg-yellow-950">
          <CardContent className="pt-6">
            <button
              className="flex items-center justify-between w-full"
              onClick={() => setShowUnmappedList((v) => !v)}
            >
              <div className="flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-yellow-600" />
                <span className="font-semibold">{unmappedCount} 條 entries 有 mapping 問題</span>
              </div>
              {showUnmappedList ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
            {showUnmappedList && (
              <div className="mt-4 space-y-2">
                {unmappedList.map((u) => (
                  <div key={u.key} className="flex items-center justify-between gap-2 p-2 bg-white dark:bg-gray-900 rounded text-sm">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold">{u.entry.claimant}</div>
                      <div className="text-xs truncate">{u.entry.memo}</div>
                      <div className="text-xs text-yellow-700">
                        {u.entry.is_credit_line ? `CR ${u.entry.credit?.toFixed(2)}` : `DR ${u.entry.debit?.toFixed(2)}`}
                        {u.entry.warning && ` · ${u.entry.warning}`}
                      </div>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => locateEntry(u.key, u.batch_no)}>
                      跳到 →
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Grouped batches */}
      <Card>
        <CardHeader><CardTitle className="text-sm">Journal Entries by Batch</CardTitle></CardHeader>
        <CardContent>
          {groupedByBatch.length === 0 && (
            <div className="text-sm text-muted-foreground py-8 text-center">
              無 approved claim batch (要 status = approved / exported)
            </div>
          )}
          {groupedByBatch.map(([batchNo, entries]) => {
            const expanded = expandedBatches.has(batchNo);
            const drSum = entries.reduce((s, e) => s + (e.debit || 0), 0);
            const crSum = entries.reduce((s, e) => s + (e.credit || 0), 0);
            const balanced = Math.abs(drSum - crSum) < 0.01;
            const firstEntry = entries[0];
            const type = firstEntry.memo.includes("Transportation") || firstEntry.memo.includes("交通") ? "transportation" : "expenses";
            return (
              <div key={batchNo} className="border-b last:border-b-0">
                <button className="w-full flex items-center justify-between py-3 text-left hover:bg-accent/30 px-2" onClick={() => toggleBatch(batchNo)}>
                  <div className="flex items-center gap-2">
                    {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    {type === "transportation" ? <Bus className="h-4 w-4 text-blue-600" /> : <Receipt className="h-4 w-4 text-purple-600" />}
                    <span className="font-mono">{batchNo}</span>
                    <span className="text-sm text-muted-foreground">{firstEntry.claimant}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Badge variant="outline">{entries.length} lines</Badge>
                    <span className={balanced ? "text-green-600" : "text-red-600"}>
                      DR {drSum.toFixed(2)} / CR {crSum.toFixed(2)}
                    </span>
                  </div>
                </button>
                {expanded && (
                  <div className="overflow-x-auto px-2 pb-3">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b text-left">
                          <th className="py-1 pr-2">Date</th>
                          <th className="py-1 pr-2">Account</th>
                          <th className="py-1 pr-2 text-right">DR</th>
                          <th className="py-1 pr-2 text-right">CR</th>
                          <th className="py-1 pr-2">Memo</th>
                          <th className="py-1 pr-2">Subsidiary</th>
                          <th className="py-1 pr-2">Department</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entries.map((e, idx) => {
                          const rowKey = `${batchNo}__${idx}`;
                          const isHighlighted = highlightedKey === rowKey;
                          return (
                            <tr
                              key={rowKey}
                              ref={(el) => { rowRefs.current.set(rowKey, el); }}
                              className={`border-b last:border-b-0 ${isHighlighted ? "bg-yellow-200 ring-2 ring-yellow-500" : ""} ${!e.mapped || e.warning ? "bg-red-50 dark:bg-red-950/30" : ""}`}
                            >
                              <td className="py-1 pr-2 font-mono">{e.date}</td>
                              <td className="py-1 pr-2 font-mono">{e.account}</td>
                              <td className="py-1 pr-2 text-right">{e.debit?.toFixed(2) || ""}</td>
                              <td className="py-1 pr-2 text-right">{e.credit?.toFixed(2) || ""}</td>
                              <td className="py-1 pr-2 max-w-md truncate" title={e.memo}>{e.memo}</td>
                              <td className="py-1 pr-2">{e.subsidiary}</td>
                              <td className="py-1 pr-2">{e.department}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
