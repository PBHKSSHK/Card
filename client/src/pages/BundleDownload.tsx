import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Download, Package, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import JSZip from "jszip";
import { saveAs } from "file-saver";

interface UploadBatch {
  id: string;
  file_name: string;
  file_path: string | null;
  upload_type: string;
  card_last4: string | null;
  statement_period: string | null;
  statement_total: number | null;
  period_month: string | null;
  uploaded_at: string;
  row_count: number | null;
}

interface MetaInvoice {
  id: string;
  invoice_number: string;
  amount: number | null;
  amount_hkd: number | null;
  invoice_date: string | null;
  account_name: string | null;
  batch_id: string;
}

interface CardTransaction {
  id: string;
  batch_id: string;
  merchant: string;
  amount: number;
  amount_hkd: number | null;
  txn_date: string;
  card_last4: string | null;
}

interface ReconResult {
  transaction_id: string;
  invoice_id: string | null;
}

interface NsCcAccount {
  card_last4: string | null;
  card_identifier: string;
  subsidiary: string;
}

// Sanitize a single filename SEGMENT (strips "/" — must not be used on a full path)
function safe(s: string): string {
  return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80);
}

// Sanitize a full path by cleaning each segment separately and keeping the "/"
// separators, so subsidiary sub-folders survive instead of being flattened into one name.
function safePath(p: string): string {
  return p.split("/").map(safe).filter(Boolean).join("/");
}

