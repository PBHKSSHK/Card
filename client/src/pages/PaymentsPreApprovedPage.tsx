// PaymentsPreApprovedPage.tsx
// 已簽批付款 (Pre-approved Payment Requisition) 面板 — 老闆已經喺紙上簽名批准
// 嘅供應商 / 自由工作者付款：同事上載已簽名發票 + 跟付款申請版面入資料，
// 提交後唔經 app 審批，直接變 approved，Owner/Admin 喺「付款申請 Export」
// 入 NetSuite (Vendor Bills)。
// - List view: claim_type='payment' AND is_pre_approved=true
// - 新增 → /claims/new/payment_supplier_pre / payment_freelancer_pre (共用 NewClaimPage)
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { usePagination, PaginationFooter } from "@/components/PaginationFooter";
import {
  ShieldCheck, Filter, CheckCircle2, Clock, XCircle, FileCheck, Send, Eye,
  Building2, UserRound, FileDown,
} from "lucide-react";

const STATUS_LABELS: Record<string, { label: string; color: string; icon: any }> = {
  draft: { label: "草稿", color: "bg-muted text-muted-foreground", icon: Clock },
  submitted: { label: "已提交 (待自動批核)", color: "bg-blue-500/15 text-blue-700 dark:text-blue-400", icon: Send },
  team_head_approved: { label: "Team Head 已簽", color: "bg-amber-500/15 text-amber-700 dark:text-amber-400", icon: FileCheck },
  approved: { label: "已批核 · 待入 NetSuite", color: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", icon: CheckCircle2 },
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
  payment_due_date: string | null;
  supplier_invoice_no: string | null;
  invoice_date: string | null;
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

export default function PaymentsPreApprovedPage() {
  const { isSuperUser } = useAuth();
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterPayeeType, setFilterPayeeType] = useState<string>("all");
  const [filterPeriod, setFilterPeriod] = useState<string>("all");
  const [searchText, setSearchText] = useState("");

  const { data: payments, isLoading } = useQuery({
    queryKey: ["payment-batches-preapproved"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_batches")
        .select("*")
        .eq("claim_type", "payment")
        .eq("is_pre_approved", true)
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

  const pg = usePagination(filtered);

  const stats = useMemo(() => {
    const arr = payments || [];
    return {
      total: arr.length,
      ready: arr.filter(c => c.status === "approved").length,
      exported: arr.filter(c => c.status === "exported").length,
      total_hkd: arr.reduce((s, c) => s + Number(c.total_hkd || 0), 0),
    };
  }, [payments]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ShieldCheck className="text-emerald-600" size={24} />
            已簽批付款 Pre-approved Payments
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            老闆已喺紙上簽名批准嘅供應商 / 自由工作者付款 — 上載已簽名發票、跟付款申請版面入資料，提交後免審批直接批核，可即時入 NetSuite
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isSuperUser && (
            <Link href="/payments/export">
              <Button variant="ghost" size="sm" data-testid="button-goto-export">
                <FileDown size={16} className="mr-1.5" />
                付款申請 Export
              </Button>
            </Link>
          )}
          <Link href="/claims/new/payment_freelancer_pre">
            <Button variant="outline" data-testid="button-new-preapproved-freelancer">
              <UserRound size={16} className="mr-2" />
              新增 自由工作者付款 (已簽批)
            </Button>
          </Link>
          <Link href="/claims/new/payment_supplier_pre">
            <Button data-testid="button-new-preapproved-supplier">
              <Building2 size={16} className="mr-2" />
              新增 供應商付款 (已簽批)
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
          <div className="text-xs text-muted-foreground">待入 NetSuite</div>
          <div className="text-2xl font-bold tabular-nums mt-1 text-emerald-600 dark:text-emerald-400">{stats.ready}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground">已入 NetSuite</div>
          <div className="text-2xl font-bold tabular-nums mt-1 text-purple-600 dark:text-purple-400">{stats.exported}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground">總金額 (HKD)</div>
          <div className="text-2xl font-bold tabular-nums mt-1">
            ${stats.total_hkd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </div>
        </CardContent></Card>
      </div>

      {/* Filters */}
      <Card><CardContent className="p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <Filter size={16} className="text-muted-foreground" />
          <Input
            placeholder="搜尋 batch no / 收款人 / 發票號 / charge to..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="max-w-xs"
            data-testid="input-search"
          />
          <Select value={filterPayeeType} onValueChange={setFilterPayeeType}>
            <SelectTrigger className="w-[150px]" data-testid="select-payee-type"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部收款人類型</SelectItem>
              <SelectItem value="supplier">供應商</SelectItem>
              <SelectItem value="freelancer">自由工作者</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-[190px]" data-testid="select-status"><SelectValue /></SelectTrigger>
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
            <ShieldCheck size={32} className="mx-auto opacity-40 mb-3" />
            <p className="text-sm">未有已簽批付款紀錄</p>
            <p className="text-xs mt-1">點擊右上方按鈕新增</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/30 border-b border-border">
                <tr>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Batch No</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">收款人</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">發票</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">入單人</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">Charge To</th>
                  <th className="text-right text-xs font-medium text-muted-foreground px-3 py-3">金額 (HKD)</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">到期日</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">狀態</th>
                  <th className="text-right text-xs font-medium text-muted-foreground px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {pg.pageItems.map((c) => {
                  const status = STATUS_LABELS[c.status] || STATUS_LABELS.draft;
                  const StatusIcon = status.icon;
                  return (
                    <tr key={c.id} className="border-b border-border/40 hover:bg-muted/20" data-testid={`row-preapproved-${c.batch_no}`}>
                      <td className="px-4 py-3 text-sm font-mono">{c.batch_no || "—"}</td>
                      <td className="px-3 py-3 text-sm">
                        <div className="font-medium flex items-center gap-1.5">
                          {c.payee_type === "freelancer"
                            ? <UserRound size={13} className="text-primary shrink-0" />
                            : <Building2 size={13} className="text-primary shrink-0" />}
                          {c.payee_name || "—"}
                          {c.is_prepayment && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-700 dark:text-purple-400 font-medium">預付</span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {c.payee_type === "freelancer" ? "自由工作者" : "供應商"}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-xs">
                        <div className="font-mono">{c.supplier_invoice_no || "—"}</div>
                        {c.invoice_date && <div className="text-muted-foreground tabular-nums">{c.invoice_date}</div>}
                      </td>
                      <td className="px-3 py-3 text-sm">{c.nick_name || c.full_name || "—"}</td>
                      <td className="px-3 py-3 text-xs">
                        <div className="font-mono">{c.charge_to_code}</div>
                        {c.department_name && <div className="text-muted-foreground truncate max-w-[160px]">{c.department_name}</div>}
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
            <div className="px-4 pb-3">
              <PaginationFooter {...pg.footerProps} />
            </div>
          </div>
        )}
      </CardContent></Card>
    </div>
  );
}
