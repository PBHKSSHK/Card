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
  Send, Eye, Loader2, UploadCloud, Building2, UserRound, RefreshCw,
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
  invoice_date: string | null;
  invoice_amount: number | null;
  invoice_currency: string | null;
  is_prepayment: boolean;
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

export default function PaymentsPage() {
  const { isSuperUser } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterPayeeType, setFilterPayeeType] = useState<string>("all");
  const [filterPeriod, setFilterPeriod] = useState<string>("all");
  const [searchText, setSearchText] = useState("");
  const [syncingVendors, setSyncingVendors] = useState(false);

  // 同步 NetSuite vendor 名冊 (收款人揀選來源) — owner/admin only
  const handleSyncVendors = async () => {
    setSyncingVendors(true);
    try {
      const { data, error } = await supabase.functions.invoke("netsuite-sync-vendors", { body: {} });
      if (error) throw new Error(error.message || "Edge Function 呼叫失敗");
      if (data?.error) throw new Error(data.error);
      toast({ title: "Vendor 名冊已同步 ✓", description: `共 ${data.fetched} 個 active vendors，收起 ${data.deactivated} 個已停用` });
      qc.invalidateQueries({ queryKey: ["ns_vendor_directory"] });
    } catch (err: any) {
      toast({ title: "同步失敗", description: err.message, variant: "destructive" });
    }
    setSyncingVendors(false);
  };

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
    if (filterPayeeType !== "all") arr = arr.filter(c => (c.payee_type || "supplier") === filterPayeeType);
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
  }, [payments, filterStatus, filterPayeeType, filterPeriod, searchText]);

  const stats = useMemo(() => {
    const arr = payments || [];
    return {
      total: arr.length,
      pending: arr.filter(c => ["submitted", "team_head_approved"].includes(c.status)).length,
      approved: arr.filter(c => c.status === "approved").length,
      total_hkd: arr.reduce((s, c) => s + Number(c.total_hkd || 0), 0),
    };
  }, [payments]);

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
        <div className="flex items-center gap-2">
          {isSuperUser && (
            <Button variant="ghost" size="sm" onClick={handleSyncVendors} disabled={syncingVendors}
              title="由 NetSuite 更新收款人名冊 (供應商 + 自由工作者)" data-testid="button-sync-vendors">
              {syncingVendors ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1.5" />}
              同步 Vendors
            </Button>
          )}
          <Link href="/claims/new/payment_freelancer">
            <Button variant="outline" data-testid="button-new-payment-freelancer">
              <UserRound size={16} className="mr-2" />
              新增 自由工作者付款
            </Button>
          </Link>
          <Link href="/claims/new/payment_supplier">
            <Button data-testid="button-new-payment-supplier">
              <Building2 size={16} className="mr-2" />
              新增 供應商付款
            </Button>
          </Link>
        </div>
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

      {/* Bills 入數 / 預付款標記已搬去「付款申請 Export」頁 (/payments/export) */}

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
          <Select value={filterPayeeType} onValueChange={setFilterPayeeType}>
            <SelectTrigger className="w-[170px]" data-testid="select-payee-type"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部類型</SelectItem>
              <SelectItem value="supplier">Supplier 供應商</SelectItem>
              <SelectItem value="freelancer">Freelancer 自由工作者</SelectItem>
            </SelectContent>
          </Select>
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
                        <div className="font-medium">
                          {c.payee_name || "—"}
                          {c.is_prepayment && (
                            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-700 dark:text-purple-400 font-medium">預付</span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {c.payee_type === "freelancer" ? "Freelancer" : c.payee_type === "supplier" ? "Supplier" : ""}
                          {c.payment_method ? ` · ${METHOD_LABELS[c.payment_method] || c.payment_method}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-xs font-mono">
                        {c.supplier_invoice_no || "—"}
                        {c.invoice_date && <div className="text-muted-foreground">{c.invoice_date}</div>}
                      </td>
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
                        <Link href={`/payments/${c.id}`}>
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
