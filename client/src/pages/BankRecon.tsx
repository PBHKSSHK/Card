import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { runBankMatching } from "@/lib/matching-engine";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Landmark, Loader2, Play, ChevronLeft, ChevronDown, ChevronRight, CheckCircle2, AlertCircle, MinusCircle } from "lucide-react";
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
  if (n == null) return "-";
  return n.toLocaleString("en-HK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function BankRecon() {
  const [subsidiary, setSubsidiary] = useState("all");
  const [period, setPeriod] = useState("all");
  const [running, setRunning] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { toast } = useToast();
  const qc = useQueryClient();

  // ─── Paginated fetch helper (Supabase caps at 1000/request) ───
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

  // ─── Fetch bank transactions (no hard limit) ───
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

  // ─── Fetch recon results for bank module (chunked .in()) ───
  const txnIds = (transactions || []).map(t => t.id);
  const { data: reconResults } = useQuery({
    queryKey: ["bank-recon-results", txnIds.length, subsidiary, period],
    queryFn: async () => {
      if (!txnIds.length) return [];
      // Chunk ids to avoid URL length limits on .in()
      const CHUNK = 200;
      const all: BankReconResult[] = [];
      for (let i = 0; i < txnIds.length; i += CHUNK) {
        const chunk = txnIds.slice(i, i + CHUNK);
        const { data } = await supabase
          .from("bank_recon_results")
          .select("*")
          .in("source_id", chunk);
        if (data) all.push(...(data as BankReconResult[]));
      }
      return all;
    },
    enabled: txnIds.length > 0,
  });

  // ─── Fetch GL entries for expanded detail ───
  const { data: glEntries } = useQuery({
    queryKey: ["gl-entries-matched", expandedId],
    queryFn: async () => {
      if (!expandedId) return null;
      const result = reconResults?.find(r => r.source_id === expandedId);
      if (!result?.target_id || result.target_type !== "ns_gl_entry") return null;
      const { data } = await supabase
        .from("ns_gl_entries")
        .select("*")
        .eq("id", result.target_id)
        .single();
      return data as NsGlEntry | null;
    },
    enabled: !!expandedId,
  });

  // ─── Build result map ───
  const resultMap = new Map<string, BankReconResult>();
  for (const r of reconResults || []) {
    resultMap.set(r.source_id, r);
  }

  // ─── Stats ───
  const total = (transactions || []).length;
  const matchedCount = (reconResults || []).filter(r => r.status === "matched").length;
  const unmatchedCount = total - matchedCount;
  const matchPct = total > 0 ? Math.round((matchedCount / total) * 100) : 0;

  // ─── Unique subsidiaries ───
  const { data: subsidiaries } = useQuery({
    queryKey: ["bank-subsidiaries"],
    queryFn: async () => {
      const { data } = await supabase
        .from("bank_transactions")
        .select("subsidiary")
        .limit(1000);
      const subs = [...new Set((data || []).map((r: any) => r.subsidiary))];
      return subs.sort();
    },
  });

  // ─── Run matching ───
  const handleRunMatching = async () => {
    setRunning(true);
    try {
      const r = await runBankMatching(
        subsidiary !== "all" ? subsidiary : undefined,
        period !== "all" ? period : undefined
      );
      toast({
        title: "配對完成",
        description: `Matched: ${r.matched}, Rule: ${r.ruleMatched}, Unmatched: ${r.unmatched}`,
      });
      qc.invalidateQueries({ queryKey: ["bank-transactions"] });
      qc.invalidateQueries({ queryKey: ["bank-recon-results"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    } catch (err: any) {
      toast({ title: "配對失敗", description: err.message, variant: "destructive" });
    }
    setRunning(false);
  };

  return (
    <div className="p-4 lg:p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Landmark className="h-5 w-5 text-blue-600" />
            Bank Reconciliation
          </h1>
          <p className="text-sm text-muted-foreground">銀行月結單對帳 — 配對 Bank Statement 與 NetSuite GL</p>
        </div>
        <Button onClick={handleRunMatching} disabled={running} data-testid="button-run-bank-matching">
          {running ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
          執行配對
        </Button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <Select value={subsidiary} onValueChange={setSubsidiary}>
          <SelectTrigger className="w-[180px]" data-testid="select-subsidiary">
            <SelectValue placeholder="All Companies" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Companies</SelectItem>
            {(subsidiaries || []).map((s: string) => (
              <SelectItem key={s} value={s}>{SUBSIDIARY_MAP[s] || s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger className="w-[140px]" data-testid="select-period">
            <SelectValue placeholder="All Periods" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Periods</SelectItem>
            {MONTHS.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-xl font-semibold">{total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground">Matched</p>
            <p className="text-xl font-semibold text-green-600">{matchedCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground">Unmatched</p>
            <p className="text-xl font-semibold text-amber-600">{unmatchedCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground">Match Rate</p>
            <p className="text-xl font-semibold">{matchPct}%</p>
          </CardContent>
        </Card>
      </div>

      {/* Transaction Table */}
      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead className="w-[90px]">Date</TableHead>
                  <TableHead className="w-[70px]">Company</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right w-[100px]">Debit</TableHead>
                  <TableHead className="text-right w-[100px]">Credit</TableHead>
                  <TableHead className="w-[80px]">Status</TableHead>
                  <TableHead className="w-[70px]">Conf.</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(transactions || []).map(txn => {
                  const result = resultMap.get(txn.id);
                  const isExpanded = expandedId === txn.id;
                  const statusIcon = result?.status === "matched"
                    ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                    : result?.status === "unmatched"
                    ? <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
                    : <MinusCircle className="h-3.5 w-3.5 text-muted-foreground" />;

                  return (
                    <>
                      <TableRow
                        key={txn.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => setExpandedId(isExpanded ? null : txn.id)}
                        data-testid={`row-bank-txn-${txn.id}`}
                      >
                        <TableCell className="py-2">
                          {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        </TableCell>
                        <TableCell className="py-2 text-xs">{txn.txn_date}</TableCell>
                        <TableCell className="py-2">
                          <Badge variant="outline" className="text-[10px]">{txn.subsidiary}</Badge>
                        </TableCell>
                        <TableCell className="py-2 text-xs max-w-[300px] truncate">{txn.description}</TableCell>
                        <TableCell className="py-2 text-xs text-right font-mono text-red-600">
                          {txn.debit ? fmt(txn.debit) : ""}
                        </TableCell>
                        <TableCell className="py-2 text-xs text-right font-mono text-green-600">
                          {txn.credit ? fmt(txn.credit) : ""}
                        </TableCell>
                        <TableCell className="py-2">
                          <div className="flex items-center gap-1">
                            {statusIcon}
                            <span className="text-[10px]">{result?.status || "pending"}</span>
                          </div>
                        </TableCell>
                        <TableCell className="py-2 text-xs">
                          {result?.confidence ? `${result.confidence}%` : "-"}
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow key={`${txn.id}-detail`}>
                          <TableCell colSpan={8} className="bg-muted/30 py-3 px-6">
                            <div className="grid grid-cols-2 gap-4 text-xs">
                              <div>
                                <p className="font-medium mb-1">Bank Transaction</p>
                                <p><span className="text-muted-foreground">Bank:</span> {txn.bank_name}</p>
                                <p><span className="text-muted-foreground">Account:</span> {txn.bank_account || "-"}</p>
                                <p><span className="text-muted-foreground">Reference:</span> {txn.reference || "-"}</p>
                                <p><span className="text-muted-foreground">Currency:</span> {txn.currency}</p>
                                <p><span className="text-muted-foreground">Balance:</span> {fmt(txn.balance)}</p>
                              </div>
                              {result && (
                                <div>
                                  <p className="font-medium mb-1">Match Detail</p>
                                  <p><span className="text-muted-foreground">Type:</span> {result.match_type || "-"}</p>
                                  <p><span className="text-muted-foreground">Confidence:</span> {result.confidence ? `${result.confidence}%` : "-"}</p>
                                  <p><span className="text-muted-foreground">Notes:</span> {result.notes || "-"}</p>
                                  {result.target_type === "ns_gl_entry" && glEntries && (
                                    <div className="mt-2 p-2 bg-background rounded border">
                                      <p className="font-medium mb-1">NetSuite GL Entry</p>
                                      <p><span className="text-muted-foreground">Account:</span> {glEntries.account}</p>
                                      <p><span className="text-muted-foreground">Entry:</span> {glEntries.entry_type} — {glEntries.transaction_number}</p>
                                      <p><span className="text-muted-foreground">Entity:</span> {glEntries.entity_name || "-"}</p>
                                      <p><span className="text-muted-foreground">Memo:</span> {glEntries.memo || "-"}</p>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  );
                })}
                {(!transactions || transactions.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-12">
                      暫無銀行交易數據。請在 Upload Centre 上傳銀行月結單，或等待 XLSX 數據導入。
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  );
}
