// ProjectCodesPage.tsx
// Project Code Register — sales 自助取 project code。
//   取 Code   : 揀公司 + 性質 → 按性質規則填資料 → 系統出 code（同時寫入 ns_project_codes，
//               claims / 付款申請 / recon 嘅 picker 即刻用得）+ email 通知會計
//   項目清單   : 狀態 (Active / Expiring / Completed / Closed / Cancelled)，Retainer 續約 (Renew)
//   違規       : (owner/admin) Xero invoice / bill 用錯 code 嘅清單
//   設定       : (owner/admin) 通知 email、性質規則、公司規則、Xero 連線
// 所有寫入經 Supabase RPC (security definer)，規則喺 DB 驗證，前端只係提示。
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FolderKanban, Plus, Copy, CheckCircle2, RefreshCw, AlertTriangle, Settings2, Link2, Mail, Search,
  Repeat, Ban, Archive, RotateCcw, Pencil, ExternalLink,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Company {
  entity_code: string; code_letters: string; charge_to: string; legal_name: string;
  xero_tenant_id: string | null; is_active: boolean; sort_order: number;
  require_code_invoice: boolean; require_code_bill: boolean;
}
interface TypeRule {
  type_code: string; name_zh: string; name_en: string; description: string | null;
  requires_quote: boolean; requires_amount: boolean; requires_end_date: boolean;
  requires_monthly_fee: boolean; period_suffix: boolean; max_months: number | null;
  expiring_days: number; close_after_days: number; admin_only: boolean; is_active: boolean; sort_order: number;
}
interface Project {
  id: string; code: string; entity_code: string; type_code: string; stem: string; period_suffix: string | null;
  title: string; customer_name: string; quote_no: string | null; quoted_amount: number | null; monthly_fee: number | null;
  start_date: string; end_date: string | null; status: ProjectStatus; status_reason: string | null;
  parent_id: string | null; sales_user_id: string | null; sales_name: string; sales_email: string | null;
  notes: string | null; created_at: string; closed_at: string | null;
}
type ProjectStatus = "Active" | "Expiring" | "Completed" | "Closed" | "Cancelled";
interface Violation {
  id: number; entity_code: string | null; doc_type: string; doc_number: string | null; reference: string | null;
  contact_name: string | null; doc_date: string | null; total: number | null; doc_status: string | null;
  codes_found: string[] | null; rule: string; message: string; xero_url: string | null;
  first_seen: string; last_seen: string; resolved_at: string | null;
}

