// ClaimsPage.tsx
// Claim Form 系統總入口
// - List view: 顯示用戶權限內的 claim batches
// - Filter: status / claim_type / period
// - New buttons: → /claims/new/expenses + /claims/new/transportation
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
  Receipt, Car, Plus, Filter, Calendar, User, CheckCircle2,
  Clock, XCircle, FileCheck, Send, Eye,
} from "lucide-react";

const STATUS_LABELS: Record<string, { label: string; color: string; icon: any }> = {
  draft: { label: "草稿", color: "bg-muted text-muted-foreground", icon: Clock },
  submitted: { label: "已提交", color: "bg-blue-500/15 text-blue-700 dark:text-blue-400", icon: Send },
  team_head_approved: { label: "Team Head 已簽", color: "bg-amber-500/15 text-amber-700 dark:text-amber-400", icon: FileCheck },
  approved: { label: "已批核", color: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", icon: CheckCircle2 },
  exported: { label: "已出 Journal", color: "bg-purple-500/15 text-purple-700 dark:text-purple-400", icon: FileCheck },
  rejected: { label: "已退回", color: "bg-red-500/15 text-red-700 dark:text-red-400", icon: XCircle },
};

interface ClaimBatch {
  id: string;
  batch_no: string;
  claim_type: "expenses" | "transportation" | "payment";
  claimant_user_id: string;
  payee_name: string | null;
  full_name: string | null;
  nick_name: string | null;
  department: string | null;
  submit_date: string | null;
  period_month: string | null;
  charge_to_code: string;
  entity_code: string | null;
  subsidiary_full_name: string | null;
  department_name: string | null;
  status: string;
  total_hkd: number;
  line_count: number;
  netsuite_journal_no: string | null;
  created_at: string;
}

export default function ClaimsPage() {
  const { profile } = useAuth();
  const [filterType, setFilterType] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterPeriod, setFilterPeriod] = useState<string>("all");
  const [searchText, setSearchText] = useState("");

  const { data: claims, isLoading } = useQuery({
    queryKey: ["claim-batches"],
    queryFn: async () => {
      // 付款申請有自己嘅面板 (/payments) — 呢度只顯示日常駛費 + 交通費
      const { data, error } = await supabase
        .from("claim_batches")
        .select("*")
        .neq("claim_type", "payment")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []) as ClaimBatch[];
    },
  });

  const periods = useMemo(() => {
    const s = new Set<string>();
    for (const c of claims || []) {
      if (c.period_month) s.add(c.period_month);
    }
    return Array.from(s).sort().reverse();
  }, [claims]);

  const filtered = useMemo(() => {
    let arr = claims || [];
    if (filterType !== "all") arr = arr.filter(c => c.claim_type === filterType);
    if (filterStatus !== "all") arr = arr.filter(c => c.status === filterStatus);
    if (filterPeriod !== "all") arr = arr.filter(c => c.period_month === filterPeriod);
    if (searchText) {
      const q = searchText.toLowerCase();
      arr = arr.filter(c =>
        (c.batch_no || "").toLowerCase().includes(q) ||
        (c.full_name || "").toLowerCase().includes(q) ||
        (c.nick_name || "").toLowerCase().includes(q) ||
        (c.charge_to_code || "").toLowerCase().includes(q)
      );
    }
    return arr;
  }, [claims, filterType, filterStatus, filterPeriod, searchText]);

  const pg = usePagination(filtered);

  const stats = useMemo(() => {
    const arr = claims || [];
    return {
      total: arr.length,
      pending: arr.filter(c => ["submitted", "team_head_approved"].includes(c.status)).length,
      approved: arr.filter(c => c.status === "approved").length,
      total_hkd: arr.reduce((s, c) => s + Number(c.total_hkd || 0), 0),
    };
  }, [claims]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Claim Forms</h1>
          <p className="text-sm text-muted-foreground mt-1">日常駛費 + 交通費用申報</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/claims/new/transportation">
            <Button variant="outline" data-testid="button-new-transport">
              <Car size={16} className="mr-2" />
              新增 交通費
            </Button>
          </Link>
          <Link href="/claims/new/expenses">
            <Button data-testid="button-new-expenses">
              <Plus size={16} className="mr-2" />
              新增 日常駛費
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
          <div className="text-xs text-muted-foreground">已批核</div>
          <div className="text-2xl font-bold tabular-nums mt-1 text-emerald-600 dark:text-emerald-400">{stats.approved}</div>
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
            placeholder="搜尋 batch no / 姓名 / charge to..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="max-w-xs"
            data-testid="input-search"
          />
          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger className="w-[140px]" data-testid="select-type"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部類型</SelectItem>
              <SelectItem value="expenses">日常駛費</SelectItem>
              <SelectItem value="transportation">交通費用</SelectItem>
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
            <Receipt size={32} className="mx-auto opacity-40 mb-3" />
            <p className="text-sm">未有 claim 紀錄</p>
            <p className="text-xs mt-1">點擊右上方按鈕新增</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/30 border-b border-border">
                <tr>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Batch No</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">類型</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">申請人</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">Charge To</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">期間</th>
                  <th className="text-right text-xs font-medium text-muted-foreground px-3 py-3">金額 (HKD)</th>
                  <th className="text-center text-xs font-medium text-muted-foreground px-3 py-3">行數</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">狀態</th>
                  <th className="text-right text-xs font-medium text-muted-foreground px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {pg.pageItems.map((c) => {
                  const status = STATUS_LABELS[c.status] || STATUS_LABELS.draft;
                  const StatusIcon = status.icon;
                  return (
                    <tr key={c.id} className="border-b border-border/40 hover:bg-muted/20" data-testid={`row-claim-${c.batch_no}`}>
                      <td className="px-4 py-3 text-sm font-mono">{c.batch_no || "—"}</td>
                      <td className="px-3 py-3 text-sm">
                        {c.claim_type === "expenses" ? (
                          <span className="inline-flex items-center gap-1.5 text-xs">
                            <Receipt size={14} className="text-primary" /> 日常駛費
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs">
                            <Car size={14} className="text-primary" /> 交通費
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-sm">
                        <div>{c.nick_name || c.full_name || "—"}</div>
                        {c.department && <div className="text-xs text-muted-foreground">{c.department}</div>}
                      </td>
                      <td className="px-3 py-3 text-xs">
                        <div className="font-mono">{c.charge_to_code}</div>
                        {c.department_name && <div className="text-muted-foreground truncate max-w-[160px]">{c.department_name}</div>}
                      </td>
                      <td className="px-3 py-3 text-sm tabular-nums">{c.period_month || "—"}</td>
                      <td className="px-3 py-3 text-sm text-right tabular-nums font-medium">
                        ${Number(c.total_hkd || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-3 py-3 text-sm text-center tabular-nums">{c.line_count || 0}</td>
                      <td className="px-3 py-3 text-xs">
                        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium ${status.color}`}>
                          <StatusIcon size={11} />
                          {status.label}
                        </span>
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
            <div className="px-4 pb-3">
              <PaginationFooter {...pg.footerProps} />
            </div>
          </div>
        )}
      </CardContent></Card>
    </div>
  );
}
