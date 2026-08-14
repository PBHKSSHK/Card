import { useState, useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { parseDocument, type ParseResult, type ParsedTransaction, type ParsedInvoice } from "@/lib/document-parser";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Upload, FileText, FileImage, FileSpreadsheet, AlertCircle, CheckCircle2, Loader2, Eye, Trash2, ChevronDown, ChevronRight, ShieldCheck, ShieldAlert, ExternalLink, StickyNote, Building2, FolderCode, Plus, X, Split, CreditCard } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { formatCategoryLabel } from "@/lib/utils";
import { todayHK, currentMonthHK } from "@/lib/hkdate";
import { useNoLedgerEntities } from "@/hooks/use-no-ledger-entities";
import type { UploadType, UploadBatch, CardTransaction, MetaInvoice, MatchingRule, ExpenseCategory, NsProjectCode, NsChartOfAccount, NsCreditCardAccount } from "@shared/schema";
import { MAPPING_TABLE_COLUMN_MAP, projectMatchesEntity, entityMatchesCardSubsidiary } from "@shared/schema";

// ---- Amount Verification Badge ----

function AmountVerification({ statementTotal, aiTotal }: { statementTotal: number | null | undefined; aiTotal: number }) {
  if (statementTotal == null || statementTotal === 0) return null;
  const diff = Math.abs(statementTotal - aiTotal);
  const match = diff < 0.02; // Allow tiny rounding tolerance

  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded-md text-xs ${match ? "bg-green-500/10 border border-green-500/20" : "bg-amber-500/10 border border-amber-500/20"}`}>
      {match ? (
        <ShieldCheck size={16} className="text-green-600 flex-shrink-0" />
      ) : (
        <ShieldAlert size={16} className="text-amber-600 flex-shrink-0" />
      )}
      <div className="flex items-center gap-4 flex-wrap">
        <span className="text-muted-foreground">
          Statement total: <span className="font-medium text-foreground tabular-nums">{statementTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
        </span>
        <span className="text-muted-foreground">
          AI parsed total: <span className="font-medium text-foreground tabular-nums">{aiTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
        </span>
        {!match && (
          <span className="text-amber-600 font-medium">
            Diff: {diff.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </span>
        )}
        {match && <span className="text-green-600 font-medium">Matched</span>}
      </div>
    </div>
  );
}

// ---- Document Upload Panel (PDF/JPG, multi-file) ----

interface FileParseState {
  file: File;
  status: "pending" | "parsing" | "done" | "error";
  progress?: string;
  result?: ParseResult;
  error?: string;
}

function DocumentUploadPanel({ title, description, onSuccess }: {
  title: string;
  description: string;
  onSuccess: () => void;
}) {
  const [fileStates, setFileStates] = useState<FileParseState[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  // Per-invoice splits: key = "fileIdx:invIdx", value = array of {project_code, amount_hkd, note}
  const [invoiceSplits, setInvoiceSplits] = useState<Record<string, Array<{ project_code: string; amount_hkd: number; note: string }>>>({});
  const [showSplitEditor, setShowSplitEditor] = useState<Record<string, boolean>>({});
  // Manual edits + per-invoice metadata for OCR-parsed invoices: key = "fileIdx:invIdx"
  // Combines field edits (invoice_number/description/date/amount/currency) with per-line metadata
  // (charge_to_entity/expense_category/project_code/card_id/note). Each invoice is independent.
  type InvoiceEdit = Partial<{
    invoice_number: string;
    description: string;
    invoice_date: string;
    amount: number;
    currency: string;
    charge_to_entity: string;
    charge_to_code: string;
    expense_category: string;
    project_code: string;
    card_id: string;
    note: string;
  }>;
  const [editedInvoices, setEditedInvoices] = useState<Record<string, InvoiceEdit>>({});
  // Manually-added invoices (when OCR fails or handwritten) — each row carries its own meta
  type ManualInvoice = {
    invoice_number: string;
    description: string;
    invoice_date: string;
    amount: number;
    currency: string;
    charge_to_entity: string;
    charge_to_code: string;
    expense_category: string;
    project_code: string;
    card_id: string;
    note: string;
  };
  const [manualInvoices, setManualInvoices] = useState<ManualInvoice[]>([]);
  // Pagination for the parsed-transactions preview table
  const [txnPage, setTxnPage] = useState(0);
  const [txnPerPage, setTxnPerPage] = useState(50);
  const { toast } = useToast();
  const { user } = useAuth();

  // Load reference data for dropdowns
  const { data: expenseCategories = [] } = useQuery<ExpenseCategory[]>({
    queryKey: ["expense_categories"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expense_categories")
        .select("*")
        .eq("is_active", true)
        .order("sort_order");
      if (error) throw error;
      return data as ExpenseCategory[];
    },
  });

  const { data: projectCodes = [] } = useQuery<NsProjectCode[]>({
    queryKey: ["ns_project_codes_all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_project_codes")
        .select("*")
        .order("project_id");
      if (error) throw error;
      return data as NsProjectCode[];
    },
  });

  // Account -> entity sharing map — used to filter expense categories by the
  // selected entity. Sourced from ns_account_subsidiaries (the real NetSuite
  // many-to-many sharing) rather than ns_chart_of_accounts.entity_code, which
  // only records a single "home" entity per account and would leave the
  // Category dropdown empty for entities that share the account (e.g. CLS).
  const { data: chartOfAccounts = [] } = useQuery<{ account_number: string; entity_code: string | null }[]>({
    queryKey: ["ns_account_subsidiary_map"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_account_subsidiaries")
        .select("account_number, entity_code");
      if (error) throw error;
      return data as any[];
    },
  });

  // Per-entity account filter: entity_code -> Set<account_number>
  const accountsByEntity = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const a of chartOfAccounts) {
      if (!a.entity_code) continue;
      if (!map.has(a.entity_code)) map.set(a.entity_code, new Set());
      map.get(a.entity_code)!.add(a.account_number);
    }
    return map;
  }, [chartOfAccounts]);

  const filterCategoriesForEntity = useCallback((entity: string | null) => {
    if (!entity) return expenseCategories;
    const accounts = accountsByEntity.get(entity);
    if (!accounts) return expenseCategories; // fallback — don't leave dropdown empty
    const matched = expenseCategories.filter((c) => accounts.has(c.ns_account_number));
    return matched.length > 0 ? matched : expenseCategories;
  }, [expenseCategories, accountsByEntity]);

  // ns_departments — single source of truth for charge_to_code → entity / subsidiary / dept name
  type NsDept = {
    entity_code: string;
    charge_to: string;
    name: string;
    subsidiary_name: string;
    subsidiary_full_name: string | null;
  };
  const { data: nsDepartments = [] } = useQuery<NsDept[]>({
    queryKey: ["ns_departments_charge_to"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_departments")
        .select("entity_code, charge_to, name, subsidiary_name, subsidiary_full_name")
        .order("entity_code")
        .order("charge_to");
      if (error) throw error;
      return (data || []) as NsDept[];
    },
  });

  // charge_to (code) → NsDept lookup
  const chargeToMap = useMemo(() => {
    const m = new Map<string, NsDept>();
    for (const d of nsDepartments) {
      if (d.charge_to) m.set(d.charge_to, d);
    }
    return m;
  }, [nsDepartments]);

  // grouped charge_to options for dropdown (sorted by entity then code)
  const chargeToOptions = useMemo(() => {
    const groups = new Map<string, NsDept[]>();
    for (const d of nsDepartments) {
      if (!d.entity_code || !d.charge_to) continue;
      if (!groups.has(d.entity_code)) groups.set(d.entity_code, []);
      groups.get(d.entity_code)!.push(d);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([entity, items]) => ({ entity, items: items.sort((a, b) => a.charge_to.localeCompare(b.charge_to)) }));
  }, [nsDepartments]);

  // Resolve entity_code from a charge_to_code (auto-derive)
  const entityFromCharge = (code: string | null | undefined): string => {
    if (!code) return "";
    return chargeToMap.get(code)?.entity_code || "";
  };

  // JS / Go Asia etc. — no independent NetSuite ledger. Journal only books a
  // "Due From" (AR) for them, so Category is neither shown nor required.
  const noLedgerEntities = useNoLedgerEntities();

  // Credit card accounts — used to associate invoice batches with a specific card
  const { data: creditCardAccounts = [] } = useQuery<NsCreditCardAccount[]>({
    queryKey: ["ns_credit_card_accounts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_credit_card_accounts")
        .select("*")
        .order("card_identifier");
      if (error) throw error;
      return data as NsCreditCardAccount[];
    },
  });

  const acceptTypes = ".pdf,.jpg,.jpeg,.png,.webp";

  // Merge all successful parse results (auto-classified: some may be CC, some invoices)
  const mergedTransactions = fileStates
    .filter((f) => f.status === "done" && f.result?.type === "cc_statement" && f.result?.transactions)
    .flatMap((f) => f.result!.transactions!);
  const mergedInvoices = fileStates
    .filter((f) => f.status === "done" && f.result?.type === "meta_invoice" && f.result?.invoices)
    .flatMap((f) => f.result!.invoices!);

  const doneCount = fileStates.filter((f) => f.status === "done").length;
  const errorCount = fileStates.filter((f) => f.status === "error").length;
  const allDone = fileStates.length > 0 && !isParsing;
  const hasData = mergedTransactions.length > 0 || mergedInvoices.length > 0 || manualInvoices.length > 0;

  // req: 強制每張 invoice 齊 Charge To + Category + 備註 先可以 Confirm & Import All
  // (備註 稍後會用做 Export CSV 的 Line memo)。只喺有 invoice 要 import 時 gate;
  // 純 CC statement 上載唔受影響。
  const hasInvoicesToImport = mergedInvoices.length > 0 || manualInvoices.length > 0;
  const invoiceMissingCount = useMemo(() => {
    // JS / Go Asia (no independent NetSuite ledger) are exempt from Category.
    const catRequired = (entity: string) => !noLedgerEntities.has(entity);
    let missing = 0;
    fileStates.forEach((fs, fileIdx) => {
      if (fs.status !== "done" || fs.result?.type !== "meta_invoice" || !fs.result?.invoices) return;
      fs.result.invoices.forEach((_inv, invIdx) => {
        const e = editedInvoices[`${fileIdx}:${invIdx}`] || {};
        const ent = e.charge_to_entity || entityFromCharge(e.charge_to_code);
        if (!e.charge_to_code || (catRequired(ent) && !e.expense_category) || !(e.note && e.note.trim())) missing++;
      });
    });
    manualInvoices.forEach((m) => {
      const ent = m.charge_to_entity || entityFromCharge(m.charge_to_code);
      if (!m.charge_to_code || (catRequired(ent) && !m.expense_category) || !(m.note && m.note.trim())) missing++;
    });
    return missing;
  }, [fileStates, editedInvoices, manualInvoices, noLedgerEntities, chargeToMap]);

  // req: 一張 invoice 可以分拆做幾行（手動新增 copy 埋 Invoice #）——
  // 同一個 Invoice # 嘅所有行金額加埋，必須等於原本（OCR）嘅 invoice 總額。
  // Target = 該 Invoice # 已解析行嘅「原始 OCR 金額」總和；只喺有手動行
  // 掛落去嗰啲 Invoice # 先至驗證（純手動、冇對應 OCR 嘅唔驗 — 冇基準）。
  const splitMismatches = useMemo(() => {
    type G = { target: number; sum: number; parsedCount: number; manualCount: number };
    const groups = new Map<string, G>();
    const get = (n: string): G => {
      if (!groups.has(n)) groups.set(n, { target: 0, sum: 0, parsedCount: 0, manualCount: 0 });
      return groups.get(n)!;
    };
    fileStates.forEach((fs, fileIdx) => {
      if (fs.status !== "done" || fs.result?.type !== "meta_invoice" || !fs.result?.invoices) return;
      fs.result.invoices.forEach((inv, invIdx) => {
        const e = editedInvoices[`${fileIdx}:${invIdx}`] || {};
        const n = (e.invoice_number ?? inv.invoice_number ?? "").trim();
        if (!n) return;
        const g = get(n);
        g.parsedCount++;
        g.target += Number(inv.amount) || 0;               // 原始 OCR 金額做基準
        g.sum += Number(e.amount ?? inv.amount) || 0;      // 現時(可能已改)金額
      });
    });
    manualInvoices.forEach((m) => {
      const n = (m.invoice_number || "").trim();
      if (!n) return;
      const g = get(n);
      g.manualCount++;
      g.sum += Number(m.amount) || 0;
    });
    const out: { invoice_number: string; sum: number; target: number }[] = [];
    groups.forEach((g, n) => {
      if (g.manualCount > 0 && g.parsedCount > 0 && Math.abs(g.sum - g.target) > 0.01) {
        out.push({ invoice_number: n, sum: Math.round(g.sum * 100) / 100, target: Math.round(g.target * 100) / 100 });
      }
    });
    return out;
  }, [fileStates, editedInvoices, manualInvoices]);

  const importBlocked = hasInvoicesToImport && (invoiceMissingCount > 0 || splitMismatches.length > 0);

  // Parse files with concurrency (3 at a time) for speed
  const parseAllFiles = async (files: File[]) => {
    const states: FileParseState[] = files.map((f) => ({ file: f, status: "pending" as const }));
    setFileStates(states);
    setIsParsing(true);

    const CONCURRENCY = 3;
    let nextIdx = 0;

    const processOne = async () => {
      while (nextIdx < states.length) {
        const i = nextIdx++;

        // Update status to parsing
        setFileStates((prev) => prev.map((s, idx) =>
          idx === i ? { ...s, status: "parsing" as const, progress: "Starting..." } : s
        ));

        try {
          const result = await parseDocument(states[i].file, "auto", (msg) => {
            setFileStates((prev) => prev.map((s, idx) =>
              idx === i ? { ...s, progress: msg } : s
            ));
          });
          setFileStates((prev) => prev.map((s, idx) =>
            idx === i ? { ...s, status: "done" as const, result, progress: undefined } : s
          ));
        } catch (err: any) {
          setFileStates((prev) => prev.map((s, idx) =>
            idx === i ? { ...s, status: "error" as const, error: err.message, progress: undefined } : s
          ));
        }

        // Small stagger between picks to avoid burst
        await new Promise((r) => setTimeout(r, 300));
      }
    };

    // Launch concurrent workers
    const workers = Array.from({ length: Math.min(CONCURRENCY, states.length) }, () => processOne());
    await Promise.all(workers);

    setIsParsing(false);
  };

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!hasData) throw new Error("No parsed data");
      const userId = user?.id ?? null;

      // 手動行如果同某張已解析 invoice 同 Invoice # → 佢哋係「分拆 pieces」，
      // 會跟嗰張 invoice 入庫（parent+children），唔會再入落獨立手動 batch。
      const consumedManualNos = new Set<string>();

      // Create one batch per file that parsed successfully
      for (const fs of fileStates.filter((f) => f.status === "done" && f.result)) {
        const result = fs.result!;
        const detectedType = result.type; // auto-classified by Edge Function
        const rowCount = result.transactions?.length || result.invoices?.length || 0;
        const aiTxnSum = detectedType === "cc_statement"
          ? (result.transactions || []).reduce((s, t) => s + (typeof t.amount === "number" ? t.amount : 0), 0)
          : (result.invoices || []).reduce((s, inv) => s + (typeof inv.amount === "number" ? inv.amount : 0), 0);
        let prevBalance = result.metadata?.previous_balance ?? 0;
        if (typeof prevBalance !== "number") prevBalance = 0;
        let aiTotal = prevBalance + aiTxnSum;
        const stmtTotalForCheck = result.metadata?.total_amount;
        if (typeof stmtTotalForCheck === "number" && stmtTotalForCheck !== 0 && prevBalance !== 0) {
          const diffOrig = Math.abs(stmtTotalForCheck - aiTotal);
          const flipped = -prevBalance + aiTxnSum;
          const diffFlip = Math.abs(stmtTotalForCheck - flipped);
          if (diffFlip < diffOrig && diffFlip < 1.0) {
            console.log(`[CardRecon] Auto-corrected prev_balance sign for DB: ${prevBalance} → ${-prevBalance}`);
            prevBalance = -prevBalance;
            aiTotal = flipped;
          }
        }

        // Compute period_month from parsed dates
        let periodMonth: string | null = null;
        if (result.metadata?.statement_period && result.metadata.statement_period.length >= 7) {
          periodMonth = result.metadata.statement_period.substring(0, 7);
        } else if (detectedType === "cc_statement" && result.transactions?.length) {
          // Use first transaction date
          const firstDate = result.transactions[0].date;
          if (firstDate && firstDate.length >= 7) periodMonth = firstDate.substring(0, 7);
        } else if (detectedType === "meta_invoice" && result.invoices?.length) {
          const firstDate = result.invoices[0].invoice_date;
          if (firstDate && firstDate.length >= 7) periodMonth = firstDate.substring(0, 7);
        }

        // Upload original file to Supabase Storage
        let filePath: string | null = null;
        if (userId) {
          const safeName = `${Date.now()}-${fs.file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
          const storagePath = `${userId}/${safeName}`;
          const { error: uploadErr } = await supabase.storage
            .from("documents")
            .upload(storagePath, fs.file, { cacheControl: "3600", upsert: false });
          if (!uploadErr) {
            filePath = storagePath;
          } else {
            console.warn("[CardRecon] File upload to storage failed:", uploadErr.message);
          }
        }

        // For invoices, use first invoice's per-line card_id as the batch card_last4 hint.
        // For CC statements, use parser metadata.
        const fileIdx = fileStates.indexOf(fs);
        let invoiceBatchCard: string | null = null;
        if (detectedType === "meta_invoice" && result.invoices) {
          for (let i = 0; i < result.invoices.length; i++) {
            const m = editedInvoices[`${fileIdx}:${i}`];
            if (m?.card_id && m.card_id !== "__none__") { invoiceBatchCard = m.card_id; break; }
          }
        }
        const batchCardLast4 =
          detectedType === "meta_invoice"
            ? (invoiceBatchCard || result.metadata?.card_last4 || null)
            : (result.metadata?.card_last4 ?? null);

        // Import dedup — refuse to silently double-insert a statement that was
        // already imported. Signature = file_name + statement_period + statement_total
        // (the same fields the duplicate badge uses). A match requires an explicit
        // user confirmation before we proceed; otherwise skip this file.
        {
          const sigPeriod = result.metadata?.statement_period ?? null;
          const sigTotal = result.metadata?.total_amount ?? null;
          let dupQuery = supabase
            .from("upload_batches")
            .select("id")
            .eq("file_name", fs.file.name);
          dupQuery = sigPeriod == null
            ? dupQuery.is("statement_period", null)
            : dupQuery.eq("statement_period", sigPeriod);
          dupQuery = sigTotal == null
            ? dupQuery.is("statement_total", null)
            : dupQuery.eq("statement_total", sigTotal);
          const { data: existingDup } = await dupQuery.limit(1);
          if (existingDup && existingDup.length > 0) {
            const proceed = window.confirm(
              `This statement looks already imported (batch ${existingDup[0].id}).\n\n` +
              `File: ${fs.file.name}\nPeriod: ${sigPeriod ?? "-"}\nTotal: ${sigTotal ?? "-"}\n\n` +
              `Import anyway?`
            );
            if (!proceed) continue; // skip this file, do not double-insert
          }
        }

        const { data: batch, error: batchError } = await supabase
          .from("upload_batches")
          .insert({
            file_name: fs.file.name,
            upload_type: detectedType,
            status: "processing",
            row_count: rowCount,
            statement_total: result.metadata?.total_amount ?? null,
            ai_parsed_total: aiTotal,
            bank: result.metadata?.bank ?? null,
            card_last4: batchCardLast4,
            statement_period: result.metadata?.statement_period ?? null,
            statement_date: result.metadata?.statement_date ?? null,
            statement_due_date: result.metadata?.statement_due_date ?? null,
            user_id: userId,
            notes: null,
            file_path: filePath,
            period_month: periodMonth,
          })
          .select()
          .single();
        if (batchError) throw batchError;

        try {
          if (detectedType === "cc_statement" && result.transactions) {
            // Filter out credit-card payment rows (找數 / Payment Received / Thank You)
            // — these are card payments, not real expenses, and should NOT be reconciled.
            const paymentPattern = /payment\s*received|thank\s*you|auto[\s-]*pay|autopay|ifs\s*payment|自動轉帳|找數|繳款|還款/i;
            const filteredTxns = result.transactions.filter((t) => {
              const merchant = (t.merchant || "").toString();
              const desc = (t.description || "").toString();
              return !paymentPattern.test(merchant) && !paymentPattern.test(desc);
            });
            const skipped = result.transactions.length - filteredTxns.length;
            if (skipped > 0) {
              console.log(`[CC filter] Skipped ${skipped} payment row(s) from ${fs.file.name}`);
            }
            await insertTransactions(batch.id, filteredTxns, result.metadata, userId, periodMonth);
          } else if (detectedType === "meta_invoice" && result.invoices) {
            // Dedupe by invoice_number — OCR sometimes extracts the same invoice twice
            // (e.g. parent line + summary line), which would double-count the amount.
            const seenInv = new Set<string>();
            const dedupedInvoices: ParsedInvoice[] = [];
            const dedupedOrigIdx: number[] = []; // original indices to preserve edited metadata
            result.invoices.forEach((inv, origIdx) => {
              const key = (inv.invoice_number || "").toString().trim().toUpperCase();
              if (key && seenInv.has(key)) {
                console.log(`[Meta dedup] Skipped duplicate invoice_number=${key} from ${fs.file.name}`);
                return;
              }
              if (key) seenInv.add(key);
              dedupedInvoices.push(inv);
              dedupedOrigIdx.push(origIdx);
            });
            // Merge OCR-parsed invoices with any manual field edits made by the user,
            // AND collect per-invoice metadata (charge_to / category / project / card / note).
            const mergedForInsert = dedupedInvoices.map((inv, idx) => {
              const invIdx = dedupedOrigIdx[idx];
              const patch = editedInvoices[`${fileIdx}:${invIdx}`] || {};
              // Only field edits flow into the ParsedInvoice shape — meta is passed separately.
              return {
                ...inv,
                ...(patch.invoice_number !== undefined ? { invoice_number: patch.invoice_number } : {}),
                ...(patch.description !== undefined ? { description: patch.description } : {}),
                ...(patch.invoice_date !== undefined ? { invoice_date: patch.invoice_date } : {}),
                ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
                ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
              } as ParsedInvoice;
            });
            // 分拆組：手動行同某張已解析 invoice 同一個 Invoice # → 呢張 invoice
            // 以「parent（OCR 總額）+ 每份 child」形式入庫。第一份 = 呢行自己
            // （用戶改細咗嘅金額 + meta），其餘 = 對應嘅手動行。
            const piecesByInvIdx: Record<number, InvoicePiece[]> = {};
            mergedForInsert.forEach((minv, idx) => {
              const n = (minv.invoice_number || "").trim();
              if (!n || consumedManualNos.has(n)) return;
              const manualPieces = manualInvoices.filter((m) => (m.invoice_number || "").trim() === n);
              if (manualPieces.length === 0) return;
              consumedManualNos.add(n);
              const invIdx = dedupedOrigIdx[idx];
              const e = editedInvoices[`${fileIdx}:${invIdx}`] || {};
              const rowEntity = e.charge_to_code && e.charge_to_code !== "__none__" ? entityFromCharge(e.charge_to_code) : (e.charge_to_entity || null);
              const firstPiece: InvoicePiece = {
                amount: Number(e.amount ?? minv.amount) || 0,
                description: (e.description ?? minv.description) || null,
                meta: {
                  charge_to_entity: rowEntity || null,
                  charge_to_code: e.charge_to_code && e.charge_to_code !== "__none__" ? e.charge_to_code : null,
                  project_code: e.project_code && e.project_code !== "__none__" ? e.project_code : null,
                  expense_category: e.expense_category || null,
                  card_id: e.card_id && e.card_id !== "__none__" ? e.card_id : null,
                  note: e.note?.trim() || null,
                },
              };
              const rest: InvoicePiece[] = manualPieces.map((m) => {
                const code = m.charge_to_code && m.charge_to_code !== "__none__" ? m.charge_to_code : null;
                return {
                  amount: Number(m.amount) || 0,
                  description: m.description || null,
                  meta: {
                    charge_to_entity: code ? entityFromCharge(code) : (m.charge_to_entity || null),
                    charge_to_code: code,
                    project_code: m.project_code && m.project_code !== "__none__" ? m.project_code : null,
                    expense_category: m.expense_category || null,
                    card_id: m.card_id && m.card_id !== "__none__" ? m.card_id : null,
                    note: m.note?.trim() || null,
                  },
                };
              });
              piecesByInvIdx[idx] = [firstPiece, ...rest];
              // parent 用 OCR 原始金額（總額）— 用戶改細咗嘅金額已經係第一份 child
              (minv as any).amount = dedupedInvoices[idx].amount;
            });
            // Per-invoice meta array (parallel to mergedForInsert)
            const metaByInvIdx = dedupedInvoices.map((_inv, idx) => {
              const invIdx = dedupedOrigIdx[idx];
              const m = editedInvoices[`${fileIdx}:${invIdx}`] || {};
              // Auto-derive charge_to_entity from charge_to_code if user only picked charge_to_code
              const codeForRow = m.charge_to_code && m.charge_to_code !== "__none__" ? m.charge_to_code : null;
              const entity = codeForRow ? entityFromCharge(codeForRow) : (m.charge_to_entity || null);
              return {
                charge_to_entity: entity || null,
                charge_to_code: codeForRow,
                project_code: m.project_code && m.project_code !== "__none__" ? m.project_code : null,
                expense_category: m.expense_category || null,
                card_id: m.card_id && m.card_id !== "__none__" ? m.card_id : null,
                note: m.note?.trim() || null,
              };
            });
            // Collect splits for this file's invoices — re-indexed to match deduped array
            const splitsByInvIdx: Record<number, Array<{ project_code: string; amount_hkd: number; note: string }>> = {};
            dedupedInvoices.forEach((_inv, idx) => {
              const invIdx = dedupedOrigIdx[idx];
              const key = `${fileIdx}:${invIdx}`;
              if (invoiceSplits[key] && invoiceSplits[key].length > 0) {
                splitsByInvIdx[idx] = invoiceSplits[key];
              }
            });
            // Cross-upload duplicate guard — CC statements have one, invoices didn't:
            // re-uploading an invoice # that already exists in the DB (often already
            // MATCHED months ago) silently created a second unmatched copy, so the same
            // invoice # showed up in both Matched and Unmatched in the Recon Queue.
            const importNos = Array.from(new Set(
              mergedForInsert.map(mi => (mi.invoice_number || "").trim()).filter(Boolean)
            ));
            let skipNos = new Set<string>();
            if (importNos.length > 0) {
              const { data: existRows } = await supabase
                .from("meta_invoices")
                .select("invoice_number, is_matched")
                .in("invoice_number", importNos)
                .is("parent_invoice_id", null);
              const existing = Array.from(new Set((existRows || []).map(r => (r.invoice_number || "").trim())));
              if (existing.length > 0) {
                const matchedNos = new Set((existRows || []).filter(r => r.is_matched).map(r => (r.invoice_number || "").trim()));
                const detail = existing.map(n => `· ${n}${matchedNos.has(n) ? "（已配對）" : ""}`).join("\n");
                const proceed = window.confirm(
                  `以下 invoice # 已經存在於系統，再 import 會出 duplicate：\n\n${detail}\n\n` +
                  `按「確定」照樣 import（會出重複）\n按「取消」跳過呢啲 invoice，只 import 其餘`
                );
                if (!proceed) skipNos = new Set(existing);
              }
            }
            // Apply the skip decision — filter all four parallel structures together.
            const keepIdx = mergedForInsert
              .map((mi, idx) => ({ idx, n: (mi.invoice_number || "").trim() }))
              .filter(({ n }) => !n || !skipNos.has(n))
              .map(({ idx }) => idx);
            const finalInvoices = keepIdx.map(i => mergedForInsert[i]);
            const finalMeta = keepIdx.map(i => metaByInvIdx[i]);
            const finalSplits: typeof splitsByInvIdx = {};
            const finalPieces: typeof piecesByInvIdx = {};
            keepIdx.forEach((oldIdx, newIdx) => {
              if (splitsByInvIdx[oldIdx]) finalSplits[newIdx] = splitsByInvIdx[oldIdx];
              if (piecesByInvIdx[oldIdx]) finalPieces[newIdx] = piecesByInvIdx[oldIdx];
            });

            if (finalInvoices.length > 0) {
              await insertInvoices(
                batch.id,
                finalInvoices,
                userId,
                periodMonth,
                finalMeta,
                finalSplits,
                finalPieces
              );
            }
          }
          await supabase
            .from("upload_batches")
            .update({ status: "processed", processed_at: new Date().toISOString() })
            .eq("id", batch.id);
        } catch (err: any) {
          await supabase
            .from("upload_batches")
            .update({ status: "error", error_message: err.message })
            .eq("id", batch.id);
          throw err;
        }
      }

      // --- Manual invoices (handwritten / OCR-failed rows typed by staff) ---
      // 已經做咗「分拆 pieces」嘅手動行唔會再入落獨立手動 batch。
      if (manualInvoices.length > 0) {
        let validManual = manualInvoices.filter(
          (m) => m.invoice_number.trim() && m.amount > 0 && !consumedManualNos.has(m.invoice_number.trim())
        );
        // 同上：手動 invoice 都做 cross-upload 防重複檢查
        if (validManual.length > 0) {
          const manualNos = Array.from(new Set(validManual.map(m => m.invoice_number.trim())));
          const { data: existRows } = await supabase
            .from("meta_invoices")
            .select("invoice_number, is_matched")
            .in("invoice_number", manualNos)
            .is("parent_invoice_id", null);
          const existing = Array.from(new Set((existRows || []).map(r => (r.invoice_number || "").trim())));
          if (existing.length > 0) {
            const matchedNos = new Set((existRows || []).filter(r => r.is_matched).map(r => (r.invoice_number || "").trim()));
            const detail = existing.map(n => `· ${n}${matchedNos.has(n) ? "（已配對）" : ""}`).join("\n");
            const proceed = window.confirm(
              `以下手動輸入嘅 invoice # 已經存在於系統：\n\n${detail}\n\n` +
              `按「確定」照樣 import（會出重複）\n按「取消」跳過呢啲，只 import 其餘`
            );
            if (!proceed) {
              const skip = new Set(existing);
              validManual = validManual.filter(m => !skip.has(m.invoice_number.trim()));
            }
          }
        }
        if (validManual.length > 0) {
          // Pick period_month from first manual invoice if possible
          const firstDate = validManual[0].invoice_date;
          // Fall back to the current HK month (not UTC) so pre-08:00 HKT entries
          // don't bucket into the previous month.
          const periodMonth = firstDate && firstDate.length >= 7 ? firstDate.substring(0, 7) : currentMonthHK();
          const aiTotal = validManual.reduce((s, m) => s + (m.amount || 0), 0);
          // Use first manual row's card_id as the batch-level card hint
          const firstCard = validManual.find((m) => m.card_id && m.card_id !== "__none__")?.card_id || null;

          const { data: batch, error: batchError } = await supabase
            .from("upload_batches")
            .insert({
              file_name: `[手動輸入] ${validManual.length} 張 invoice`,
              upload_type: "meta_invoice",
              status: "processing",
              row_count: validManual.length,
              statement_total: null,
              ai_parsed_total: aiTotal,
              bank: null,
              card_last4: firstCard,
              statement_period: null,
              user_id: userId,
              notes: "手動輸入 invoice",
              file_path: null,
              period_month: periodMonth,
            })
            .select()
            .single();
          if (batchError) throw batchError;

          try {
            // Strip meta fields from the ParsedInvoice and pass them separately
            const manualAsParsed = validManual.map((m) => ({
              invoice_number: m.invoice_number,
              description: m.description,
              invoice_date: m.invoice_date,
              amount: m.amount,
              currency: m.currency,
            } as ParsedInvoice));
            const manualMeta = validManual.map((m) => {
              const code = m.charge_to_code && m.charge_to_code !== "__none__" ? m.charge_to_code : null;
              const entity = code ? entityFromCharge(code) : (m.charge_to_entity || null);
              return {
                charge_to_entity: entity || null,
                charge_to_code: code,
                project_code: m.project_code && m.project_code !== "__none__" ? m.project_code : null,
                expense_category: m.expense_category || null,
                card_id: m.card_id && m.card_id !== "__none__" ? m.card_id : null,
                note: m.note?.trim() || null,
              };
            });
            await insertInvoices(
              batch.id,
              manualAsParsed,
              userId,
              periodMonth,
              manualMeta,
              {}
            );
            await supabase
              .from("upload_batches")
              .update({ status: "processed", processed_at: new Date().toISOString() })
              .eq("id", batch.id);
          } catch (err: any) {
            await supabase
              .from("upload_batches")
              .update({ status: "error", error_message: err.message })
              .eq("id", batch.id);
            throw err;
          }
        }
      }
    },
    onSuccess: () => {
      reset();
      onSuccess();
    },
  });

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer.files).filter(
      (f) => /\.(pdf|jpe?g|png|webp)$/i.test(f.name)
    );
    if (dropped.length > 0) parseAllFiles(dropped);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    if (selected.length > 0) parseAllFiles(selected);
  };

  const reset = () => {
    setFileStates([]);
    setIsParsing(false);
    setInvoiceSplits({});
    setShowSplitEditor({});
    setEditedInvoices({});
    setManualInvoices([]);
  };

  // Helpers: merge OCR + user edits for a given invoice
  const getEditedInvoice = (fileIdx: number, invIdx: number, original: ParsedInvoice): ParsedInvoice => {
    const patch = editedInvoices[`${fileIdx}:${invIdx}`];
    if (!patch) return original;
    return { ...original, ...patch } as ParsedInvoice;
  };
  const updateInvoiceEdit = (fileIdx: number, invIdx: number, patch: InvoiceEdit) => {
    setEditedInvoices((prev) => ({
      ...prev,
      [`${fileIdx}:${invIdx}`]: { ...(prev[`${fileIdx}:${invIdx}`] || {}), ...patch },
    }));
  };
  const addManualInvoice = () => {
    setManualInvoices((prev) => {
      // req: 手動新增時 copy 上一筆做起點（先取最後一筆手動，冇就取最後一張
      // 已解析 invoice 連埋佢嘅人手修改），俾同事只改唔同嘅欄位。
      // Invoice # 都會 copy — 用嚟將一張 invoice 分拆做幾行；
      // Amount 預設帶入「剩餘金額」（原本 invoice 總額 − 已入行嘅金額加埋），
      // 咁全部行加埋就啱啱等於 invoice 總額。
      let seed: Partial<ManualInvoice> = {};
      if (prev.length > 0) {
        seed = prev[prev.length - 1];
      } else {
        outer: for (let f = fileStates.length - 1; f >= 0; f--) {
          const fs = fileStates[f];
          if (fs.status !== "done" || fs.result?.type !== "meta_invoice" || !fs.result.invoices?.length) continue;
          const invIdx = fs.result.invoices.length - 1;
          const inv = fs.result.invoices[invIdx];
          const e = editedInvoices[`${f}:${invIdx}`] || {};
          seed = {
            invoice_number: (e.invoice_number ?? inv.invoice_number ?? "") as string,
            description: e.description ?? inv.description ?? "",
            invoice_date: e.invoice_date ?? inv.invoice_date ?? "",
            currency: e.currency ?? inv.currency ?? "HKD",
            charge_to_code: e.charge_to_code || "",
            charge_to_entity: e.charge_to_entity || entityFromCharge(e.charge_to_code),
            expense_category: e.expense_category || "",
            project_code: e.project_code || "",
            card_id: e.card_id || "",
            note: e.note || "",
          };
          break outer;
        }
      }

      // 計「剩餘金額」：同一 Invoice # — 原始 OCR 總額 − (已解析行現時金額 + 已有手動行金額)
      const seedNo = (seed.invoice_number || "").trim();
      let remaining = 0;
      if (seedNo) {
        let target = 0;
        let current = 0;
        fileStates.forEach((fs, fileIdx) => {
          if (fs.status !== "done" || fs.result?.type !== "meta_invoice" || !fs.result?.invoices) return;
          fs.result.invoices.forEach((inv, invIdx) => {
            const e = editedInvoices[`${fileIdx}:${invIdx}`] || {};
            const n = (e.invoice_number ?? inv.invoice_number ?? "").trim();
            if (n !== seedNo) return;
            target += Number(inv.amount) || 0;
            current += Number(e.amount ?? inv.amount) || 0;
          });
        });
        prev.forEach((m) => {
          if ((m.invoice_number || "").trim() === seedNo) current += Number(m.amount) || 0;
        });
        remaining = Math.round((target - current) * 100) / 100;
      }

      return [
        ...prev,
        {
          invoice_number: seed.invoice_number || "",
          description: seed.description || "",
          invoice_date: seed.invoice_date || todayHK(), // HK-local default date (not UTC)
          amount: remaining > 0 ? remaining : 0,
          currency: seed.currency || "HKD",
          charge_to_entity: seed.charge_to_entity || "",
          charge_to_code: seed.charge_to_code || "",
          expense_category: seed.expense_category || "",
          project_code: seed.project_code || "",
          card_id: seed.card_id || "",
          note: seed.note || "",
        },
      ];
    });
  };
  const updateManualInvoice = (idx: number, patch: Partial<ManualInvoice>) => {
    setManualInvoices((prev) => prev.map((m, i) => (i === idx ? { ...m, ...patch } : m)));
  };
  const removeManualInvoice = (idx: number) => {
    setManualInvoices((prev) => prev.filter((_, i) => i !== idx));
  };

  // Compute per-file verification
  // Formula: previous_balance + transactions_sum ≈ statement_balance (total_amount)
  // Auto-correct: if sign of previous_balance is wrong (AI missed CR suffix), try flipping it
  const getFileVerification = (fs: FileParseState) => {
    if (fs.status !== "done" || !fs.result) return null;
    const stmtTotal = fs.result.metadata?.total_amount;
    let prevBalance = fs.result.metadata?.previous_balance ?? 0;
    if (typeof prevBalance !== "number") prevBalance = 0;
    const txns = fs.result.transactions || [];
    const invs = fs.result.invoices || [];
    const fileType = fs.result?.type;
    const aiTxnSum = fileType === "cc_statement"
      ? txns.reduce((s, t) => s + (typeof t.amount === "number" ? t.amount : 0), 0)
      : invs.reduce((s, inv) => s + (typeof inv.amount === "number" ? inv.amount : 0), 0);

    // Try original sign first
    let computedTotal = prevBalance + aiTxnSum;

    // Auto-correct: if prev_balance sign is wrong, flip it
    // This handles cases where AI returns positive previous_balance but it should be negative (CR)
    if (typeof stmtTotal === "number" && stmtTotal !== 0 && prevBalance !== 0) {
      const diffOriginal = Math.abs(stmtTotal - computedTotal);
      const flippedTotal = -prevBalance + aiTxnSum;
      const diffFlipped = Math.abs(stmtTotal - flippedTotal);
      if (diffFlipped < diffOriginal && diffFlipped < 1.0) {
        console.log(`[CardRecon] Auto-corrected previous_balance sign: ${prevBalance} → ${-prevBalance}`);
        prevBalance = -prevBalance;
        computedTotal = flippedTotal;
      }
    }

    return {
      stmtTotal: typeof stmtTotal === "number" ? stmtTotal : null,
      aiTotal: computedTotal,
      aiTxnSum,
      prevBalance,
    };
  };

  return (
    <Card className="mt-4">
      <CardContent className="pt-6">
        {fileStates.length === 0 ? (
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            className="border-2 border-dashed border-border rounded-lg p-10 text-center cursor-pointer hover:border-primary/50 transition-colors"
            onClick={() => document.getElementById("file-documents")?.click()}
            data-testid="dropzone-documents"
          >
            <Upload className="mx-auto text-muted-foreground mb-3" size={32} />
            <p className="text-sm font-medium">{title}</p>
            <p className="text-xs text-muted-foreground mt-1">{description}</p>
            <p className="text-xs text-muted-foreground mt-3">
              Drop one or multiple PDF / image files here, or click to browse
            </p>
            <div className="flex justify-center gap-2 mt-3">
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">PDF</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">JPG</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">PNG</span>
            </div>
            <input
              id="file-documents"
              type="file"
              accept={acceptTypes}
              multiple
              className="hidden"
              onChange={handleFileChange}
            />
          </div>
        ) : (
          <div className="space-y-4">
            {/* File list with per-file status */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{fileStates.length} file(s)</p>
                <Button variant="ghost" size="sm" onClick={reset} data-testid="button-reset-upload">
                  <Trash2 size={14} className="mr-1" /> Reset
                </Button>
              </div>
              {fileStates.map((fs, i) => {
                const v = getFileVerification(fs);
                return (
                  <div key={i} className="space-y-1.5">
                    <div className="flex items-center gap-2 text-sm border border-border/50 rounded-md px-3 py-2">
                      {fs.file.type === "application/pdf" ? (
                        <FileText size={15} className="text-primary flex-shrink-0" />
                      ) : (
                        <FileImage size={15} className="text-primary flex-shrink-0" />
                      )}
                      <span className="truncate flex-1 min-w-0">{fs.file.name}</span>
                      <span className="text-xs text-muted-foreground flex-shrink-0">
                        {(fs.file.size / 1024).toFixed(0)} KB
                      </span>
                      {fs.status === "pending" && (
                        <span className="text-xs text-muted-foreground flex-shrink-0">Queued</span>
                      )}
                      {fs.status === "parsing" && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground flex-shrink-0">
                          <Loader2 className="animate-spin" size={12} />
                          {fs.progress || "Parsing..."}
                        </span>
                      )}
                      {fs.status === "done" && (
                        <span className="flex items-center gap-1 text-xs text-green-600 flex-shrink-0">
                          <CheckCircle2 size={12} />
                          {fs.result?.type === "cc_statement" ? "CC" : "Invoice"} · {fs.result?.transactions?.length || fs.result?.invoices?.length || 0} items
                        </span>
                      )}
                      {fs.status === "error" && (
                        <span className="flex items-center gap-1 text-xs text-destructive flex-shrink-0" title={fs.error}>
                          <AlertCircle size={12} />
                          Failed
                        </span>
                      )}
                    </div>
                    {/* Per-file amount verification */}
                    {v && <AmountVerification statementTotal={v.stmtTotal} aiTotal={v.aiTotal} />}
                  </div>
                );
              })}
            </div>

            {/* Summary */}
            {allDone && (
              <div className="text-sm text-muted-foreground">
                {doneCount} of {fileStates.length} file(s) parsed
                {errorCount > 0 && <span className="text-destructive"> · {errorCount} failed</span>}
                {mergedTransactions.length > 0 && <span> · {mergedTransactions.length} total transactions</span>}
                {mergedInvoices.length > 0 && <span> · {mergedInvoices.length} total invoices</span>}
              </div>
            )}

            {/* Merged transactions preview — paginated */}
            {allDone && mergedTransactions.length > 0 && (() => {
              const totalPages = Math.max(1, Math.ceil(mergedTransactions.length / txnPerPage));
              const page = Math.min(txnPage, totalPages - 1);
              const pageRows = mergedTransactions.slice(page * txnPerPage, (page + 1) * txnPerPage);
              return (
              <div>
                <p className="text-sm font-medium mb-2 flex items-center gap-1.5">
                  <Eye size={14} />
                  {mergedTransactions.length} transactions (all files)
                </p>
                <div className="overflow-x-auto max-h-96 border rounded-md">
                  <table className="w-full table-dense text-xs">
                    <thead className="bg-muted/50 sticky top-0">
                      <tr>
                        <th className="text-left px-2 py-1.5 font-medium">Date</th>
                        <th className="text-left px-2 py-1.5 font-medium">Merchant</th>
                        <th className="text-right px-2 py-1.5 font-medium">Amount</th>
                        <th className="text-left px-2 py-1.5 font-medium">Currency</th>
                        <th className="text-left px-2 py-1.5 font-medium">Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((txn, i) => (
                        <tr key={`${page}-${i}`} className="border-t border-border/50">
                          <td className="px-2 py-1 tabular-nums">{txn.date}</td>
                          <td className="px-2 py-1 truncate max-w-[180px]">{txn.merchant}</td>
                          <td className="px-2 py-1 text-right tabular-nums font-medium">
                            {typeof txn.amount === "number" ? txn.amount.toLocaleString(undefined, { minimumFractionDigits: 2 }) : txn.amount}
                          </td>
                          <td className="px-2 py-1">{txn.currency}</td>
                          <td className="px-2 py-1 truncate max-w-[200px] text-muted-foreground">{txn.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Pagination bar: Page X of Y (N total items) · items per page */}
                <div className="flex items-center justify-between gap-2 flex-wrap py-1.5 px-1 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <Button variant="outline" size="sm" className="h-6 px-2 text-xs"
                      disabled={page === 0} onClick={() => setTxnPage(page - 1)} data-testid="txn-prev-page">‹</Button>
                    <span className="tabular-nums">Page {page + 1} of {totalPages} ({mergedTransactions.length} total items)</span>
                    <Button variant="outline" size="sm" className="h-6 px-2 text-xs"
                      disabled={page >= totalPages - 1} onClick={() => setTxnPage(page + 1)} data-testid="txn-next-page">›</Button>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span>showing</span>
                    <Select value={String(txnPerPage)} onValueChange={(v) => { setTxnPerPage(Number(v)); setTxnPage(0); }}>
                      <SelectTrigger className="h-6 w-20 text-xs" data-testid="txn-per-page"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="50">50</SelectItem>
                        <SelectItem value="100">100</SelectItem>
                        <SelectItem value="150">150</SelectItem>
                        <SelectItem value="200">200</SelectItem>
                      </SelectContent>
                    </Select>
                    <span>items per page</span>
                  </div>
                </div>
              </div>
              );
            })()}

            {/* Merged invoices preview with per-invoice split editor + manual edit */}
            {allDone && (mergedInvoices.length > 0 || manualInvoices.length > 0 || errorCount > 0) && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-sm font-medium flex items-center gap-1.5">
                    <Eye size={14} />
                    {mergedInvoices.length + manualInvoices.length} invoices ({mergedInvoices.length} OCR
                    {manualInvoices.length > 0 ? ` + ${manualInvoices.length} 手動` : ""})
                    <span className="text-xs text-muted-foreground font-normal ml-1">
                      — 第一行：Invoice#/Date/Desc/Currency/Amount/信用卡；第二行：Charge To / Project / Category（必填）· 展開可分拆 Project
                    </span>
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={addManualInvoice}
                    className="h-7 text-xs"
                    data-testid="button-add-manual-invoice"
                  >
                    <Plus size={12} className="mr-1" /> 手動新增 invoice
                  </Button>
                </div>
                <div className="border rounded-md overflow-x-auto">
                  <table className="w-full table-dense text-xs min-w-[1100px]">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-left px-2 py-1.5 font-medium w-6"></th>
                        <th className="text-left px-2 py-1.5 font-medium">Invoice #</th>
                        <th className="text-left px-2 py-1.5 font-medium">Date</th>
                        <th className="text-left px-2 py-1.5 font-medium">Description</th>
                        <th className="text-left px-2 py-1.5 font-medium">Currency</th>
                        <th className="text-right px-2 py-1.5 font-medium">Amount</th>
                        <th className="text-left px-2 py-1.5 font-medium">信用卡</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fileStates.flatMap((fs, fileIdx) => {
                        if (fs.status !== "done" || fs.result?.type !== "meta_invoice" || !fs.result?.invoices) return [];
                        return fs.result.invoices.map((inv, invIdx) => {
                          const key = `${fileIdx}:${invIdx}`;
                          const editedInv = getEditedInvoice(fileIdx, invIdx, inv);
                          const splits = invoiceSplits[key] || [];
                          const isOpen = showSplitEditor[key];
                          const invAmt = typeof editedInv.amount === "number" ? editedInv.amount : parseFloat(String(editedInv.amount).replace(/[,$]/g, "")) || 0;
                          const invCur = editedInv.currency || "HKD";
                          // No fabricated FX rate — use the invoice's own amount as the split target.
          // For non-HKD the user enters/adjusts the HKD split amounts; the import path
          // likewise stores amount_hkd=null rather than inventing a 7.8 conversion.
          const invAmtHkd = invAmt;
                          const allocated = splits.reduce((s, sp) => s + (sp.amount_hkd || 0), 0);
                          const diff = Math.round((invAmtHkd - allocated) * 100) / 100;
                          const balanced = Math.abs(diff) < 0.01;
                          const hasSplits = splits.length > 0;

                          const updateSplit = (idx: number, patch: Partial<{ project_code: string; amount_hkd: number; note: string }>) => {
                            setInvoiceSplits((prev) => {
                              const arr = [...(prev[key] || [])];
                              arr[idx] = { ...arr[idx], ...patch };
                              return { ...prev, [key]: arr };
                            });
                          };
                          const addSplit = () => {
                            setInvoiceSplits((prev) => {
                              const arr = [...(prev[key] || [])];
                              const remaining = Math.max(0, Math.round((invAmtHkd - arr.reduce((s, sp) => s + (sp.amount_hkd || 0), 0)) * 100) / 100);
                              arr.push({ project_code: "", amount_hkd: remaining, note: "" });
                              return { ...prev, [key]: arr };
                            });
                            setShowSplitEditor((p) => ({ ...p, [key]: true }));
                          };
                          const removeSplit = (idx: number) => {
                            setInvoiceSplits((prev) => {
                              const arr = [...(prev[key] || [])];
                              arr.splice(idx, 1);
                              return { ...prev, [key]: arr };
                            });
                          };
                          const toggleOpen = () => setShowSplitEditor((p) => ({ ...p, [key]: !p[key] }));

                          const currentChargeCode = editedInvoices[key]?.charge_to_code || "";
                          // entity auto-derived from charge_to_code (single source of truth)
                          const currentEntity = currentChargeCode
                            ? entityFromCharge(currentChargeCode)
                            : (editedInvoices[key]?.charge_to_entity || "");
                          const currentCategory = editedInvoices[key]?.expense_category || "";
                          const currentProject = editedInvoices[key]?.project_code || "";
                          const currentCard = editedInvoices[key]?.card_id || "";
                          const currentNote = editedInvoices[key]?.note || "";
                          const catsForEntity = filterCategoriesForEntity(currentEntity || null);
                          // req: category depends on whether a Project Code is chosen.
                          // Project selected → only [Project] categories (account 7xxxx);
                          // no project → only non-[Project] (overhead 8xxxx / others).
                          const isProjectCat = (c: ExpenseCategory) => (c.ns_account_number || "").startsWith("7");
                          const hasProject = !!currentProject && currentProject !== "__none__";
                          const catsForRow = hasProject
                            ? catsForEntity.filter(isProjectCat)
                            : catsForEntity.filter((c) => !isProjectCat(c));
                          return [
                            <tr key={key} className="border-t border-border/50">
                              <td className="px-2 py-1">
                                <button
                                  type="button"
                                  onClick={toggleOpen}
                                  className="text-muted-foreground hover:text-foreground"
                                  title={isOpen ? "收起分拆" : "展開分拆"}
                                  data-testid={`button-toggle-split-${key}`}
                                >
                                  {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                </button>
                              </td>
                              <td className="px-2 py-1">
                                <Input
                                  value={editedInv.invoice_number || ""}
                                  onChange={(e) => updateInvoiceEdit(fileIdx, invIdx, { invoice_number: e.target.value })}
                                  className="h-7 text-xs font-medium"
                                  placeholder="Invoice #"
                                  data-testid={`input-edit-invnum-${key}`}
                                />
                              </td>
                              <td className="px-2 py-1">
                                <Input
                                  type="date"
                                  value={editedInv.invoice_date || ""}
                                  onChange={(e) => updateInvoiceEdit(fileIdx, invIdx, { invoice_date: e.target.value })}
                                  className="h-7 text-xs tabular-nums"
                                  data-testid={`input-edit-date-${key}`}
                                />
                              </td>
                              <td className="px-2 py-1">
                                <Input
                                  value={editedInv.description || ""}
                                  onChange={(e) => updateInvoiceEdit(fileIdx, invIdx, { description: e.target.value })}
                                  className="h-7 text-xs"
                                  placeholder="Description"
                                  data-testid={`input-edit-desc-${key}`}
                                />
                              </td>
                              <td className="px-2 py-1">
                                <Input
                                  value={editedInv.currency || invCur}
                                  onChange={(e) => updateInvoiceEdit(fileIdx, invIdx, { currency: e.target.value.toUpperCase() })}
                                  className="h-7 text-xs w-16 uppercase"
                                  maxLength={3}
                                  data-testid={`input-edit-cur-${key}`}
                                />
                              </td>
                              <td className="px-2 py-1">
                                <Input
                                  type="number"
                                  step="0.01"
                                  value={typeof editedInv.amount === "number" ? editedInv.amount : invAmt}
                                  onChange={(e) => updateInvoiceEdit(fileIdx, invIdx, { amount: parseFloat(e.target.value) || 0 })}
                                  className="h-7 text-xs w-28 text-right tabular-nums font-medium"
                                  data-testid={`input-edit-amt-${key}`}
                                />
                              </td>
                              <td className="px-2 py-1">
                                <Select
                                  value={currentCard || "__none__"}
                                  onValueChange={(v) => updateInvoiceEdit(fileIdx, invIdx, { card_id: v === "__none__" ? "" : v })}
                                >
                                  <SelectTrigger className="h-7 text-xs w-44" data-testid={`select-card-${key}`}>
                                    <SelectValue placeholder="信用卡（可留空）" />
                                  </SelectTrigger>
                                  <SelectContent className="max-h-72">
                                    <SelectItem value="__none__">— 不指定卡 —</SelectItem>
                                    {creditCardAccounts
                                      .filter((c) => !currentEntity || entityMatchesCardSubsidiary(currentEntity, c.subsidiary))
                                      .map((c) => (
                                        <SelectItem key={c.id} value={c.card_last4 || c.card_identifier}>
                                          {c.card_identifier}{c.card_last4 ? ` · **${c.card_last4}` : ""} — {c.bank} ({c.subsidiary})
                                        </SelectItem>
                                      ))}
                                  </SelectContent>
                                </Select>
                              </td>
                            </tr>,
                            <tr key={`${key}-assign`}>
                              <td></td>
                              <td colSpan={6} className="px-2 pt-1.5 pb-0.5">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">Charge To <span className="text-destructive">*</span></span>
                                  <Select
                                    value={currentChargeCode || "__none__"}
                                    onValueChange={(v) => {
                                      const code = v === "__none__" ? "" : v;
                                      const newEntity = entityFromCharge(code);
                                      updateInvoiceEdit(fileIdx, invIdx, { charge_to_code: code, charge_to_entity: newEntity, expense_category: "", project_code: "" });
                                    }}
                                  >
                                    <SelectTrigger className={`h-7 text-xs w-56 ${!currentChargeCode ? "border-destructive/70" : ""}`} data-testid={`select-chargeto-${key}`}>
                                      <SelectValue placeholder="揀 Charge To *" />
                                    </SelectTrigger>
                                    <SelectContent className="max-h-80">
                                      <SelectItem value="__none__">— 未揀 —</SelectItem>
                                      {chargeToOptions.map((grp) => (
                                        <div key={grp.entity}>
                                          <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground sticky top-0 bg-popover">{grp.entity}</div>
                                          {grp.items.map((d) => (
                                            <SelectItem key={d.charge_to} value={d.charge_to}>
                                              <span className="font-mono text-xs">{d.charge_to}</span>
                                              <span className="text-muted-foreground ml-2">— {d.name}</span>
                                            </SelectItem>
                                          ))}
                                        </div>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  <span className="text-[10px] text-muted-foreground whitespace-nowrap ml-1">Project</span>
                                  <Select
                                    value={currentProject || "__none__"}
                                    onValueChange={(v) => {
                                      const proj = v === "__none__" ? "" : v;
                                      const patch: InvoiceEdit = { project_code: proj };
                                      const cat = catsForEntity.find((c) => c.category_key === currentCategory);
                                      const catIsProj = cat ? (cat.ns_account_number || "").startsWith("7") : false;
                                      if (currentCategory && ((proj && !catIsProj) || (!proj && catIsProj))) patch.expense_category = "";
                                      updateInvoiceEdit(fileIdx, invIdx, patch);
                                    }}
                                  >
                                    <SelectTrigger className="h-7 text-xs w-56" data-testid={`select-project-${key}`}>
                                      <SelectValue placeholder={currentEntity ? `選 Project (${currentEntity})` : "先選公司"} />
                                    </SelectTrigger>
                                    <SelectContent className="max-h-72">
                                      <SelectItem value="__none__">— 無 Project Code —</SelectItem>
                                      {projectCodes.filter((p) => projectMatchesEntity(p, currentEntity || null)).map((p) => (
                                        <SelectItem key={p.id} value={p.project_id}>{p.project_id} — {p.project_name}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  {currentEntity && noLedgerEntities.has(currentEntity) ? (
                                    <>
                                      <span className="text-[10px] text-muted-foreground whitespace-nowrap ml-1">Category</span>
                                      <span className="h-7 inline-flex items-center rounded-md border border-border/60 bg-muted/40 px-2 text-[10px] text-muted-foreground w-48" data-testid={`no-ledger-note-${key}`}>
                                        {currentEntity} 唔使揀 — 只出 Due From (AR)
                                      </span>
                                    </>
                                  ) : (
                                  <>
                                  <span className="text-[10px] text-muted-foreground whitespace-nowrap ml-1">Category <span className="text-destructive">*</span></span>
                                  <Select value={currentCategory} onValueChange={(v) => updateInvoiceEdit(fileIdx, invIdx, { expense_category: v })}>
                                    <SelectTrigger className={`h-7 text-xs w-48 ${!currentCategory ? "border-destructive/70" : ""}`} data-testid={`select-category-${key}`}>
                                      <SelectValue placeholder={currentEntity ? "選類別 *" : "先選公司"} />
                                    </SelectTrigger>
                                    <SelectContent className="max-h-72">
                                      {catsForRow.length === 0 && currentEntity && (
                                        <div className="px-2 py-1.5 text-xs text-muted-foreground">
                                          {hasProject ? "此 Project 沒對應 [Project] 類別" : "呢間公司冇 overhead 類別 / 揀 Project 先有 [Project]"}
                                        </div>
                                      )}
                                      {catsForRow.map((cat) => (
                                        <SelectItem key={cat.category_key} value={cat.category_key}>{formatCategoryLabel(cat.label_zh, cat.ns_account_number)}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  </>
                                  )}
                                </div>
                              </td>
                            </tr>,
                            <tr key={`${key}-note`}>
                              <td></td>
                              <td colSpan={6} className="px-2 pb-2 pt-0.5">
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-muted-foreground whitespace-nowrap flex items-center gap-0.5">
                                    <StickyNote size={10} /> 備註 <span className="text-destructive">*</span>
                                  </span>
                                  <Input
                                    value={currentNote}
                                    onChange={(e) => updateInvoiceEdit(fileIdx, invIdx, { note: e.target.value })}
                                    className={`h-7 text-xs flex-1 ${!currentNote.trim() ? "border-destructive/70" : ""}`}
                                    placeholder="必填 — 稍後用做 Export CSV Line memo（例：客戶 ABC 11月 ads）"
                                    data-testid={`input-note-visible-${key}`}
                                  />
                                </div>
                              </td>
                            </tr>,
                            ...(isOpen
                              ? [(
                                  <tr key={`${key}-editor`} className="bg-muted/20 border-t border-border/30">
                                    <td></td>
                                    <td colSpan={6} className="px-3 py-3">
                                      <div className="space-y-4">
                                        {/* Project split editor (Project Code / 信用卡 已移去上面兩行) */}
                                        <div className="space-y-2">
                                        <div className="flex items-center justify-between">
                                          <span className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
                                            <Split size={10} /> 分拆到多個 Project · Invoice HKD total: <span className="font-mono tabular-nums text-foreground">{invAmtHkd.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                                            · Allocated: <span className={`font-mono tabular-nums ${balanced ? "text-green-700" : "text-amber-700"}`}>{allocated.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                                            {!balanced && hasSplits && <span className="text-amber-700"> · Diff: {diff.toFixed(2)}</span>}
                                          </span>
                                          <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={addSplit} data-testid={`button-add-split-row-${key}`}>
                                            <Plus size={10} className="mr-0.5" /> Add row
                                          </Button>
                                        </div>
                                        {splits.length === 0 ? (
                                          <p className="text-[11px] text-muted-foreground py-2">
                                            不分拆 — 將使用上面的 Project Code（整張 invoice 走同一個）。按 Add row 開始分拆。
                                          </p>
                                        ) : (
                                          <div className="space-y-1.5">
                                            {splits.map((sp, idx) => (
                                              <div key={idx} className="flex items-center gap-2">
                                                <Select value={sp.project_code} onValueChange={(v) => updateSplit(idx, { project_code: v })}>
                                                  <SelectTrigger className="h-8 text-xs flex-1" data-testid={`select-split-project-${key}-${idx}`}>
                                                    <SelectValue placeholder="選 Project" />
                                                  </SelectTrigger>
                                                  <SelectContent className="max-h-72">
                                                    {projectCodes
                                                      .filter((p) => projectMatchesEntity(p, currentEntity || null))
                                                      .map((p) => (
                                                        <SelectItem key={p.id} value={p.project_id}>
                                                          {p.project_id} — {p.project_name}
                                                        </SelectItem>
                                                      ))}
                                                  </SelectContent>
                                                </Select>
                                                <Input
                                                  type="number"
                                                  step="0.01"
                                                  placeholder="HKD"
                                                  value={sp.amount_hkd || ""}
                                                  onChange={(e) => updateSplit(idx, { amount_hkd: parseFloat(e.target.value) || 0 })}
                                                  className="h-8 text-xs w-28 text-right tabular-nums"
                                                  data-testid={`input-split-amount-${key}-${idx}`}
                                                />
                                                <Input
                                                  placeholder="備註（可選）"
                                                  value={sp.note}
                                                  onChange={(e) => updateSplit(idx, { note: e.target.value })}
                                                  className="h-8 text-xs flex-1"
                                                  data-testid={`input-split-note-${key}-${idx}`}
                                                />
                                                <button
                                                  type="button"
                                                  onClick={() => removeSplit(idx)}
                                                  className="text-muted-foreground hover:text-destructive"
                                                  title="刪除"
                                                  data-testid={`button-remove-split-${key}-${idx}`}
                                                >
                                                  <X size={14} />
                                                </button>
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                        </div>
                                      </div>
                                    </td>
                                  </tr>
                                )]
                              : []),
                          ];
                        });
                      })}
                      {/* Manual invoice rows (typed by staff) */}
                      {manualInvoices.flatMap((m, mIdx) => {
                        const manualCats = filterCategoriesForEntity(m.charge_to_entity || null);
                        const manualHasProject = !!m.project_code && m.project_code !== "__none__";
                        const manualCatsRow = manualHasProject
                          ? manualCats.filter((c) => (c.ns_account_number || "").startsWith("7"))
                          : manualCats.filter((c) => !(c.ns_account_number || "").startsWith("7"));
                        return [(
                        <tr key={`manual-${mIdx}`} className="border-t border-border/50 bg-amber-500/5">
                          <td className="px-2 py-1">
                            <button
                              type="button"
                              onClick={() => removeManualInvoice(mIdx)}
                              className="text-muted-foreground hover:text-destructive"
                              title="刪除手動 invoice"
                              data-testid={`button-remove-manual-${mIdx}`}
                            >
                              <X size={12} />
                            </button>
                          </td>
                          <td className="px-2 py-1">
                            <Input
                              value={m.invoice_number}
                              onChange={(e) => updateManualInvoice(mIdx, { invoice_number: e.target.value })}
                              className="h-7 text-xs font-medium"
                              placeholder="Invoice #"
                              data-testid={`input-manual-invnum-${mIdx}`}
                            />
                          </td>
                          <td className="px-2 py-1">
                            <Input
                              type="date"
                              value={m.invoice_date}
                              onChange={(e) => updateManualInvoice(mIdx, { invoice_date: e.target.value })}
                              className="h-7 text-xs tabular-nums"
                              data-testid={`input-manual-date-${mIdx}`}
                            />
                          </td>
                          <td className="px-2 py-1">
                            <Input
                              value={m.description}
                              onChange={(e) => updateManualInvoice(mIdx, { description: e.target.value })}
                              className="h-7 text-xs"
                              placeholder="Description"
                              data-testid={`input-manual-desc-${mIdx}`}
                            />
                          </td>
                          <td className="px-2 py-1">
                            <Input
                              value={m.currency}
                              onChange={(e) => updateManualInvoice(mIdx, { currency: e.target.value.toUpperCase() })}
                              className="h-7 text-xs w-16 uppercase"
                              maxLength={3}
                              data-testid={`input-manual-cur-${mIdx}`}
                            />
                          </td>
                          <td className="px-2 py-1">
                            <Input
                              type="number"
                              step="0.01"
                              value={m.amount || ""}
                              onChange={(e) => updateManualInvoice(mIdx, { amount: parseFloat(e.target.value) || 0 })}
                              className="h-7 text-xs w-28 text-right tabular-nums font-medium"
                              placeholder="0.00"
                              data-testid={`input-manual-amt-${mIdx}`}
                            />
                          </td>
                          <td className="px-2 py-1">
                            <Select
                              value={m.card_id || "__none__"}
                              onValueChange={(v) => updateManualInvoice(mIdx, { card_id: v === "__none__" ? "" : v })}
                            >
                              <SelectTrigger className="h-7 text-xs w-44" data-testid={`select-manual-card-${mIdx}`}>
                                <SelectValue placeholder="信用卡（可留空）" />
                              </SelectTrigger>
                              <SelectContent className="max-h-72">
                                <SelectItem value="__none__">— 不指定卡 —</SelectItem>
                                {creditCardAccounts
                                  .filter((c) => !m.charge_to_entity || entityMatchesCardSubsidiary(m.charge_to_entity, c.subsidiary))
                                  .map((c) => (
                                    <SelectItem key={c.id} value={c.card_last4 || c.card_identifier}>
                                      {c.card_identifier}{c.card_last4 ? ` · **${c.card_last4}` : ""} — {c.bank} ({c.subsidiary})
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                          </td>
                        </tr>
                        ),(
                        <tr key={`manual-${mIdx}-assign`} className="bg-amber-500/5">
                          <td></td>
                          <td colSpan={6} className="px-2 pt-1.5 pb-0.5">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[10px] text-muted-foreground whitespace-nowrap">Charge To <span className="text-destructive">*</span></span>
                              <Select
                                value={m.charge_to_code || "__none__"}
                                onValueChange={(v) => {
                                  const code = v === "__none__" ? "" : v;
                                  const newEntity = entityFromCharge(code);
                                  updateManualInvoice(mIdx, { charge_to_code: code, charge_to_entity: newEntity, expense_category: "", project_code: "" });
                                }}
                              >
                                <SelectTrigger className={`h-7 text-xs w-56 ${!m.charge_to_code ? "border-destructive/70" : ""}`} data-testid={`select-manual-chargeto-${mIdx}`}>
                                  <SelectValue placeholder="揀 Charge To *" />
                                </SelectTrigger>
                                <SelectContent className="max-h-80">
                                  <SelectItem value="__none__">— 未揀 —</SelectItem>
                                  {chargeToOptions.map((grp) => (
                                    <div key={grp.entity}>
                                      <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground sticky top-0 bg-popover">{grp.entity}</div>
                                      {grp.items.map((d) => (
                                        <SelectItem key={d.charge_to} value={d.charge_to}>
                                          <span className="font-mono text-xs">{d.charge_to}</span>
                                          <span className="text-muted-foreground ml-2">— {d.name}</span>
                                        </SelectItem>
                                      ))}
                                    </div>
                                  ))}
                                </SelectContent>
                              </Select>
                              <span className="text-[10px] text-muted-foreground whitespace-nowrap ml-1">Project</span>
                              <Select
                                value={m.project_code || "__none__"}
                                onValueChange={(v) => {
                                  const proj = v === "__none__" ? "" : v;
                                  const patch: Partial<ManualInvoice> = { project_code: proj };
                                  const cat = manualCats.find((c) => c.category_key === m.expense_category);
                                  const catIsProj = cat ? (cat.ns_account_number || "").startsWith("7") : false;
                                  if (m.expense_category && ((proj && !catIsProj) || (!proj && catIsProj))) patch.expense_category = "";
                                  updateManualInvoice(mIdx, patch);
                                }}
                              >
                                <SelectTrigger className="h-7 text-xs w-56" data-testid={`select-manual-project-${mIdx}`}>
                                  <SelectValue placeholder={m.charge_to_entity ? `選 Project (${m.charge_to_entity})` : "先選公司"} />
                                </SelectTrigger>
                                <SelectContent className="max-h-72">
                                  <SelectItem value="__none__">— 無 Project Code —</SelectItem>
                                  {projectCodes.filter((p) => projectMatchesEntity(p, m.charge_to_entity || null)).map((p) => (
                                    <SelectItem key={p.id} value={p.project_id}>{p.project_id} — {p.project_name}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              {m.charge_to_entity && noLedgerEntities.has(m.charge_to_entity) ? (
                                <>
                                  <span className="text-[10px] text-muted-foreground whitespace-nowrap ml-1">Category</span>
                                  <span className="h-7 inline-flex items-center rounded-md border border-border/60 bg-muted/40 px-2 text-[10px] text-muted-foreground w-48" data-testid={`no-ledger-note-manual-${mIdx}`}>
                                    {m.charge_to_entity} 唔使揀 — 只出 Due From (AR)
                                  </span>
                                </>
                              ) : (
                              <>
                              <span className="text-[10px] text-muted-foreground whitespace-nowrap ml-1">Category <span className="text-destructive">*</span></span>
                              <Select value={m.expense_category} onValueChange={(v) => updateManualInvoice(mIdx, { expense_category: v })}>
                                <SelectTrigger className={`h-7 text-xs w-48 ${!m.expense_category ? "border-destructive/70" : ""}`} data-testid={`select-manual-category-${mIdx}`}>
                                  <SelectValue placeholder={m.charge_to_entity ? "選類別 *" : "先選公司"} />
                                </SelectTrigger>
                                <SelectContent className="max-h-72">
                                  {manualCatsRow.length === 0 && m.charge_to_entity && (
                                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                                      {manualHasProject ? "此 Project 沒對應 [Project] 類別" : "呢間公司冇 overhead 類別 / 揀 Project 先有 [Project]"}
                                    </div>
                                  )}
                                  {manualCatsRow.map((cat) => (
                                    <SelectItem key={cat.category_key} value={cat.category_key}>{formatCategoryLabel(cat.label_zh, cat.ns_account_number)}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              </>
                              )}
                            </div>
                          </td>
                        </tr>
                        ),(
                        <tr key={`manual-${mIdx}-note`} className="bg-amber-500/5">
                          <td></td>
                          <td colSpan={6} className="px-2 pb-2 pt-0.5">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-muted-foreground whitespace-nowrap flex items-center gap-0.5">
                                <StickyNote size={10} /> 備註 <span className="text-destructive">*</span>
                              </span>
                              <Input
                                value={m.note}
                                onChange={(e) => updateManualInvoice(mIdx, { note: e.target.value })}
                                className={`h-7 text-xs flex-1 ${!(m.note && m.note.trim()) ? "border-destructive/70" : ""}`}
                                placeholder="必填 — 稍後用做 Export CSV Line memo"
                                data-testid={`input-manual-note-${mIdx}`}
                              />
                            </div>
                          </td>
                        </tr>
                        )];
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Upload button (metadata is now per-invoice, see each row above) */}
            {allDone && hasData && (
              <div className="flex flex-col gap-1.5">
                <div className="flex gap-2 items-center">
                  <Button
                    onClick={() => uploadMutation.mutate()}
                    disabled={uploadMutation.isPending || importBlocked}
                    data-testid="button-upload"
                  >
                    {uploadMutation.isPending ? (
                      <><Loader2 className="animate-spin mr-2" size={16} /> Saving...</>
                    ) : (
                      <><CheckCircle2 className="mr-2" size={16} /> Confirm & Import All</>
                    )}
                  </Button>
                  <Button variant="outline" onClick={reset}>Cancel</Button>
                  {importBlocked && (
                    <span className="text-xs text-destructive flex flex-col gap-0.5" data-testid="import-blocked-reason">
                      {invoiceMissingCount > 0 && (
                        <span className="flex items-center gap-1">
                          <AlertCircle size={14} /> 仲有 {invoiceMissingCount} 張 invoice 未填齊 Charge To / Category / 備註
                        </span>
                      )}
                      {splitMismatches.map((g) => (
                        <span key={g.invoice_number} className="flex items-center gap-1">
                          <AlertCircle size={14} /> {g.invoice_number} 分拆金額加埋 {g.sum.toLocaleString()} ≠ invoice 總額 {g.target.toLocaleString()}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            )}

            {uploadMutation.isError && (
              <div className="flex items-center gap-2 text-destructive text-sm">
                <AlertCircle size={16} />
                Import failed: {(uploadMutation.error as Error).message}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- CSV Upload Panel (for matching rules) ----

interface ParsedCsvFile {
  file: File;
  headers: string[];
  rows: any[];
  rowCount: number;
}

function useSpreadsheetParser() {
  const [parsed, setParsed] = useState<ParsedCsvFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parseFile = useCallback((file: File) => {
    setError(null);
    setParsed(null);

    const isExcel = /\.xlsx?$/i.test(file.name);

    if (isExcel) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target?.result as ArrayBuffer);
          const workbook = XLSX.read(data, { type: "array" });
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];
          const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });
          if (rows.length === 0) {
            setError("No data found in spreadsheet");
            return;
          }
          const headers = Object.keys(rows[0]);
          setParsed({ file, headers, rows, rowCount: rows.length });
        } catch (err: any) {
          setError(`Excel parse error: ${err.message}`);
        }
      };
      reader.onerror = () => setError("Failed to read file");
      reader.readAsArrayBuffer(file);
    } else {
      // CSV
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          if (results.errors.length > 0) {
            setError(`Parse error: ${results.errors[0].message}`);
            return;
          }
          const headers = results.meta.fields || [];
          setParsed({ file, headers, rows: results.data, rowCount: results.data.length });
        },
        error: (err) => setError(err.message),
      });
    }
  }, []);

  return { parsed, error, parseFile, reset: () => { setParsed(null); setError(null); } };
}

/**
 * Map raw XLSX/CSV headers to normalized DB column names.
 * Returns: { columnMap: { origHeader → dbField }, mappedCount }
 */
function mapHeaders(rawHeaders: string[]): { columnMap: Record<string, string>; mappedCount: number; hasKeyword: boolean } {
  const columnMap: Record<string, string> = {};
  let mappedCount = 0;
  let hasKeyword = false;
  for (const h of rawHeaders) {
    // Normalize: lowercase, trim, collapse whitespace, strip \n
    const norm = h.toLowerCase().replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    const mapped = MAPPING_TABLE_COLUMN_MAP[norm];
    if (mapped) {
      columnMap[h] = mapped;
      mappedCount++;
      if (mapped === 'keyword') hasKeyword = true;
    }
  }
  return { columnMap, mappedCount, hasKeyword };
}

function MappingRulesUploadPanel({ title, description, onSuccess }: {
  title: string;
  description: string;
  onSuccess: () => void;
}) {
  const { parsed, error, parseFile, reset } = useSpreadsheetParser();

  // Compute header mapping
  const headerMapping = parsed ? mapHeaders(parsed.headers) : null;

  // Normalize rows using column map
  const normalizedRows = (parsed && headerMapping)
    ? parsed.rows
        .map((row) => {
          const out: Record<string, string> = {};
          for (const [origH, dbField] of Object.entries(headerMapping.columnMap)) {
            const val = row[origH];
            out[dbField] = val != null ? String(val).trim() : '';
          }
          return out;
        })
        .filter((r) => r.keyword && r.keyword.length > 0) // Skip empty keyword rows
    : [];

  const uploadMutation = useMutation({
    mutationFn: async (data: { file: File; rows: Record<string, string>[] }) => {
      const { data: batch, error: batchError } = await supabase
        .from("upload_batches")
        .insert({
          file_name: data.file.name,
          upload_type: "matching_rules" as UploadType,
          status: "processing",
          row_count: data.rows.length,
        })
        .select()
        .single();
      if (batchError) throw batchError;

      try {
        await insertRules(batch.id, data.rows);
        await supabase
          .from("upload_batches")
          .update({ status: "processed", processed_at: new Date().toISOString() })
          .eq("id", batch.id);
      } catch (err: any) {
        await supabase
          .from("upload_batches")
          .update({ status: "error", error_message: err.message })
          .eq("id", batch.id);
        throw err;
      }
    },
    onSuccess: () => {
      reset();
      onSuccess();
    },
  });

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && /\.(csv|xlsx?)$/i.test(file.name)) parseFile(file);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) parseFile(file);
  };

  // Display columns for preview
  const previewCols = ['keyword', 'account_name', 'dr_account_code', 'cr_account_code', 'target_entity', 'dept_code', 'customer', 'vendor'];
  const previewLabels: Record<string, string> = {
    keyword: 'Keyword',
    account_name: 'Account Name',
    dr_account_code: 'Dr Code',
    cr_account_code: 'Cr Code',
    target_entity: 'Entity',
    dept_code: 'Dept',
    customer: 'Customer',
    vendor: 'Vendor',
  };

  return (
    <Card className="mt-4">
      <CardContent className="pt-6">
        {!parsed ? (
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            className="border-2 border-dashed border-border rounded-lg p-10 text-center cursor-pointer hover:border-primary/50 transition-colors"
            onClick={() => document.getElementById("file-matching_rules")?.click()}
            data-testid="dropzone-matching_rules"
          >
            <Upload className="mx-auto text-muted-foreground mb-3" size={32} />
            <p className="text-sm font-medium">{title}</p>
            <p className="text-xs text-muted-foreground mt-1">{description}</p>
            <p className="text-xs text-muted-foreground mt-3">Drop CSV or Excel file here, or click to browse</p>
            <div className="flex justify-center gap-2 mt-3">
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">XLSX</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">XLS</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">CSV</span>
            </div>
            <input
              id="file-matching_rules"
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileSpreadsheet size={18} className="text-primary" />
                <div>
                  <p className="text-sm font-medium">{parsed.file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {normalizedRows.length} rules (from {parsed.rowCount} rows) · {headerMapping?.mappedCount || 0} columns mapped
                  </p>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={reset} data-testid="button-reset-upload">
                Change file
              </Button>
            </div>

            {/* Show which headers were mapped */}
            {headerMapping && (
              <div className="flex flex-wrap gap-1.5">
                {parsed.headers.filter(h => h != null).map((h) => {
                  const mapped = headerMapping.columnMap[h];
                  return (
                    <span key={h} className={`text-xs px-2 py-0.5 rounded-full ${
                      mapped ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                    }`}>
                      {mapped ? `${h} → ${mapped}` : h}
                    </span>
                  );
                })}
              </div>
            )}

            {headerMapping && !headerMapping.hasKeyword && (
              <div className="flex items-center gap-2 text-destructive text-sm">
                <AlertCircle size={16} />
                Cannot find keyword column (識別條件). Make sure your file has the correct headers.
              </div>
            )}

            {normalizedRows.length === 0 && headerMapping?.hasKeyword && (
              <div className="flex items-center gap-2 text-amber-600 text-sm">
                <AlertCircle size={16} />
                No rows with a non-empty keyword found.
              </div>
            )}

            {/* Normalized preview table */}
            {normalizedRows.length > 0 && (
              <div className="overflow-x-auto max-h-64 border rounded-md">
                <table className="w-full table-dense text-xs">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr>
                      {previewCols.map((c) => (
                        <th key={c} className="text-left px-2 py-1.5 font-medium whitespace-nowrap">{previewLabels[c]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {normalizedRows.slice(0, 10).map((row, i) => (
                      <tr key={i} className="border-t border-border/50">
                        {previewCols.map((c) => (
                          <td key={c} className="px-2 py-1 truncate max-w-[150px]">{row[c] || ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {normalizedRows.length > 10 && (
                  <p className="text-[10px] text-center text-muted-foreground py-1.5">
                    +{normalizedRows.length - 10} more rules
                  </p>
                )}
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 text-destructive text-sm">
                <AlertCircle size={16} /> {error}
              </div>
            )}

            <div className="flex gap-2">
              <Button
                onClick={() => uploadMutation.mutate({ file: parsed.file, rows: normalizedRows })}
                disabled={!headerMapping?.hasKeyword || normalizedRows.length === 0 || uploadMutation.isPending}
                data-testid="button-upload"
              >
                {uploadMutation.isPending ? (
                  <><Loader2 className="animate-spin mr-2" size={16} /> Processing...</>
                ) : (
                  <><CheckCircle2 className="mr-2" size={16} /> Import {normalizedRows.length} Rules</>
                )}
              </Button>
              <Button variant="outline" onClick={reset}>Cancel</Button>
            </div>

            {uploadMutation.isError && (
              <div className="flex items-center gap-2 text-destructive text-sm">
                <AlertCircle size={16} />
                Upload failed: {(uploadMutation.error as Error).message}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Expandable Batch Row ----

function BatchRow({ batch, onRemove, isDuplicate, uploaderEmail }: { batch: UploadBatch; onRemove: (id: string) => void; isDuplicate?: boolean; uploaderEmail?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: transactions, isLoading: txnLoading } = useQuery({
    queryKey: ["batch-transactions", batch.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("card_transactions")
        .select("*")
        .eq("batch_id", batch.id)
        .order("txn_date", { ascending: true });
      if (error) throw error;
      return data as CardTransaction[];
    },
    enabled: expanded && batch.upload_type === "cc_statement",
  });

  const { data: invoices, isLoading: invLoading } = useQuery({
    queryKey: ["batch-invoices", batch.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("meta_invoices")
        .select("*")
        .eq("batch_id", batch.id)
        .order("invoice_date", { ascending: true });
      if (error) throw error;
      return data as MetaInvoice[];
    },
    enabled: expanded && batch.upload_type === "meta_invoice",
  });

  const { data: rules, isLoading: rulesLoading } = useQuery({
    queryKey: ["batch-rules", batch.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("matching_rules")
        .select("*")
        .eq("batch_id", batch.id)
        .order("keyword", { ascending: true });
      if (error) throw error;
      return data as MatchingRule[];
    },
    enabled: expanded && batch.upload_type === "matching_rules",
  });

  const isLoading = txnLoading || invLoading || rulesLoading;
  const isClickable = batch.status === "processed";

  // Compute verified status
  const stmtTotal = batch.statement_total;
  const aiTotal = batch.ai_parsed_total;
  const hasVerification = stmtTotal != null && aiTotal != null;
  const isMatch = hasVerification && Math.abs(stmtTotal! - aiTotal!) < 0.02;

  return (
    <>
      <tr
        className={`border-b border-border/50 last:border-0 ${isClickable ? "cursor-pointer hover:bg-muted/30 transition-colors" : ""} ${isDuplicate ? "bg-amber-50/50 dark:bg-amber-900/10" : ""}`}
        onClick={() => isClickable && setExpanded(!expanded)}
        data-testid={`batch-row-${batch.id}`}
      >
        <td className="py-2 text-sm">
          <div className="flex items-center gap-1.5">
            {isClickable && (
              expanded
                ? <ChevronDown size={14} className="text-muted-foreground flex-shrink-0" />
                : <ChevronRight size={14} className="text-muted-foreground flex-shrink-0" />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                {isDuplicate && (
                  <span
                    className="text-[9px] px-1 py-0.5 rounded bg-amber-200 text-amber-900 font-medium flex-shrink-0"
                    title="Duplicate detected (same file + total + period)"
                  >
                    DUP
                  </span>
                )}
                <span className="truncate">{batch.file_name}</span>
                {(batch as any).file_path && (
                  <button
                    className="text-primary hover:text-primary/80 flex-shrink-0"
                    title="View original file"
                    onClick={async (e) => {
                      e.stopPropagation();
                      const { data } = await supabase.storage.from("documents").createSignedUrl((batch as any).file_path, 3600);
                      if (data?.signedUrl) window.open(data.signedUrl, "_blank");
                    }}
                  >
                    <ExternalLink size={12} />
                  </button>
                )}
              </div>
              {(batch as any).notes && (
                <p className="text-[11px] text-muted-foreground truncate max-w-[200px]">
                  <StickyNote size={10} className="inline mr-1" />{(batch as any).notes}
                </p>
              )}
            </div>
          </div>
        </td>
        <td className="py-2 text-sm text-muted-foreground">{batch.upload_type.replace("_", " ")}</td>
        <td className="py-2 text-sm tabular-nums text-muted-foreground">{(batch as any).period_month || "—"}</td>
        <td className="py-2 text-sm text-right tabular-nums">{batch.row_count}</td>
        <td className="py-2">
          <span className={`text-xs px-2 py-0.5 rounded-full ${
            batch.status === "processed" ? "status-matched" :
            batch.status === "error" ? "status-exception" : "status-pending"
          }`}>{batch.status}</span>
        </td>
        {/* Statement total vs AI total */}
        <td className="py-2 text-sm text-right tabular-nums">
          {stmtTotal != null ? stmtTotal.toLocaleString(undefined, { minimumFractionDigits: 2 }) : "—"}
        </td>
        <td className="py-2 text-sm text-right tabular-nums">
          {aiTotal != null ? aiTotal.toLocaleString(undefined, { minimumFractionDigits: 2 }) : "—"}
        </td>
        <td className="py-2 text-center">
          {hasVerification ? (
            isMatch ? (
              <ShieldCheck size={14} className="text-green-600 inline-block" />
            ) : (
              <ShieldAlert size={14} className="text-amber-600 inline-block" />
            )
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="py-2 text-sm text-muted-foreground">
          {new Date(batch.uploaded_at).toLocaleDateString()}
        </td>
        <td className="py-2 text-xs text-muted-foreground max-w-[170px] truncate" title={uploaderEmail || undefined}>
          {uploaderEmail || "—"}
        </td>
        <td className="py-2 text-center">
          {confirmDelete ? (
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <Button
                variant="destructive"
                size="sm"
                className="h-6 text-[10px] px-2"
                onClick={(e) => { e.stopPropagation(); onRemove(batch.id); setConfirmDelete(false); }}
                data-testid={`button-confirm-delete-${batch.id}`}
              >
                Confirm
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[10px] px-2"
                onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <button
              className={`transition-colors p-1 rounded flex items-center gap-1 ${
                batch.status === "error"
                  ? "text-destructive hover:bg-destructive/10"
                  : "text-muted-foreground hover:text-destructive"
              }`}
              onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
              title={batch.status === "error" ? "刪除 — 修正後可重新 upload" : "Remove this batch"}
              data-testid={`button-delete-${batch.id}`}
            >
              <Trash2 size={14} />
              {batch.status === "error" && <span className="text-[10px] whitespace-nowrap">刪除重上</span>}
            </button>
          )}
        </td>
      </tr>
      {/* Expanded detail rows */}
      {expanded && (
        <tr>
          <td colSpan={11} className="p-0">
            <div className="bg-muted/20 border-t border-b border-border/30 px-4 py-3">
              {isLoading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                  <Loader2 className="animate-spin" size={14} /> Loading entries...
                </div>
              )}
              {/* CC transactions */}
              {transactions && transactions.length > 0 && (
                <div className="overflow-x-auto max-h-72">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-left px-2 py-1.5 font-medium">Date</th>
                        <th className="text-left px-2 py-1.5 font-medium">Merchant</th>
                        <th className="text-right px-2 py-1.5 font-medium">Amount</th>
                        <th className="text-left px-2 py-1.5 font-medium">Currency</th>
                        <th className="text-left px-2 py-1.5 font-medium">Cardholder</th>
                        <th className="text-left px-2 py-1.5 font-medium">Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.map((txn) => (
                        <tr key={txn.id} className="border-t border-border/30">
                          <td className="px-2 py-1 tabular-nums whitespace-nowrap">{txn.txn_date}</td>
                          <td className="px-2 py-1 truncate max-w-[200px]">{txn.merchant}</td>
                          <td className="px-2 py-1 text-right tabular-nums font-medium whitespace-nowrap">
                            {txn.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </td>
                          <td className="px-2 py-1">{txn.currency}</td>
                          <td className="px-2 py-1 text-muted-foreground">{txn.card_last4 || "—"}</td>
                          <td className="px-2 py-1 truncate max-w-[200px] text-muted-foreground">{txn.description}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-muted/30 font-medium">
                      <tr className="border-t border-border">
                        <td className="px-2 py-1.5" colSpan={2}>Total ({transactions.length} transactions)</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {transactions.reduce((s, t) => s + t.amount, 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </td>
                        <td colSpan={3}></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
              {/* Invoices */}
              {invoices && invoices.length > 0 && (
                <div className="overflow-x-auto max-h-72">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-left px-2 py-1.5 font-medium">Invoice #</th>
                        <th className="text-left px-2 py-1.5 font-medium">Description</th>
                        <th className="text-left px-2 py-1.5 font-medium">Date</th>
                        <th className="text-right px-2 py-1.5 font-medium">Amount</th>
                        <th className="text-left px-2 py-1.5 font-medium">Currency</th>
                        <th className="text-left px-2 py-1.5 font-medium">Account</th>
                        <th className="text-left px-2 py-1.5 font-medium">Period</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoices.map((inv: any) => (
                        <tr key={inv.id} className="border-t border-border/30">
                          <td className="px-2 py-1 font-medium">{inv.invoice_number}</td>
                          <td className="px-2 py-1 truncate max-w-[250px] text-muted-foreground">{inv.description || "—"}</td>
                          <td className="px-2 py-1 tabular-nums">{inv.invoice_date || "—"}</td>
                          <td className="px-2 py-1 text-right tabular-nums font-medium">
                            {inv.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </td>
                          <td className="px-2 py-1">{inv.currency}</td>
                          <td className="px-2 py-1 truncate max-w-[180px]">{inv.account_name}</td>
                          <td className="px-2 py-1 text-muted-foreground">{inv.billing_period || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-muted/30 font-medium">
                      <tr className="border-t border-border">
                        <td className="px-2 py-1.5" colSpan={3}>Total ({invoices.length} invoices)</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {invoices.reduce((s: number, inv: any) => s + inv.amount, 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </td>
                        <td colSpan={3}></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
              {/* Matching rules */}
              {rules && rules.length > 0 && (
                <div className="overflow-x-auto max-h-72">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-left px-2 py-1.5 font-medium">Keyword</th>
                        <th className="text-left px-2 py-1.5 font-medium">Account Name</th>
                        <th className="text-left px-2 py-1.5 font-medium">Dr Code</th>
                        <th className="text-left px-2 py-1.5 font-medium">Cr Code</th>
                        <th className="text-left px-2 py-1.5 font-medium">Entity</th>
                        <th className="text-left px-2 py-1.5 font-medium">Dept</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rules.map((rule) => (
                        <tr key={rule.id} className="border-t border-border/30">
                          <td className="px-2 py-1 font-medium">{rule.keyword}</td>
                          <td className="px-2 py-1 truncate max-w-[180px]">{rule.account_name || "—"}</td>
                          <td className="px-2 py-1 tabular-nums">{rule.dr_account_code || "—"}</td>
                          <td className="px-2 py-1 tabular-nums">{rule.cr_account_code || "—"}</td>
                          <td className="px-2 py-1 truncate max-w-[150px]">{rule.target_entity || "—"}</td>
                          <td className="px-2 py-1">{rule.dept_code || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {!isLoading && (!transactions || transactions.length === 0) && (!invoices || invoices.length === 0) && (!rules || rules.length === 0) && (
                <p className="text-sm text-muted-foreground py-2">No entries found for this batch.</p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ---- Main Page ----

export default function UploadCentre() {
  const [activeTab, setActiveTab] = useState("documents");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [searchFilter, setSearchFilter] = useState("");
  const [showDuplicatesOnly, setShowDuplicatesOnly] = useState(false);
  // Upload History pagination
  const [histPage, setHistPage] = useState(0);
  const [histPerPage, setHistPerPage] = useState(20);

  const { data: recentBatches } = useQuery({
    queryKey: ["upload-batches"],
    queryFn: async () => {
      // Bank statement batches live in the Bank Upload Centre — keep them out of here
      const { data, error } = await supabase
        .from("upload_batches")
        .select("*")
        .or("module.neq.bank,module.is.null")
        .order("uploaded_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data as UploadBatch[];
    },
  });

  // Uploader (user email) per user_id — for the "Uploaded by" column so an admin can
  // track who uploaded each batch. Resilient: returns [] if user_profiles is unreadable.
  const { data: uploaderProfiles } = useQuery({
    queryKey: ["uploader-profiles"],
    queryFn: async () => {
      const { data, error } = await supabase.from("user_profiles").select("user_id, email, full_name");
      if (error) return [] as { user_id: string; email: string; full_name: string | null }[];
      return (data || []) as { user_id: string; email: string; full_name: string | null }[];
    },
    retry: false,
  });
  const uploaderById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of (uploaderProfiles || [])) if (p.user_id) m.set(p.user_id, p.email || "");
    return m;
  }, [uploaderProfiles]);

  // Detect duplicates: same file_name + statement_total + statement_period
  const duplicateGroups = useMemo(() => {
    if (!recentBatches) return new Map<string, string[]>();
    const groups = new Map<string, string[]>();
    for (const b of recentBatches) {
      const key = `${b.file_name}|${b.statement_total ?? ""}|${(b as any).statement_period ?? ""}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(b.id);
    }
    // Only keep groups with >1 batch
    const dups = new Map<string, string[]>();
    groups.forEach((ids, key) => { if (ids.length > 1) dups.set(key, ids); });
    return dups;
  }, [recentBatches]);

  const duplicateBatchIds = useMemo(() => {
    const ids = new Set<string>();
    duplicateGroups.forEach((batchIds) => batchIds.forEach((id) => ids.add(id)));
    return ids;
  }, [duplicateGroups]);

  const filteredBatches = useMemo(() => {
    if (!recentBatches) return [];
    return recentBatches.filter((b) => {
      if (showDuplicatesOnly && !duplicateBatchIds.has(b.id)) return false;
      if (searchFilter) {
        const q = searchFilter.toLowerCase();
        if (!b.file_name?.toLowerCase().includes(q) &&
            !(b as any).statement_period?.toLowerCase().includes(q) &&
            !(b as any).card_last4?.includes(q)) return false;
      }
      return true;
    });
  }, [recentBatches, searchFilter, showDuplicatesOnly, duplicateBatchIds]);

  // History pagination slices (每頁顯示行數可以揀)
  const histTotalPages = Math.max(1, Math.ceil(filteredBatches.length / histPerPage));
  const histSafePage = Math.min(histPage, histTotalPages - 1);
  const pagedBatches = filteredBatches.slice(histSafePage * histPerPage, (histSafePage + 1) * histPerPage);

  const handleRemoveBatch = useCallback(async (batchId: string) => {
    try {
      // Mirror the safe massDelete order and check every { error } so a failed
      // delete (e.g. RLS) rejects instead of leaving orphaned rows.
      const { data: txnIds, error: txnSelErr } = await supabase
        .from("card_transactions")
        .select("id")
        .eq("batch_id", batchId);
      if (txnSelErr) throw txnSelErr;
      if (txnIds && txnIds.length > 0) {
        const ids = txnIds.map((t) => t.id);
        // Collect invoices matched to these transactions so we can un-match them
        // afterwards — otherwise deleting the txn leaves the invoice stuck
        // is_matched=true but orphaned (matched to a now-deleted transaction).
        const matchedInvoiceIds = new Set<string>();
        for (let i = 0; i < ids.length; i += 50) {
          const chunk = ids.slice(i, i + 50);
          const { data: recon, error: reconSelErr } = await supabase
            .from("reconciliation_results")
            .select("invoice_id")
            .in("transaction_id", chunk)
            .not("invoice_id", "is", null);
          if (reconSelErr) throw reconSelErr;
          (recon || []).forEach((r: any) => { if (r.invoice_id) matchedInvoiceIds.add(r.invoice_id); });
        }
        for (let i = 0; i < ids.length; i += 50) {
          const chunk = ids.slice(i, i + 50);
          // accounting_lines FIRST (references card_transactions), then recon results.
          const alRes = await supabase.from("accounting_lines").delete().in("transaction_id", chunk);
          if (alRes.error) throw alRes.error;
          const rrRes = await supabase.from("reconciliation_results").delete().in("transaction_id", chunk);
          if (rrRes.error) throw rrRes.error;
        }
        // Reset is_matched on invoices that were matched to the deleted transactions
        // (these invoices may belong to other batches and must not stay orphaned).
        const invIds = Array.from(matchedInvoiceIds);
        for (let i = 0; i < invIds.length; i += 50) {
          const chunk = invIds.slice(i, i + 50);
          const { error: unmatchErr } = await supabase
            .from("meta_invoices")
            .update({ is_matched: false })
            .in("id", chunk);
          if (unmatchErr) throw unmatchErr;
        }
      }
      const ctRes = await supabase.from("card_transactions").delete().eq("batch_id", batchId);
      if (ctRes.error) throw ctRes.error;
      const miRes = await supabase.from("meta_invoices").delete().eq("batch_id", batchId);
      if (miRes.error) throw miRes.error;
      const mrRes = await supabase.from("matching_rules").delete().eq("batch_id", batchId);
      if (mrRes.error) throw mrRes.error;
      // Delete the batch itself
      const { error } = await supabase.from("upload_batches").delete().eq("id", batchId);
      if (error) throw error;

      queryClient.invalidateQueries({ queryKey: ["upload-batches"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["matching-rules"] });
      toast({ title: "Batch removed", description: "Upload and related entries deleted." });
    } catch (err: any) {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    }
  }, [queryClient, toast]);

  return (
    <div className="p-6 space-y-6 max-w-[1200px]">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" data-testid="text-page-title">Upload Centre</h1>
        <p className="text-sm text-muted-foreground mt-1">Upload CC statements, invoices, or matching rules</p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="documents" data-testid="tab-documents">Documents</TabsTrigger>
          <TabsTrigger value="matching_rules" data-testid="tab-matching-rules">Matching Rules</TabsTrigger>
        </TabsList>

        <TabsContent value="documents">
          <DocumentUploadPanel
            title="Upload Documents"
            description="CC statements, invoices, receipts — drop any PDF or image. AI will auto-detect the type."
            onSuccess={() => {
              queryClient.invalidateQueries({ queryKey: ["upload-batches"] });
              queryClient.invalidateQueries({ queryKey: ["dashboard"] });
              toast({ title: "Documents imported", description: "Files parsed and saved." });
            }}
          />
        </TabsContent>

        <TabsContent value="matching_rules">
          <MappingRulesUploadPanel
            title="Mapping Table"
            description="Upload your XLSX mapping table with columns: 識別條件, 會計科目名稱, 借方/貸方科目代碼, 所屬公司, 部門代碼, etc."
            onSuccess={() => {
              queryClient.invalidateQueries({ queryKey: ["upload-batches"] });
              queryClient.invalidateQueries({ queryKey: ["matching-rules"] });
              toast({ title: "Mapping table imported", description: "Rules imported successfully." });
            }}
          />
        </TabsContent>
      </Tabs>

      {/* Upload History with expandable rows */}
      {recentBatches && recentBatches.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <CardTitle className="text-sm font-medium">Upload History</CardTitle>
                <span className="text-xs text-muted-foreground">
                  {filteredBatches.length} / {recentBatches.length} batches
                </span>
                {duplicateBatchIds.size > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300">
                    ⚠ {duplicateBatchIds.size} duplicate{duplicateBatchIds.size > 1 ? "s" : ""} detected
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Search file / period / last4..."
                  value={searchFilter}
                  onChange={(e) => { setSearchFilter(e.target.value); setHistPage(0); }}
                  className="text-xs px-2 py-1 border border-border rounded w-56 bg-background"
                  data-testid="input-search-batches"
                />
                <button
                  onClick={() => { setShowDuplicatesOnly(!showDuplicatesOnly); setHistPage(0); }}
                  className={`text-xs px-2 py-1 rounded border ${
                    showDuplicatesOnly
                      ? "bg-amber-100 border-amber-300 text-amber-800"
                      : "bg-background border-border text-muted-foreground hover:bg-muted"
                  }`}
                  data-testid="button-filter-duplicates"
                >
                  {showDuplicatesOnly ? "✓ Duplicates only" : "Show duplicates only"}
                </button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full table-dense">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-xs font-medium text-muted-foreground">File</th>
                    <th className="text-left text-xs font-medium text-muted-foreground">Type</th>
                    <th className="text-left text-xs font-medium text-muted-foreground">Period</th>
                    <th className="text-right text-xs font-medium text-muted-foreground">Rows</th>
                    <th className="text-left text-xs font-medium text-muted-foreground">Status</th>
                    <th className="text-right text-xs font-medium text-muted-foreground">Stmt Total</th>
                    <th className="text-right text-xs font-medium text-muted-foreground">AI Total</th>
                    <th className="text-center text-xs font-medium text-muted-foreground">✓</th>
                    <th className="text-left text-xs font-medium text-muted-foreground">Uploaded</th>
                    <th className="text-left text-xs font-medium text-muted-foreground">Uploaded by</th>
                    <th className="text-center text-xs font-medium text-muted-foreground w-[80px]"></th>
                  </tr>
                </thead>
                <tbody>
                  {pagedBatches.map((b) => (
                    <BatchRow
                      key={b.id}
                      batch={b}
                      onRemove={handleRemoveBatch}
                      isDuplicate={duplicateBatchIds.has(b.id)}
                      uploaderEmail={uploaderById.get((b as any).user_id) || ""}
                    />
                  ))}
                  {filteredBatches.length === 0 && (
                    <tr>
                      <td colSpan={11} className="text-center text-sm text-muted-foreground py-4">
                        No batches match the current filter
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {/* History pagination: Page X of Y (N total items) · 每頁顯示行數 */}
            <div className="flex items-center justify-between gap-2 flex-wrap py-1.5 px-1 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <Button variant="outline" size="sm" className="h-6 px-2 text-xs"
                  disabled={histSafePage === 0} onClick={() => setHistPage(histSafePage - 1)} data-testid="hist-prev-page">‹</Button>
                <span className="tabular-nums">Page {histSafePage + 1} of {histTotalPages} ({filteredBatches.length} total items)</span>
                <Button variant="outline" size="sm" className="h-6 px-2 text-xs"
                  disabled={histSafePage >= histTotalPages - 1} onClick={() => setHistPage(histSafePage + 1)} data-testid="hist-next-page">›</Button>
              </div>
              <div className="flex items-center gap-1.5">
                <span>showing</span>
                <Select value={String(histPerPage)} onValueChange={(v) => { setHistPerPage(Number(v)); setHistPage(0); }}>
                  <SelectTrigger className="h-6 w-20 text-xs" data-testid="hist-per-page"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="20">20</SelectItem>
                    <SelectItem value="50">50</SelectItem>
                    <SelectItem value="100">100</SelectItem>
                    <SelectItem value="200">200</SelectItem>
                  </SelectContent>
                </Select>
                <span>items per page</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---- Insert helpers ----

// Extract real last-4 digits of a card. Tries multiple sources, falling back
// to grabbing the trailing 4 digits of the bank's printed account_number
// (e.g. "5592 4033 3682 2118" -> "2118").
function extractLast4(...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) {
    if (!c) continue;
    const trimmed = String(c).trim();
    // Direct match: already 4 digits
    if (/^\d{4}$/.test(trimmed)) return trimmed;
    // Pull last 4 digits from any longer string with digits
    const digits = trimmed.replace(/\D+/g, '');
    if (digits.length >= 4) return digits.slice(-4);
  }
  return '';
}

async function insertTransactions(batchId: string, transactions: ParsedTransaction[], metadata?: Record<string, any>, userId?: string | null, periodMonth?: string | null) {
  const records = transactions.map((t) => {
    // Per-transaction period_month from its own date, fallback to batch-level
    const txnMonth = t.date && t.date.length >= 7 ? t.date.substring(0, 7) : periodMonth;
    const amt = typeof t.amount === "number" ? t.amount : parseFloat(String(t.amount).replace(/[,$]/g, ""));
    const cur = t.currency || "HKD";

    // Calculate fx_rate and amount_hkd from parsed data (handles USD and other FX transactions).
    // Never fabricate a rate: a non-HKD txn with no real fx_rate keeps fx_rate AND
    // amount_hkd null so downstream flags it, rather than assuming a 1:1 (or any) rate.
    const fxRate = t.fx_rate || (cur === "HKD" ? 1 : null);
    const amtHkd = t.amount_hkd || (cur === "HKD" ? amt : (fxRate ? amt * fxRate : null));

    return {
      batch_id: batchId,
      txn_date: t.date,
      merchant: t.merchant || "",
      amount: amt,
      amount_hkd: amtHkd,
      currency: cur,
      fx_rate: fxRate, // null for non-HKD without a real rate — do not store a fabricated 1:1
      reference: t.reference || "",
      card_last4: extractLast4(t.card_last4, metadata?.card_last4, metadata?.account_number),
      cardholder_name: metadata?.cardholder || null,
      post_date: t.post_date || null,
      description: t.description || t.merchant || "",
      ...(userId ? { user_id: userId } : {}),
      ...(txnMonth ? { period_month: txnMonth } : {}),
    };
  });

  for (let i = 0; i < records.length; i += 50) {
    const chunk = records.slice(i, i + 50);
    const { error } = await supabase.from("card_transactions").insert(chunk);
    if (error) throw error;
  }

  // Create pending reconciliation results
  const { data: txns } = await supabase
    .from("card_transactions")
    .select("id")
    .eq("batch_id", batchId);

  if (txns) {
    const reconRecords = txns.map((t) => ({
      transaction_id: t.id,
      status: "pending" as const,
    }));
    for (let i = 0; i < reconRecords.length; i += 50) {
      const chunk = reconRecords.slice(i, i + 50);
      const { error } = await supabase.from("reconciliation_results").insert(chunk);
      if (error) throw error;
    }
  }
}

// Resolve the NetSuite account for an expense category.
//
// A NetSuite GL account is a single shared record (one internal id) shared
// across subsidiaries, so the account number is the same regardless of the
// charge-to entity — we resolve by account_number alone. Which categories are
// even selectable for a given entity is already constrained upstream in the UI
// via ns_account_subsidiaries, so there is no need (and it is wrong) to
// entity-match here or to silently fall back to Sundry Expenses, which would
// misbook the cost.
async function resolveAccountCode(
  _chargeToEntity: string | null,
  categoryKey: string | null
): Promise<{ account_number: string | null; account_name: string | null }> {
  if (!categoryKey) return { account_number: null, account_name: null };

  const { data: cat } = await supabase
    .from("expense_categories")
    .select("ns_account_number")
    .eq("category_key", categoryKey)
    .maybeSingle();

  if (!cat) return { account_number: null, account_name: null };
  const baseAcct = (cat as any).ns_account_number as string;

  const { data: acc } = await supabase
    .from("ns_chart_of_accounts")
    .select("account_number, account_name")
    .eq("account_number", baseAcct)
    .maybeSingle();

  return {
    account_number: baseAcct,
    account_name: (acc as any)?.account_name ?? null,
  };
}

type InvoiceMetaForInsert = {
  charge_to_entity: string | null;
  charge_to_code: string | null;
  project_code: string | null;
  expense_category: string | null;
  card_id: string | null;
  note: string | null;
};

// 一張 invoice 分拆做幾份（唔同公司）時，每份嘅內容
type InvoicePiece = {
  amount: number;
  description: string | null;
  meta: InvoiceMetaForInsert;
};

async function insertInvoices(
  batchId: string,
  invoices: ParsedInvoice[],
  userId: string | null | undefined,
  periodMonth: string | null | undefined,
  metaByInvIdx: InvoiceMetaForInsert[],
  splitsByInvIdx?: Record<number, Array<{ project_code: string; amount_hkd: number; note: string }>>,
  piecesByInvIdx?: Record<number, InvoicePiece[]>
) {
  for (let invIdx = 0; invIdx < invoices.length; invIdx++) {
    const inv = invoices[invIdx];
    const pieces = piecesByInvIdx?.[invIdx];
    // 分拆 invoice：parent 係「成張 invoice」（總額，用嚟配對 CC 交易），
    // 每份公司分配做 child — parent 自己唔揸 charge-to/category。
    const meta: InvoiceMetaForInsert = pieces && pieces.length > 0
      ? { charge_to_entity: null, charge_to_code: null, project_code: null, expense_category: null, card_id: pieces[0].meta.card_id, note: null }
      : (metaByInvIdx[invIdx] || { charge_to_entity: null, charge_to_code: null, project_code: null, expense_category: null, card_id: null, note: null });
    // Resolve account code per invoice (each invoice has its own entity + category)
    const resolvedAccount = await resolveAccountCode(meta.charge_to_entity, meta.expense_category);
    const invMonth = inv.invoice_date && inv.invoice_date.length >= 7 ? inv.invoice_date.substring(0, 7) : periodMonth;
    const amt = typeof inv.amount === "number" ? inv.amount : parseFloat(String(inv.amount).replace(/[,$]/g, ""));
    const cur = inv.currency || "HKD";
    // Never fabricate an FX rate. Previously all non-HKD invoices were converted
    // at a hardcoded 7.8, silently mis-stating amount_hkd for non-USD currencies.
    // Now a non-HKD invoice without a real (user-provided) rate leaves fx_rate and
    // amount_hkd null so it gets flagged rather than guessed. Currency is preserved.
    const fxRate = cur === "HKD" ? 1 : ((inv as any).fx_rate ?? null);
    const amtHkd = cur === "HKD" ? amt : (fxRate ? Math.round(amt * fxRate * 100) / 100 : null);
    const parentRecord = {
      batch_id: batchId,
      invoice_number: inv.invoice_number || "",
      billing_period: inv.billing_period || "",
      amount: amt,
      currency: cur,
      amount_hkd: amtHkd,
      fx_rate: fxRate,
      invoice_date: inv.invoice_date || null,
      account_name: inv.account_name || "",
      account_id: inv.account_id || null,
      description: inv.description || null,
      ...(userId ? { user_id: userId } : {}),
      ...(invMonth ? { period_month: invMonth } : {}),
      ...(meta.charge_to_entity ? { charge_to_entity: meta.charge_to_entity } : {}),
      ...(meta.charge_to_code ? { charge_to_code: meta.charge_to_code } : {}),
      ...(meta.project_code ? { project_code: meta.project_code } : {}),
      ...(meta.expense_category ? { expense_category: meta.expense_category } : {}),
      ...(meta.card_id ? { card_last4: meta.card_id } : {}),
      ...(meta.note ? { notes: meta.note } : {}),
      ...(resolvedAccount.account_number ? { ns_account_number: resolvedAccount.account_number } : {}),
      ...(resolvedAccount.account_name ? { ns_account_name: resolvedAccount.account_name } : {}),
    };

    // Insert parent invoice and get its ID back
    const { data: parentData, error: parentError } = await supabase
      .from("meta_invoices")
      .insert(parentRecord)
      .select("id")
      .single();
    if (parentError) throw parentError;

    // Insert splits if provided for this invoice
    const splits = splitsByInvIdx?.[invIdx];
    if (splits && splits.length > 0 && parentData?.id) {
      const splitRecords = splits
        .filter((s) => s.amount_hkd > 0)
        .map((s, sidx) => ({
          invoice_id: parentData.id,
          project_code: s.project_code && s.project_code !== "__none__" ? s.project_code : null,
          amount_hkd: s.amount_hkd,
          note: s.note?.trim() || null,
          sort_order: sidx,
        }));
      if (splitRecords.length > 0) {
        const { error: splitErr } = await supabase.from("meta_invoice_splits").insert(splitRecords);
        if (splitErr) throw splitErr;
      }
    }

    // 分拆 pieces → children：每份帶自己嘅公司/部門/project/category/金額。
    // Recon Queue 嘅 Unmatched 淨係列 parent（總額），所以配對用一個 combined 金額；
    // 展開先見到每份分配。
    if (pieces && pieces.length > 0 && parentData?.id) {
      const pieceRecords = [] as Record<string, any>[];
      for (const p of pieces) {
        const pAcc = await resolveAccountCode(p.meta.charge_to_entity, p.meta.expense_category);
        const pHkd = cur === "HKD" ? p.amount : (fxRate ? Math.round(p.amount * fxRate * 100) / 100 : null);
        pieceRecords.push({
          batch_id: batchId,
          invoice_number: inv.invoice_number || "",
          billing_period: inv.billing_period || "",
          amount: p.amount,
          currency: cur,
          amount_hkd: pHkd,
          fx_rate: fxRate,
          invoice_date: inv.invoice_date || null,
          account_name: inv.account_name || "",
          account_id: inv.account_id || null,
          description: p.description || inv.description || null,
          parent_invoice_id: parentData.id,
          ...(userId ? { user_id: userId } : {}),
          ...(invMonth ? { period_month: invMonth } : {}),
          ...(p.meta.charge_to_entity ? { charge_to_entity: p.meta.charge_to_entity } : {}),
          ...(p.meta.charge_to_code ? { charge_to_code: p.meta.charge_to_code } : {}),
          ...(p.meta.project_code ? { project_code: p.meta.project_code } : {}),
          ...(p.meta.expense_category ? { expense_category: p.meta.expense_category } : {}),
          ...(p.meta.card_id ? { card_last4: p.meta.card_id } : {}),
          ...(p.meta.note ? { notes: p.meta.note } : {}),
          ...(pAcc.account_number ? { ns_account_number: pAcc.account_number } : {}),
          ...(pAcc.account_name ? { ns_account_name: pAcc.account_name } : {}),
        });
      }
      const { error: pieceErr } = await supabase.from("meta_invoices").insert(pieceRecords);
      if (pieceErr) throw pieceErr;
      // pieces 取代 OCR campaign line items 做 children — 唔好兩種 children 溝埋
      continue;
    }

    // Insert children (Meta campaign line items) with parent_invoice_id
    const children = inv.children || [];
    if (children.length > 0 && parentData?.id) {
      const childRecords = children.map((child) => {
        const childMonth = child.invoice_date && child.invoice_date.length >= 7 ? child.invoice_date.substring(0, 7) : invMonth;
        const childAmt = typeof child.amount === "number" ? child.amount : parseFloat(String(child.amount).replace(/[,$]/g, ""));
        const childCur = child.currency || inv.currency || "HKD";
        // Inherit the parent's rate (may be null when non-HKD without a real rate);
        // never fabricate — leave amount_hkd null instead of multiplying by a guess.
        const childFx = childCur === "HKD" ? 1 : fxRate;
        const childHkd = childCur === "HKD" ? childAmt : (childFx ? Math.round(childAmt * childFx * 100) / 100 : null);
        return {
          batch_id: batchId,
          invoice_number: child.invoice_number || inv.invoice_number || "",
          billing_period: child.billing_period || inv.billing_period || "",
          amount: childAmt,
          currency: childCur,
          amount_hkd: childHkd,
          fx_rate: childFx,
          invoice_date: child.invoice_date || inv.invoice_date || null,
          account_name: child.account_name || inv.account_name || "",
          account_id: child.account_id || inv.account_id || null,
          description: child.description || null,
          parent_invoice_id: parentData.id,
          ...(userId ? { user_id: userId } : {}),
          ...(childMonth ? { period_month: childMonth } : {}),
        };
      });

      for (let i = 0; i < childRecords.length; i += 50) {
        const chunk = childRecords.slice(i, i + 50);
        const { error } = await supabase.from("meta_invoices").insert(chunk);
        if (error) throw error;
      }
    }
  }
}

async function insertRules(batchId: string, rows: Record<string, string>[]) {
  const records = rows.map((r) => ({
    batch_id: batchId,
    keyword: r.keyword || "",
    account_name: r.account_name || null,
    dr_account_code: r.dr_account_code || null,
    cr_account_code: r.cr_account_code || null,
    target_entity: r.target_entity || null,
    dept_code: r.dept_code || null,
    customer: r.customer || null,
    vendor: r.vendor || null,
    netsuite_account: r.netsuite_account || null,
    project_code: r.project_code || null,
    notes: r.notes || null,
  }));

  for (let i = 0; i < records.length; i += 50) {
    const chunk = records.slice(i, i + 50);
    const { error } = await supabase.from("matching_rules").insert(chunk);
    if (error) throw error;
  }
}
