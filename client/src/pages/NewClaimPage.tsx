// NewClaimPage.tsx
// 新建 Claim form
// URL: /claims/new/expenses 或 /claims/new/transportation
// 用 useRoute 取出 claim_type
import { useState, useMemo, useEffect, useRef } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { parseDocument } from "@/lib/document-parser";
import { todayHK, currentMonthHK } from "@/lib/hkdate";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft, Plus, Trash2, Receipt, Car, Save, Send, Upload, X, UserCog, RefreshCw, HandCoins,
} from "lucide-react";

type ClaimType = "expenses" | "transportation" | "payment";

const PAYMENT_TERMS = [
  { code: "due_on_receipt", label: "即時付款 (Due on receipt)" },
  { code: "net7", label: "Net 7" },
  { code: "net14", label: "Net 14" },
  { code: "net30", label: "Net 30" },
  { code: "net60", label: "Net 60" },
  { code: "monthly", label: "月結" },
  { code: "other", label: "其他" },
];

const PAYMENT_METHODS = [
  { code: "bank_transfer", label: "銀行轉賬" },
  { code: "fps", label: "FPS 轉數快" },
  { code: "cheque", label: "支票" },
  { code: "autopay", label: "自動轉賬 Autopay" },
  { code: "other", label: "其他" },
];

const MEANS_OF_TRANSPORT = [
  { code: "TAXI", label: "Taxi 的士" },
  { code: "UBER", label: "Uber" },
  { code: "MTR", label: "MTR 港鐵" },
  { code: "BUS", label: "Bus 巴士" },
  { code: "TRAM", label: "Tram 電車" },
  { code: "MINIBUS", label: "Mini Bus 小巴" },
  { code: "FERRY", label: "Ferry 渡輪" },
  { code: "TRAIN", label: "Train 火車" },
  { code: "OTHER", label: "其他" },
];

const CURRENCIES = ["HKD", "USD", "CNY", "JPY", "EUR", "GBP", "TWD", "SGD", "THB", "MYR"];

// ns_departments.entity_code → ns_project_codes.charge_to prefix
// 704 只見 704 嘅 projects；SSHK 見 SS / SS-JM / SS-JS / SS-Prod；PBHK 見 PB-* etc.
const ENTITY_TO_PROJECT_PREFIXES: Record<string, string[]> = {
  "704": ["704"],
  "CLS": ["CLS"],
  "JM": ["JM"],
  "SSHK": ["SS"],
  "PBHK": ["PB"],
  "JS": ["SS-JS", "JS"],
  "GoAsia": [],
};

// Hardcoded HR department list — 純記錄用，唔同 charge_to
const HR_DEPARTMENTS = [
  "Management",
  "Finance",
  "Operations",
  "Sales",
  "Marketing",
  "Creative",
  "Media",
  "Performance",
  "Admin",
  "IT",
  "HR",
  "Other",
];

interface LineForm {
  _key: string;
  item_no: number;
  line_date: string;
  project_code: string;
  description: string;
  has_receipt: boolean;
  receipts: File[];  // 一行可多張
  // expenses
  client_name?: string;
  currency?: string;
  original_amount?: string;  // string for input ease
  fx_rate?: string;
  hkd_amount?: string;
  billable_to_client_hkd?: string;
  expense_category_code?: string;
  // payment — 一張發票拆多個 department (空 = 跟表頭 Charge To)
  line_charge_to?: string;
  // transport
  means_of_transport?: string;
  taxi_reason?: string;
}

function genKey() {
  return Math.random().toString(36).slice(2, 9);
}

// Period (YYYY-MM) → 該月第一日 / 最後一日 (明細日期只可以喺 Period 月份內揀)
function monthBounds(period: string | undefined): { min: string; max: string } | null {
  const m = (period || "").match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const lastDay = new Date(Number(m[1]), Number(m[2]), 0).getDate();
  return { min: `${period}-01`, max: `${period}-${String(lastDay).padStart(2, "0")}` };
}

// 將日期 clamp 入 period 月份：保留日子，超出月尾就用月尾
function clampToPeriod(date: string, period: string): string {
  const b = monthBounds(period);
  if (!b || !date) return date;
  if (date >= b.min && date <= b.max) return date;
  const day = date.slice(8, 10);
  if (!/^\d{2}$/.test(day)) return b.min;
  return `${period}-${day}` > b.max ? b.max : `${period}-${day}`;
}

function makeBlankLine(itemNo: number, type: ClaimType, period?: string): LineForm {
  // 預設日期 = 今日，但唔可以出 Period 月份 (fix #4: HK-local)
  const today = period ? clampToPeriod(todayHK(), period) : todayHK();
  // payment (付款申請) 明細同 expenses 一樣：project / category / 幣別 / 金額
  if (type === "expenses" || type === "payment") {
    return {
      _key: genKey(), item_no: itemNo, line_date: today,
      project_code: "", description: "", has_receipt: true,
      receipts: [],
      client_name: "", currency: "HKD",
      original_amount: "", fx_rate: "1", hkd_amount: "",
      billable_to_client_hkd: "0", expense_category_code: "",
      line_charge_to: "",
    };
  }
  return {
    _key: genKey(), item_no: itemNo, line_date: today,
    project_code: "", description: "", has_receipt: false,
    receipts: [],
    means_of_transport: "TAXI", taxi_reason: "",
    hkd_amount: "",
    expense_category_code: "staff_transport",
  };
}

// 交通類默認只顯示呢幾個 category；用戶可以揀
const TRANSPORT_CATEGORY_KEYS = ["staff_transport", "project_travel", "overseas_travel"];

