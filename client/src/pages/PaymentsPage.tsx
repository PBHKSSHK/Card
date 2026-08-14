// PaymentsPage.tsx
// 付款申請 (Payment Requisition) 面板 — 同 Claim Forms 分開
// - List view: claim_type='payment' 嘅 batches
// - 新增 → /claims/new/payment (共用 NewClaimPage)
// - Owner/Admin: 「入 NetSuite (Bills)」 — approved 批次直接 post 做 vendor bill,
//   供應商發票號碼做 Reference No
import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  HandCoins, Plus, Filter, CheckCircle2, Clock, XCircle, FileCheck,
  Send, Eye, Loader2, UploadCloud,
} from "lucide-react";

const STATUS_LABELS: Record<string, { label: string; color: string; icon: any }> = {
  draft: { label: "草稿", color: "bg-muted text-muted-foreground", icon: Clock },
  submitted: { label: "已提交", color: "bg-blue-500/15 text-blue-700 dark:text-blue-400", icon: Send },
  team_head_approved: { label: "Team Head 已簽", color: "bg-amber-500/15 text-amber-700 dark:text-amber-400", icon: FileCheck },
  approved: { label: "已批核", color: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", icon: CheckCircle2 },
  exported: { label: "已入 NetSuite", color: "bg-purple-500/15 text-purple-700 dark:text-purple-400", icon: FileCheck },
  rejected: { label: "已退回", color: "bg-red-500/15 text-red-700 dark:text-red-400", icon: XCircle },
};

interface PaymentBatch {
  id: string;
  batch_no: string;
  claimant_user_id: string;
  full_name: string | null;
  nick_name: string | null;
  payee_name: string | null;
  payee_type: string | null;
  payment_method: string | null;
  payment_due_date: string | null;
  supplier_invoice_no: string | null;
  submit_date: string | null;
  period_month: string | null;
  charge_to_code: string;
  entity_code: string | null;
  department_name: string | null;
  status: string;
  total_hkd: number;
  approved_total_hkd: number | null;
  line_count: number;
  netsuite_journal_no: string | null;
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

export default function PaymentsPage() {
  const { isSuperUser } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterPeriod, setFilterPeriod] = useState<string>("all");
  const [searchText, setSearchText] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [posting, setPosting] = useState(false);
  const [postResults, setPostResults] = useState<PostResult[]>([]);

  const { data: payments, isLoading } = useQuery({
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

  const periods = useMemo(() => {
    const s = new Set<string>();
    for (const c of payments || []) if (c.period_month) s.add(c.period_month);
    return Array.from(s).sort().reverse();
  }, [payments]);

  const filtered = useMemo(() => {
    let arr = payments || [];
    if (filterStatus !== "all") arr = arr.filter(c => c.status === filterStatus);
    if (filterPeriod !== "all") arr = arr.filter(c => c.period_month === filterPeriod);
    if (searchText) {
      const q = searchText.toLowerCase();
      arr = arr.filter(c =>
        (c.batch_no || "").toLowerCase().includes(q) ||
        (c.full_name || "").toLowerCase().includes(q) ||
        (c.payee_name || "").toLowerCase().includes(q) ||
        (c.supplier_invoice_no || "").toLowerCase().includes(q) ||
        (c.charge_to_code || "").toLowerCase().includes(q)
      );
    }
    return arr;
  }, [payments, filterStatus, filterPeriod, searchText]);

  const stats = useMemo(() => {
    const arr = payments || [];
    return {
      total: arr.length,
      pending: arr.filter(c => ["submitted", "team_head_approved"].includes(c.status)).length,
      approved: arr.filter(c => c.status === "approved").length,
      total_hkd: arr.reduce((s, c) => s + Number(c.total_hkd || 0), 0),
    };
  }, [payments]);

  // 已批核、未入 NetSuite 嘅批次 — Bills post 候選
  const readyBatches = useMemo(
    () => (payments || []).filter(c => c.status === "approved"),
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
        description: `新建 ${data.created} 張 bill · ${data.duplicates} 張已存在 · ${data.failed} 張失敗`,
        variant: data.failed > 0 ? "destructive" : undefined,
      });
      setSelectedIds(new Set());
      qc.invalidateQueries({ queryKey: ["payment-batches"] });
    } catch (err: any) {
      toast({ title: "入數失敗", description: err.message, variant: "destructive" });
    }
    setPosting(false);
  };

  const METHOD_LABELS: Record<string, string> = {
    bank_transfer: "銀行轉賬", fps: "FPS", cheque: "支票", autopay: "Autopay", other: "其他",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <HandCoins className="text-primary" size={24} />
            付款申請 Payment Requisition
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            申請付款俾 Supplier 供應商 / Freelancer 自由工作者 — 批核後入 NetSuite 做 Bills
          </p>
        </div>
        <Link href="/claims/new/payment">
          <Button data-testid="button-new-payment">
            <Plus size={16} className="mr-2" />
            新增 付款申請
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground">總單數</div>
          <div className="text-2xl font-bold tabular-nums mt-1">{stats.total}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground">待批核</div>
          <div className="text-2xl font-bold tabular-nums mt-1 text-amber-600 dark:text-amber-400">{stats.pending}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground">已批核 (未入數)</div>
          <div className="text-2xl font-bold tabular-nums mt-1 text-emerald-600 dark:text-emerald-400">{stats.approved}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground">總金額 (HKD)</div>
          <div className="text-2xl font-bold tabular-nums mt-1">
            ${stats.total_hkd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </div>
        </CardContent></Card>
      </div>

      {/* NetSuite Bills 入數 (owner/admin) */}
      {isSuperUser && readyBatches.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <UploadCloud size={15} className="text-primary" />
                入 NetSuite (Vendor Bills) — {readyBatches.length} 張已批核
              </CardTitle>
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
            {postResults.length > 0 && (
              <div className="border-t border-border/40 pt-2 space-y-1">
                {postResults.map((r, i) => (
                  <div key={i} className={`text-[11px] flex items-start gap-2 ${r.status === "error" ? "text-red-600 dark:text-red-400" : r.status === "created" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}`}>
                    <span className="font-mono">{r.batch_no}</span>
                    {r.status === "created" && <span>✓ Bill {r.netsuite_id} 已建立{r.vendor ? ` (${r.vendor})` : ""}</span>}
                    {r.status === "duplicate" && <span>已存在 NetSuite (跳過)</span>}
                    {r.status === "error" && <span>✗ {r.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <Card><CardContent className="p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <Filter size={16} className="text-muted-foreground" />
          <Input
            placeholder="搜尋 batch no / 申請人 / 收款人 / INV# ..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="max-w-xs"
            data-testid="input-search"
          />
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-[150px]" data-testid="select-status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部狀態</SelectItem>
              {Object.entries(STATUS_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filterPeriod} onValueChange={setFilterPeriod}>
            <SelectTrigger className="w-[140px]" data-testid="select-period"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部月份</SelectItem>
              {periods.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </CardContent></Card>

      {/* List */}
      <Card><CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">
            <HandCoins size={32} className="mx-auto opacity-40 mb-3" />
            <p className="text-sm">未有付款申請</p>
            <p className="text-xs mt-1">點擊右上方「新增 付款申請」</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/30 border-b border-border">
                <tr>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Batch No</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">收款人</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">Supplier INV#</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">申請人</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">Charge To</th>
                  <th className="text-right text-xs font-medium text-muted-foreground px-3 py-3">金額 (HKD)</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">到期日</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">狀態</th>
                  <th className="text-right text-xs font-medium text-muted-foreground px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => {
                  const status = STATUS_LABELS[c.status] || STATUS_LABELS.draft;
                  const StatusIcon = status.icon;
                  return (
                    <tr key={c.id} className="border-b border-border/40 hover:bg-muted/20" data-testid={`row-payment-${c.batch_no}`}>
                      <td className="px-4 py-3 text-sm font-mono">{c.batch_no || "—"}</td>
                      <td className="px-3 py-3 text-sm">
                        <div className="font-medium">{c.payee_name || "—"}</div>
                        <div className="text-xs text-muted-foreground">
                          {c.payee_type === "freelancer" ? "Freelancer" : c.payee_type === "supplier" ? "Supplier" : ""}
                          {c.payment_method ? ` · ${METHOD_LABELS[c.payment_method] || c.payment_method}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-xs font-mono">{c.supplier_invoice_no || "—"}</td>
                      <td className="px-3 py-3 text-sm">{c.nick_name || c.full_name || "—"}</td>
                      <td className="px-3 py-3 text-xs">
                        <div className="font-mono">{c.charge_to_code}</div>
                        {c.department_name && <div className="text-muted-foreground truncate max-w-[140px]">{c.department_name}</div>}
                      </td>
                      <td className="px-3 py-3 text-sm text-right tabular-nums font-medium">
                        ${Number(c.total_hkd || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-3 py-3 text-xs tabular-nums">{c.payment_due_date || "—"}</td>
                      <td className="px-3 py-3 text-xs">
                        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium ${status.color}`}>
                          <StatusIcon size={11} />
                          {status.label}
                        </span>
                        {c.netsuite_journal_no && (
                          <div className="text-[10px] text-muted-foreground font-mono mt-0.5">{c.netsuite_journal_no}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link href={`/claims/${c.id}`}>
                          <Button size="sm" variant="ghost" data-testid={`button-view-${c.batch_no}`}>
                            <Eye size={14} className="mr-1" />
                            查看
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent></Card>
    </div>
  );
}
