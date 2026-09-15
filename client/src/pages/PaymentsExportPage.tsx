// PaymentsExportPage.tsx
// 付款申請 Export — Owner/Admin 專用：
// - 已批核批次 post 去 NetSuite 做 Vendor Bills (subsidiary filter + 已 post 過)
// - 預付款批次：NetSuite Vendor Prepayment 手動入數後「標記已入數」
// - CSV：下載付款申請一覽 (對數/存檔用)
import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { csvText, csvAmount } from "@/lib/csv";
import { todayHK } from "@/lib/hkdate";
import { HandCoins, Loader2, UploadCloud, Download, Eye } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePagination, PaginationFooter } from "@/components/PaginationFooter";

interface PaymentBatch {
  id: string;
  batch_no: string;
  full_name: string | null;
  payee_name: string | null;
  payee_type: string | null;
  supplier_invoice_no: string | null;
  invoice_date: string | null;
  invoice_amount: number | null;
  invoice_currency: string | null;
  is_prepayment: boolean;
  is_pre_approved?: boolean;
  period_month: string | null;
  charge_to_code: string;
  entity_code: string | null;
  status: string;
  total_hkd: number;
  approved_total_hkd: number | null;
  netsuite_journal_no: string | null;
  exported_at: string | null;
  approved_at: string | null;
  created_at: string;
}

type PreviewRow = {
  doc: "BILL" | "JE";
  date: string;
  kind: string;
  account: string;
  debit: number | null;
  credit: number | null;
  department: string;
  project: string;
  memo: string;
  batch_no?: string;
};

// 同 subsidiary + 同日期 + 同類 (accrual / prepaid) 嘅 JE — 跨批次合併成一張
type PreviewJournal = {
  external_id: string;
  date: string;
  kind: string;
  subsidiary: string;
  batches: string[];
  lines: number;
  total: number;
  memo?: string;
  preview?: PreviewRow[];
  status?: string;
  netsuite_id?: string;
  error?: string;
};

type PostResult = {
  batch_id?: string;
  batch_no: string | null;
  label?: string;
  vendor?: string;
  status: string;
  netsuite_id?: string;
  error?: string;
  bill_date?: string;
  invoice_no?: string | null;
  due_date?: string | null;
  is_prepayment?: boolean;
  total?: number;
  header_memo?: string;
  already_posted?: number;
  journals?: { date: string; kind: string; total: number; status?: string; netsuite_id?: string; error?: string; external_id?: string; combined?: number }[];
  preview?: PreviewRow[];
};

