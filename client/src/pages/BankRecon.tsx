import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { runBankMatching } from "@/lib/matching-engine";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Landmark, Loader2, Play, RefreshCw, Search } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { BankTransaction, NsGlEntry, BankReconResult } from "@shared/schema";

// Subsidiary display mapping
const SUBSIDIARY_MAP: Record<string, string> = {
  SSHK: "Social Strategy Hong Kong Limited",
  PBHK: "Photoblog.hk Limited",
  CLS: "CLS Production Limited",
  JM: "Jervois M Limited",
  "704": "704 Production Limited",
  EXT: "ExtravelIsm",
  JS: "Jervois Solution",
};

const MONTHS = Array.from({ length: 6 }, (_, i) => {
  const d = new Date(); d.setMonth(d.getMonth() - i);
  return d.toISOString().slice(0, 7);
});

function fmt(n: number | null | undefined): string {
  if (n == null) return "";
  return n.toLocaleString("en-HK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function dmy(iso: string | null | undefined): string {
  const m = (iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(m[2]) - 1]} ${m[1]}` : (iso || "");
}
const amtOf = (r: { debit: number | null; credit: number | null }) =>
  Math.abs(Number(r.debit ?? r.credit ?? 0));

type PanelTab = "match" | "create" | "discuss";

// ─────────────────────────────────────────────────────────────────────────────
// One statement line: left = bank line, right = Match/Create/Discuss panel
// (Xero-style). OK button sits between the two when a candidate is selected.
// ─────────────────────────────────────────────────────────────────────────────
function StatementRow({
  txn, result, candidates, onConfirm, onCreate, onDiscuss, onUnmatch, busy,
}: {
  txn: BankTransaction;
  result: BankReconResult | undefined;
  candidates: NsGlEntry[];
  onConfirm: (gl: NsGlEntry) => void;
  onCreate: (who: string, what: string, why: string) => void;
  onDiscuss: (note: string) => void;
  onUnmatch: () => void;
  busy: boolean;
}) {
  const isReconciled = result?.status === "matched" || result?.status === "manual";
  const [tab, setTab] = useState<PanelTab>("match");
  const [showDetails, setShowDetails] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [find, setFind] = useState("");
  const [selectedGl, setSelectedGl] = useState<string | null>(null);
  const [who, setWho] = useState("");
  const [what, setWhat] = useState("");
  const [why, setWhy] = useState("");
  const [note, setNote] = useState(result?.notes || "");

  // Find & Match — widen the search across ALL candidates when the user types
  const shown = useMemo(() => {
    const term = find.trim().toLowerCase();
    let list = candidates;
    if (term) {
      list = list.filter(g =>
        (g.description || "").toLowerCase().includes(term) ||
        (g.entity_name || "").toLowerCase().includes(term) ||
        (g.transaction_number || "").toLowerCase().includes(term) ||
        (g.memo || "").toLowerCase().includes(term) ||
        String(g.debit || "").includes(term) || String(g.credit || "").includes(term)
      );
    }
    return list.slice(0, findOpen || term ? 8 : 1); // 預設淨係顯示最佳建議
  }, [candidates, find, findOpen]);

  const active = shown.find(g => g.id === selectedGl) || shown[0] || null;

  return (
    <Card className="overflow-visible">
      <CardContent className="p-0">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_44px_1fr] items-stretch">
          {/* ── LEFT: bank statement line ── */}
          <div className="p-3 border-b lg:border-b-0 lg:border-r border-border/60">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs tabular-nums text-muted-foreground">{dmy(txn.txn_date)} <Badge variant="outline" className="ml-1 text-[9px] align-middle">{txn.subsidiary}</Badge></p>
                <p className="text-sm font-medium mt-0.5 break-words">{txn.description}</p>
                {txn.reference && <p className="text-[11px] text-muted-foreground mt-0.5 truncate">Ref: {txn.reference}</p>}
                <button className="text-[11px] text-primary hover:underline mt-1" onClick={() => setShowDetails(v => !v)}>
                  {showDetails ? "Hide details" : "More details"}
                </button>
                {showDetails && (
                  <div className="mt-1 text-[11px] text-muted-foreground space-y-0.5">
                    <p>Bank: {txn.bank_name} {txn.bank_account ? `· ${txn.bank_account}` : ""}</p>
                    <p>Currency: {txn.currency} · Balance: {fmt(txn.balance) || "—"}</p>
                  </div>
                )}
              </div>
              <div className="flex gap-4 text-right shrink-0">
                <div className="w-20">
                  <p className="text-[10px] text-muted-foreground">Spent</p>
                  <p className="text-sm font-semibold tabular-nums text-red-600">{fmt(txn.debit)}</p>
                </div>
                <div className="w-20">
                  <p className="text-[10px] text-muted-foreground">Received</p>
                  <p className="text-sm font-semibold tabular-nums text-green-700">{fmt(txn.credit)}</p>
                </div>
              </div>
            </div>
          </div>

          {/* ── MIDDLE: OK button ── */}
          <div className="hidden lg:flex items-center justify-center">
            {!isReconciled && tab === "match" && active && (
              <Button size="sm" className="h-9 px-3 bg-blue-600 hover:bg-blue-700 text-white"
                disabled={busy}
                onClick={() => onConfirm(active)}
                data-testid={`btn-ok-${txn.id}`}>
                OK
              </Button>
            )}
          </div>

          {/* ── RIGHT: action panel ── */}
          <div className="p-3">
            {isReconciled ? (
              /* 已對數 — green matched state */
              <div className="h-full flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-medium text-green-700 dark:text-green-400">
                    ✓ Reconciled{result?.match_type ? ` · ${result.match_type}` : ""}{result?.confidence ? ` · ${result.confidence}%` : ""}
                  </span>
                  <Button variant="ghost" size="sm" className="h-6 text-[11px] text-muted-foreground"
                    disabled={busy} onClick={onUnmatch}>解除</Button>
                </div>
                <div className="rounded-md bg-green-500/10 border border-green-600/30 p-2.5 text-xs">
                  <p className="font-medium">{result?.notes || "已人手歸類"}</p>
                </div>
              </div>
            ) : (
              <>
                {/* Tabs */}
                <div className="flex items-center gap-4 border-b border-border/60 pb-1.5 mb-2 text-xs">
                  {(["match", "create", "discuss"] as PanelTab[]).map(t => (
                    <button key={t}
                      onClick={() => setTab(t)}
                      className={`capitalize pb-0.5 -mb-[7px] border-b-2 ${tab === t ? "border-primary text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
                      {t}
                    </button>
                  ))}
                  <button className="ml-auto text-primary hover:underline text-[11px]"
                    onClick={() => { setTab("match"); setFindOpen(v => !v); }}>
                    Find &amp; Match
                  </button>
                </div>

                {tab === "match" && (
                  <div className="space-y-1.5">
                    {(findOpen || find) && (
                      <div className="relative">
                        <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                        <Input value={find} onChange={e => setFind(e.target.value)}
                          placeholder="Search amount / description / txn no…" className="h-7 pl-7 text-xs" />
                      </div>
                    )}
                    {shown.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground py-3 text-center">
                        冇金額吻合嘅 NetSuite GL 紀錄 — 可以用 Find &amp; Match 搜尋，或者用 Create 人手歸類。
                      </p>
                    ) : shown.map(g => {
                      const isSel = (active?.id === g.id);
                      return (
                        <button key={g.id}
                          onClick={() => setSelectedGl(g.id)}
                          className={`w-full text-left rounded-md border p-2.5 transition-colors ${
                            isSel ? "bg-green-500/15 border-green-600/40" : "bg-transparent border-border hover:bg-muted/40"
                          }`}
                          data-testid={`gl-candidate-${g.id}`}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-[11px] tabular-nums text-muted-foreground">{dmy(g.txn_date)}</p>
                              <p className="text-xs font-medium truncate">{g.entity_name || g.description || g.memo || g.account}</p>
                              <p className="text-[11px] text-muted-foreground truncate">
                                {g.transaction_number ? `Ref: ${g.transaction_number}` : g.account}
                              </p>
                            </div>
                            <div className="flex gap-4 text-right shrink-0">
                              <div className="w-16">
                                <p className="text-[10px] text-muted-foreground">Spent</p>
                                <p className="text-xs font-semibold tabular-nums">{fmt(g.debit)}</p>
                              </div>
                              <div className="w-16">
                                <p className="text-[10px] text-muted-foreground">Received</p>
                                <p className="text-xs font-semibold tabular-nums">{fmt(g.credit)}</p>
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                    {/* Mobile OK */}
                    {active && (
                      <div className="lg:hidden pt-1">
                        <Button size="sm" className="w-full bg-blue-600 hover:bg-blue-700 text-white" disabled={busy}
                          onClick={() => onConfirm(active)}>OK — 確認配對</Button>
                      </div>
                    )}
                  </div>
                )}

                {tab === "create" && (
                  <div className="space-y-2">
                    <div className="grid grid-cols-[38px_1fr] items-center gap-2">
                      <span className="text-[11px] text-muted-foreground">Who</span>
                      <Input value={who} onChange={e => setWho(e.target.value)} placeholder="Name of the contact…" className="h-7 text-xs" />
                      <span className="text-[11px] text-muted-foreground">What</span>
                      <Input value={what} onChange={e => setWhat(e.target.value)} placeholder="分類 / 科目（例：Bank charges）" className="h-7 text-xs" />
                      <span className="text-[11px] text-muted-foreground">Why</span>
                      <Input value={why} onChange={e => setWhy(e.target.value)} placeholder="Enter a description…" className="h-7 text-xs" />
                    </div>
                    <div className="flex justify-end">
                      <Button size="sm" className="h-7 text-xs" disabled={busy || (!who && !what && !why)}
                        onClick={() => onCreate(who, what, why)} data-testid={`btn-create-${txn.id}`}>
                        歸類並對數
                      </Button>
                    </div>
                  </div>
                )}

                {tab === "discuss" && (
                  <div className="space-y-2">
                    <textarea value={note} onChange={e => setNote(e.target.value)}
                      placeholder="留言俾同事跟進（唔會對數）…"
                      className="w-full h-16 text-xs rounded-md border border-border bg-transparent p-2 resize-none" />
                    <div className="flex justify-end">
                      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy || !note.trim()}
                        onClick={() => onDiscuss(note.trim())}>儲存留言</Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function BankRecon() {
  const [subsidiary, setSubsidiary] = useState("all");
  const [period, setPeriod] = useState("all");
  const [view, setView] = useState<"todo" | "done">("todo");
  const [running, setRunning] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [page, setPage] = useState(0);
  const PER_PAGE = 15;
  const { toast } = useToast();
  const qc = useQueryClient();

  async function fetchAll<T>(table: string, buildQuery: (q: any) => any): Promise<T[]> {
    const PAGE = 1000;
    let all: T[] = [];
    let from = 0;
    while (true) {
      let q = supabase.from(table).select("*").range(from, from + PAGE - 1);
      q = buildQuery(q);
      const { data } = await q;
      if (!data?.length) break;
      all = all.concat(data as T[]);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  }

  const { data: transactions, isLoading } = useQuery({
    queryKey: ["bank-transactions", subsidiary, period],
    queryFn: async () => {
      return fetchAll<BankTransaction>("bank_transactions", (q: any) => {
        q = q.order("txn_date", { ascending: false });
        if (subsidiary !== "all") q = q.eq("subsidiary", subsidiary);
        if (period !== "all") q = q.eq("period_month", period);
        return q;
      });
    },
  });

  const txnIds = (transactions || []).map(t => t.id);
  const { data: reconResults } = useQuery({
    queryKey: ["bank-recon-results", txnIds.length, subsidiary, period],
    queryFn: async () => {
      if (!txnIds.length) return [];
      const CHUNK = 200;
      const all: BankReconResult[] = [];
      for (let i = 0; i < txnIds.length; i += CHUNK) {
        const chunk = txnIds.slice(i, i + CHUNK);
        const { data } = await supabase.from("bank_recon_results").select("*").in("source_id", chunk);
        if (data) all.push(...(data as BankReconResult[]));
      }
      return all;
    },
    enabled: txnIds.length > 0,
  });

  // Unmatched GL entries in scope — candidate pool for the Match panel
  const { data: glPool } = useQuery({
    queryKey: ["gl-pool", subsidiary, period],
    queryFn: async () => {
      return fetchAll<NsGlEntry>("ns_gl_entries", (q: any) => {
        q = q.eq("is_matched", false).order("txn_date", { ascending: false });
        if (subsidiary !== "all") q = q.eq("subsidiary", subsidiary);
        if (period !== "all") q = q.eq("period_month", period);
        return q;
      });
    },
  });

  const resultMap = useMemo(() => {
    const m = new Map<string, BankReconResult>();
    for (const r of reconResults || []) m.set(r.source_id, r);
    return m;
  }, [reconResults]);

  // Candidates per bank txn: same subsidiary + equal amount, nearest date first
  const candidatesFor = useMemo(() => {
    const pool = glPool || [];
    return (txn: BankTransaction): NsGlEntry[] => {
      const amt = amtOf(txn);
      if (!amt) return [];
      const c = pool.filter(g =>
        (g.subsidiary === txn.subsidiary || !txn.subsidiary) &&
        Math.abs(amtOf(g) - amt) < 0.01
      );
      const t0 = new Date(txn.txn_date).getTime();
      return c.sort((a, b) =>
        Math.abs(new Date(a.txn_date).getTime() - t0) - Math.abs(new Date(b.txn_date).getTime() - t0)
      );
    };
  }, [glPool]);

  const isDone = (t: BankTransaction) => {
    const r = resultMap.get(t.id);
    return r?.status === "matched" || r?.status === "manual";
  };
  const todo = (transactions || []).filter(t => !isDone(t));
  const done = (transactions || []).filter(isDone);
  const rows = view === "todo" ? todo : done;
  const totalPages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const pageRows = rows.slice(Math.min(page, totalPages - 1) * PER_PAGE, (Math.min(page, totalPages - 1) + 1) * PER_PAGE);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["bank-transactions"] });
    qc.invalidateQueries({ queryKey: ["bank-recon-results"] });
    qc.invalidateQueries({ queryKey: ["gl-pool"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  // Upsert a bank_recon_results row for a txn
  const upsertResult = async (txnId: string, patch: Partial<BankReconResult>) => {
    const { data: existing } = await supabase
      .from("bank_recon_results").select("id").eq("source_id", txnId).maybeSingle();
    if (existing?.id) {
      const { error } = await supabase.from("bank_recon_results").update(patch).eq("id", existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from("bank_recon_results").insert({
        module: "bank", source_type: "bank_transaction", source_id: txnId, status: "pending", ...patch,
      });
      if (error) throw error;
    }
  };

  const confirmMutation = useMutation({
    mutationFn: async ({ txn, gl }: { txn: BankTransaction; gl: NsGlEntry }) => {
      await upsertResult(txn.id, {
        status: "matched", match_type: "manual", confidence: 100,
        target_type: "ns_gl_entry", target_id: gl.id,
        matched_at: new Date().toISOString(), matched_by: "user",
        notes: `${gl.entity_name || gl.description || gl.account} · ${gl.transaction_number || ""} · ${fmt(amtOf(gl))}`,
      } as any);
      const { error } = await supabase.from("ns_gl_entries").update({ is_matched: true }).eq("id", gl.id);
      if (error) throw error;
    },
    onSuccess: () => { invalidate(); toast({ title: "已對數 ✓" }); },
    onError: (e: Error) => toast({ title: "對數失敗", description: e.message, variant: "destructive" }),
  });

  const createMutation = useMutation({
    mutationFn: async ({ txn, who, what, why }: { txn: BankTransaction; who: string; what: string; why: string }) => {
      await upsertResult(txn.id, {
        status: "manual", match_type: "manual", confidence: 100,
        target_type: null, target_id: null,
        matched_at: new Date().toISOString(), matched_by: "user",
        notes: ["Create:", who, what, why].filter(Boolean).join(" · "),
      } as any);
    },
    onSuccess: () => { invalidate(); toast({ title: "已歸類並對數 ✓" }); },
    onError: (e: Error) => toast({ title: "儲存失敗", description: e.message, variant: "destructive" }),
  });

  const discussMutation = useMutation({
    mutationFn: async ({ txn, note }: { txn: BankTransaction; note: string }) => {
      await upsertResult(txn.id, { notes: `💬 ${note}` } as any);
    },
    onSuccess: () => { invalidate(); toast({ title: "留言已儲存" }); },
    onError: (e: Error) => toast({ title: "儲存失敗", description: e.message, variant: "destructive" }),
  });

  const unmatchMutation = useMutation({
    mutationFn: async (txn: BankTransaction) => {
      const r = resultMap.get(txn.id);
      if (r?.target_type === "ns_gl_entry" && r.target_id) {
        await supabase.from("ns_gl_entries").update({ is_matched: false }).eq("id", r.target_id);
      }
      await upsertResult(txn.id, {
        status: "unmatched", match_type: null, confidence: null,
        target_type: null, target_id: null, matched_at: null, matched_by: "user",
        notes: "Unreconciled by user",
      } as any);
    },
    onSuccess: () => { invalidate(); toast({ title: "已解除對數" }); },
    onError: (e: Error) => toast({ title: "解除失敗", description: e.message, variant: "destructive" }),
  });

  const busy = confirmMutation.isPending || createMutation.isPending || discussMutation.isPending || unmatchMutation.isPending;

  const { data: subsidiaries } = useQuery({
    queryKey: ["bank-subsidiaries"],
    queryFn: async () => {
      const { data } = await supabase.from("bank_transactions").select("subsidiary").limit(1000);
      return [...new Set((data || []).map((r: any) => r.subsidiary))].sort();
    },
  });

  // Pull the latest bank-account GL lines from NetSuite into ns_gl_entries
  // (server-side dedupe on ns_line_key — re-runs only add new lines).
  const handleSyncNetSuite = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("netsuite-sync-gl", {
        body: { months: 3 },
      });
      if (error) throw new Error(error.message || "Edge Function 呼叫失敗");
      if (data?.error) throw new Error(data.error);
      toast({
        title: "NetSuite 同步完成",
        description: `由 ${data.since} 起共 ${data.fetched} 行，新增 ${data.inserted} 行`,
      });
      qc.invalidateQueries({ queryKey: ["gl-pool"] });
      qc.invalidateQueries({ queryKey: ["bank-recon-results"] });
    } catch (err: any) {
      toast({ title: "同步失敗", description: err.message, variant: "destructive" });
    }
    setSyncing(false);
  };

  const handleRunMatching = async () => {
    setRunning(true);
    try {
      const r = await runBankMatching(
        subsidiary !== "all" ? subsidiary : undefined,
        period !== "all" ? period : undefined
      );
      toast({ title: "自動配對完成", description: `Matched: ${r.matched}, Rule: ${r.ruleMatched}, Unmatched: ${r.unmatched}` });
      invalidate();
    } catch (err: any) {
      toast({ title: "配對失敗", description: err.message, variant: "destructive" });
    }
    setRunning(false);
  };

  return (
    <div className="p-4 lg:p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Landmark className="h-5 w-5 text-blue-600" />
            Bank Reconciliation
          </h1>
          <p className="text-sm text-muted-foreground">左邊係銀行月結單 → 右邊揀 NetSuite 紀錄配對，或者 Create 人手歸類</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleSyncNetSuite} disabled={syncing} data-testid="button-sync-netsuite">
            {syncing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            同步 NetSuite
          </Button>
          <Button onClick={handleRunMatching} disabled={running} data-testid="button-run-bank-matching">
            {running ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
            自動配對
          </Button>
        </div>
      </div>

      {/* Filters + view toggle */}
      <div className="flex gap-3 flex-wrap items-center">
        <Select value={subsidiary} onValueChange={v => { setSubsidiary(v); setPage(0); }}>
          <SelectTrigger className="w-[190px]" data-testid="select-subsidiary">
            <SelectValue placeholder="All Companies" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Companies</SelectItem>
            {(subsidiaries || []).map((s: string) => (
              <SelectItem key={s} value={s}>{SUBSIDIARY_MAP[s] || s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={period} onValueChange={v => { setPeriod(v); setPage(0); }}>
          <SelectTrigger className="w-[140px]" data-testid="select-period">
            <SelectValue placeholder="All Periods" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Periods</SelectItem>
            {MONTHS.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="ml-auto flex rounded-md border border-border overflow-hidden text-xs">
          <button onClick={() => { setView("todo"); setPage(0); }}
            className={`px-3 py-1.5 ${view === "todo" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>
            未對數 ({todo.length})
          </button>
          <button onClick={() => { setView("done"); setPage(0); }}
            className={`px-3 py-1.5 ${view === "done" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>
            已對數 ({done.length})
          </button>
        </div>
      </div>

      {/* Column captions (Xero-style) */}
      <div className="hidden lg:grid grid-cols-[1fr_44px_1fr] text-[11px] text-muted-foreground px-1">
        <span>Review your bank statement lines…</span>
        <span></span>
        <span>…then match with your NetSuite records</span>
      </div>

      {/* Rows */}
      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : pageRows.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground text-sm">
          {view === "todo" ? "全部對晒數 🎉（或者暫無銀行交易 — 請喺 Upload Centre 上傳銀行月結單）" : "仲未有已對數紀錄。"}
        </CardContent></Card>
      ) : (
        <div className="space-y-3">
          {pageRows.map(txn => (
            <StatementRow
              key={txn.id}
              txn={txn}
              result={resultMap.get(txn.id)}
              candidates={candidatesFor(txn)}
              busy={busy}
              onConfirm={(gl) => confirmMutation.mutate({ txn, gl })}
              onCreate={(who, what, why) => createMutation.mutate({ txn, who, what, why })}
              onDiscuss={(note) => discussMutation.mutate({ txn, note })}
              onUnmatch={() => unmatchMutation.mutate(txn)}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {rows.length > PER_PAGE && (
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Button variant="outline" size="sm" className="h-7 px-2" disabled={page === 0} onClick={() => setPage(p => p - 1)}>‹</Button>
          <span className="tabular-nums">Page {Math.min(page, totalPages - 1) + 1} of {totalPages} ({rows.length} items)</span>
          <Button variant="outline" size="sm" className="h-7 px-2" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>›</Button>
        </div>
      )}
    </div>
  );
}