const STATUS_STYLE: Record<ProjectStatus, { label: string; cls: string }> = {
  Active: { label: "Active 進行中", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  Expiring: { label: "Expiring 即將完結", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  Completed: { label: "Completed 已完成", cls: "bg-blue-500/15 text-blue-700 dark:text-blue-400" },
  Closed: { label: "Closed 已關閉", cls: "bg-muted text-muted-foreground" },
  Cancelled: { label: "Cancelled 已取消", cls: "bg-red-500/15 text-red-700 dark:text-red-400" },
};
const RULE_LABEL: Record<string, string> = {
  missing: "冇 code", unknown: "code 唔存在", closed: "code 已關閉", outside_period: "超出合約期",
  wrong_company: "公司唔啱", multiple: "多過一個 code",
};

const money = (n: number | null | undefined) =>
  n == null ? "—" : "HK$" + Number(n).toLocaleString("en-HK", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const errMsg = (e: any) => String(e?.message || e).replace(/^.*?ERROR:\s*/, "");

function StatusBadge({ s }: { s: ProjectStatus }) {
  const st = STATUS_STYLE[s];
  return <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${st.cls}`}>{st.label}</span>;
}

// 送出排隊中嘅 email（失敗唔影響 UI；cron 每 10 分鐘會補送）
async function flushEmails() {
  try { await supabase.functions.invoke("project-code-notify", { body: {} }); } catch { /* cron will retry */ }
}

// ---------------------------------------------------------------------------
// Shared data
// ---------------------------------------------------------------------------
function useRefData() {
  const companies = useQuery({
    queryKey: ["project_companies"],
    queryFn: async () => {
      const { data, error } = await supabase.from("project_companies").select("*").order("sort_order");
      if (error) throw error;
      return data as Company[];
    },
  });
  const rules = useQuery({
    queryKey: ["project_type_rules"],
    queryFn: async () => {
      const { data, error } = await supabase.from("project_type_rules").select("*").order("sort_order");
      if (error) throw error;
      return data as TypeRule[];
    },
  });
  return { companies: companies.data || [], rules: rules.data || [], loading: companies.isLoading || rules.isLoading };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function ProjectCodesPage() {
  const { isSuperUser } = useAuth();
  const initialTab = useMemo(() => {
    const q = new URLSearchParams(window.location.hash.split("?")[1] || "");
    return q.get("tab") || "new";
  }, []);
  const [tab, setTab] = useState(initialTab);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <FolderKanban size={20} />
        <h1 className="text-lg font-semibold">Project Codes</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        所有 invoice、bill、報銷、付款申請都要用同一個 project code。Code 只可以喺呢度取；已關閉嘅 code 系統會拒絕。
      </p>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="new"><Plus size={14} className="mr-1.5" /> 取 Code</TabsTrigger>
          <TabsTrigger value="list"><FolderKanban size={14} className="mr-1.5" /> 項目清單</TabsTrigger>
          {isSuperUser && <TabsTrigger value="violations"><AlertTriangle size={14} className="mr-1.5" /> 違規</TabsTrigger>}
          {isSuperUser && <TabsTrigger value="settings"><Settings2 size={14} className="mr-1.5" /> 設定</TabsTrigger>}
        </TabsList>
        <TabsContent value="new"><NewProjectTab onDone={() => setTab("list")} /></TabsContent>
        <TabsContent value="list"><ProjectListTab /></TabsContent>
        {isSuperUser && <TabsContent value="violations"><ViolationsTab /></TabsContent>}
        {isSuperUser && <TabsContent value="settings"><SettingsTab /></TabsContent>}
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 取 Code
// ---------------------------------------------------------------------------
interface FormState {
  entity: string; type: string; title: string; customer: string; quote: string;
  amount: string; monthly: string; start: string; end: string; sales: string; notes: string;
}

function ruleHints(r: TypeRule | undefined): string[] {
  if (!r) return [];
  const h: string[] = [];
  if (r.requires_quote) h.push("要有客人接受咗嘅 Xero quote 號");
  if (r.requires_amount) h.push("要填報價金額");
  if (r.requires_monthly_fee) h.push("要填每月收費");
  if (r.requires_end_date) h.push("要填完結日期");
  if (r.max_months) h.push(`一個 code 最長 ${r.max_months} 個月`);
  if (r.period_suffix) h.push("code 尾有合約完結年；續約按 Renew 出新 code");
  h.push(`完結前 ${r.expiring_days} 日 email 提醒；完結後 ${r.close_after_days} 日自動關閉`);
  if (r.admin_only) h.push("只限會計／admin 開");
  return h;
}

function NewProjectTab({ onDone }: { onDone: () => void }) {
  const { profile, isSuperUser } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { companies, rules, loading } = useRefData();
  const [created, setCreated] = useState<Project | null>(null);

  const allowedCompanies = companies.filter(c => c.is_active &&
    (isSuperUser || (profile?.entity_scope || []).includes(c.entity_code)));
  const allowedRules = rules.filter(r => r.is_active && (!r.admin_only || isSuperUser));

  const [f, setF] = useState<FormState>({
    entity: "", type: "C", title: "", customer: "", quote: "", amount: "", monthly: "",
    start: today(), end: "", sales: "", notes: "",
  });
  useEffect(() => {
    if (!f.entity && allowedCompanies.length === 1) setF(s => ({ ...s, entity: allowedCompanies[0].entity_code }));
  }, [allowedCompanies.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!f.sales && profile) setF(s => ({ ...s, sales: profile.full_name || "" }));
  }, [profile]); // eslint-disable-line react-hooks/exhaustive-deps

  const rule = rules.find(r => r.type_code === f.type);
  const comp = companies.find(c => c.entity_code === f.entity);
  const preview = comp && rule
    ? `P${new Date().getFullYear().toString().slice(2)}${comp.code_letters}-${rule.type_code}####${rule.period_suffix && f.end ? "-" + f.end.slice(2, 4) : ""}`
    : "—";

  const set = (k: keyof FormState) => (e: any) => setF(s => ({ ...s, [k]: e?.target ? e.target.value : e }));

  const create = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("project_register_create", {
        p_entity: f.entity, p_type: f.type, p_title: f.title, p_customer: f.customer,
        p_quote_no: f.quote || null,
        p_quoted_amount: f.amount ? Number(f.amount) : null,
        p_monthly_fee: f.monthly ? Number(f.monthly) : null,
        p_start: f.start || null, p_end: f.end || null,
        p_sales_name: f.sales || null, p_notes: f.notes || null,
      });
      if (error) throw error;
      return data as Project;
    },
    onSuccess: (p) => {
      setCreated(p);
      qc.invalidateQueries({ queryKey: ["project_register"] });
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] || "").startsWith("ns_project_codes") });
      flushEmails();
    },
    onError: (e) => toast({ title: "未能開 code", description: errMsg(e), variant: "destructive" }),
  });

  if (loading) return <Skeleton className="h-64 w-full" />;
  if (allowedCompanies.length === 0) {
    return <Card><CardContent className="p-8 text-center text-muted-foreground">你未有任何公司嘅權限，請聯絡 admin（Settings → Users → Entity scope）。</CardContent></Card>;
  }

  if (created) {
    const ref = `${created.code} / ${created.sales_name}`;
    return (
      <Card className="max-w-2xl">
        <CardContent className="p-6 space-y-4">
          <div className="flex items-center gap-2 text-emerald-600"><CheckCircle2 size={20} /> 已開 project code</div>
          <div className="text-3xl font-bold tracking-wider font-mono" data-testid="text-new-code">{created.code}</div>
          <div className="text-sm space-y-1">
            <div>{created.title} · {created.customer_name}</div>
            <div className="text-muted-foreground">{created.start_date} 至 {created.end_date || "—"} · <StatusBadge s={created.status} /></div>
          </div>
          <div className="rounded-md bg-muted p-3 text-sm">
            <div className="text-muted-foreground text-xs mb-1">Xero invoice / bill 嘅 Reference 請寫：</div>
            <div className="font-mono">{ref}</div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" onClick={() => { navigator.clipboard.writeText(created.code); toast({ title: "已複製 code" }); }}>
              <Copy size={14} className="mr-1.5" /> 複製 code
            </Button>
            <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(ref); toast({ title: "已複製 Reference" }); }}>
              <Copy size={14} className="mr-1.5" /> 複製 Reference
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setCreated(null); setF(s => ({ ...s, title: "", customer: "", quote: "", amount: "", monthly: "", end: "", notes: "" })); }}>
              <Plus size={14} className="mr-1.5" /> 再開一個
            </Button>
            <Button size="sm" variant="ghost" onClick={onDone}>去項目清單</Button>
          </div>
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Mail size={12} /> 已 email 通知會計同你自己。</p>
        </CardContent>
      </Card>
    );
  }

  const req = (on: boolean | undefined) => (on ? <span className="text-red-500"> *</span> : null);

  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">取新 project code</CardTitle>
          <CardDescription>客人接受報價之後先取 code。續約唔好喺度開，去「項目清單」按 Renew。</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid sm:grid-cols-2 gap-4"
            onSubmit={(e) => { e.preventDefault(); create.mutate(); }}
          >
            <div className="space-y-1.5">
              <Label>公司{req(true)}</Label>
              <Select value={f.entity} onValueChange={set("entity")}>
                <SelectTrigger data-testid="select-entity"><SelectValue placeholder="揀公司" /></SelectTrigger>
                <SelectContent>
                  {allowedCompanies.map(c => <SelectItem key={c.entity_code} value={c.entity_code}>{c.code_letters} · {c.legal_name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Project 性質{req(true)}</Label>
              <Select value={f.type} onValueChange={set("type")}>
                <SelectTrigger data-testid="select-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {allowedRules.map(r => <SelectItem key={r.type_code} value={r.type_code}>{r.type_code} · {r.name_zh}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>項目名稱{req(true)}</Label>
              <Input value={f.title} onChange={set("title")} placeholder="例：HK Express Winter Campaign 2026" data-testid="input-title" />
            </div>
            <div className="space-y-1.5">
              <Label>客戶（同 Xero contact 名一樣）{req(true)}</Label>
              <Input value={f.customer} onChange={set("customer")} data-testid="input-customer" />
            </div>
            <div className="space-y-1.5">
              <Label>Xero quote 號{req(rule?.requires_quote)}</Label>
              <Input value={f.quote} onChange={set("quote")} placeholder="QU26SS-0015" data-testid="input-quote" />
            </div>
            <div className="space-y-1.5">
              <Label>報價金額 (HKD){req(rule?.requires_amount)}</Label>
              <Input type="number" min="0" step="0.01" value={f.amount} onChange={set("amount")} data-testid="input-amount" />
            </div>
            {rule?.requires_monthly_fee && (
              <div className="space-y-1.5">
                <Label>每月收費 (HKD){req(true)}</Label>
                <Input type="number" min="0" step="0.01" value={f.monthly} onChange={set("monthly")} data-testid="input-monthly" />
              </div>
            )}
            <div className="space-y-1.5">
              <Label>開始日期{req(true)}</Label>
              <Input type="date" value={f.start} onChange={set("start")} data-testid="input-start" />
            </div>
            <div className="space-y-1.5">
              <Label>{f.type === "R" ? "合約完結日" : f.type === "E" ? "活動最後一日" : "預計完成日"}{req(rule?.requires_end_date)}</Label>
              <Input type="date" value={f.end} onChange={set("end")} data-testid="input-end" />
            </div>
            <div className="space-y-1.5">
              <Label>Sales 全名</Label>
              <Input value={f.sales} onChange={set("sales")} placeholder="例：Lung Yuen Ki Fornia" data-testid="input-sales" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>備註</Label>
              <Textarea rows={2} value={f.notes} onChange={set("notes")} />
            </div>
            <div className="sm:col-span-2 flex items-center justify-between gap-2 flex-wrap">
              <div className="text-sm text-muted-foreground">Code 預覽：<span className="font-mono">{preview}</span></div>
              <Button type="submit" disabled={create.isPending || !f.entity} data-testid="button-create-code">
                {create.isPending ? "處理中…" : "取 project code"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{rule ? `${rule.type_code} · ${rule.name_zh}` : "性質規則"}</CardTitle>
          {rule?.description && <CardDescription>{rule.description}</CardDescription>}
        </CardHeader>
        <CardContent>
          <ul className="text-sm space-y-1.5 list-disc pl-4">
            {ruleHints(rule).map(h => <li key={h}>{h}</li>)}
          </ul>
          <div className="mt-4 text-xs text-muted-foreground space-y-1">
            <div>格式：P + 年 + 公司碼 - 性質 + 流水號</div>
            <div>例：P26SS-C0012、P26SS-R0003-27</div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 項目清單
// ---------------------------------------------------------------------------
function ProjectListTab() {
  const { profile, isSuperUser, user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { companies, rules } = useRefData();
  const [entity, setEntity] = useState("all");
  const [status, setStatus] = useState("open");
  const [type, setType] = useState("all");
  const [mine, setMine] = useState(!isSuperUser);
  const [q, setQ] = useState("");
  const [renewOf, setRenewOf] = useState<Project | null>(null);
  const [editOf, setEditOf] = useState<Project | null>(null);
  const [statusOf, setStatusOf] = useState<{ p: Project; to: ProjectStatus } | null>(null);
  const [detailOf, setDetailOf] = useState<Project | null>(null);

  const { data: projects, isLoading, refetch } = useQuery({
    queryKey: ["project_register"],
    queryFn: async () => {
      const { data, error } = await supabase.from("project_register").select("*").order("created_at", { ascending: false }).limit(2000);
      if (error) throw error;
      return data as Project[];
    },
  });
  const childOf = useMemo(() => {
    const m = new Set<string>();
    (projects || []).forEach(p => { if (p.parent_id && p.status !== "Cancelled") m.add(p.parent_id); });
    return m;
  }, [projects]);

  const rows = (projects || []).filter(p =>
    (entity === "all" || p.entity_code === entity) &&
    (type === "all" || p.type_code === type) &&
    (status === "all" || (status === "open" ? ["Active", "Expiring", "Completed"].includes(p.status) : p.status === status)) &&
    (!mine || p.sales_user_id === user?.id) &&
    (!q || `${p.code} ${p.title} ${p.customer_name} ${p.quote_no || ""} ${p.sales_name}`.toLowerCase().includes(q.toLowerCase())));

  const ruleOf = (t: string) => rules.find(r => r.type_code === t);
  const compOf = (e: string) => companies.find(c => c.entity_code === e);

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-3 flex flex-wrap gap-2 items-center">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-2.5 text-muted-foreground" />
            <Input className="pl-8 w-56" placeholder="搵 code / 名稱 / 客戶 / quote" value={q} onChange={e => setQ(e.target.value)} data-testid="input-search" />
          </div>
          <Select value={entity} onValueChange={setEntity}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部公司</SelectItem>
              {companies.map(c => <SelectItem key={c.entity_code} value={c.entity_code}>{c.code_letters}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部性質</SelectItem>
              {rules.map(r => <SelectItem key={r.type_code} value={r.type_code}>{r.type_code} · {r.name_zh}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="open">未關閉</SelectItem>
              <SelectItem value="all">全部狀態</SelectItem>
              {(Object.keys(STATUS_STYLE) as ProjectStatus[]).map(s => <SelectItem key={s} value={s}>{STATUS_STYLE[s].label}</SelectItem>)}
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2 text-sm"><Switch checked={mine} onCheckedChange={setMine} /> 只睇我嘅</label>
          <Button size="sm" variant="ghost" onClick={() => refetch()}><RefreshCw size={14} /></Button>
          <span className="text-xs text-muted-foreground ml-auto">{rows.length} 個項目</span>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? <Skeleton className="h-40 m-4" /> : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="text-left p-2">Code</th><th className="text-left p-2">項目 / 客戶</th>
                  <th className="text-left p-2">性質</th><th className="text-left p-2">期間</th>
                  <th className="text-right p-2">報價</th><th className="text-left p-2">狀態</th>
                  <th className="text-left p-2">Sales</th><th className="text-right p-2">動作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(p => {
                  const r = ruleOf(p.type_code);
                  const mineRow = p.sales_user_id === user?.id;
                  const canRenew = r?.period_suffix && ["Active", "Expiring", "Completed", "Closed"].includes(p.status) && !childOf.has(p.id) && (isSuperUser || mineRow);
                  return (
                    <tr key={p.id} className="border-t hover:bg-muted/30" data-testid={`row-project-${p.code}`}>
                      <td className="p-2 font-mono whitespace-nowrap">
                        <button className="hover:underline" onClick={() => setDetailOf(p)}>{p.code}</button>
                        <button className="ml-1 text-muted-foreground hover:text-foreground" title="複製"
                          onClick={() => { navigator.clipboard.writeText(p.code); toast({ title: `已複製 ${p.code}` }); }}><Copy size={12} /></button>
                      </td>
                      <td className="p-2"><div>{p.title}</div><div className="text-xs text-muted-foreground">{p.customer_name}{p.quote_no ? ` · ${p.quote_no}` : ""}</div></td>
                      <td className="p-2 whitespace-nowrap">{compOf(p.entity_code)?.code_letters} · {r?.name_zh || p.type_code}</td>
                      <td className="p-2 whitespace-nowrap text-xs">{p.start_date}<br />{p.end_date || "—"}</td>
                      <td className="p-2 text-right whitespace-nowrap">{money(p.quoted_amount)}{p.monthly_fee ? <div className="text-xs text-muted-foreground">{money(p.monthly_fee)}/月</div> : null}</td>
                      <td className="p-2"><StatusBadge s={p.status} /></td>
                      <td className="p-2 text-xs">{p.sales_name}</td>
                      <td className="p-2 text-right whitespace-nowrap space-x-1">
                        {canRenew && <Button size="sm" variant="outline" onClick={() => setRenewOf(p)} data-testid={`button-renew-${p.code}`}><Repeat size={13} className="mr-1" />Renew</Button>}
                        {mineRow && !isSuperUser && ["Active", "Expiring"].includes(p.status) && (
                          <Button size="sm" variant="ghost" onClick={() => setStatusOf({ p, to: "Completed" })}>完成</Button>
                        )}
                        {isSuperUser && (
                          <>
                            <Button size="icon" variant="ghost" title="修改" onClick={() => setEditOf(p)}><Pencil size={14} /></Button>
                            {["Active", "Expiring"].includes(p.status) && <Button size="icon" variant="ghost" title="標記完成" onClick={() => setStatusOf({ p, to: "Completed" })}><CheckCircle2 size={14} /></Button>}
                            {!["Closed", "Cancelled"].includes(p.status) && <Button size="icon" variant="ghost" title="關閉" onClick={() => setStatusOf({ p, to: "Closed" })}><Archive size={14} /></Button>}
                            {!["Cancelled"].includes(p.status) && <Button size="icon" variant="ghost" title="取消" onClick={() => setStatusOf({ p, to: "Cancelled" })}><Ban size={14} /></Button>}
                            {["Closed", "Cancelled", "Completed"].includes(p.status) && <Button size="icon" variant="ghost" title="重開" onClick={() => setStatusOf({ p, to: "Active" })}><RotateCcw size={14} /></Button>}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">冇項目</td></tr>}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {renewOf && <RenewDialog parent={renewOf} rule={ruleOf(renewOf.type_code)} onClose={() => setRenewOf(null)} />}
      {editOf && <EditDialog p={editOf} onClose={() => setEditOf(null)} />}
      {statusOf && <StatusDialog p={statusOf.p} to={statusOf.to} onClose={() => setStatusOf(null)} />}
      {detailOf && <DetailDialog p={detailOf} onClose={() => setDetailOf(null)} />}
    </div>
  );
}

function RenewDialog({ parent, rule, onClose }: { parent: Project; rule?: TypeRule; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const nextStart = parent.end_date
    ? new Date(new Date(parent.end_date).getTime() + 86400000).toISOString().slice(0, 10) : today();
  const [f, setF] = useState({ quote: "", amount: String(parent.quoted_amount ?? ""), monthly: String(parent.monthly_fee ?? ""), start: nextStart, end: "", notes: "" });
  const m = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("project_register_renew", {
        p_parent: parent.id, p_quote_no: f.quote || null,
        p_quoted_amount: f.amount ? Number(f.amount) : null, p_monthly_fee: f.monthly ? Number(f.monthly) : null,
        p_start: f.start, p_end: f.end || null, p_notes: f.notes || null,
      });
      if (error) throw error;
      return data as Project;
    },
    onSuccess: (p) => {
      toast({ title: `已續約：${p.code}`, description: "已 email 通知會計" });
      navigator.clipboard?.writeText(p.code).catch(() => null);
      qc.invalidateQueries({ queryKey: ["project_register"] });
      flushEmails();
      onClose();
    },
    onError: (e) => toast({ title: "未能續約", description: errMsg(e), variant: "destructive" }),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>續約 {parent.code}</DialogTitle>
          <DialogDescription>新一期會用 {parent.stem}-YY（YY = 新合約完結年）。要有新一期嘅 Xero quote。</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1"><Label>新 Xero quote 號{rule?.requires_quote ? " *" : ""}</Label><Input value={f.quote} onChange={e => setF({ ...f, quote: e.target.value })} /></div>
          <div className="space-y-1"><Label>報價金額</Label><Input type="number" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></div>
          <div className="space-y-1"><Label>每月收費</Label><Input type="number" value={f.monthly} onChange={e => setF({ ...f, monthly: e.target.value })} /></div>
          <div className="space-y-1"><Label>開始日期</Label><Input type="date" value={f.start} onChange={e => setF({ ...f, start: e.target.value })} /></div>
          <div className="space-y-1"><Label>完結日期 *</Label><Input type="date" value={f.end} onChange={e => setF({ ...f, end: e.target.value })} /></div>
          <div className="col-span-2 space-y-1"><Label>備註</Label><Textarea rows={2} value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? "處理中…" : "出新一期 code"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ p, onClose }: { p: Project; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({
    title: p.title, customer: p.customer_name, quote: p.quote_no || "", amount: String(p.quoted_amount ?? ""),
    monthly: String(p.monthly_fee ?? ""), start: p.start_date, end: p.end_date || "", notes: p.notes || "",
  });
  const m = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("project_register_update", {
        p_id: p.id, p_title: f.title, p_customer: f.customer, p_quote_no: f.quote || null,
        p_quoted_amount: f.amount ? Number(f.amount) : null, p_monthly_fee: f.monthly ? Number(f.monthly) : null,
        p_start: f.start, p_end: f.end || null, p_notes: f.notes || null,
      });
      if (error) throw error;
    },
    onSuccess: () => { toast({ title: "已更新" }); qc.invalidateQueries({ queryKey: ["project_register"] }); onClose(); },
    onError: (e) => toast({ title: "未能更新", description: errMsg(e), variant: "destructive" }),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>修改 {p.code}</DialogTitle><DialogDescription>Code 本身唔會變。</DialogDescription></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1"><Label>項目名稱</Label><Input value={f.title} onChange={e => setF({ ...f, title: e.target.value })} /></div>
          <div className="space-y-1"><Label>客戶</Label><Input value={f.customer} onChange={e => setF({ ...f, customer: e.target.value })} /></div>
          <div className="space-y-1"><Label>Quote 號</Label><Input value={f.quote} onChange={e => setF({ ...f, quote: e.target.value })} /></div>
          <div className="space-y-1"><Label>報價金額</Label><Input type="number" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></div>
          <div className="space-y-1"><Label>每月收費</Label><Input type="number" value={f.monthly} onChange={e => setF({ ...f, monthly: e.target.value })} /></div>
          <div className="space-y-1"><Label>開始日期</Label><Input type="date" value={f.start} onChange={e => setF({ ...f, start: e.target.value })} /></div>
          <div className="space-y-1"><Label>完結日期</Label><Input type="date" value={f.end} onChange={e => setF({ ...f, end: e.target.value })} /></div>
          <div className="col-span-2 space-y-1"><Label>備註</Label><Textarea rows={2} value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>儲存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusDialog({ p, to, onClose }: { p: Project; to: ProjectStatus; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("project_register_set_status", { p_id: p.id, p_status: to, p_reason: reason || null });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: `${p.code} → ${STATUS_STYLE[to].label}` });
      qc.invalidateQueries({ queryKey: ["project_register"] });
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] || "").startsWith("ns_project_codes") });
      onClose();
    },
    onError: (e) => toast({ title: "未能更改", description: errMsg(e), variant: "destructive" }),
  });
  const note = to === "Closed" || to === "Cancelled"
    ? "之後報銷、付款申請、card recon 都唔可以再用呢個 code；Xero 再有新單會列入違規。"
    : to === "Completed" ? "標記完成後，收尾期過咗系統會自動關閉。" : "重開後可以再用。";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{p.code} 改為 {STATUS_STYLE[to].label}</DialogTitle><DialogDescription>{note}</DialogDescription></DialogHeader>
        <div className="space-y-1"><Label>原因{to === "Cancelled" ? " *" : ""}</Label><Textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} /></div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>返回</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending} variant={to === "Cancelled" ? "destructive" : "default"}>確定</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetailDialog({ p, onClose }: { p: Project; onClose: () => void }) {
  const { data: events } = useQuery({
    queryKey: ["project_events", p.id],
    queryFn: async () => {
      const { data, error } = await supabase.from("project_events").select("*").eq("project_id", p.id).order("created_at");
      if (error) throw error;
      return data as any[];
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle className="font-mono">{p.code}</DialogTitle><DialogDescription>{p.title} · {p.customer_name}</DialogDescription></DialogHeader>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="text-muted-foreground">狀態</div><div><StatusBadge s={p.status} />{p.status_reason ? <span className="text-xs ml-2">{p.status_reason}</span> : null}</div>
          <div className="text-muted-foreground">Quote</div><div>{p.quote_no || "—"}</div>
          <div className="text-muted-foreground">報價 / 月費</div><div>{money(p.quoted_amount)} / {money(p.monthly_fee)}</div>
          <div className="text-muted-foreground">期間</div><div>{p.start_date} 至 {p.end_date || "—"}</div>
          <div className="text-muted-foreground">Sales</div><div>{p.sales_name}</div>
          <div className="text-muted-foreground">Xero Reference</div><div className="font-mono text-xs">{p.code} / {p.sales_name}</div>
          {p.notes && <><div className="text-muted-foreground">備註</div><div>{p.notes}</div></>}
        </div>
        <div className="mt-2">
          <div className="text-xs font-medium text-muted-foreground mb-1">紀錄</div>
          <ul className="text-xs space-y-1 max-h-48 overflow-y-auto">
            {(events || []).map(ev => (
              <li key={ev.id}>{new Date(ev.created_at).toLocaleString("en-HK")} · {ev.action}
                {ev.to_status ? ` → ${ev.to_status}` : ""}{ev.detail?.code ? ` (${ev.detail.code})` : ""}{ev.detail?.reason ? ` — ${ev.detail.reason}` : ""}{ev.detail?.auto ? " (自動)" : ""}</li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 違規（Xero 檢查）
// ---------------------------------------------------------------------------
function ViolationsTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showResolved, setShowResolved] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["project_code_violations", showResolved],
    queryFn: async () => {
      let qy = supabase.from("project_code_violations").select("*").order("doc_date", { ascending: false }).limit(500);
      if (!showResolved) qy = qy.is("resolved_at", null);
      const { data, error } = await qy;
      if (error) throw error;
      return data as Violation[];
    },
  });
  const run = useMutation({
    mutationFn: async (days?: number) => {
      const { data, error } = await supabase.functions.invoke("xero-project-check", { body: days ? { days } : {} });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      return data as any;
    },
    onSuccess: (d) => {
      toast({ title: "Xero 檢查完成", description: d?.skipped ? String(d.skipped) : `新違規 ${d?.new_violations ?? 0} 項` });
      qc.invalidateQueries({ queryKey: ["project_code_violations"] });
    },
    onError: (e) => toast({ title: "檢查失敗", description: errMsg(e), variant: "destructive" }),
  });
  const resolve = useMutation({
    mutationFn: async (id: number) => {
      const { error } = await supabase.from("project_code_violations").update({ resolved_at: new Date().toISOString() }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project_code_violations"] }),
  });

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => run.mutate(undefined)} disabled={run.isPending}><RefreshCw size={14} className="mr-1.5" /> 立即檢查 Xero</Button>
          <Button size="sm" variant="outline" onClick={() => run.mutate(120)} disabled={run.isPending}>重查最近 120 日</Button>
          <label className="flex items-center gap-2 text-sm ml-2"><Switch checked={showResolved} onCheckedChange={setShowResolved} /> 顯示已解決</label>
          <span className="text-xs text-muted-foreground ml-auto">每晚 04:00 自動檢查；會計喺 Xero 改正後自動消除</span>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? <Skeleton className="h-40 m-4" /> : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr><th className="text-left p-2">公司</th><th className="text-left p-2">單據</th><th className="text-left p-2">對手方</th>
                  <th className="text-left p-2">日期</th><th className="text-right p-2">金額</th><th className="text-left p-2">Reference</th>
                  <th className="text-left p-2">問題</th><th className="p-2"></th></tr>
              </thead>
              <tbody>
                {(data || []).map(v => (
                  <tr key={v.id} className={`border-t ${v.resolved_at ? "opacity-50" : ""}`}>
                    <td className="p-2">{v.entity_code}</td>
                    <td className="p-2 whitespace-nowrap">{v.doc_type === "ACCREC" ? "Invoice" : "Bill"}{" "}
                      {v.xero_url ? <a className="underline inline-flex items-center gap-0.5" href={v.xero_url} target="_blank" rel="noreferrer">{v.doc_number || "(未有號碼)"}<ExternalLink size={11} /></a> : v.doc_number}
                      <div className="text-xs text-muted-foreground">{v.doc_status}</div></td>
                    <td className="p-2">{v.contact_name}</td>
                    <td className="p-2 whitespace-nowrap">{v.doc_date}</td>
                    <td className="p-2 text-right">{money(v.total)}</td>
                    <td className="p-2 font-mono text-xs">{v.reference || "—"}</td>
                    <td className="p-2"><span className="inline-flex px-1.5 py-0.5 rounded bg-red-500/15 text-red-700 dark:text-red-400 text-xs mr-1">{RULE_LABEL[v.rule] || v.rule}</span><span className="text-xs">{v.message}</span></td>
                    <td className="p-2">{!v.resolved_at && <Button size="sm" variant="ghost" onClick={() => resolve.mutate(v.id)} title="人手標記已處理">已處理</Button>}</td>
                  </tr>
                ))}
                {(data || []).length === 0 && <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">冇違規</td></tr>}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------
function SettingsTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { companies, rules } = useRefData();

  const xeroMsg = useMemo(() => new URLSearchParams(window.location.hash.split("?")[1] || "").get("xero"), []);
  useEffect(() => {
    if (xeroMsg) toast({ title: xeroMsg.startsWith("connected") ? "Xero 已連接" : "Xero 連接失敗", description: xeroMsg, variant: xeroMsg.startsWith("connected") ? "default" : "destructive" });
  }, [xeroMsg]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: settings } = useQuery({
    queryKey: ["project_register_settings"],
    queryFn: async () => {
      const { data, error } = await supabase.from("project_register_settings").select("*").eq("id", 1).maybeSingle();
      if (error) throw error;
      return data as { notify_emails: string[]; notify_sales: boolean; xero_check_enabled: boolean } | null;
    },
  });
  const [emails, setEmails] = useState("");
  useEffect(() => { if (settings) setEmails(settings.notify_emails.join(", ")); }, [settings]);

  const saveSettings = useMutation({
    mutationFn: async (patch: Record<string, any>) => {
      const { error } = await supabase.from("project_register_settings").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", 1);
      if (error) throw error;
    },
    onSuccess: () => { toast({ title: "已儲存" }); qc.invalidateQueries({ queryKey: ["project_register_settings"] }); },
    onError: (e) => toast({ title: "未能儲存", description: errMsg(e), variant: "destructive" }),
  });
  const saveRule = useMutation({
    mutationFn: async ({ code, patch }: { code: string; patch: Partial<TypeRule> }) => {
      const { error } = await supabase.from("project_type_rules").update({ ...patch, updated_at: new Date().toISOString() }).eq("type_code", code);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project_type_rules"] }),
    onError: (e) => toast({ title: "未能更新規則", description: errMsg(e), variant: "destructive" }),
  });
  const saveCompany = useMutation({
    mutationFn: async ({ code, patch }: { code: string; patch: Partial<Company> }) => {
      const { error } = await supabase.from("project_companies").update(patch).eq("entity_code", code);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project_companies"] }),
  });

  const { data: conns, refetch: refetchConns } = useQuery({
    queryKey: ["xero_connections"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("xero_connections_list");
      if (error) throw error;
      return data as { tenant_id: string; tenant_name: string; entity_code: string | null; updated_at: string; last_checked_at: string | null }[];
    },
  });
  const connect = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("xero-oauth", { body: { action: "start" } });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      window.location.href = (data as any).url;
    },
    onError: (e) => toast({ title: "未能連接 Xero", description: errMsg(e), variant: "destructive" }),
  });
  const mapTenant = useMutation({
    mutationFn: async ({ tenant, entity }: { tenant: string; entity: string }) => {
      const { error } = await supabase.rpc("xero_connection_set_entity", { p_tenant: tenant, p_entity: entity });
      if (error) throw error;
    },
    onSuccess: () => refetchConns(),
  });

  const { data: outbox } = useQuery({
    queryKey: ["project_notifications"],
    queryFn: async () => {
      const { data, error } = await supabase.from("project_notifications").select("id, kind, recipients, subject, status, error, created_at, sent_at").order("id", { ascending: false }).limit(15);
      if (error) throw error;
      return data as any[];
    },
  });

  const num = (v: string) => (v === "" ? null : Number(v));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Mail size={16} /> Email 通知</CardTitle>
          <CardDescription>開 code、續約、即將完結、自動關閉、Xero 違規都會 email 呢度嘅地址。</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input value={emails} onChange={e => setEmails(e.target.value)} placeholder="accounts@pbhk.info, ..." data-testid="input-notify-emails" />
            <Button onClick={() => saveSettings.mutate({ notify_emails: emails.split(/[,\s]+/).map(s => s.trim()).filter(Boolean) })}>儲存</Button>
          </div>
          <label className="flex items-center gap-2 text-sm"><Switch checked={!!settings?.notify_sales} onCheckedChange={(v) => saveSettings.mutate({ notify_sales: v })} /> 同時 email 開 code 嘅 sales</label>
          <div className="text-xs">
            <div className="font-medium text-muted-foreground mb-1">最近 email</div>
            <ul className="space-y-0.5">
              {(outbox || []).map(n => (
                <li key={n.id} className={n.status === "failed" ? "text-red-600" : ""}>
                  {new Date(n.created_at).toLocaleString("en-HK")} · {n.status}{n.error ? ` (${n.error})` : ""} · {n.subject}
                </li>
              ))}
            </ul>
            <Button size="sm" variant="ghost" className="mt-1" onClick={async () => { await flushEmails(); qc.invalidateQueries({ queryKey: ["project_notifications"] }); }}>重送 pending</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Project 性質規則</CardTitle>
          <CardDescription>改完即時生效（新開 code 用新規則；已開嘅唔變）。</CardDescription></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr><th className="p-2 text-left">性質</th><th className="p-2">要 quote</th><th className="p-2">要金額</th><th className="p-2">要完結日</th>
                <th className="p-2">要月費</th><th className="p-2">年份尾碼</th><th className="p-2">最長(月)</th><th className="p-2">提醒(日前)</th>
                <th className="p-2">關閉(日後)</th><th className="p-2">只限 admin</th><th className="p-2">啟用</th></tr>
            </thead>
            <tbody>
              {rules.map(r => (
                <tr key={r.type_code} className="border-t">
                  <td className="p-2">{r.type_code} · {r.name_zh}</td>
                  {(["requires_quote", "requires_amount", "requires_end_date", "requires_monthly_fee", "period_suffix"] as const).map(k => (
                    <td key={k} className="p-2 text-center"><Switch checked={r[k]} onCheckedChange={(v) => saveRule.mutate({ code: r.type_code, patch: { [k]: v } })} /></td>
                  ))}
                  {(["max_months", "expiring_days", "close_after_days"] as const).map(k => (
                    <td key={k} className="p-2"><Input className="w-16 h-7 text-xs" type="number" defaultValue={r[k] ?? ""}
                      onBlur={(e) => { const v = num(e.target.value); if (v !== r[k] && !(k !== "max_months" && v == null)) saveRule.mutate({ code: r.type_code, patch: { [k]: v } as any }); }} /></td>
                  ))}
                  <td className="p-2 text-center"><Switch checked={r.admin_only} onCheckedChange={(v) => saveRule.mutate({ code: r.type_code, patch: { admin_only: v } })} /></td>
                  <td className="p-2 text-center"><Switch checked={r.is_active} onCheckedChange={(v) => saveRule.mutate({ code: r.type_code, patch: { is_active: v } })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">公司規則</CardTitle>
          <CardDescription>Xero 檢查：邊間公司嘅 invoice / bill 一定要有 project code。</CardDescription></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground"><tr><th className="p-2 text-left">公司</th><th className="p-2">Code 字頭</th><th className="p-2">Invoice 必須有 code</th><th className="p-2">Bill 必須有 code</th></tr></thead>
            <tbody>
              {companies.map(c => (
                <tr key={c.entity_code} className="border-t">
                  <td className="p-2">{c.legal_name}</td><td className="p-2 text-center font-mono">{c.code_letters}</td>
                  <td className="p-2 text-center"><Switch checked={c.require_code_invoice} onCheckedChange={(v) => saveCompany.mutate({ code: c.entity_code, patch: { require_code_invoice: v } })} /></td>
                  <td className="p-2 text-center"><Switch checked={c.require_code_bill} onCheckedChange={(v) => saveCompany.mutate({ code: c.entity_code, patch: { require_code_bill: v } })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Link2 size={16} /> Xero 連線</CardTitle>
          <CardDescription>每間公司授權一次（只讀 invoice / bill / contact）。授權完要揀返對應公司。</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Button onClick={() => connect.mutate()} disabled={connect.isPending}><Link2 size={14} className="mr-1.5" /> 連接 Xero</Button>
            <label className="flex items-center gap-2 text-sm"><Switch checked={!!settings?.xero_check_enabled} onCheckedChange={(v) => saveSettings.mutate({ xero_check_enabled: v })} /> 每晚自動檢查</label>
          </div>
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground"><tr><th className="text-left p-1">Xero organisation</th><th className="text-left p-1">對應公司</th><th className="text-left p-1">上次檢查</th></tr></thead>
            <tbody>
              {(conns || []).map(c => (
                <tr key={c.tenant_id} className="border-t">
                  <td className="p-1">{c.tenant_name}</td>
                  <td className="p-1">
                    <Select value={c.entity_code || ""} onValueChange={(v) => mapTenant.mutate({ tenant: c.tenant_id, entity: v })}>
                      <SelectTrigger className="h-8 w-48"><SelectValue placeholder="揀公司" /></SelectTrigger>
                      <SelectContent>{companies.map(co => <SelectItem key={co.entity_code} value={co.entity_code}>{co.code_letters} · {co.legal_name}</SelectItem>)}</SelectContent>
                    </Select>
                  </td>
                  <td className="p-1 text-xs">{c.last_checked_at ? new Date(c.last_checked_at).toLocaleString("en-HK") : "未檢查"}</td>
                </tr>
              ))}
              {(conns || []).length === 0 && <tr><td colSpan={3} className="p-2 text-muted-foreground text-xs">未連接</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