export default function NewClaimPage() {
  const [, params] = useRoute<{ type: string }>("/claims/new/:type");
  const [, editParams] = useRoute<{ id: string }>("/claims/:id/edit");
  const [, payEditParams] = useRoute<{ id: string }>("/payments/:id/edit");
  const [, setLocation] = useLocation();
  const editId = editParams?.id || payEditParams?.id || null;
  const isEdit = !!editId;
  const isPayRoute = !!payEditParams;  // 由 /payments/:id/edit 入嚟
  // 付款申請分開兩個入口: /claims/new/payment_supplier (供應商) 同
  // /claims/new/payment_freelancer (自由工作者) — 類型由入口鎖死。
  const routeType = params?.type || "";
  const [initialType, setInitialType] = useState<ClaimType>(
    routeType === "transportation" ? "transportation"
      : (routeType.startsWith("payment") || isPayRoute) ? "payment"
      : "expenses"
  );
  // claim type — new 由 URL 決定；edit 由 loaded batch 決定（先用初始值，load 完會更新）
  const claimType: ClaimType = initialType;
  const { profile, session } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isSuperUser = profile?.role === "owner" || profile?.role === "admin";

  // Track original status (draft / rejected) for audit log + UI hints
  const [originalStatus, setOriginalStatus] = useState<string>("draft");
  const [rejectReason, setRejectReason] = useState<string>("");
  // Track existing attachments in edit mode (to allow user to delete pre-existing ones)
  const [existingAttachments, setExistingAttachments] = useState<any[]>([]);
  const [removedAttachmentIds, setRemovedAttachmentIds] = useState<Set<string>>(new Set());
  // Map of existing line_id → existing line-level attachments (for edit mode)
  const [existingLineAttachments, setExistingLineAttachments] = useState<Map<string, any[]>>(new Map());
  const [loadingEdit, setLoadingEdit] = useState<boolean>(isEdit);

  // Header form
  const [fullName, setFullName] = useState(profile?.full_name || profile?.email || session?.user?.email || "");
  const [nickName, setNickName] = useState("");
  const [department, setDepartment] = useState("");
  const [chargeToCode, setChargeToCode] = useState("");
  const [periodMonth, setPeriodMonth] = useState(currentMonthHK());  // HK-local (fix #4)
  const [submitDate, setSubmitDate] = useState(todayHK());  // HK-local (fix #4)

  // 代人填：predefined claimant_user_id；冇揀就用 login user
  const [claimantUserId, setClaimantUserId] = useState<string>(session?.user?.id || "");

  // Payment requisition (付款申請) — 收款人 + 付款資料
  const [payeeName, setPayeeName] = useState("");
  const [payeeType, setPayeeType] = useState(
    routeType === "payment_freelancer" ? "freelancer" : "supplier"
  );
  const [payeeFocus, setPayeeFocus] = useState(false);
  // IR56M 個人資料 (freelancer 付款先用)
  const [payeeHkid, setPayeeHkid] = useState("");
  const [payeeAddress, setPayeeAddress] = useState("");
  const [payeeGender, setPayeeGender] = useState("");
  const [payeePhone, setPayeePhone] = useState("");
  // 發票欄位 (payment 必填)
  const [invoiceDate, setInvoiceDate] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [invoiceAmount, setInvoiceAmount] = useState("");
  const [invoiceCurrency, setInvoiceCurrency] = useState("HKD");
  const [isPrepayment, setIsPrepayment] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState("bank_transfer");
  const [payeeBank, setPayeeBank] = useState("");
  const [payeeBankAccount, setPayeeBankAccount] = useState("");
  const [payeeAccountName, setPayeeAccountName] = useState("");
  const [payeeFpsId, setPayeeFpsId] = useState("");
  const [paymentDueDate, setPaymentDueDate] = useState("");
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState("");

  // Sync default claimant 同 fullName 跟住 profile 更新
  useEffect(() => {
    if (session?.user?.id && !claimantUserId) {
      setClaimantUserId(session.user.id);
    }
  }, [session?.user?.id]);

  useEffect(() => {
    if (!fullName && (profile?.full_name || profile?.email)) {
      setFullName(profile.full_name || profile.email || "");
    }
  }, [profile?.full_name, profile?.email]);

  // 代人填：所有 user_profiles (super user only)
  const { data: allUsers = [] } = useQuery({
    queryKey: ["user_profiles_for_proxy"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_profiles")
        .select("user_id, email, full_name, role")
        .order("full_name");
      if (error) return [];
      return data || [];
    },
    enabled: isSuperUser,
  });

  // 切換代填人時，auto-fill fullName
  function selectProxyClaimant(uid: string) {
    setClaimantUserId(uid);
    const u = allUsers.find((x: any) => x.user_id === uid);
    if (u) {
      setFullName(u.full_name || u.email || "");
    }
  }

  // Lines
  const [lines, setLines] = useState<LineForm[]>([makeBlankLine(1, claimType)]);

  // === EDIT MODE: load existing batch + lines + attachments ===
  useEffect(() => {
    if (!isEdit || !editId) return;
    let cancelled = false;
    (async () => {
      try {
        // 1. Load batch
        const { data: batch, error: bErr } = await supabase
          .from("claim_batches")
          .select("*")
          .eq("id", editId)
          .single();
        if (bErr) throw bErr;
        if (!batch) throw new Error("Claim not found");
        if (cancelled) return;

        // Only draft / rejected is editable
        if (batch.status !== "draft" && batch.status !== "rejected") {
          toast({
            title: "無法修改",
            description: `Claim 狀態為「${batch.status}」，只有 draft / rejected 可以修改`,
            variant: "destructive",
          });
          setLocation(batch.claim_type === "payment" ? `/payments/${editId}` : `/claims/${editId}`);
          return;
        }

        // Permission: must be claimant or super user
        const myUid = session?.user?.id;
        const isClaimant = myUid === batch.claimant_user_id;
        if (!isClaimant && !isSuperUser) {
          toast({
            title: "權限不足",
            description: "只有 claimant 或 admin/owner 可以修改",
            variant: "destructive",
          });
          setLocation(batch.claim_type === "payment" ? `/payments/${editId}` : `/claims/${editId}`);
          return;
        }

        // Populate header
        setOriginalStatus(batch.status || "draft");
        setRejectReason(batch.reject_reason || "");
        setInitialType((batch.claim_type as ClaimType) || "expenses");
        setFullName(batch.full_name || "");
        setNickName(batch.nick_name || "");
        setDepartment(batch.department || "");
        setChargeToCode(batch.charge_to_code || "");
        setPeriodMonth(batch.period_month || currentMonthHK());  // HK-local fallback (fix #4)
        setSubmitDate(batch.submit_date || todayHK());  // HK-local fallback (fix #4)
        setClaimantUserId(batch.claimant_user_id || myUid || "");
        // 付款申請 fields
        setPayeeName(batch.payee_name || "");
        setPayeeType(batch.payee_type || "supplier");
        setPaymentMethod(batch.payment_method || "bank_transfer");
        setPayeeBank(batch.payee_bank || "");
        setPayeeBankAccount(batch.payee_bank_account || "");
        setPayeeAccountName(batch.payee_account_name || "");
        setPayeeFpsId(batch.payee_fps_id || "");
        setPaymentDueDate(batch.payment_due_date || "");
        setSupplierInvoiceNo(batch.supplier_invoice_no || "");
        setPayeeHkid(batch.payee_hkid || "");
        setPayeeAddress(batch.payee_address || "");
        setPayeeGender(batch.payee_gender || "");
        setPayeePhone(batch.payee_phone || "");
        setInvoiceDate(batch.invoice_date || "");
        setPaymentTerms(batch.payment_terms || "");
        setInvoiceAmount(batch.invoice_amount != null ? String(batch.invoice_amount) : "");
        setInvoiceCurrency(batch.invoice_currency || "HKD");
        setIsPrepayment(!!batch.is_prepayment);

        // 2. Load lines
        const { data: existingLines } = await supabase
          .from("claim_lines")
          .select("*")
          .eq("batch_id", editId)
          .order("item_no");
        if (cancelled) return;

        if (existingLines && existingLines.length > 0) {
          const lineForms: LineForm[] = existingLines.map((l: any, idx: number) => ({
            _key: genKey(),
            item_no: l.item_no || idx + 1,
            line_date: l.line_date || todayHK(),  // HK-local fallback (fix #4)
            project_code: l.project_code || "",
            description: l.description || "",
            has_receipt: !!l.has_receipt,
            receipts: [],
            client_name: l.client_name || "",
            currency: l.currency || "HKD",
            original_amount: l.original_amount != null ? String(l.original_amount) : "",
            fx_rate: l.fx_rate != null ? String(l.fx_rate) : "1",
            hkd_amount: l.hkd_amount != null ? String(l.hkd_amount) : "",
            billable_to_client_hkd: l.billable_to_client_hkd != null ? String(l.billable_to_client_hkd) : "0",
            expense_category_code: l.expense_category_code || "",
            line_charge_to: l.line_charge_to || "",
            means_of_transport: l.means_of_transport || "TAXI",
            taxi_reason: l.taxi_reason || "",
            // attach DB id so we can map back line-level attachments
            ...({ _existing_line_id: l.id } as any),
          }));
          setLines(lineForms);
        }

        // 3. Load attachments
        const { data: atts } = await supabase
          .from("claim_attachments")
          .select("*")
          .eq("batch_id", editId)
          .order("uploaded_at");
        if (cancelled) return;

        if (atts && atts.length > 0) {
          // Batch-level: line_id = null
          setExistingAttachments(atts.filter((a: any) => !a.line_id));
          // Line-level: keyed by line_id
          const lineMap = new Map<string, any[]>();
          for (const a of atts) {
            if (!a.line_id) continue;
            if (!lineMap.has(a.line_id)) lineMap.set(a.line_id, []);
            lineMap.get(a.line_id)!.push(a);
          }
          setExistingLineAttachments(lineMap);
        }
      } catch (err: any) {
        console.error("[Edit Load]", err);
        toast({
          title: "無法載入草稿",
          description: err.message || "Load failed",
          variant: "destructive",
        });
        setLocation(isPayRoute ? "/payments" : "/claims");
      } finally {
        if (!cancelled) setLoadingEdit(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

  async function openExistingAttachment(path: string) {
    const { data } = await supabase.storage.from("documents").createSignedUrl(path, 3600);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  }

  function toggleRemoveExistingAttachment(id: string) {
    setRemovedAttachmentIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Attachments (file objects, upload on save)
  const [attachments, setAttachments] = useState<File[]>([]);

  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  // ns_departments for charge_to dropdown
  const { data: nsDepartments = [] } = useQuery({
    queryKey: ["ns_departments_claim"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_departments")
        .select("entity_code, charge_to, name, subsidiary_full_name")
        .order("entity_code").order("charge_to");
      if (error) throw error;
      return data || [];
    },
  });

  const chargeToMap = useMemo(() => {
    const m = new Map<string, any>();
    for (const d of nsDepartments) if (d.charge_to) m.set(d.charge_to, d);
    return m;
  }, [nsDepartments]);

  const chargeToOptions = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const d of nsDepartments) {
      if (!d.entity_code || !d.charge_to) continue;
      if (!groups.has(d.entity_code)) groups.set(d.entity_code, []);
      groups.get(d.entity_code)!.push(d);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([entity, items]) => ({ entity, items: items.sort((a: any, b: any) => a.charge_to.localeCompare(b.charge_to)) }));
  }, [nsDepartments]);

  // Project codes — table column 名係 project_id / project_name / charge_to / entity_name
  const { data: projectCodes = [] } = useQuery({
    queryKey: ["ns_project_codes_claim"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_project_codes")
        .select("id, project_id, project_name, charge_to, entity_name")
        .order("project_id");
      if (error) {
        console.warn("[NewClaimPage] ns_project_codes:", error.message);
        return [];
      }
      return data || [];
    },
  });

  // 揀完 charge_to 之後，根據 entity_code filter projects
  const currentEntity = chargeToCode ? chargeToMap.get(chargeToCode)?.entity_code : null;
  const filteredProjectCodes = useMemo(() => {
    if (!currentEntity) return [] as any[];
    const prefixes = ENTITY_TO_PROJECT_PREFIXES[currentEntity];
    if (!prefixes || prefixes.length === 0) return [];
    return projectCodes.filter((p: any) => {
      if (!p.charge_to) return false;
      // exact 或者 startsWith（讓 SSHK 見 SS 同 SS-JM/SS-JS 等）
      return prefixes.some(prefix =>
        p.charge_to === prefix || p.charge_to.startsWith(prefix + "-") || p.charge_to.startsWith(prefix)
      );
    });
  }, [projectCodes, currentEntity]);

  // Expense categories — settings 入面嘅 mapping (同 credit card recon 用同一張表)
  const { data: expenseCategoriesRaw = [] } = useQuery({
    queryKey: ["expense_categories_claim"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expense_categories")
        .select("category_key, label_zh, label_en, ns_account_number, sort_order, is_active")
        .eq("is_active", true)
        .order("sort_order");
      if (error) return [];
      return data || [];
    },
  });

  // Filter by claim type
  const expenseCategories = useMemo(() => {
    if (claimType === "transportation") {
      return expenseCategoriesRaw.filter((c: any) => TRANSPORT_CATEGORY_KEYS.includes(c.category_key));
    }
    return expenseCategoriesRaw;
  }, [expenseCategoriesRaw, claimType]);

  // NetSuite vendor 名冊 (ns_vendor_directory 鏡射) — 收款人揀選來源。
  // individual = 自由工作者，company = 供應商；表格類型只出對應嗰批。
  const { data: nsVendors = [] } = useQuery({
    queryKey: ["ns_vendor_directory", payeeType],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_vendor_directory")
        .select("internal_id, entityid, company_name, is_person, last_payment_date")
        .eq("is_inactive", false)
        .eq("is_person", payeeType === "freelancer")
        .order("company_name");
      if (error) return [];
      return data || [];
    },
    enabled: claimType === "payment",
  });

  const payeeMatches = useMemo(() => {
    const q = payeeName.trim().toLowerCase();
    if (!q) return nsVendors.slice(0, 8);
    return nsVendors
      .filter((v: any) =>
        (v.company_name || "").toLowerCase().includes(q) ||
        (v.entityid || "").toLowerCase().includes(q))
      .slice(0, 8);
  }, [nsVendors, payeeName]);

  const matchedVendor = useMemo(() => {
    const q = payeeName.trim().toLowerCase();
    if (!q) return null;
    return nsVendors.find((v: any) =>
      (v.company_name || "").trim().toLowerCase() === q ||
      (v.entityid || "").trim().toLowerCase() === q) || null;
  }, [nsVendors, payeeName]);
  const payeeInNs = !!matchedVendor;

  // IR56M 規則：freelancer 付款，NetSuite 未有呢個人，或者有但超過兩年
  // 冇銀行交易 (last_payment_date) — 一律要重新提交個人資料。
  const twoYearsAgo = useMemo(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 2);
    return d.toISOString().slice(0, 10);
  }, []);
  const needsPersonalInfo =
    claimType === "payment" && payeeType === "freelancer" && !!payeeName.trim() &&
    (!matchedVendor || !(matchedVendor as any).last_payment_date ||
      (matchedVendor as any).last_payment_date < twoYearsAgo);

  // 同 Upload Centre / Assign / Split 同一規則：
  // 揀咗 Project → Category 只出 [Project] (account 7xxxx)；
  // 冇揀 Project → 唔出 [Project] items。
  const isProjectCat = (c: any) => String(c.ns_account_number || "").startsWith("7");
  const categoriesForLine = (hasProject: boolean) =>
    expenseCategories.filter((c: any) => (hasProject ? isProjectCat(c) : !isProjectCat(c)));

  // Derived totals
  const totalHkd = useMemo(() => {
    return lines.reduce((s, l) => s + (parseFloat(l.hkd_amount || "0") || 0), 0);
  }, [lines]);

  function updateLine(key: string, patch: Partial<LineForm>) {
    setLines(prev => prev.map(l => {
      if (l._key !== key) return l;
      const merged = { ...l, ...patch };
      // FX auto-calc:expenses only —— 改 original_amount / fx_rate 時自動算 hkd_amount
      // 用戶直接改 hkd_amount 不會 trigger (因為 patch.hkd_amount 已經喺度，跳過 recompute)
      const isFxFieldChange =
        ("original_amount" in patch || "fx_rate" in patch || "currency" in patch)
        && !("hkd_amount" in patch);
      if (isFxFieldChange && claimType !== "transportation") {
        const orig = parseFloat(merged.original_amount || "");
        const fx = parseFloat(merged.fx_rate || "");
        if (!isNaN(orig) && !isNaN(fx) && orig > 0 && fx > 0) {
          merged.hkd_amount = (orig * fx).toFixed(2);
        }
      }
      return merged;
    }));
  }

  // Fetch live FX rate (free API, no key required)
  async function fetchFxRate(lineKey: string, currency: string) {
    if (!currency || currency === "HKD") {
      updateLine(lineKey, { fx_rate: "1" });
      return;
    }
    try {
      const resp = await fetch(`https://api.frankfurter.app/latest?from=${currency}&to=HKD`);
      const json = await resp.json();
      const rate = json?.rates?.HKD;
      if (rate) {
        updateLine(lineKey, { fx_rate: String(rate) });
        toast({
          title: "匯率已更新",
          description: `1 ${currency} = ${rate} HKD (${json.date})`,
        });
      } else {
        throw new Error("No rate returned");
      }
    } catch (e: any) {
      toast({
        title: "取匯率失敗",
        description: `${currency} → HKD 抓不到，請手動輸入`,
        variant: "destructive",
      });
    }
  }

  // Period 改咗 → 所有明細日期搬入新月份 (保留日子，超出月尾用月尾)
  function handlePeriodChange(v: string) {
    setPeriodMonth(v);
    if (!monthBounds(v)) return;
    setLines(prev => prev.map(l =>
      l.line_date ? { ...l, line_date: clampToPeriod(l.line_date, v) } : l
    ));
  }

  const periodBounds = monthBounds(periodMonth);

  function addLine() {
    setLines(prev => [...prev, makeBlankLine(prev.length + 1, claimType, periodMonth)]);
  }

  function removeLine(key: string) {
    setLines(prev => prev.filter(l => l._key !== key).map((l, idx) => ({ ...l, item_no: idx + 1 })));
  }

  // 上載發票影像 → AI 解析自動填收款人/發票欄位，影像自動變附件
  async function handleInvoiceOcr(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setOcrBusy(true);
    try {
      const res = await parseDocument(file, "meta_invoice");
      const inv = res.invoices?.[0];
      const vendor = (res.metadata as any)?.vendor;
      let filled = 0;
      if (vendor) { setPayeeName(String(vendor)); filled++; }
      if (inv?.invoice_number) { setSupplierInvoiceNo(String(inv.invoice_number)); filled++; }
      if (inv?.invoice_date) { setInvoiceDate(String(inv.invoice_date)); filled++; }
      if (inv?.amount != null && !isNaN(Number(inv.amount))) { setInvoiceAmount(String(inv.amount)); filled++; }
      if (inv?.currency) setInvoiceCurrency(String(inv.currency).toUpperCase());
      // 得一行空白明細 → 順手填埋金額
      setLines(prev => {
        if (prev.length === 1 && !prev[0].hkd_amount && !prev[0].original_amount && inv?.amount != null) {
          const cur = String(inv.currency || "HKD").toUpperCase();
          const patch: Partial<LineForm> = cur === "HKD"
            ? { hkd_amount: String(inv.amount), currency: "HKD", fx_rate: "1", original_amount: String(inv.amount) }
            : { currency: cur, original_amount: String(inv.amount), fx_rate: "", hkd_amount: "" };
          return [{ ...prev[0], ...patch, description: prev[0].description || inv.description || "" }];
        }
        return prev;
      });
      // 發票影像自動做附件 (附件係必填)
      setAttachments(prev => [...prev, file]);
      toast({
        title: "發票解析完成 ✓",
        description: filled > 0
          ? `已自動填咗 ${filled} 個欄位，請核對一次（尤其係金額同發票號）`
          : "解析唔到欄位 — 請人手填寫，影像已加入附件",
      });
    } catch (err: any) {
      toast({ title: "發票解析失敗", description: `${err.message || err} — 請人手填寫`, variant: "destructive" });
    } finally {
      setOcrBusy(false);
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    setAttachments(prev => [...prev, ...files]);
    e.target.value = ""; // reset input
  }

  function removeAttachment(idx: number) {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  }

  function handleLineFileUpload(lineKey: string, e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    setLines(prev => prev.map(l => l._key === lineKey
      ? { ...l, receipts: [...l.receipts, ...files], has_receipt: true }
      : l));
    e.target.value = "";
  }

  function removeLineReceipt(lineKey: string, idx: number) {
    setLines(prev => prev.map(l => {
      if (l._key !== lineKey) return l;
      const next = l.receipts.filter((_, i) => i !== idx);
      return { ...l, receipts: next, has_receipt: next.length > 0 ? l.has_receipt : false };
    }));
  }

  async function save(asSubmit: boolean) {
    if (!session?.user?.id) {
      toast({ title: "未登入", description: "請重新登入", variant: "destructive" });
      return;
    }
    // double-click 防護 — setSaving 係 async，快手連撳兩下會插兩張 batch
    // (實例: PAY-202608-0001/0002 一秒內孖生)，用 ref 即時擋
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await doSave(asSubmit);
    } finally {
      savingRef.current = false;
    }
  }

  async function doSave(asSubmit: boolean) {
    if (!session?.user?.id) return;
    // Draft 可以唔填 charge_to_code / full_name；submit 先要 enforce
    if (asSubmit) {
      if (!chargeToCode) {
        toast({ title: "缺少 Charge To", description: "請選擇 charge to code", variant: "destructive" });
        return;
      }
      if (!fullName) {
        toast({ title: "缺少姓名", description: "請填寫 Full Name", variant: "destructive" });
        return;
      }
      if (lines.length === 0 || lines.every(l => !l.hkd_amount)) {
        toast({ title: "未有明細", description: "至少需要一行有金額嘅明細", variant: "destructive" });
        return;
      }
      if (claimType === "payment" && !payeeName.trim()) {
        toast({ title: "缺少收款人", description: "付款申請必須填收款人 (supplier / freelancer 名稱)", variant: "destructive" });
        return;
      }
      // IR56M: 新收款人 / 超過兩年冇銀行交易嘅自由工作者 — 個人資料必填
      if (needsPersonalInfo && (!payeeHkid.trim() || !payeeAddress.trim() || !payeeGender || !payeePhone.trim())) {
        toast({
          title: "個人資料未填齊 (IR56M)",
          description: "呢位自由工作者係新收款人或超過兩年冇銀行交易 — HKID、住址、性別、電話全部必填",
          variant: "destructive",
        });
        return;
      }
      // 付款申請發票規則：必填欄位 + 每行合計=發票總額 + 附件 + 查重
      if (claimType === "payment") {
        if (!supplierInvoiceNo.trim()) {
          toast({ title: "缺少發票號", description: "供應商發票號必填", variant: "destructive" });
          return;
        }
        if (!invoiceDate) {
          toast({ title: "缺少發票日期", description: "發票日期必填", variant: "destructive" });
          return;
        }
        if (!paymentTerms) {
          toast({ title: "缺少付款條款", description: "請揀付款條款 (COD / Net 30 …)", variant: "destructive" });
          return;
        }
        const invAmt = parseFloat(invoiceAmount);
        if (!invoiceAmount || isNaN(invAmt) || invAmt <= 0) {
          toast({ title: "缺少發票總額", description: "發票總額必填 (要大過 0)", variant: "destructive" });
          return;
        }
        // 附件 (發票影像) 必填
        const lineReceiptCount = lines.reduce((s, l) => s + (l.receipts?.length || 0), 0);
        const keptExisting =
          existingAttachments.filter((a: any) => !removedAttachmentIds.has(a.id)).length +
          Array.from(existingLineAttachments.values()).flat().filter((a: any) => !removedAttachmentIds.has(a.id)).length;
        if (attachments.length + lineReceiptCount + keptExisting === 0) {
          toast({ title: "缺少附件", description: "請上載發票影像 (可以用「上載發票自動填表」)", variant: "destructive" });
          return;
        }
        // 每行金額合計 = 發票總額 (HKD 發票對 HKD 行；外幣發票對同幣別原幣)
        const sum = invoiceCurrency === "HKD"
          ? lines.reduce((s, l) => s + (parseFloat(l.hkd_amount || "0") || 0), 0)
          : lines.reduce((s, l) => s + ((l.currency || "HKD") === invoiceCurrency ? (parseFloat(l.original_amount || "0") || 0) : 0), 0);
        if (Math.abs(sum - invAmt) > 0.01) {
          toast({
            title: "行合計唔等於發票總額",
            description: `明細行合計 ${invoiceCurrency} ${sum.toFixed(2)}，發票總額 ${invoiceCurrency} ${invAmt.toFixed(2)} — 拆行後要啱數先可以提交`,
            variant: "destructive",
          });
          return;
        }
        // App 內查重：同一供應商 + 同一發票號 (DB trigger 都會擋，呢度俾清楚提示)
        // 只計已提交嘅單 — draft (包括提交失敗留低嘅) 唔應該阻住正式提交
        const escaped = supplierInvoiceNo.trim().replace(/[%_\\]/g, (m) => "\\" + m);
        const { data: dupApp } = await supabase.from("claim_batches")
          .select("id, batch_no, payee_name, status")
          .eq("claim_type", "payment")
          .not("status", "in", "(rejected,draft)")
          .ilike("supplier_invoice_no", escaped);
        const dupHit = (dupApp || []).find((b: any) => b.id !== editId &&
          String(b.payee_name || "").trim().toLowerCase() === payeeName.trim().toLowerCase());
        if (dupHit) {
          toast({
            title: "重複發票",
            description: `${dupHit.batch_no} 已用咗 ${payeeName} 嘅發票號 ${supplierInvoiceNo}，唔可以重複申請`,
            variant: "destructive",
          });
          return;
        }
        // NetSuite 查重：呢個 vendor 現有嘅 vendor bill 有冇同一發票號
        try {
          const { data: nsChk, error: nsErr } = await supabase.functions.invoke("netsuite-check-vendor-bill", {
            body: { payee_name: payeeName.trim(), invoice_no: supplierInvoiceNo.trim() },
          });
          if (!nsErr && nsChk?.exists) {
            toast({
              title: "NetSuite 已有呢張發票",
              description: `Vendor bill ${nsChk.bill?.tranid || ""}（${nsChk.bill?.trandate || ""}）已入咗數，唔可以重複申請`,
              variant: "destructive",
            });
            return;
          }
        } catch {
          // NetSuite 暫時查唔到就唔阻提交 — app / DB 查重照樣生效
        }
      }
      // 明細日期一定要喺 Period 月份之內
      if (periodBounds) {
        const bad = lines.filter(l => l.hkd_amount && l.line_date &&
          (l.line_date < periodBounds.min || l.line_date > periodBounds.max));
        if (bad.length > 0) {
          toast({
            title: "明細日期唔喺 Period 之內",
            description: `第 ${bad.map(l => l.item_no).join(", ")} 行嘅日期要喺 ${periodMonth} 月內`,
            variant: "destructive",
          });
          return;
        }
      }
      // Claim Forms 限制 (payment 唔受限)：60 天 + 防重複申報
      // (DB trigger 都會擋 — 呢度係俾同事清楚提示)
      if (claimType !== "payment") {
        const cutoff = (() => {
          const d = new Date(`${submitDate}T00:00:00`);
          d.setDate(d.getDate() - 60);
          return d.toISOString().slice(0, 10);
        })();
        const amtLines = lines.filter(l => l.hkd_amount && parseFloat(l.hkd_amount) > 0 && l.line_date);
        const tooOld = amtLines.filter(l => l.line_date < cutoff);
        if (tooOld.length > 0) {
          toast({
            title: "超過 60 天不可申報",
            description: `第 ${tooOld.map(l => l.item_no).join(", ")} 行日期早過 ${cutoff}（由 submit date 向前計 60 天）`,
            variant: "destructive",
          });
          return;
        }
        // 同一張表入面唔可以有重複行 (同日期+金額+描述)
        const seen = new Map<string, number>();
        for (const l of amtLines) {
          const key = `${l.line_date}|${parseFloat(l.hkd_amount!)}|${(l.description || "").trim().toLowerCase()}`;
          const prev = seen.get(key);
          if (prev != null) {
            toast({
              title: "重複明細",
              description: `第 ${prev} 同 ${l.item_no} 行係同日期+金額+描述，唔可以重複申報`,
              variant: "destructive",
            });
            return;
          }
          seen.set(key, l.item_no);
        }
        // 同一員工其他 claim (未被退回) 已申報過同日期+金額+描述
        const effClaimant = isSuperUser ? (claimantUserId || session.user.id) : session.user.id;
        const dates = [...new Set(amtLines.map(l => l.line_date))];
        if (dates.length > 0) {
          const { data: existing } = await supabase
            .from("claim_lines")
            .select("line_date, hkd_amount, description, line_status, batch_id, claim_batches!inner(claimant_user_id, status, batch_no, claim_type)")
            .in("line_date", dates)
            .eq("claim_batches.claimant_user_id", effClaimant)
            .not("claim_batches.status", "in", "(rejected,draft)")
            .in("claim_batches.claim_type", ["expenses", "transportation"]);
          for (const l of amtLines) {
            const hit: any = (existing || []).find((e: any) =>
              e.batch_id !== editId &&
              e.line_status !== "rejected" &&
              e.line_date === l.line_date &&
              Number(e.hkd_amount) === parseFloat(l.hkd_amount!) &&
              String(e.description || "").trim().toLowerCase() === (l.description || "").trim().toLowerCase());
            if (hit) {
              toast({
                title: "重複申報",
                description: `第 ${l.item_no} 行同 ${hit.claim_batches?.batch_no || "另一張 claim"} 已有嘅明細相同（同日期+金額+描述）`,
                variant: "destructive",
              });
              return;
            }
          }
        }
      }
    }

    setSaving(true);
    try {
      const effectiveClaimant = isSuperUser ? (claimantUserId || session.user.id) : session.user.id;
      // 收款人/付款欄位 — 只有付款申請先有值，其他類型全 null
      const payeeFields = claimType === "payment" ? {
        payee_name: payeeName.trim() || null,
        payee_type: payeeType || null,
        payment_method: paymentMethod || null,
        payee_bank: payeeBank.trim() || null,
        payee_bank_account: payeeBankAccount.trim() || null,
        payee_account_name: payeeAccountName.trim() || null,
        payee_fps_id: payeeFpsId.trim() || null,
        payment_due_date: paymentDueDate || null,
        supplier_invoice_no: supplierInvoiceNo.trim() || null,
        payee_hkid: payeeType === "freelancer" ? (payeeHkid.trim() || null) : null,
        payee_address: payeeType === "freelancer" ? (payeeAddress.trim() || null) : null,
        payee_gender: payeeType === "freelancer" ? (payeeGender || null) : null,
        payee_phone: payeeType === "freelancer" ? (payeePhone.trim() || null) : null,
        invoice_date: invoiceDate || null,
        payment_terms: paymentTerms || null,
        invoice_amount: invoiceAmount ? parseFloat(invoiceAmount) : null,
        invoice_currency: invoiceCurrency || "HKD",
        is_prepayment: isPrepayment,
      } : {
        payee_name: null, payee_type: null, payment_method: null,
        payee_bank: null, payee_bank_account: null, payee_account_name: null,
        payee_fps_id: null, payment_due_date: null, supplier_invoice_no: null,
        payee_hkid: null, payee_address: null, payee_gender: null, payee_phone: null,
        invoice_date: null, payment_terms: null, invoice_amount: null,
        invoice_currency: null, is_prepayment: false,
      };
      let batch: any;

      if (isEdit && editId) {
        // === UPDATE flow ===
        // 1a. Update batch header
        const { data: updatedBatch, error: updErr } = await supabase
          .from("claim_batches")
          .update({
            claim_type: claimType,
            claimant_user_id: effectiveClaimant,
            full_name: fullName || null,
            nick_name: nickName || null,
            department: department || null,
            submit_date: submitDate,
            period_month: periodMonth,
            charge_to_code: chargeToCode || null,
            ...payeeFields,
            // Fix #1: keep the batch in a lines-writable state (draft) while we
            // re-insert claim_lines below; the flip to "submitted" happens as the
            // LAST step (RLS only allows line writes while draft/rejected).
            status: "draft",
          })
          .eq("id", editId)
          .in("status", ["draft", "rejected"])  // safety: 只准 draft / rejected 改
          .select()
          .single();
        if (updErr) throw updErr;
        if (!updatedBatch) throw new Error("草稿不存在或狀態已變");
        batch = updatedBatch;

        // 1b. Delete existing lines (will re-insert)
        // 注意：claim_attachments 與 line_id 關聯，刪 lines 會 cascade 或會 孤兒。
        // 讀 schema FK = ON DELETE SET NULL。所以先將 line-level attachments 推到 batch 級。
        // 簡單作法：先 刪除 line-level attachments 的 row（storage 保留並 由 caller 手動清）
        // 但我們的 user 只修 draft，lines 並 重設，最安全作法：
        //   - 刪除 line_id 仍參照 舊 lines 的 attachments rows（storage object 保留，避免 誤刪）
        //   - 刪 lines（舊 id 不再被參照）
        // user 原本加 receipts 在 edit 中 本 依 舊 line.id 查，現改為 重設。
        // 為保護：只 在 line-level attachment 被 手動 標記 刪除時 才 動。
        // 這裡我們選擇：保留舊 line attachments rows，包含 line_id 指向刪除中 lines。
        // 該 line_id FK 為 ON DELETE SET NULL（見 migration_attachment_line_id）→ 會 推到 batch 級。
        await supabase.from("claim_lines").delete().eq("batch_id", editId);
      } else {
        // === INSERT flow (new claim) ===
        const { data: insertedBatch, error: batchErr } = await supabase
          .from("claim_batches")
          .insert({
            claim_type: claimType,
            claimant_user_id: effectiveClaimant,
            full_name: fullName || null,
            nick_name: nickName || null,
            department: department || null,
            submit_date: submitDate,
            period_month: periodMonth,
            charge_to_code: chargeToCode || null,
            ...payeeFields,
            // Fix #1: always insert as draft so claim_lines (below) are writable
            // under RLS; flip to "submitted" as the LAST step if asSubmit.
            status: "draft",
          })
          .select()
          .single();
        if (batchErr) throw batchErr;
        batch = insertedBatch;
      }

      // 2. Insert lines (both create + edit re-insert)
      // Draft: 保留所有「有任何資料」嘅行；Submit: 先 enforce hkd_amount > 0
      const hasAnyData = (l: LineForm) =>
        !!(l.hkd_amount || l.original_amount || l.description || l.client_name
           || l.project_code || l.taxi_reason
           || (l.receipts && l.receipts.length > 0));
      const linesToInsert = asSubmit
        ? lines.filter(l => l.hkd_amount && parseFloat(l.hkd_amount) > 0)
        : lines.filter(hasAnyData);
      const lineRows = linesToInsert.map(l => ({
        batch_id: batch.id,
        item_no: l.item_no,
        line_date: l.line_date || null,
        project_code: l.project_code || null,
        description: l.description || null,
        has_receipt: l.has_receipt,
        // expenses
        client_name: l.client_name || null,
        currency: l.currency || null,
        original_amount: l.original_amount ? parseFloat(l.original_amount) : null,
        fx_rate: l.fx_rate ? parseFloat(l.fx_rate) : null,
        hkd_amount: l.hkd_amount ? parseFloat(l.hkd_amount) : 0,
        billable_to_client_hkd: l.billable_to_client_hkd ? parseFloat(l.billable_to_client_hkd) : 0,
        expense_category_code: l.expense_category_code || null,
        line_charge_to: claimType === "payment" ? (l.line_charge_to || null) : null,
        // transport — location_from / destination 已棄用，留 NULL 兼容舊 schema
        means_of_transport: l.means_of_transport || null,
        taxi_reason: l.taxi_reason || null,
        location_from: null,
        destination: null,
      }));

      let insertedLines: any[] = [];
      if (lineRows.length > 0) {
        const { data: insRows, error: linesErr } = await supabase
          .from("claim_lines")
          .insert(lineRows)
          .select("id, item_no");
        if (linesErr) throw linesErr;
        insertedLines = insRows || [];
      }

      // Map item_no -> inserted line id
      const itemNoToLineId = new Map<number, string>();
      for (const r of insertedLines) itemNoToLineId.set(r.item_no, r.id);

      // 3a. Upload BATCH-level attachments (cover sheet etc, line_id = null)
      if (attachments.length > 0) {
        for (const file of attachments) {
          const ts = Date.now();
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
          const path = `${session.user.id}/claim-${batch.id}/${ts}-${safeName}`;
          const { error: upErr } = await supabase.storage
            .from("documents")
            .upload(path, file);
          if (upErr) {
            console.error("Attachment upload failed:", upErr);
            continue;
          }
          // Fix #5: check the row insert — a silent failure here orphans the
          // uploaded storage object (file exists but no claim_attachments row).
          const { error: attErr } = await supabase.from("claim_attachments").insert({
            batch_id: batch.id,
            line_id: null,
            storage_path: path,
            file_name: file.name,
            mime_type: file.type,
            size_bytes: file.size,
            uploaded_by_user_id: session.user.id,
          });
          if (attErr) {
            console.error("Attachment row insert failed:", attErr);
            toast({
              title: "附件記錄失敗",
              description: `「${file.name}」已上傳但未能記錄，請重試`,
              variant: "destructive",
            });
          }
        }
      }

      // 3b. Upload LINE-level attachments
      for (const l of linesToInsert) {
        if (!l.receipts || l.receipts.length === 0) continue;
        const lineId = itemNoToLineId.get(l.item_no);
        if (!lineId) continue;
        for (const file of l.receipts) {
          const ts = Date.now();
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
          const path = `${session.user.id}/claim-${batch.id}/line-${lineId}/${ts}-${safeName}`;
          const { error: upErr } = await supabase.storage
            .from("documents")
            .upload(path, file);
          if (upErr) {
            console.error("Line attachment upload failed:", upErr);
            continue;
          }
          // Fix #5: check the row insert (see batch-level note above).
          const { error: attErr } = await supabase.from("claim_attachments").insert({
            batch_id: batch.id,
            line_id: lineId,
            storage_path: path,
            file_name: file.name,
            mime_type: file.type,
            size_bytes: file.size,
            uploaded_by_user_id: session.user.id,
          });
          if (attErr) {
            console.error("Line attachment row insert failed:", attErr);
            toast({
              title: "附件記錄失敗",
              description: `「${file.name}」已上傳但未能記錄，請重試`,
              variant: "destructive",
            });
          }
        }
      }

      // 3c. Edit mode: process removed existing attachments
      if (isEdit && removedAttachmentIds.size > 0) {
        const idsToRemove = Array.from(removedAttachmentIds);
        // Find storage paths
        const allOld = [
          ...existingAttachments,
          ...Array.from(existingLineAttachments.values()).flat(),
        ];
        const pathsToRemove = allOld
          .filter((a: any) => idsToRemove.includes(a.id))
          .map((a: any) => a.storage_path)
          .filter(Boolean);
        if (pathsToRemove.length > 0) {
          await supabase.storage.from("documents").remove(pathsToRemove);
        }
        await supabase
          .from("claim_attachments")
          .delete()
          .in("id", idsToRemove);
      }

      // Fix #1: flip status to "submitted" as the LAST step, now that all
      // claim_lines + attachments have been written while the batch was still
      // draft/rejected (RLS only permits line writes in those states). Guarded
      // with .in(status) so a concurrently-changed batch can't be clobbered.
      if (asSubmit) {
        const { data: flipped, error: flipErr } = await supabase
          .from("claim_batches")
          .update({ status: "submitted" })
          .eq("id", batch.id)
          .in("status", ["draft", "rejected"])
          .select()
          .single();
        if (flipErr) throw flipErr;
        if (!flipped) throw new Error("提交失敗：狀態已變或無權限");
        batch = flipped;
      }

      // 4. Audit log
      await supabase.from("claim_audit_log").insert({
        batch_id: batch.id,
        action: isEdit
          ? (asSubmit ? "submitted" : "edited")
          : (asSubmit ? "submitted" : "created"),
        from_status: isEdit ? originalStatus : null,
        to_status: asSubmit ? "submitted" : "draft",
        actor_user_id: session.user.id,
      });

      toast({
        title: asSubmit
          ? (originalStatus === "rejected" ? "已重新提交" : "已提交")
          : (isEdit
              ? (originalStatus === "rejected" ? "已轉回草稿" : "已更新草稿")
              : "已儲存草稿"),
        description: `${batch.batch_no || ""} · 總金額 HK$${totalHkd.toFixed(2)}`,
      });
      // Fix #3: refresh the claims list + detail so the new/updated claim shows
      // without a hard reload.
      queryClient.invalidateQueries({ queryKey: ["claim-batches"] });
      queryClient.invalidateQueries({ queryKey: ["claim-batch", batch.id] });
      queryClient.invalidateQueries({ queryKey: ["claim-lines", batch.id] });
      setLocation(claimType === "payment" ? `/payments/${batch.id}` : `/claims/${batch.id}`);
    } catch (err: any) {
      console.error(err);
      toast({ title: "錯誤", description: err.message || "保存失敗", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const Icon = claimType === "expenses" ? Receipt : claimType === "payment" ? HandCoins : Car;
  const typeLabel = claimType === "expenses" ? "日常駛費 Claim"
    : claimType === "payment"
      ? (payeeType === "freelancer" ? "自由工作者付款申請 (Freelancer)" : "供應商付款申請 (Supplier)")
    : "交通費 Claim";
  const pageTitle = isEdit
    ? (originalStatus === "rejected" ? `修改退回申請 · ${typeLabel}` : `修改草稿 · ${typeLabel}`)
    : `新建 ${typeLabel}`;

  if (loadingEdit) {
    return (
      <div className="p-4 text-sm text-muted-foreground">載入草稿中 …</div>
    );
  }

  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => setLocation(
          isEdit
            ? (claimType === "payment" ? `/payments/${editId}` : `/claims/${editId}`)
            : (claimType === "payment" ? "/payments" : "/claims")
        )} data-testid="button-back">
          <ArrowLeft size={16} className="mr-1" /> 返回
        </Button>
        <div className="flex items-center gap-2">
          <Icon size={20} className="text-primary" />
          <h1 className="text-xl font-bold">{pageTitle}</h1>
        </div>
      </div>

      {/* Reject reason banner (only when editing a rejected claim) */}
      {isEdit && originalStatus === "rejected" && rejectReason && (
        <div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-sm">
          <div className="font-medium text-red-700 dark:text-red-400 mb-1">退回原因：</div>
          <div className="text-red-700 dark:text-red-400 whitespace-pre-wrap">{rejectReason}</div>
          <div className="text-[10px] text-muted-foreground mt-2">修改後点「提交申請」重新送審；点「儲存草稿」會轉回草稿狀態。</div>
        </div>
      )}

      {/* Header */}
      <Card><CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-muted-foreground">基本資料</div>
          {isSuperUser && (
            <div className="flex items-center gap-2">
              <UserCog size={14} className="text-muted-foreground" />
              <span className="text-xs text-muted-foreground">幫同事填:</span>
              <Select value={claimantUserId} onValueChange={selectProxyClaimant}>
                <SelectTrigger className="h-8 text-xs w-[240px]" data-testid="select-proxy-claimant">
                  <SelectValue placeholder="選擇 Claimant" />
                </SelectTrigger>
                <SelectContent>
                  {allUsers.map((u: any) => (
                    <SelectItem key={u.user_id} value={u.user_id}>
                      {u.full_name || u.email}
                      {u.user_id === session?.user?.id && <span className="text-muted-foreground ml-1">(我)</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">Claimant (Full Name) *</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} data-testid="input-fullname" />
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {claimantUserId === session?.user?.id ? "= 自己 (" + (session?.user?.email || "") + ")" : "代填中"}
            </div>
          </div>
          <div>
            <Label className="text-xs">Nick Name</Label>
            <Input value={nickName} onChange={(e) => setNickName(e.target.value)} data-testid="input-nickname" />
          </div>
          <div>
            <Label className="text-xs">Department (HR 分組)</Label>
            <Select value={department || "__none__"} onValueChange={(v) => setDepartment(v === "__none__" ? "" : v)}>
              <SelectTrigger data-testid="select-department"><SelectValue placeholder="選擇部門" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">—</SelectItem>
                {HR_DEPARTMENTS.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="md:col-span-2">
            <Label className="text-xs">Charge To Code * <span className="text-muted-foreground">(自動 derive entity / subsidiary)</span></Label>
            <Select value={chargeToCode} onValueChange={setChargeToCode}>
              <SelectTrigger data-testid="select-charge-to"><SelectValue placeholder="選擇 Charge To" /></SelectTrigger>
              <SelectContent className="max-h-[400px]">
                {chargeToOptions.map(({ entity, items }) => (
                  <div key={entity}>
                    <div className="sticky top-0 bg-muted/60 px-2 py-1 text-[10px] font-bold uppercase text-muted-foreground">{entity}</div>
                    {items.map((d: any) => (
                      <SelectItem key={d.charge_to} value={d.charge_to}>
                        <span className="font-mono text-xs">{d.charge_to}</span>
                        <span className="ml-2 text-muted-foreground">{d.name}</span>
                      </SelectItem>
                    ))}
                  </div>
                ))}
              </SelectContent>
            </Select>
            {chargeToCode && chargeToMap.get(chargeToCode) && (
              <div className="text-xs text-muted-foreground mt-1">
                → {chargeToMap.get(chargeToCode)?.subsidiary_full_name} · {chargeToMap.get(chargeToCode)?.name}
              </div>
            )}
          </div>
          <div>
            <Label className="text-xs">Period (Month) <span className="text-muted-foreground">(明細日期只可以喺呢個月內)</span></Label>
            <Input type="month" value={periodMonth} onChange={(e) => handlePeriodChange(e.target.value)} data-testid="input-period" />
          </div>
          <div>
            <Label className="text-xs">Submit Date</Label>
            <Input type="date" value={submitDate} onChange={(e) => setSubmitDate(e.target.value)} data-testid="input-submit-date" />
          </div>
        </div>
      </CardContent></Card>

      {/* 付款申請 — 收款人 + 付款資料 */}
      {claimType === "payment" && (
        <Card><CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <HandCoins size={15} /> 收款人資料 (Payee)
            </div>
            {/* 影相/上載發票 → AI 自動填收款人 + 發票欄位，影像自動做附件 */}
            <label htmlFor="invoice-ocr-upload" className="inline-flex">
              <Button asChild variant="outline" size="sm" disabled={ocrBusy}>
                <span>
                  {ocrBusy ? "解析緊發票…" : "📷 上載發票自動填表"}
                </span>
              </Button>
            </label>
            <input id="invoice-ocr-upload" type="file" accept=".pdf,.png,.jpg,.jpeg,.heic,.webp"
              capture="environment" onChange={handleInvoiceOcr} className="hidden" data-testid="input-invoice-ocr" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="relative">
              <Label className="text-xs">收款人名稱 *</Label>
              <Input value={payeeName}
                onChange={(e) => setPayeeName(e.target.value)}
                onFocus={() => setPayeeFocus(true)}
                onBlur={() => setTimeout(() => setPayeeFocus(false), 150)}
                placeholder={payeeType === "freelancer" ? "搜尋 NetSuite 自由工作者，或輸入新名" : "搜尋 NetSuite 供應商，或輸入新名"}
                autoComplete="off"
                data-testid="input-payee-name" />
              {payeeFocus && payeeMatches.length > 0 && (
                <div className="absolute z-30 mt-1 w-full max-h-56 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
                  {payeeMatches.map((v: any) => (
                    <button type="button" key={v.internal_id}
                      className="w-full text-left px-2 py-1.5 text-xs hover:bg-muted"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setPayeeName(v.company_name || v.entityid || "");
                        setPayeeFocus(false);
                      }}>
                      <span className="font-mono text-[10px] text-muted-foreground mr-1.5">{v.entityid}</span>
                      {v.company_name}
                    </button>
                  ))}
                </div>
              )}
              {payeeName.trim() && (payeeInNs ? (
                <div className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-0.5">✓ NetSuite 已有呢個收款人</div>
              ) : (
                <div className="text-[10px] text-amber-600 dark:text-amber-500 mt-0.5">
                  新收款人 — NetSuite 未有，批核後入 Bills 前要先喺 NetSuite 開 vendor
                </div>
              ))}
            </div>
            <div>
              <Label className="text-xs">類型 (由入口決定)</Label>
              <div className="h-9 flex items-center px-3 rounded-md border border-border bg-muted/30 text-sm" data-testid="payee-type-fixed">
                {payeeType === "freelancer" ? "Freelancer 自由工作者" : "Supplier 供應商"}
              </div>
            </div>
            <div>
              <Label className="text-xs">付款方式</Label>
              <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                <SelectTrigger data-testid="select-payment-method"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map(m => <SelectItem key={m.code} value={m.code}>{m.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {paymentMethod === "fps" ? (
              <div>
                <Label className="text-xs">FPS ID / 電話</Label>
                <Input value={payeeFpsId} onChange={(e) => setPayeeFpsId(e.target.value)} data-testid="input-payee-fps" />
              </div>
            ) : (
              <>
                <div>
                  <Label className="text-xs">銀行</Label>
                  <Input value={payeeBank} onChange={(e) => setPayeeBank(e.target.value)}
                    placeholder="e.g. HSBC / Hang Seng" data-testid="input-payee-bank" />
                </div>
                <div>
                  <Label className="text-xs">戶口號碼</Label>
                  <Input value={payeeBankAccount} onChange={(e) => setPayeeBankAccount(e.target.value)} data-testid="input-payee-account" />
                </div>
              </>
            )}
            <div>
              <Label className="text-xs">戶口名稱</Label>
              <Input value={payeeAccountName} onChange={(e) => setPayeeAccountName(e.target.value)}
                placeholder="同銀行紀錄一致" data-testid="input-payee-account-name" />
            </div>
            <div>
              <Label className="text-xs">供應商發票號 * <span className="text-muted-foreground">(同一供應商不可重複)</span></Label>
              <Input value={supplierInvoiceNo} onChange={(e) => setSupplierInvoiceNo(e.target.value)} data-testid="input-supplier-invoice" />
              <div className="text-[10px] text-muted-foreground mt-0.5">
                一張申請只認一張發票 — 同一供應商有多張發票，請分開多次申請
              </div>
            </div>
            <div>
              <Label className="text-xs">發票日期 *</Label>
              <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} data-testid="input-invoice-date" />
            </div>
            <div>
              <Label className="text-xs">付款條款 *</Label>
              <Select value={paymentTerms || undefined} onValueChange={setPaymentTerms}>
                <SelectTrigger data-testid="select-payment-terms"><SelectValue placeholder="揀…" /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_TERMS.map(t => <SelectItem key={t.code} value={t.code}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">發票總額 *</Label>
              <div className="flex gap-1.5">
                <Select value={invoiceCurrency} onValueChange={setInvoiceCurrency}>
                  <SelectTrigger className="w-[84px]" data-testid="select-invoice-currency"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Input type="number" step="0.01" value={invoiceAmount}
                  onChange={(e) => setInvoiceAmount(e.target.value)}
                  placeholder="0.00" className="text-right" data-testid="input-invoice-amount" />
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">明細行合計要等於呢個數 (可以拆多行唔同 project / 部門)</div>
            </div>
            <div>
              <Label className="text-xs">付款到期日</Label>
              <Input type="date" value={paymentDueDate} onChange={(e) => setPaymentDueDate(e.target.value)} data-testid="input-payment-due" />
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox checked={isPrepayment} onCheckedChange={(v) => setIsPrepayment(!!v)} data-testid="checkbox-prepayment" />
                <span>
                  預付款 / 按金 (Prepayment)
                  <span className="block text-[10px] text-muted-foreground">
                    唔係一般費用 — NetSuite 用 Vendor Prepayment / 預付科目入數，之後對沖
                  </span>
                </span>
              </label>
            </div>
          </div>
          {/* IR56M 個人資料 — freelancer 新收款人 / 超過兩年冇銀行交易先顯示 (必填) */}
          {payeeType === "freelancer" && needsPersonalInfo && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 space-y-3">
              <div className="text-xs font-medium text-amber-700 dark:text-amber-400">
                個人資料 (IR56M 報稅用途) — {matchedVendor
                  ? "呢位收款人超過兩年冇銀行交易，要重新提交"
                  : "NetSuite 未有呢位收款人，要提交"}個人資料，全部必填
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs">HKID 身份證號碼 *</Label>
                  <Input value={payeeHkid} onChange={(e) => setPayeeHkid(e.target.value)}
                    placeholder="e.g. A123456(7)" data-testid="input-payee-hkid" />
                </div>
                <div>
                  <Label className="text-xs">性別 *</Label>
                  <Select value={payeeGender || undefined} onValueChange={setPayeeGender}>
                    <SelectTrigger data-testid="select-payee-gender"><SelectValue placeholder="揀…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="M">男 M</SelectItem>
                      <SelectItem value="F">女 F</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">電話 *</Label>
                  <Input value={payeePhone} onChange={(e) => setPayeePhone(e.target.value)}
                    placeholder="e.g. 9123 4567" data-testid="input-payee-phone" />
                </div>
                <div className="md:col-span-3">
                  <Label className="text-xs">住址 *</Label>
                  <Input value={payeeAddress} onChange={(e) => setPayeeAddress(e.target.value)}
                    placeholder="完整通訊地址" data-testid="input-payee-address" />
                </div>
              </div>
            </div>
          )}
          {payeeType === "freelancer" && payeeName.trim() && !needsPersonalInfo && (
            <div className="text-[10px] text-emerald-600 dark:text-emerald-400">
              ✓ 呢位自由工作者兩年內有銀行交易紀錄，唔使重新提交個人資料
            </div>
          )}
          <div className="text-[10px] text-muted-foreground">
            記得喺下面附件位上載 supplier invoice / 報價單，方便審批。
          </div>
        </CardContent></Card>
      )}

      {/* Lines */}
      <Card><CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium">明細 ({lines.length} 行)</div>
          <Button size="sm" variant="outline" onClick={addLine} data-testid="button-add-line">
            <Plus size={14} className="mr-1" /> 加一行
          </Button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/30">
              <tr>
                <th className="px-2 py-2 text-left w-12">#</th>
                <th className="px-2 py-2 text-left">日期</th>
                <th className="px-2 py-2 text-left">Project</th>
                {claimType === "payment" && <th className="px-2 py-2 text-left">部門 (Charge To)</th>}
                {claimType !== "transportation" && <th className="px-2 py-2 text-left">Client</th>}
                {claimType === "transportation" && <>
                  <th className="px-2 py-2 text-left">交通工具</th>
                  <th className="px-2 py-2 text-left">類別</th>
                </>}
                <th className="px-2 py-2 text-left">說明 (由邊到邊 / 用途)</th>
                {claimType !== "transportation" && <>
                  <th className="px-2 py-2 text-left">Category</th>
                  <th className="px-2 py-2 text-left">幣別</th>
                  <th className="px-2 py-2 text-right">原幣金額</th>
                  <th className="px-2 py-2 text-right">FX</th>
                </>}
                <th className="px-2 py-2 text-right">HKD 金額</th>
                {claimType !== "transportation" && <th className="px-2 py-2 text-right">Billable</th>}
                {claimType !== "payment" && <th className="px-2 py-2 text-center w-[140px]">收據 (可多張)</th>}
                <th className="px-2 py-2 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l._key} className="border-b border-border/40" data-testid={`row-line-${l.item_no}`}>
                  <td className="px-2 py-2 tabular-nums">{l.item_no}</td>
                  <td className="px-2 py-2"><Input type="date" value={l.line_date}
                    min={periodBounds?.min} max={periodBounds?.max}
                    onChange={(e) => updateLine(l._key, { line_date: e.target.value })}
                    onBlur={(e) => {
                      // date picker min/max 可以被手動打字繞過 — blur 時 clamp 返入 Period
                      const v = e.target.value;
                      if (v && periodBounds && (v < periodBounds.min || v > periodBounds.max)) {
                        updateLine(l._key, { line_date: clampToPeriod(v, periodMonth) });
                      }
                    }}
                    className="h-7 text-xs" /></td>
                  <td className="px-2 py-2">
                    <Select
                      value={l.project_code || "__none__"}
                      onValueChange={(v) => {
                        const project_code = v === "__none__" ? "" : v;
                        const patch: Partial<LineForm> = { project_code };
                        // category 同新 project 狀態唔夾就自動處理:
                        // transport 轉返合適類別，expenses/payment 清走要重新揀
                        const cat = expenseCategoriesRaw.find((c: any) => c.category_key === l.expense_category_code);
                        if (cat && !!project_code !== isProjectCat(cat)) {
                          patch.expense_category_code = claimType === "transportation"
                            ? (project_code ? "project_travel" : "staff_transport")
                            : "";
                        }
                        updateLine(l._key, patch);
                      }}
                      disabled={!chargeToCode}
                    >
                      <SelectTrigger className="h-7 text-xs min-w-[140px]">
                        <SelectValue placeholder={chargeToCode ? "—" : "請先揀 Charge To"} />
                      </SelectTrigger>
                      <SelectContent className="max-h-[400px]">
                        <SelectItem value="__none__">—</SelectItem>
                        {filteredProjectCodes.length === 0 && chargeToCode && (
                          <div className="px-2 py-1 text-[10px] text-muted-foreground">
                            {currentEntity} 沒有可選 project
                          </div>
                        )}
                        {filteredProjectCodes.map((p: any) => (
                          <SelectItem key={p.id || p.project_id} value={p.project_id}>
                            <span className="font-mono text-[10px] mr-1">{p.project_id}</span>
                            <span className="text-muted-foreground">{p.project_name}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  {claimType === "payment" && (
                    <td className="px-2 py-2">
                      {/* 一張發票拆多個 department — 空 = 跟表頭 Charge To */}
                      <Select
                        value={l.line_charge_to || "__hdr__"}
                        onValueChange={(v) => updateLine(l._key, { line_charge_to: v === "__hdr__" ? "" : v })}
                      >
                        <SelectTrigger className="h-7 text-xs min-w-[130px]">
                          <SelectValue placeholder="跟表頭" />
                        </SelectTrigger>
                        <SelectContent className="max-h-[400px]">
                          <SelectItem value="__hdr__">跟表頭 ({chargeToCode || "未揀"})</SelectItem>
                          {chargeToOptions.map(({ entity, items }) => (
                            <div key={entity}>
                              <div className="sticky top-0 bg-muted/60 px-2 py-1 text-[10px] font-bold uppercase text-muted-foreground">{entity}</div>
                              {items.map((d: any) => (
                                <SelectItem key={d.charge_to} value={d.charge_to}>
                                  <span className="font-mono text-[10px]">{d.charge_to}</span>
                                  <span className="ml-1 text-muted-foreground">{d.name}</span>
                                </SelectItem>
                              ))}
                            </div>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                  )}
                  {claimType !== "transportation" && (
                    <td className="px-2 py-2">
                      <Input
                        value={l.client_name || ""}
                        onChange={(e) => updateLine(l._key, { client_name: e.target.value })}
                        className="h-7 text-xs min-w-[180px]"
                        placeholder="客戶名"
                      />
                    </td>
                  )}
                  {claimType === "transportation" && <>
                    <td className="px-2 py-2">
                      <Select value={l.means_of_transport} onValueChange={(v) => updateLine(l._key, { means_of_transport: v })}>
                        <SelectTrigger className="h-7 text-xs min-w-[80px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {MEANS_OF_TRANSPORT.map(m => <SelectItem key={m.code} value={m.code}>{m.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      {(l.means_of_transport === "TAXI" || l.means_of_transport === "UBER") && (
                        <Input placeholder="原因..." value={l.taxi_reason || ""} onChange={(e) => updateLine(l._key, { taxi_reason: e.target.value })} className="h-6 text-[10px] mt-1" />
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <Select value={l.expense_category_code || "staff_transport"} onValueChange={(v) => updateLine(l._key, { expense_category_code: v })}>
                        <SelectTrigger className="h-7 text-xs min-w-[140px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {categoriesForLine(!!l.project_code).map((c: any) => (
                            <SelectItem key={c.category_key} value={c.category_key}>
                              <span className="font-mono text-[10px] text-muted-foreground mr-1">{c.ns_account_number}</span>
                              {c.label_zh}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                  </>}
                  <td className="px-2 py-2">
                    <Input
                      value={l.description}
                      onChange={(e) => updateLine(l._key, { description: e.target.value })}
                      className="h-7 text-xs min-w-[240px]"
                      placeholder={claimType === "transportation" ? "由 Mong Kok 到 Chai Wan (送貨)" : "說明 / 用途"}
                    />
                  </td>
                  {claimType !== "transportation" && <>
                    <td className="px-2 py-2">
                      <Select value={l.expense_category_code || "__none__"} onValueChange={(v) => updateLine(l._key, { expense_category_code: v === "__none__" ? "" : v })}>
                        <SelectTrigger className="h-7 text-xs min-w-[160px]">
                          <SelectValue placeholder={l.project_code ? "揀 [Project] 類別" : "— 選費用類別 —"} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">—</SelectItem>
                          {categoriesForLine(!!l.project_code).map((c: any) => (
                            <SelectItem key={c.category_key} value={c.category_key}>
                              <span className="font-mono text-[10px] text-muted-foreground mr-1">{c.ns_account_number}</span>
                              {c.label_zh}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-2 py-2">
                      <Select value={l.currency} onValueChange={(v) => {
                        // Fix: never reuse the previous currency's (stale) rate.
                        // HKD => rate 1; any other currency => clear rate+HKD and
                        // refetch live, so a failed fetch forces manual entry
                        // instead of silently booking foreign spend at 1:1.
                        if (v === "HKD") {
                          updateLine(l._key, { currency: v, fx_rate: "1" });
                        } else {
                          updateLine(l._key, { currency: v, fx_rate: "", hkd_amount: "" });
                          fetchFxRate(l._key, v);
                        }
                      }}>
                        <SelectTrigger className="h-7 text-xs w-[70px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {CURRENCIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-2 py-2"><Input type="number" step="0.01" value={l.original_amount} onChange={(e) => updateLine(l._key, { original_amount: e.target.value })} className="h-7 text-xs text-right w-[90px]" placeholder="0.00" /></td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          step="0.000001"
                          value={l.fx_rate}
                          onChange={(e) => updateLine(l._key, { fx_rate: e.target.value })}
                          className="h-7 text-xs text-right w-[80px]"
                          placeholder="1"
                        />
                        {l.currency && l.currency !== "HKD" && (
                          <button
                            type="button"
                            onClick={() => fetchFxRate(l._key, l.currency!)}
                            className="text-muted-foreground hover:text-primary p-1"
                            title={`取即時匯率 ${l.currency} → HKD`}
                          >
                            <RefreshCw size={11} />
                          </button>
                        )}
                      </div>
                    </td>
                  </>}
                  <td className="px-2 py-2"><Input type="number" step="0.01" value={l.hkd_amount} onChange={(e) => updateLine(l._key, { hkd_amount: e.target.value })} className="h-7 text-xs text-right font-medium w-[100px]" /></td>
                  {claimType !== "transportation" && (
                    <td className="px-2 py-2"><Input type="number" step="0.01" value={l.billable_to_client_hkd} onChange={(e) => updateLine(l._key, { billable_to_client_hkd: e.target.value })} className="h-7 text-xs text-right w-[90px]" /></td>
                  )}
                  {/* 付款申請一張申請只認一張發票 — 冇明細行收據，發票/supporting docs 用下面附件區 */}
                  {claimType !== "payment" && (
                  <td className="px-2 py-2 text-center">
                    <div className="flex flex-col items-center gap-1">
                      <label htmlFor={`line-receipt-${l._key}`} className="inline-flex cursor-pointer">
                        <span className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-muted hover:bg-muted/80 border border-border">
                          <Upload size={10} /> 上載
                        </span>
                      </label>
                      <input
                        id={`line-receipt-${l._key}`}
                        type="file"
                        multiple
                        accept=".pdf,.png,.jpg,.jpeg,.heic"
                        onChange={(e) => handleLineFileUpload(l._key, e)}
                        className="hidden"
                      />
                      {l.receipts.length > 0 && (
                        <div className="flex flex-col gap-0.5 mt-1">
                          {l.receipts.map((f, idx) => (
                            <div key={idx} className="flex items-center gap-1 text-[9px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 px-1 py-0.5 rounded max-w-[120px]">
                              <span className="truncate" title={f.name}>{f.name}</span>
                              <button type="button" onClick={() => removeLineReceipt(l._key, idx)} className="flex-shrink-0">
                                <X size={9} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Fix #2: render pre-existing line-level receipts (edit mode) so
                          users can view/keep them (open) or mark them for removal. */}
                      {isEdit && (existingLineAttachments.get((l as any)._existing_line_id) || []).length > 0 && (
                        <div className="flex flex-col gap-0.5 mt-1">
                          {(existingLineAttachments.get((l as any)._existing_line_id) || []).map((a: any) => {
                            const marked = removedAttachmentIds.has(a.id);
                            return (
                              <div
                                key={a.id}
                                className={`flex items-center gap-1 text-[9px] px-1 py-0.5 rounded max-w-[120px] ${marked ? "bg-red-500/15 line-through opacity-60" : "bg-sky-500/15 text-sky-700 dark:text-sky-400"}`}
                              >
                                <button type="button" onClick={() => openExistingAttachment(a.storage_path)} className="truncate text-left hover:underline" title={a.file_name}>
                                  {a.file_name}
                                </button>
                                <button type="button" onClick={() => toggleRemoveExistingAttachment(a.id)} className="flex-shrink-0" title={marked ? "取消刪除" : "刪除這個收據"}>
                                  {marked ? <Plus size={9} /> : <X size={9} />}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </td>
                  )}
                  <td className="px-2 py-2 text-center">
                    {lines.length > 1 && (
                      <Button size="icon" variant="ghost" onClick={() => removeLine(l._key)} className="h-6 w-6">
                        <Trash2 size={12} className="text-destructive" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border font-medium">
                <td colSpan={claimType === "transportation" ? 6 : claimType === "payment" ? 12 : 11} className="px-2 py-2 text-right">TOTAL</td>
                <td className="px-2 py-2 text-right tabular-nums">
                  HK${totalHkd.toFixed(2)}
                </td>
                <td colSpan={claimType === "payment" ? 2 : claimType !== "transportation" ? 3 : 2}></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </CardContent></Card>

      {/* Attachments — batch 級 (cover sheet 或統一上傳) */}
      <Card><CardContent className="p-4 space-y-3">
        <div className="text-sm font-medium">
          {claimType === "payment" ? (
            <>發票 + Supporting Documents <span className="text-xs text-muted-foreground font-normal">(發票影像、報價單、合約、收據等 — 可上載多個檔案)</span></>
          ) : (
            <>以上是 Cover Sheet / 整包收據附件 <span className="text-xs text-muted-foreground font-normal">(如需個別行有收據，請在表格上面「收據」那 column 上載)</span></>
          )}
        </div>
        <div>
          <label htmlFor="claim-file-upload" className="inline-flex">
            <Button asChild variant="outline" size="sm">
              <span><Upload size={14} className="mr-1" /> {claimType === "payment" ? "上載發票 / Supporting Documents (PDF / 圖片)" : "上載 Cover / 附件 (PDF / 圖片)"}</span>
            </Button>
          </label>
          <input
            id="claim-file-upload"
            type="file"
            multiple
            accept=".pdf,.png,.jpg,.jpeg,.heic"
            onChange={handleFileUpload}
            className="hidden"
            data-testid="input-file-upload"
          />
        </div>
        {/* Existing attachments (edit mode) */}
        {isEdit && existingAttachments.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide">現有附件</div>
            {existingAttachments.map((a: any) => {
              const marked = removedAttachmentIds.has(a.id);
              return (
                <div
                  key={a.id}
                  className={`flex items-center justify-between px-3 py-1.5 rounded text-xs ${marked ? "bg-red-500/10 line-through opacity-60" : "bg-muted/30"}`}
                >
                  <button
                    type="button"
                    onClick={() => openExistingAttachment(a.storage_path)}
                    className="truncate text-left hover:underline"
                  >
                    {a.file_name}{" "}
                    <span className="text-muted-foreground">
                      ({a.size_bytes ? (a.size_bytes / 1024).toFixed(1) + " KB" : ""})
                    </span>
                  </button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => toggleRemoveExistingAttachment(a.id)}
                    className="h-5 w-5"
                    title={marked ? "取消刪除" : "刪除這個附件"}
                  >
                    {marked ? <Plus size={12} /> : <Trash2 size={12} />}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="space-y-1">
            {isEdit && (
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">新增附件</div>
            )}
            {attachments.map((f, idx) => (
              <div key={idx} className="flex items-center justify-between bg-muted/30 px-3 py-1.5 rounded text-xs">
                <span className="truncate">{f.name} <span className="text-muted-foreground">({(f.size / 1024).toFixed(1)} KB)</span></span>
                <Button size="icon" variant="ghost" onClick={() => removeAttachment(idx)} className="h-5 w-5">
                  <X size={12} />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent></Card>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 sticky bottom-0 bg-background/80 backdrop-blur py-3">
        <Button variant="outline" onClick={() => save(false)} disabled={saving} data-testid="button-save-draft">
          <Save size={14} className="mr-1" /> {isEdit ? "更新草稿" : "儲存草稿"}
        </Button>
        <Button onClick={() => save(true)} disabled={saving} data-testid="button-submit">
          <Send size={14} className="mr-1" /> 提交申請
        </Button>
      </div>
    </div>
  );
}
