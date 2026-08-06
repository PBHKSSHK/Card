import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge, formatCurrency } from "@/components/StatusBadge";
import { CreditCard, FileCheck, AlertTriangle, DollarSign, Clock, FileQuestion, ChevronDown, ChevronRight, FileText, ExternalLink } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

export default function Dashboard() {
  const [expandedSection, setExpandedSection] = useState<"cc" | "inv" | null>(null);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const { data: txnStats, isLoading: loadingTxn } = useQuery({
    queryKey: ["dashboard", "txn-stats"],
    queryFn: async () => {
      const { data, error } = await supabase.from("card_transactions").select("id, amount, amount_hkd, merchant, description");
      if (error) throw error;
      // Exclude CC repayment rows from the money total (same filter as the unmatched list below) —
      // they're card payments, not expenses. Use amount_hkd when present, else fall back to amount
      // so FX rows lacking amount_hkd are not silently dropped from the total.
      const total = data
        .filter(t => {
          const m = (t.merchant || "").toString();
          const d = ((t as any).description || "").toString();
          return !CC_PAYMENT_PATTERN.test(m) && !CC_PAYMENT_PATTERN.test(d);
        })
        .reduce((s, t) => s + Number(t.amount_hkd ?? t.amount ?? 0), 0);
      return { count: data.length, total };
    },
  });

  const { data: reconStats, isLoading: loadingRecon } = useQuery({
    queryKey: ["dashboard", "recon-stats"],
    queryFn: async () => {
      const { data, error } = await supabase.from("reconciliation_results").select("id, status");
      if (error) throw error;
      const matched = data.filter(r => r.status === 'matched').length;
      const pending = data.filter(r => r.status === 'pending').length;
      const unmatched = data.filter(r => r.status === 'unmatched').length;
      const exceptions = data.filter(r => r.status === 'exception').length;
      return { total: data.length, matched, pending, unmatched, exceptions };
    },
  });

  const { data: recentBatches, isLoading: loadingBatches } = useQuery({
    queryKey: ["dashboard", "recent-batches"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("upload_batches")
        .select("*")
        .order("uploaded_at", { ascending: false })
        .limit(5);
      if (error) throw error;
      return data;
    },
  });

  // Unmatched CC transactions (with full details for list)
  // Note: CC payment rows (找數 / Payment Received / Thank You) are filtered out — they're
  // card payments, not real expenses, and shouldn't appear in the unmatched dashboard.
  const CC_PAYMENT_PATTERN = /payment\s*received|thank\s*you|auto[\s-]*pay|autopay|ifs\s*payment|自動轉帳|找數|繳款|還款/i;
  const { data: unmatchedCC, isLoading: loadingUnmatchedCC } = useQuery({
    queryKey: ["dashboard", "unmatched-cc-list"],
    queryFn: async () => {
      // Get pending/unmatched reconciliation results with transaction IDs
      const { data: reconRows, error: reconErr } = await supabase
        .from("reconciliation_results")
        .select("id, transaction_id, status, invoice_id")
        .in("status", ["pending", "unmatched"]);
      if (reconErr) throw reconErr;
      if (!reconRows || reconRows.length === 0) return [];

      const txnIds = reconRows.map(r => r.transaction_id);
      // Fetch transaction details
      const { data: txns, error: txnErr } = await supabase
        .from("card_transactions")
        .select("id, txn_date, merchant, amount, amount_hkd, currency, card_last4, description")
        .in("id", txnIds)
        .order("txn_date", { ascending: false });
      if (txnErr) throw txnErr;

      return (txns || [])
        .filter(t => {
          // Hide CC payment rows everywhere on the dashboard
          const m = (t.merchant || "").toString();
          const d = ((t as any).description || "").toString();
          return !CC_PAYMENT_PATTERN.test(m) && !CC_PAYMENT_PATTERN.test(d);
        })
        .map(t => {
          const recon = reconRows.find(r => r.transaction_id === t.id);
          return { ...t, recon_status: recon?.status, recon_id: recon?.id, invoice_id: recon?.invoice_id };
        });
    },
  });

  // Unmatched invoices (parent only, with details)
  const { data: unmatchedInv, isLoading: loadingUnmatchedInv } = useQuery({
    queryKey: ["dashboard", "unmatched-inv-list"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("meta_invoices")
        .select("id, invoice_number, amount, currency, invoice_date, description, account_name, billing_period")
        .eq("is_matched", false)
        .is("parent_invoice_id", null)
        .order("invoice_date", { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  // Matched invoice detail for expanded CC row
  const { data: matchedInvoiceDetail } = useQuery({
    queryKey: ["dashboard", "matched-invoice", expandedRow],
    enabled: !!expandedRow && expandedSection === "cc",
    queryFn: async () => {
      // Find the recon result for this transaction to get invoice_id
      const ccItem = unmatchedCC?.find(c => c.id === expandedRow);
      if (!ccItem?.invoice_id) return null;
      const { data, error } = await supabase
        .from("meta_invoices")
        .select("id, invoice_number, amount, currency, invoice_date, description, account_name")
        .eq("id", ccItem.invoice_id)
        .single();
      if (error) return null;
      return data;
    },
  });

  // Matched CC transaction detail for expanded invoice row
  const { data: matchedTxnDetail } = useQuery({
    queryKey: ["dashboard", "matched-txn", expandedRow],
    enabled: !!expandedRow && expandedSection === "inv",
    queryFn: async () => {
      // Find recon results that reference this invoice
      const { data: reconRows, error: reconErr } = await supabase
        .from("reconciliation_results")
        .select("transaction_id")
        .eq("invoice_id", expandedRow);
      if (reconErr || !reconRows || reconRows.length === 0) return null;
      const { data, error } = await supabase
        .from("card_transactions")
        .select("id, txn_date, merchant, amount, amount_hkd, currency, card_last4")
        .eq("id", reconRows[0].transaction_id)
        .single();
      if (error) return null;
      return data;
    },
  });

  const { data: buSummary, isLoading: loadingBu } = useQuery({
    queryKey: ["dashboard", "bu-summary"],
    queryFn: async () => {
      const { data, error } = await supabase.from("v_bu_summary").select("*");
      if (error) throw error;
      return data;
    },
  });

  const matchRate = reconStats && reconStats.total > 0
    ? Math.round((reconStats.matched / reconStats.total) * 100)
    : 0;

  const unmatchedCCCount = unmatchedCC?.length ?? 0;
  const unmatchedInvCount = unmatchedInv?.length ?? 0;

  const toggleSection = (section: "cc" | "inv") => {
    setExpandedSection(prev => prev === section ? null : section);
    setExpandedRow(null);
  };

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" data-testid="text-page-title">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">Credit card reconciliation overview</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <KpiCard
          title="Transactions"
          value={loadingTxn ? null : txnStats?.count ?? 0}
          icon={CreditCard}
          loading={loadingTxn}
        />
        <KpiCard
          title="Total Amount"
          value={loadingTxn ? null : formatCurrency(txnStats?.total ?? 0)}
          icon={DollarSign}
          loading={loadingTxn}
        />
        <KpiCard
          title="Match Rate"
          value={loadingRecon ? null : `${matchRate}%`}
          icon={FileCheck}
          loading={loadingRecon}
          accent
        />
      </div>

      {/* Unmatched counts — clickable to expand */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiCard
          title="Unmatched CC"
          subtitle="未兌信用卡項目"
          value={loadingUnmatchedCC ? null : unmatchedCCCount}
          icon={Clock}
          loading={loadingUnmatchedCC}
          warning={unmatchedCCCount > 0}
          onClick={() => toggleSection("cc")}
          active={expandedSection === "cc"}
        />
        <KpiCard
          title="Unmatched Invoices"
          subtitle="未兌 Invoice"
          value={loadingUnmatchedInv ? null : unmatchedInvCount}
          icon={FileQuestion}
          loading={loadingUnmatchedInv}
          warning={unmatchedInvCount > 0}
          onClick={() => toggleSection("inv")}
          active={expandedSection === "inv"}
        />
        <KpiCard
          title="Exceptions"
          value={loadingRecon ? null : reconStats?.exceptions ?? 0}
          icon={AlertTriangle}
          loading={loadingRecon}
          warning={(reconStats?.exceptions ?? 0) > 0}
        />
      </div>

      {/* Expanded: Unmatched CC list */}
      {expandedSection === "cc" && (
        <Card className="border-destructive/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Clock size={14} className="text-destructive" />
              未兌信用卡項目 ({unmatchedCCCount})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loadingUnmatchedCC ? (
              <div className="space-y-2">
                {[1,2,3].map(i => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : unmatchedCCCount === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">無未兌信用卡項目</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="w-8 px-2 py-2"></th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Date</th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Merchant</th>
                      <th className="text-right text-xs font-medium text-muted-foreground px-3 py-2">Amount</th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Currency</th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Cardholder</th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unmatchedCC!.map(txn => (
                      <>
                        <tr
                          key={txn.id}
                          className="border-b border-border/50 hover:bg-muted/20 cursor-pointer transition-colors"
                          onClick={() => setExpandedRow(prev => prev === txn.id ? null : txn.id)}
                          data-testid={`row-unmatched-cc-${txn.id}`}
                        >
                          <td className="px-2 py-2 text-muted-foreground">
                            {expandedRow === txn.id
                              ? <ChevronDown size={14} />
                              : <ChevronRight size={14} />}
                          </td>
                          <td className="px-3 py-2 text-sm tabular-nums">{txn.txn_date}</td>
                          <td className="px-3 py-2 text-sm font-medium">{txn.merchant}</td>
                          <td className="px-3 py-2 text-sm text-right tabular-nums font-medium">
                            {formatCurrency(txn.amount_hkd ?? txn.amount, txn.currency)}
                          </td>
                          <td className="px-3 py-2 text-sm text-muted-foreground">{txn.currency}</td>
                          <td className="px-3 py-2 text-sm text-muted-foreground">{txn.card_last4 || '—'}</td>
                          <td className="px-3 py-2">
                            <StatusBadge status={txn.recon_status as any} />
                          </td>
                        </tr>
                        {expandedRow === txn.id && (
                          <tr key={`${txn.id}-detail`} className="bg-muted/10">
                            <td colSpan={7} className="px-6 py-3">
                              {txn.invoice_id && matchedInvoiceDetail ? (
                                <div className="flex items-start gap-3 text-sm">
                                  <FileText size={16} className="text-primary mt-0.5 flex-shrink-0" />
                                  <div className="space-y-1">
                                    <p className="font-medium">已配對 Invoice</p>
                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 text-xs">
                                      <div>
                                        <span className="text-muted-foreground">Invoice #: </span>
                                        <span className="font-medium">{matchedInvoiceDetail.invoice_number}</span>
                                      </div>
                                      <div>
                                        <span className="text-muted-foreground">Amount: </span>
                                        <span className="font-medium tabular-nums">
                                          {formatCurrency(matchedInvoiceDetail.amount, matchedInvoiceDetail.currency)}
                                        </span>
                                      </div>
                                      <div>
                                        <span className="text-muted-foreground">Date: </span>
                                        <span>{matchedInvoiceDetail.invoice_date || '—'}</span>
                                      </div>
                                      <div>
                                        <span className="text-muted-foreground">Account: </span>
                                        <span>{matchedInvoiceDetail.account_name || '—'}</span>
                                      </div>
                                    </div>
                                    {matchedInvoiceDetail.description && (
                                      <p className="text-xs text-muted-foreground">{matchedInvoiceDetail.description}</p>
                                    )}
                                  </div>
                                </div>
                              ) : (
                                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                  <FileQuestion size={14} />
                                  <span>未有配對的 Invoice</span>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Expanded: Unmatched Invoice list */}
      {expandedSection === "inv" && (
        <Card className="border-destructive/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <FileQuestion size={14} className="text-destructive" />
              未兌 Invoice ({unmatchedInvCount})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loadingUnmatchedInv ? (
              <div className="space-y-2">
                {[1,2,3].map(i => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : unmatchedInvCount === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">無未兌 Invoice</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="w-8 px-2 py-2"></th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Invoice #</th>
                      <th className="text-right text-xs font-medium text-muted-foreground px-3 py-2">Amount</th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Currency</th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Date</th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Account</th>
                      <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unmatchedInv!.map(inv => (
                      <>
                        <tr
                          key={inv.id}
                          className="border-b border-border/50 hover:bg-muted/20 cursor-pointer transition-colors"
                          onClick={() => setExpandedRow(prev => prev === inv.id ? null : inv.id)}
                          data-testid={`row-unmatched-inv-${inv.id}`}
                        >
                          <td className="px-2 py-2 text-muted-foreground">
                            {expandedRow === inv.id
                              ? <ChevronDown size={14} />
                              : <ChevronRight size={14} />}
                          </td>
                          <td className="px-3 py-2 text-sm font-medium">{inv.invoice_number}</td>
                          <td className="px-3 py-2 text-sm text-right tabular-nums font-medium">
                            {formatCurrency(inv.amount, inv.currency)}
                          </td>
                          <td className="px-3 py-2 text-sm text-muted-foreground">{inv.currency}</td>
                          <td className="px-3 py-2 text-sm tabular-nums">{inv.invoice_date || '—'}</td>
                          <td className="px-3 py-2 text-sm text-muted-foreground">{inv.account_name || '—'}</td>
                          <td className="px-3 py-2 text-sm text-muted-foreground truncate max-w-[200px]">
                            {inv.description || '—'}
                          </td>
                        </tr>
                        {expandedRow === inv.id && (
                          <tr key={`${inv.id}-detail`} className="bg-muted/10">
                            <td colSpan={7} className="px-6 py-3">
                              {matchedTxnDetail ? (
                                <div className="flex items-start gap-3 text-sm">
                                  <CreditCard size={16} className="text-primary mt-0.5 flex-shrink-0" />
                                  <div className="space-y-1">
                                    <p className="font-medium">已配對信用卡交易</p>
                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 text-xs">
                                      <div>
                                        <span className="text-muted-foreground">Date: </span>
                                        <span className="tabular-nums">{matchedTxnDetail.txn_date}</span>
                                      </div>
                                      <div>
                                        <span className="text-muted-foreground">Merchant: </span>
                                        <span className="font-medium">{matchedTxnDetail.merchant}</span>
                                      </div>
                                      <div>
                                        <span className="text-muted-foreground">Amount: </span>
                                        <span className="font-medium tabular-nums">
                                          {formatCurrency(matchedTxnDetail.amount_hkd ?? matchedTxnDetail.amount, matchedTxnDetail.currency)}
                                        </span>
                                      </div>
                                      <div>
                                        <span className="text-muted-foreground">Cardholder: </span>
                                        <span>{matchedTxnDetail.card_last4 || '—'}</span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              ) : (
                                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                  <CreditCard size={14} />
                                  <span>未有配對的信用卡交易</span>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Status breakdown + Recent uploads */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Match status breakdown */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Reconciliation Status</CardTitle>
          </CardHeader>
          <CardContent>
            {loadingRecon ? (
              <div className="space-y-3">
                {[1,2,3,4].map(i => <Skeleton key={i} className="h-8 w-full" />)}
              </div>
            ) : (
              <div className="space-y-3">
                {[
                  { status: 'matched' as const, count: reconStats?.matched ?? 0, label: 'Matched' },
                  { status: 'pending' as const, count: reconStats?.pending ?? 0, label: 'Pending' },
                  { status: 'unmatched' as const, count: reconStats?.unmatched ?? 0, label: 'Unmatched' },
                  { status: 'exception' as const, count: reconStats?.exceptions ?? 0, label: 'Exception' },
                ].map(item => (
                  <div key={item.status} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={item.status} />
                    </div>
                    <span className="text-sm font-medium tabular-nums" data-testid={`text-count-${item.status}`}>
                      {item.count}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent uploads */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Recent Uploads</CardTitle>
          </CardHeader>
          <CardContent>
            {loadingBatches ? (
              <div className="space-y-3">
                {[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />)}
              </div>
            ) : recentBatches && recentBatches.length > 0 ? (
              <div className="space-y-2">
                {recentBatches.map(b => (
                  <div key={b.id} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
                    <div className="min-w-0">
                      <p className="text-sm truncate font-medium">{b.file_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {b.upload_type.replace('_', ' ')} · {b.row_count} rows
                      </p>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      b.status === 'processed' ? 'status-matched' :
                      b.status === 'error' ? 'status-exception' : 'status-pending'
                    }`}>
                      {b.status}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-4 text-center">No uploads yet</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* BU Summary */}
      {buSummary && buSummary.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">BU Allocation Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full table-dense">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-xs font-medium text-muted-foreground py-2">Entity</th>
                    <th className="text-left text-xs font-medium text-muted-foreground py-2">Department</th>
                    <th className="text-right text-xs font-medium text-muted-foreground py-2">Lines</th>
                    <th className="text-right text-xs font-medium text-muted-foreground py-2">Total</th>
                    <th className="text-right text-xs font-medium text-muted-foreground py-2">Confirmed</th>
                  </tr>
                </thead>
                <tbody>
                  {buSummary.map((row: any, i: number) => (
                    <tr key={i} className="border-b border-border/50 last:border-0">
                      <td className="py-2 text-sm font-medium">{row.entity_code}</td>
                      <td className="py-2 text-sm">{row.department_name}</td>
                      <td className="py-2 text-sm text-right tabular-nums">{row.line_count}</td>
                      <td className="py-2 text-sm text-right tabular-nums">{formatCurrency(Number(row.total_amount))}</td>
                      <td className="py-2 text-sm text-right tabular-nums">{formatCurrency(Number(row.confirmed_amount))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function KpiCard({ title, subtitle, value, icon: Icon, loading, accent, warning, onClick, active }: {
  title: string;
  subtitle?: string;
  value: string | number | null;
  icon: any;
  loading: boolean;
  accent?: boolean;
  warning?: boolean;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <Card
      className={`transition-all ${onClick ? 'cursor-pointer hover:border-primary/40' : ''} ${active ? 'border-primary ring-1 ring-primary/20' : ''}`}
      onClick={onClick}
    >
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{title}</p>
              {onClick && (
                active
                  ? <ChevronDown size={12} className="text-primary" />
                  : <ChevronRight size={12} className="text-muted-foreground" />
              )}
            </div>
            {subtitle && <p className="text-[10px] text-muted-foreground/70 mt-0.5">{subtitle}</p>}
            {loading ? (
              <Skeleton className="h-8 w-24 mt-1" />
            ) : (
              <p className={`text-2xl font-semibold mt-1 tabular-nums ${
                accent ? 'text-primary' : warning ? 'text-destructive' : ''
              }`} data-testid={`text-kpi-${title.toLowerCase().replace(/\s/g, '-')}`}>
                {value}
              </p>
            )}
          </div>
          <div className={`p-2 rounded-lg ${accent ? 'bg-primary/10' : warning ? 'bg-destructive/10' : 'bg-muted'}`}>
            <Icon size={18} className={accent ? 'text-primary' : warning ? 'text-destructive' : 'text-muted-foreground'} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
