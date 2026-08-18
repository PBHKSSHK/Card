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
import { HandCoins, Loader2, UploadCloud, Download } from "lucide-react";

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

type PostResult = {
  batch_no: string | null;
  label?: string;
  vendor?: string;
  status: string;
  netsuite_id?: string;
  error?: string;
};

export default function PaymentsExportPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [posting, setPosting] = useState(false);
  const [postResults, setPostResults] = useState<PostResult[]>([]);
  const [billsSub, setBillsSub] = useState<string>("all");

  const { data: payments } = useQuery({
    queryKey: ["payment-batches"],
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
      c.status === "approved" && !c.is_prepayment &&
      (billsSub === "all" || c.entity_code === billsSub)),
    [payments, billsSub],
  );
  const billsSubOptions = useMemo(() => {
    const s = new Set<string>();
    (payments || []).forEach(c => {
      if (c.status === "approved" && !c.is_prepayment && c.entity_code) s.add(c.entity_code);
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

  const toggleSelect = (id: string, on: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  };

  const handlePostBills = async () => {
    const ids = readyBatches.filter(b => selectedIds.has(b.id)).map(b => b.id);
    if (ids.length === 0) {
      toast({ title: "未揀批次", description: "請先剔選要入數嘅批次", variant: "destructive" });
      return;
    }
    if (!window.confirm(`確定將 ${ids.length} 張付款申請 post 去 NetSuite 做 vendor bill?\n\nVendor 用收款人名對應，供應商發票號碼做 Reference No。`)) return;
    setPosting(true);
    setPostResults([]);
    try {
      const { data, error } = await supabase.functions.invoke("netsuite-post-vendor-bill", {
        body: { batch_ids: ids },
      });
      if (error) throw new Error(error.message || "Edge Function 呼叫失敗");
      if (data?.error) throw new Error(data.error);
      setPostResults(data.results || []);
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
            已批核付款申請入 NetSuite (Vendor Bills)；預付款用 Vendor Prepayment 手動入後標記
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
            <Button size="sm" onClick={handlePostBills} disabled={posting || selectedIds.size === 0}
              data-testid="button-post-bills">
              {posting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <UploadCloud className="h-4 w-4 mr-2" />}
              Post {selectedIds.size > 0 ? `${selectedIds.size} 張` : ""} 去 NetSuite
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="text-[11px] text-muted-foreground">
            Vendor 用「收款人名」對應 NetSuite vendor(companyname / entityid,唔分大小寫);供應商發票號碼做 bill Reference No。
            入完數 status 自動變「已入 NetSuite」,重按唔會重複 (externalId = batch no)。
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
                <div key={i} className={`text-[11px] flex items-start gap-2 ${r.status === "error" ? "text-red-600 dark:text-red-400" : r.status === "created" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}`}>
                  <span className="font-mono">{r.batch_no}</span>
                  {r.status === "created" && <span>✓ Bill {r.netsuite_id} 已建立{r.vendor ? ` (${r.vendor})` : ""}</span>}
                  {r.status === "duplicate" && <span>已 post 過 (跳過)</span>}
                  {r.status === "prepayment" && <span>{r.error}</span>}
                  {r.status === "error" && <span>✗ {r.error}</span>}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 預付款 */}
      {prepayReady.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">預付款 / 按金 — {prepayReady.length} 張已批核 (唔會自動開 bill)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="text-[11px] text-muted-foreground">
              請喺 NetSuite 用 <b>Vendor Prepayment</b>（或先入預付科目）入數，之後返嚟撳「標記已入數」；收到正式發票時喺 NetSuite 對沖。
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
          {exported.slice(0, 50).map(b => (
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
        </CardContent>
      </Card>
    </div>
  );
}