const fmtAmt = (n: number | null | undefined) =>
  n == null ? "" : n.toLocaleString("en-HK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PaymentsExportPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [posting, setPosting] = useState(false);
  const [postResults, setPostResults] = useState<PostResult[]>([]);
  const [billsSub, setBillsSub] = useState<string>("all");
  // 入 NetSuite 前 preview (dry_run)：睇清楚 bill + JE 分錄先確認
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PostResult[] | null>(null);
  const [previewIds, setPreviewIds] = useState<string[]>([]);
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  const [previewJournals, setPreviewJournals] = useState<PreviewJournal[]>([]);
  const [postJournals, setPostJournals] = useState<PreviewJournal[]>([]);

  const { data: payments } = useQuery({
    queryKey: ["payment-batches"],
    staleTime: 0,  // 列表每次入頁都 refetch (global 預設 staleTime Infinity)
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_batches")
        .select("*")
        .eq("claim_type", "payment")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []) as PaymentBatch[];
    },
  });

  const readyBatches = useMemo(
    () => (payments || []).filter(c =>
      c.status === "approved" &&
      (billsSub === "all" || c.entity_code === billsSub)),
    [payments, billsSub],
  );
  const billsSubOptions = useMemo(() => {
    const s = new Set<string>();
    (payments || []).forEach(c => {
      if (c.status === "approved" && c.entity_code) s.add(c.entity_code);
    });
    return Array.from(s).sort();
  }, [payments]);
  const prepayReady = useMemo(
    () => (payments || []).filter(c => c.status === "approved" && c.is_prepayment),
    [payments],
  );
  const exported = useMemo(
    () => (payments || []).filter(c => c.status === "exported"),
    [payments],
  );
  const exportedPg = usePagination(exported);

  const toggleSelect = (id: string, on: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  };

  // Step 1：dry_run 拎分錄 preview (唔會寫 NetSuite)
  const handlePreview = async () => {
    // 未剔選 → 預覽全部（當前 subsidiary filter 內）已批核批次；有剔選 → 只預覽已選
    const ids = selectedIds.size > 0
      ? readyBatches.filter(b => selectedIds.has(b.id)).map(b => b.id)
      : readyBatches.map(b => b.id);
    if (ids.length === 0) {
      toast({ title: "冇已批核批次", description: "冇可以入數嘅批次", variant: "destructive" });
      return;
    }
    if (selectedIds.size === 0) setSelectedIds(new Set(ids));
    setPreviewing(true);
    setPostResults([]);
    try {
      const { data, error } = await supabase.functions.invoke("netsuite-post-vendor-bill", {
        body: { batch_ids: ids, dry_run: true },
      });
      if (error) throw new Error(error.message || "Edge Function 呼叫失敗");
      if (data?.error) throw new Error(data.error);
      setPreview(data.results || []);
      setPreviewIds(ids);
      setPreviewWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      setPreviewJournals(Array.isArray(data.journals) ? data.journals : []);
    } catch (err: any) {
      toast({ title: "Preview 失敗", description: err.message, variant: "destructive" });
    }
    setPreviewing(false);
  };

  // Step 2：用戶喺 preview 確認先真正 post
  const handlePostBills = async () => {
    const ids = previewIds.filter(id => (preview || []).some(r => r.batch_id === id && r.status === "dry_run"));
    if (ids.length === 0) {
      toast({ title: "冇可入數嘅批次", description: "preview 入面全部有問題，請先修正", variant: "destructive" });
      return;
    }
    setPreview(null);
    setPosting(true);
    setPostResults([]);
    setPostJournals([]);
    try {
      const { data, error } = await supabase.functions.invoke("netsuite-post-vendor-bill", {
        body: { batch_ids: ids },
      });
      if (error) throw new Error(error.message || "Edge Function 呼叫失敗");
      if (data?.error) throw new Error(data.error);
      setPostResults(data.results || []);
      setPostJournals(Array.isArray(data.journals) ? data.journals : []);
      toast({
        title: data.failed > 0 ? "部分完成" : "入數完成 ✓",
        description: `新建 ${data.created} 張 bill · ${data.duplicates} 張已 post 過 · ${data.failed} 張失敗`,
        variant: data.failed > 0 ? "destructive" : undefined,
      });
      setSelectedIds(new Set());
      qc.invalidateQueries({ queryKey: ["payment-batches"] });
    } catch (err: any) {
      toast({ title: "入數失敗", description: err.message, variant: "destructive" });
    }
    setPosting(false);
  };

  const markPrepaymentDone = async (b: PaymentBatch) => {
    if (!window.confirm(`確認已喺 NetSuite 用 Vendor Prepayment 入咗「${b.batch_no} · ${b.payee_name}」?\n\n張單會標記做「已入 NetSuite」。`)) return;
    const { data: updated, error } = await supabase.from("claim_batches").update({
      status: "exported",
      netsuite_journal_no: "PREPAYMENT (手動入)",
      exported_at: new Date().toISOString(),
    }).eq("id", b.id).eq("status", "approved").select();
    if (error || !updated?.length) {
      toast({ title: "標記失敗", description: error?.message || "狀態已變，請重新整理", variant: "destructive" });
      return;
    }
    toast({ title: "已標記 ✓", description: `${b.batch_no} 已當作入咗 NetSuite (Vendor Prepayment)` });
    qc.invalidateQueries({ queryKey: ["payment-batches"] });
  };

  // 付款申請一覽 CSV (approved + exported)
  const handleExportCsv = () => {
    const rows = (payments || []).filter(b => ["approved", "exported"].includes(b.status));
    if (rows.length === 0) {
      toast({ title: "冇可匯出嘅批次", description: "要 approved / exported 先會出現", variant: "destructive" });
      return;
    }
    const header = ["Batch No", "Payee", "Type", "Invoice No", "Invoice Date", "Invoice Amount", "Currency", "Entity", "Charge To", "Total HKD", "Status", "NetSuite Ref", "Prepayment"];
    const csv = [
      header.join(","),
      ...rows.map(b => [
        csvText(b.batch_no),
        csvText(b.payee_name || ""),
        csvText(b.payee_type || ""),
        csvText(b.supplier_invoice_no || ""),
        csvText(b.invoice_date || ""),
        csvAmount(b.invoice_amount),
        csvText(b.invoice_currency || "HKD"),
        csvText(b.entity_code || ""),
        csvText(b.charge_to_code || ""),
        csvAmount(b.approved_total_hkd ?? b.total_hkd),
        csvText(b.status),
        csvText(b.netsuite_journal_no || ""),
        csvText(b.is_prepayment ? "Y" : ""),
      ].join(",")),
    ].join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payment_requisitions_${todayHK()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Export complete", description: `${rows.length} 張批次已匯出` });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <HandCoins className="text-primary" size={24} />
            付款申請 Export
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            已批核付款申請入 NetSuite (Vendor Bills)；預付款會自動開 bill + accrual / prepaid JE (明細早過發票日期 → 37001010，遲過 → 22005010)
          </p>
        </div>
        <Button variant="outline" onClick={handleExportCsv} data-testid="button-export-payments-csv">
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {/* NetSuite Bills */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <UploadCloud size={15} className="text-primary" />
              入 NetSuite (Vendor Bills) — {readyBatches.length} 張已批核
            </CardTitle>
            <Select value={billsSub} onValueChange={(v) => { setBillsSub(v); setSelectedIds(new Set()); }}>
              <SelectTrigger className="h-8 w-[170px] text-xs" data-testid="select-bills-subsidiary"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Subsidiaries</SelectItem>
                {billsSubOptions.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={handlePreview} disabled={posting || previewing || readyBatches.length === 0}
              data-testid="button-preview-bills">
              {previewing || posting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Eye className="h-4 w-4 mr-2" />}
              Preview {selectedIds.size > 0 ? `${selectedIds.size} 張` : `全部 ${readyBatches.length} 張`} 入數分錄
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="text-[11px] text-muted-foreground">
            Vendor 用「收款人名」對應 NetSuite vendor(companyname / entityid,唔分大小寫);供應商發票號碼做 bill Reference No。
            入完數 status 自動變「已入 NetSuite」,重按唔會重複 (externalId = batch no)。
            撳「Preview」未剔選 = 預覽全部已批核批次；只想入部分就先剔選。Preview 之後撳「確認入 NetSuite」先會真正入數。
          </div>
          {readyBatches.length === 0 && (
            <div className="text-sm text-muted-foreground py-4 text-center">冇已批核、未入數嘅批次</div>
          )}
          {readyBatches.length > 0 && (
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-xs text-muted-foreground px-1">
                <Checkbox
                  checked={readyBatches.length > 0 && readyBatches.every(b => selectedIds.has(b.id))}
                  onCheckedChange={(v) => {
                    setSelectedIds(v ? new Set(readyBatches.map(b => b.id)) : new Set());
                  }}
                />
                全選
              </label>
              {readyBatches.map(b => (
                <label key={b.id} className="flex items-center gap-2 text-xs px-1 py-1 rounded hover:bg-muted/40 cursor-pointer">
                  <Checkbox checked={selectedIds.has(b.id)} onCheckedChange={(v) => toggleSelect(b.id, !!v)} />
                  <span className="font-mono">{b.batch_no}</span>
                  <span className="font-medium">{b.payee_name}</span>
                  {b.is_prepayment && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-700 dark:text-purple-400 font-medium" title="會自動開 bill + accrual / prepaid JE">預付</span>
                  )}
                  {b.is_pre_approved && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 font-medium">已簽批</span>
                  )}
                  {b.supplier_invoice_no && <span className="text-muted-foreground">INV: {b.supplier_invoice_no}</span>}
                  <span className="text-muted-foreground">{b.entity_code} · {b.charge_to_code}</span>
                  <span className="ml-auto tabular-nums font-medium">
                    HK${Number(b.approved_total_hkd ?? b.total_hkd ?? 0).toFixed(2)}
                  </span>
                </label>
              ))}
            </div>
          )}
          {postResults.length > 0 && (
            <div className="border-t border-border/40 pt-2 space-y-1">
              {postResults.map((r, i) => (
                <div key={i} className={`text-[11px] flex items-start gap-2 flex-wrap ${r.status === "error" ? "text-red-600 dark:text-red-400" : r.status === "partial" ? "text-amber-600 dark:text-amber-500" : r.status === "created" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}`}>
                  <span className="font-mono">{r.batch_no}</span>
                  {r.status === "created" && <span>✓ Bill {r.netsuite_id} 已建立{r.vendor ? ` (${r.vendor})` : ""}</span>}
                  {r.status === "duplicate" && <span>已 post 過 (跳過)</span>}
                  {r.status === "partial" && <span>⚠ Bill {r.netsuite_id} 已建立，但 {r.error}</span>}
                  {r.status === "error" && <span>✗ {r.error}</span>}
                  {Array.isArray(r.journals) && r.journals.length > 0 && (
                    <span className="text-muted-foreground w-full pl-2">
                      JE：{r.journals.map((j) =>
                        `${j.date} ${j.kind === "accrual" ? "accrual" : "prepaid"} HK$${Number(j.total || 0).toFixed(2)}${(j.combined || 1) > 1 ? ` (合併 ${j.combined} 張單)` : ""} ${
                          j.status === "created" ? `✓ ${j.netsuite_id}` : j.status === "duplicate" ? "已 post 過" : "✗"}`
                      ).join(" · ")}
                    </span>
                  )}
                </div>
              ))}
              {postJournals.length > 0 && (
                <div className="text-[11px] pt-1 space-y-0.5">
                  <div className="font-medium text-muted-foreground">JE（同 subsidiary、同日期合併）— {postJournals.length} 張</div>
                  {postJournals.map((j) => (
                    <div key={j.external_id} className={`flex items-center gap-2 flex-wrap ${j.status === "error" ? "text-red-600 dark:text-red-400" : j.status === "created" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}`}>
                      <span className="tabular-nums">{j.date}</span>
                      <span>{j.kind === "accrual" ? "accrual" : "prepaid"}</span>
                      <span>{j.subsidiary}</span>
                      <span className="font-mono">{j.batches.join(", ")}</span>
                      <span className="tabular-nums">HK${fmtAmt(j.total)}</span>
                      <span>{j.status === "created" ? `✓ JE ${j.netsuite_id}` : j.status === "duplicate" ? "已 post 過" : `✗ ${j.error || ""}`}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 預付款 */}
      {prepayReady.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">預付款 / 按金 — {prepayReady.length} 張已批核 · 後備手動標記</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="text-[11px] text-muted-foreground">
              預付款而家會由上面「入 NetSuite」自動開 bill + 每月 accrual / prepaid JE。只有自動入數失敗、喺 NetSuite 手動入咗嘅時候，先喺呢度撳「標記已入數」。
            </div>
            {prepayReady.map(b => (
              <div key={b.id} className="flex items-center gap-2 text-xs px-1 py-1 rounded hover:bg-muted/40">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-700 dark:text-purple-400 font-medium">預付</span>
                <span className="font-mono">{b.batch_no}</span>
                <span className="font-medium">{b.payee_name}</span>
                {b.supplier_invoice_no && <span className="text-muted-foreground">INV: {b.supplier_invoice_no}</span>}
                <span className="ml-auto tabular-nums font-medium">
                  HK${Number(b.approved_total_hkd ?? b.total_hkd ?? 0).toFixed(2)}
                </span>
                <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]"
                  onClick={() => markPrepaymentDone(b)} data-testid={`button-mark-prepay-${b.batch_no}`}>
                  標記已入數
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* 已入 NetSuite 紀錄 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">已 post 過 ({exported.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {exported.length === 0 && (
            <div className="text-sm text-muted-foreground py-2 text-center">未有已入 NetSuite 嘅批次</div>
          )}
          {exportedPg.pageItems.map(b => (
            <div key={b.id} className="flex items-center gap-2 text-xs px-1 py-1">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 font-medium">已 post 過 ✓</span>
              <span className="font-mono">{b.batch_no}</span>
              <span className="font-medium">{b.payee_name}</span>
              <span className="text-muted-foreground font-mono">{b.netsuite_journal_no}</span>
              <span className="ml-auto tabular-nums">
                HK${Number(b.approved_total_hkd ?? b.total_hkd ?? 0).toFixed(2)}
              </span>
            </div>
          ))}
          <PaginationFooter {...exportedPg.footerProps} />
        </CardContent>
      </Card>

      {/* 入 NetSuite 前 preview — 每張單嘅 Bill + JE 分錄，確認先真正 post */}
      <Dialog open={!!preview} onOpenChange={(o) => { if (!o) setPreview(null); }}>
        <DialogContent className="max-w-5xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>入 NetSuite 前 Preview — 請核對分錄</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {previewWarnings.length > 0 && (
              <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-400 space-y-1">
                <div className="font-medium">⚠ NetSuite 權限檢查未通過 — 撳「確認入 NetSuite」會失敗，請先搞掂權限：</div>
                {previewWarnings.map((w, i) => <div key={i} className="whitespace-pre-wrap">{w}</div>)}
              </div>
            )}
            {(preview || []).map((r) => (
              <div key={r.batch_id || r.batch_no || ""} className="border border-border/60 rounded-md">
                <div className="px-3 py-2 bg-muted/40 flex items-center gap-2 flex-wrap text-sm">
                  <span className="font-mono font-medium">{r.batch_no}</span>
                  <span className="font-medium">{r.vendor || r.label}</span>
                  {r.is_prepayment && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-700 dark:text-purple-400 font-medium">預付</span>
                  )}
                  {r.status === "dry_run" && (
                    <span className="text-xs text-muted-foreground">
                      Bill 日期 {r.bill_date}{r.invoice_no ? ` · 發票 ${r.invoice_no}` : ""}{r.due_date ? ` · 到期 ${r.due_date}` : ""}
                      {" · "}總額 HK${fmtAmt(r.total)}
                      {r.journals && r.journals.length > 0 ? ` · ${r.journals.length} 個日期 JE（下面合併顯示）` : ""}
                      {r.already_posted ? ` · ${r.already_posted} 行 JE 已入過（跳過）` : ""}
                    </span>
                  )}
                  {r.status === "dry_run" && r.header_memo && (
                    <div className="w-full text-xs text-muted-foreground">Bill Memo：{r.header_memo}</div>
                  )}
                  {r.status === "error" && (
                    <span className="text-xs text-red-600 dark:text-red-400">✗ 唔會入數：{r.error}</span>
                  )}
                </div>
                {r.status === "dry_run" && r.preview && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="text-muted-foreground border-b border-border/60">
                        <tr>
                          <th className="text-left px-3 py-1.5 font-medium whitespace-nowrap">Date</th>
                          <th className="text-left px-2 py-1.5 font-medium">Doc</th>
                          <th className="text-left px-2 py-1.5 font-medium">Account</th>
                          <th className="text-right px-2 py-1.5 font-medium">Debit</th>
                          <th className="text-right px-2 py-1.5 font-medium">Credit</th>
                          <th className="text-left px-2 py-1.5 font-medium">Dept</th>
                          <th className="text-left px-2 py-1.5 font-medium">Project</th>
                          <th className="text-left px-3 py-1.5 font-medium">Memo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.preview.map((row, i) => {
                          const prev = i > 0 ? r.preview![i - 1] : null;
                          const newGroup = !prev || prev.doc !== row.doc || prev.date !== row.date;
                          return (
                            <tr key={i} className={`${newGroup && i > 0 ? "border-t-2 border-border" : "border-t border-border/40"} ${row.doc === "JE" ? "bg-amber-500/5" : ""}`}>
                              <td className="px-3 py-1 tabular-nums whitespace-nowrap">{row.date}</td>
                              <td className="px-2 py-1">
                                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${row.doc === "BILL" ? "bg-blue-500/15 text-blue-700 dark:text-blue-400" : "bg-amber-500/15 text-amber-700 dark:text-amber-500"}`}>
                                  {row.doc}{row.doc === "JE" ? ` · ${row.kind === "accrual" ? "accrual" : "prepaid"}` : ""}
                                </span>
                              </td>
                              <td className="px-2 py-1 whitespace-nowrap">{row.account}</td>
                              <td className="px-2 py-1 text-right tabular-nums">{fmtAmt(row.debit)}</td>
                              <td className="px-2 py-1 text-right tabular-nums">{fmtAmt(row.credit)}</td>
                              <td className="px-2 py-1 whitespace-nowrap text-muted-foreground">{row.department}</td>
                              <td className="px-2 py-1 font-mono text-muted-foreground">{row.project}</td>
                              <td className="px-3 py-1 text-muted-foreground max-w-[360px] truncate" title={row.memo}>{row.memo}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
            {previewJournals.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-medium flex items-center gap-2">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-500 font-medium">JE</span>
                  應計 / 預付款 JE — 同 subsidiary、同日期、同類合併，共 {previewJournals.length} 張
                  <span className="text-xs text-muted-foreground font-normal">（一張 JE 可以包含多張單嘅 transaction；每張單一條貸方行）</span>
                </div>
                {previewJournals.map((j) => (
                  <div key={j.external_id} className="border border-amber-500/30 rounded-md">
                    <div className="px-3 py-2 bg-amber-500/5 flex items-center gap-2 flex-wrap text-xs">
                      <span className="font-medium tabular-nums">{j.date}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-500 font-medium">{j.kind === "accrual" ? "accrual" : "prepaid"}</span>
                      <span>{j.subsidiary}</span>
                      <span className="font-mono text-muted-foreground">{j.batches.join(" + ")}</span>
                      <span className="text-muted-foreground">· {j.lines} 行 · HK${fmtAmt(j.total)}</span>
                      {j.memo && <div className="w-full text-muted-foreground">JE Memo：{j.memo}</div>}
                    </div>
                    {j.preview && (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead className="text-muted-foreground border-b border-border/60">
                            <tr>
                              <th className="text-left px-3 py-1.5 font-medium">Batch</th>
                              <th className="text-left px-2 py-1.5 font-medium">Account</th>
                              <th className="text-right px-2 py-1.5 font-medium">Debit</th>
                              <th className="text-right px-2 py-1.5 font-medium">Credit</th>
                              <th className="text-left px-2 py-1.5 font-medium">Dept</th>
                              <th className="text-left px-2 py-1.5 font-medium">Project</th>
                              <th className="text-left px-3 py-1.5 font-medium">Memo</th>
                            </tr>
                          </thead>
                          <tbody>
                            {j.preview.map((row, i) => (
                              <tr key={i} className={`border-t border-border/40 ${row.credit != null ? "bg-muted/30" : ""}`}>
                                <td className="px-3 py-1 font-mono whitespace-nowrap">{row.batch_no}</td>
                                <td className="px-2 py-1 whitespace-nowrap">{row.account}</td>
                                <td className="px-2 py-1 text-right tabular-nums">{fmtAmt(row.debit)}</td>
                                <td className="px-2 py-1 text-right tabular-nums">{fmtAmt(row.credit)}</td>
                                <td className="px-2 py-1 whitespace-nowrap text-muted-foreground">{row.department}</td>
                                <td className="px-2 py-1 font-mono text-muted-foreground">{row.project}</td>
                                <td className="px-3 py-1 text-muted-foreground max-w-[360px] truncate" title={row.memo}>{row.memo}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreview(null)} disabled={posting}>取消</Button>
            <Button onClick={handlePostBills} disabled={posting || !(preview || []).some(r => r.status === "dry_run")}
              data-testid="button-confirm-post-bills">
              {posting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <UploadCloud className="h-4 w-4 mr-2" />}
              確認入 NetSuite ({(preview || []).filter(r => r.status === "dry_run").length} 張)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