export default function BundleDownload() {
  const { toast } = useToast();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadingMonth, setDownloadingMonth] = useState<string | null>(null);

  // Fetch CC statement batches only
  const { data: ccBatches, isLoading } = useQuery<UploadBatch[]>({
    queryKey: ["bundle-cc-batches"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("upload_batches")
        .select("*")
        .eq("upload_type", "cc_statement")
        .order("statement_period", { ascending: false })
        .order("card_last4");
      if (error) throw error;
      return (data || []) as UploadBatch[];
    },
  });

  // Fetch all invoice batches (so we can find invoice file_paths)
  const { data: invoiceBatches } = useQuery<UploadBatch[]>({
    queryKey: ["bundle-invoice-batches"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("upload_batches")
        .select("*")
        .eq("upload_type", "meta_invoice");
      if (error) throw error;
      return (data || []) as UploadBatch[];
    },
  });

  // Fetch all invoices
  const { data: invoices } = useQuery<MetaInvoice[]>({
    queryKey: ["bundle-invoices"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("meta_invoices")
        .select("id,invoice_number,amount,amount_hkd,invoice_date,account_name,batch_id");
      if (error) throw error;
      return (data || []) as MetaInvoice[];
    },
  });

  // Fetch all CC transactions
  const { data: ccTxns } = useQuery<CardTransaction[]>({
    queryKey: ["bundle-cc-txns"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("card_transactions")
        .select("id,batch_id,merchant,amount,amount_hkd,txn_date,card_last4");
      if (error) throw error;
      return (data || []) as CardTransaction[];
    },
  });

  // Fetch recon results
  const { data: recons } = useQuery<ReconResult[]>({
    queryKey: ["bundle-recons"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reconciliation_results")
        .select("transaction_id,invoice_id")
        .not("invoice_id", "is", null);
      if (error) throw error;
      return (data || []) as ReconResult[];
    },
  });

  // Fetch CC accounts (for nickname)
  const { data: ccAccounts } = useQuery<NsCcAccount[]>({
    queryKey: ["bundle-cc-accounts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ns_credit_card_accounts")
        .select("card_last4,card_identifier,subsidiary");
      if (error) throw error;
      return (data || []) as NsCcAccount[];
    },
  });

  // Indexes
  const invoiceById = useMemo(() => {
    const m = new Map<string, MetaInvoice>();
    (invoices || []).forEach(i => m.set(i.id, i));
    return m;
  }, [invoices]);

  const invoiceBatchById = useMemo(() => {
    const m = new Map<string, UploadBatch>();
    (invoiceBatches || []).forEach(b => m.set(b.id, b));
    return m;
  }, [invoiceBatches]);

  const txnsByBatch = useMemo(() => {
    const m = new Map<string, CardTransaction[]>();
    (ccTxns || []).forEach(t => {
      if (!m.has(t.batch_id)) m.set(t.batch_id, []);
      m.get(t.batch_id)!.push(t);
    });
    return m;
  }, [ccTxns]);

  const invoiceByTxnId = useMemo(() => {
    const m = new Map<string, string>();
    (recons || []).forEach(r => {
      if (r.invoice_id) m.set(r.transaction_id, r.invoice_id);
    });
    return m;
  }, [recons]);

  const nicknameByLast4 = useMemo(() => {
    const m = new Map<string, { nickname: string; subsidiary: string }>();
    (ccAccounts || []).forEach(a => {
      if (a.card_last4) m.set(a.card_last4, { nickname: a.card_identifier, subsidiary: a.subsidiary });
    });
    return m;
  }, [ccAccounts]);

  // Group CC batches by period_month for month bundle
  const monthGroups = useMemo(() => {
    const m = new Map<string, UploadBatch[]>();
    (ccBatches || []).forEach(b => {
      const month = b.period_month || (b.statement_period?.split(" ")[0] || "unknown");
      if (!m.has(month)) m.set(month, []);
      m.get(month)!.push(b);
    });
    return Array.from(m.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [ccBatches]);

  // Download a file from Supabase storage
  async function downloadFromStorage(filePath: string): Promise<Blob | null> {
    try {
      const { data, error } = await supabase.storage.from("documents").download(filePath);
      if (error || !data) {
        console.error("Download failed", filePath, error);
        return null;
      }
      return data;
    } catch (e) {
      console.error("Download exception", filePath, e);
      return null;
    }
  }

  // Build bundle for one statement batch
  async function buildStatementBundle(batch: UploadBatch): Promise<JSZip> {
    const zip = new JSZip();
    const nick = batch.card_last4 ? nicknameByLast4.get(batch.card_last4) : undefined;
    const folderName = `Statement_${batch.statement_period || batch.period_month || "unknown"}_${nick?.nickname || "Card"}_${batch.card_last4 || "----"}`;
    const root = zip.folder(safe(folderName))!;

    // 1. Statement PDF
    if (batch.file_path) {
      const blob = await downloadFromStorage(batch.file_path);
      if (blob) {
        root.file(`00_statement_${safe(batch.file_name)}`, blob);
      }
    }

    // 2. All transactions + matched invoices
    const txns = (txnsByBatch.get(batch.id) || []).sort((a, b) => a.txn_date.localeCompare(b.txn_date));
    const invoicesFolder = root.folder("invoices")!;
    const summary: string[] = [
      "# Statement Bundle Summary",
      "",
      `**Statement**: ${batch.file_name}`,
      `**Card**: ${nick?.nickname || "?"} ····${batch.card_last4 || "----"}`,
      `**Subsidiary**: ${nick?.subsidiary || "?"}`,
      `**Period**: ${batch.statement_period || "?"}`,
      `**Total HKD**: ${batch.statement_total ?? "?"}`,
      `**Transactions**: ${txns.length}`,
      "",
      "## Transactions",
      "",
      "| # | Date | Merchant | HKD | Invoice | File |",
      "| - | --- | --- | --- | --- | --- |",
    ];

    let invoiceSeq = 0;
    for (let i = 0; i < txns.length; i++) {
      const t = txns[i];
      const invId = invoiceByTxnId.get(t.id);
      const inv = invId ? invoiceById.get(invId) : undefined;
      let invFileName = "—";
      if (inv) {
        const invBatch = invoiceBatchById.get(inv.batch_id);
        if (invBatch?.file_path) {
          invoiceSeq++;
          const blob = await downloadFromStorage(invBatch.file_path);
          if (blob) {
            invFileName = `${String(invoiceSeq).padStart(2, "0")}_${safe(inv.invoice_number)}_${safe(invBatch.file_name)}`;
            invoicesFolder.file(invFileName, blob);
          }
        }
      }
      summary.push(
        `| ${i + 1} | ${t.txn_date} | ${(t.merchant || "").replace(/\|/g, "/")} | ${(t.amount_hkd ?? t.amount).toFixed(2)} | ${inv?.invoice_number || "—"} | ${invFileName} |`
      );
    }

    root.file("README.md", summary.join("\n"));
    return zip;
  }

  // Download single statement bundle
  async function downloadStatement(batch: UploadBatch) {
    setDownloadingId(batch.id);
    try {
      const zip = await buildStatementBundle(batch);
      const blob = await zip.generateAsync({ type: "blob" });
      const nick = batch.card_last4 ? nicknameByLast4.get(batch.card_last4) : undefined;
      saveAs(blob, `Statement_${batch.statement_period || "x"}_${nick?.nickname || "card"}_${batch.card_last4 || "----"}.zip`);
      toast({ title: "Bundle ready", description: `Downloaded ${batch.file_name}` });
    } catch (e: any) {
      toast({ title: "Download failed", description: e.message, variant: "destructive" });
    } finally {
      setDownloadingId(null);
    }
  }

  // Download month bundle (all statements for a month)
  async function downloadMonth(month: string, batches: UploadBatch[]) {
    setDownloadingMonth(month);
    try {
      const masterZip = new JSZip();
      for (let i = 0; i < batches.length; i++) {
        const b = batches[i];
        const sub = await buildStatementBundle(b);
        // Merge sub's files into masterZip
        const subBlob = await sub.generateAsync({ type: "blob" });
        const nick = b.card_last4 ? nicknameByLast4.get(b.card_last4) : undefined;
        // Sanitize each path segment (keep "/" so the subsidiary sub-folder survives) and
        // prefix a unique index so two statements for the same card in a month don't collide/overwrite.
        masterZip.file(
          safePath(`${nick?.subsidiary || "Unknown"}/${String(i + 1).padStart(2, "0")}_Statement_${nick?.nickname || "card"}_${b.card_last4 || "----"}.zip`),
          subBlob
        );
      }
      const blob = await masterZip.generateAsync({ type: "blob" });
      saveAs(blob, `Month_${month}_AllStatements.zip`);
      toast({ title: "Month bundle ready", description: `${batches.length} statements packed` });
    } catch (e: any) {
      toast({ title: "Download failed", description: e.message, variant: "destructive" });
    } finally {
      setDownloadingMonth(null);
    }
  }

  if (isLoading) return <Skeleton className="h-96" />;

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Package size={20} /> File Bundle Download
        </h1>
        <p className="text-sm text-muted-foreground">
          一鍵下載 credit card statement + 對應 invoices，按 statement 排好序
        </p>
      </div>

      {/* Month bundles */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">📅 整月下載 (Month bundle)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {monthGroups.map(([month, batches]) => (
              <div key={month} className="flex items-center justify-between p-2 border border-border rounded">
                <div>
                  <span className="font-medium text-sm">{month}</span>
                  <span className="text-xs text-muted-foreground ml-2">
                    {batches.length} statement{batches.length > 1 ? "s" : ""} · {batches.reduce((s, b) => s + (b.row_count || 0), 0)} txns
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => downloadMonth(month, batches)}
                  disabled={downloadingMonth === month}
                >
                  {downloadingMonth === month ? (
                    <><Loader2 size={14} className="mr-1.5 animate-spin" /> Packing...</>
                  ) : (
                    <><Download size={14} className="mr-1.5" /> Download ZIP</>
                  )}
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Individual statements */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">💳 單張 Statement (Per-statement bundle)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1">
            {(ccBatches || []).map(b => {
              const nick = b.card_last4 ? nicknameByLast4.get(b.card_last4) : undefined;
              const matchedCount = (txnsByBatch.get(b.id) || []).filter(t => invoiceByTxnId.has(t.id)).length;
              const totalTxns = (txnsByBatch.get(b.id) || []).length;
              return (
                <div key={b.id} className="flex items-center justify-between p-2 border border-border rounded text-sm">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{nick?.nickname || "?"} ····{b.card_last4 || "----"}</span>
                      <Badge variant="outline" className="text-xs">{nick?.subsidiary || "?"}</Badge>
                      <span className="text-xs text-muted-foreground">{b.statement_period}</span>
                    </div>
                    <div className="text-xs text-muted-foreground truncate" title={b.file_name}>
                      {b.file_name} · {totalTxns} txns ({matchedCount} matched) · HK${b.statement_total?.toFixed(2) || "?"}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => downloadStatement(b)}
                    disabled={downloadingId === b.id}
                    className="ml-2 flex-shrink-0"
                  >
                    {downloadingId === b.id ? (
                      <><Loader2 size={14} className="mr-1.5 animate-spin" /> Packing...</>
                    ) : (
                      <><Download size={14} className="mr-1.5" /> ZIP</>
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
