import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Landmark, Upload, Loader2, Trash2, Eye, FileSpreadsheet } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { UploadBatch } from "@shared/schema";
import { parseDocument, type BankStatementRow } from "@/lib/document-parser";
import { usePagination, PaginationFooter } from "@/components/PaginationFooter";

// Bank statement Upload Centre: XLSX/CSV/PDF → bank_transactions (Bank Recon 左邊).
// 銀行月結單匯出格式各有不同，所以 XLSX/CSV parse 完會顯示欄位對應俾用戶自己
// 調整；PDF 就交俾 AI (parse-document Edge Function, bank_statement type) 解析，
// 電子 PDF 行文字模式、掃描版自動轉圖 OCR。確認 preview 無誤先入庫。

const SUBSIDIARIES: { code: string; name: string }[] = [
  { code: "PBHK", name: "Photoblog.hk Limited" },
  { code: "SSHK", name: "Social Strategy Hong Kong Limited" },
  { code: "CLS", name: "CLS Production Limited" },
  { code: "JM", name: "Jervois M Limited" },
  { code: "704", name: "704 Production Limited" },
  { code: "EXT", name: "ExtravelIsm" },
  { code: "JS", name: "Jervois Solution" },
];

// Target fields a statement column can map to
type FieldKey = "ignore" | "date" | "description" | "reference" | "debit" | "credit" | "balance" | "amount";
const FIELD_OPTIONS: { key: FieldKey; label: string }[] = [
  { key: "ignore", label: "— 忽略 —" },
  { key: "date", label: "日期 Date" },
  { key: "description", label: "描述 Description" },
  { key: "reference", label: "Reference" },
  { key: "debit", label: "支出 Debit (錢出)" },
  { key: "credit", label: "存入 Credit (錢入)" },
  { key: "balance", label: "結餘 Balance" },
  { key: "amount", label: "金額 Amount (+入 / −出)" },
];

// Auto-detect a header cell → target field
function guessField(header: string): FieldKey {
  const h = header.trim().toLowerCase();
  if (!h) return "ignore";
  if (/(^|\b)(date|value date|txn date|transaction date|post date)|日期/.test(h)) return "date";
  if (/balance|結餘|餘額/.test(h)) return "balance";
  if (/debit|withdraw|paid out|money out|支出|提款|借方|扣賬/.test(h)) return "debit";
  if (/credit|deposit|paid in|money in|存入|存款|貸方|入賬/.test(h)) return "credit";
  if (/^(amount|amt)$|^金額$/.test(h)) return "amount";
  if (/reference|ref\.?$|cheque|chq|票據|編號/.test(h)) return "reference";
  if (/desc|detail|particular|narrative|transaction|摘要|說明|描述|項目/.test(h)) return "description";
  return "ignore";
}

// Excel serial or common string formats → 'YYYY-MM-DD' (or null)
function normalizeDate(v: any): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && isFinite(v) && v > 20000 && v < 60000) {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);                    // yyyy-mm-dd
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);                        // dd/mm/yyyy (HK 銀行標準)
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,})[-/. ](\d{2,4})/);               // dd MMM yyyy / dd-Jan-26
  if (m) {
    const mon = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]
      .indexOf(m[2].slice(0, 3).toLowerCase());
    if (mon >= 0) {
      const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
      return `${yr}-${String(mon + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    }
  }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/);                       // dd/mm/yy
  if (m) return `20${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

// "1,234.56" / "(1,234.56)" / "1234.56 CR" → number (or null)
function normalizeAmount(v: any): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  let s = String(v).replace(/[,\s]|HKD|HK\$|\$/gi, "").trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/DR$/i.test(s)) { neg = true; s = s.replace(/DR$/i, ""); }
  s = s.replace(/CR$/i, "");
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

type ParsedRow = {
  txn_date: string;
  description: string;
  reference: string | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
};

function fmt(n: number | null | undefined): string {
  if (n == null) return "";
  return n.toLocaleString("en-HK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function BankUploadCentre() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  // Upload form state
  const [subsidiary, setSubsidiary] = useState("");
  const [bankName, setBankName] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [grid, setGrid] = useState<any[][]>([]);       // raw cells below the header row
  const [headers, setHeaders] = useState<string[]>([]); // detected header row
  const [mapping, setMapping] = useState<FieldKey[]>([]); // per-column target field
  const [parseError, setParseError] = useState("");

  // PDF (AI 解析) 路徑 — 冇欄位對應，直接出 preview rows
  const [pdfRows, setPdfRows] = useState<ParsedRow[] | null>(null);
  const [pdfMeta, setPdfMeta] = useState<Record<string, any> | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfProgress, setPdfProgress] = useState("");

  // ---- file parsing ----
  const loadGrid = (rows: any[][]) => {
    // Header row = first row where ≥2 cells look like known statement headers
    // (bank exports often have preamble rows above the table).
    let headerIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const hits = (rows[i] || []).filter((c) => guessField(String(c ?? "")) !== "ignore").length;
      if (hits >= 2) { headerIdx = i; break; }
    }
    if (headerIdx < 0) {
      setParseError("搵唔到表頭行 — 檔案入面要有 Date/日期 同 Debit/Credit/金額 等欄位名");
      setHeaders([]); setGrid([]); setMapping([]);
      return;
    }
    const hdr = (rows[headerIdx] || []).map((c) => String(c ?? "").trim());
    setHeaders(hdr);
    setMapping(hdr.map(guessField));
    setGrid(rows.slice(headerIdx + 1).filter((r) => (r || []).some((c) => c !== "" && c != null)));
    setParseError("");
  };

  // PDF → parse-document Edge Function (bank_statement)。AI 已經自我核對
  // opening + credits − debits = closing；出返嚟仍然過一次 normalize 保險。
  const handlePdf = async (f: File) => {
    setPdfBusy(true);
    setPdfRows(null); setPdfMeta(null); setParseError("");
    try {
      const res = await parseDocument(f, "bank_statement", setPdfProgress);
      const out: ParsedRow[] = [];
      for (const r of (res.bank_rows || []) as BankStatementRow[]) {
        const txn_date = normalizeDate(r.date);
        let debit = normalizeAmount(r.debit);
        let credit = normalizeAmount(r.credit);
        if (debit != null) debit = Math.abs(debit);
        if (credit != null) credit = Math.abs(credit);
        if (!txn_date || (debit == null && credit == null)) continue;
        out.push({
          txn_date,
          description: String(r.description || "").trim() || "(no description)",
          reference: r.reference ? String(r.reference).trim() : null,
          debit, credit,
          balance: normalizeAmount(r.balance),
        });
      }
      if (out.length === 0) throw new Error("解析唔到任何交易行 — 請檢查係咪銀行月結單 PDF");
      setPdfRows(out);
      setPdfMeta(res.metadata || null);
      // 順手帶入銀行/戶口 (冇填先至填)
      if (!bankName && res.metadata?.bank) setBankName(String(res.metadata.bank));
      if (!bankAccount && res.metadata?.account_number) setBankAccount(String(res.metadata.account_number));
      toast({ title: "PDF 解析完成 ✓", description: `讀到 ${out.length} 行交易，請核對 preview 先匯入` });
    } catch (err: any) {
      setParseError(`PDF 解析失敗: ${err.message || err}`);
    } finally {
      setPdfBusy(false);
      setPdfProgress("");
    }
  };

  const handleFile = (f: File) => {
    setFile(f);
    setPdfRows(null); setPdfMeta(null);
    if (/\.pdf$/i.test(f.name)) {
      setHeaders([]); setGrid([]); setMapping([]);
      void handlePdf(f);
    } else if (/\.xlsx?$/i.test(f.name)) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(new Uint8Array(e.target?.result as ArrayBuffer), { type: "array" });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          loadGrid(XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true }) as any[][]);
        } catch (err: any) {
          setParseError(`讀取 Excel 失敗: ${err.message}`);
        }
      };
      reader.readAsArrayBuffer(f);
    } else if (/\.csv$/i.test(f.name)) {
      Papa.parse(f, {
        skipEmptyLines: true,
        complete: (res) => loadGrid(res.data as any[][]),
        error: (err) => setParseError(`讀取 CSV 失敗: ${err.message}`),
      });
    } else {
      setParseError("只支援 .xlsx / .xls / .csv / .pdf 銀行月結單");
    }
  };

  // ---- rows derived from grid + mapping (PDF 路徑直接用 AI 解析結果) ----
  const { rows, skipped } = useMemo(() => {
    if (pdfRows) return { rows: pdfRows, skipped: 0 };
    const col = (k: FieldKey) => mapping.indexOf(k);
    const iDate = col("date"), iDesc = col("description"), iRef = col("reference");
    const iDebit = col("debit"), iCredit = col("credit"), iBal = col("balance"), iAmt = col("amount");
    const out: ParsedRow[] = [];
    let skip = 0;
    if (iDate < 0) return { rows: out, skipped: 0 };
    for (const r of grid) {
      const txn_date = normalizeDate(r[iDate]);
      let debit = iDebit >= 0 ? normalizeAmount(r[iDebit]) : null;
      let credit = iCredit >= 0 ? normalizeAmount(r[iCredit]) : null;
      if (iAmt >= 0 && debit == null && credit == null) {
        const amt = normalizeAmount(r[iAmt]);
        if (amt != null) { if (amt >= 0) credit = amt; else debit = Math.abs(amt); }
      }
      if (debit != null) debit = Math.abs(debit);
      if (credit != null) credit = Math.abs(credit);
      if (!txn_date || (debit == null && credit == null)) { skip++; continue; }
      out.push({
        txn_date,
        description: iDesc >= 0 ? String(r[iDesc] ?? "").trim() || "(no description)" : "(no description)",
        reference: iRef >= 0 ? String(r[iRef] ?? "").trim() || null : null,
        debit, credit,
        balance: iBal >= 0 ? normalizeAmount(r[iBal]) : null,
      });
    }
    return { rows: out, skipped: skip };
  }, [grid, mapping, pdfRows]);

  const totals = useMemo(() => ({
    debit: rows.reduce((s, r) => s + (r.debit || 0), 0),
    credit: rows.reduce((s, r) => s + (r.credit || 0), 0),
  }), [rows]);

  const resetForm = () => {
    setFile(null); setGrid([]); setHeaders([]); setMapping([]); setParseError("");
    setPdfRows(null); setPdfMeta(null);
  };

  // PDF 解析後對數檢查：開頭結餘 + 存入 − 支出 = 期末結餘 (差異 > $0.01 就警告)
  const pdfBalanceDiff = useMemo(() => {
    if (!pdfRows || !pdfMeta) return null;
    const open = Number(pdfMeta.opening_balance);
    const close = Number(pdfMeta.closing_balance);
    if (!isFinite(open) || !isFinite(close)) return null;
    const dr = pdfRows.reduce((s, r) => s + (r.debit || 0), 0);
    const cr = pdfRows.reduce((s, r) => s + (r.credit || 0), 0);
    const diff = open + cr - dr - close;
    return Math.abs(diff) > 0.01 ? diff : 0;
  }, [pdfRows, pdfMeta]);

  // ---- import ----
  const importMutation = useMutation({
    mutationFn: async () => {
      if (!subsidiary) throw new Error("請先揀公司 (Subsidiary)");
      if (!file || rows.length === 0) throw new Error("冇可入庫嘅交易行");

      // Duplicate guard: same file already imported for this subsidiary
      const { data: dup } = await supabase
        .from("upload_batches").select("id, uploaded_at")
        .eq("module", "bank").eq("file_name", file.name).eq("subsidiary", subsidiary)
        .limit(1);
      if (dup && dup.length > 0) {
        const ok = window.confirm(
          `「${file.name}」(${subsidiary}) 之前已經 upload 過 — 繼續會造成 duplicate 交易。\n\n確定要再入一次?`
        );
        if (!ok) throw new Error("已取消 (檔案重複)");
      }

      // Store the original file (best-effort — import continues even if this fails)
      const path = `bank/${Date.now()}_${file.name.replace(/[^\w.\-]+/g, "_")}`;
      const up = await supabase.storage.from("documents").upload(path, file);
      const filePath = up.error ? null : path;

      // period_month = most common transaction month in the file
      const monthCount = new Map<string, number>();
      for (const r of rows) {
        const m = r.txn_date.slice(0, 7);
        monthCount.set(m, (monthCount.get(m) || 0) + 1);
      }
      const periodMonth = [...monthCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

      const { data: batch, error: bErr } = await supabase.from("upload_batches").insert({
        file_name: file.name,
        upload_type: "bank_statement",
        status: "processed",
        row_count: rows.length,
        processed_at: new Date().toISOString(),
        subsidiary,
        bank: bankName || null,
        bank_account: bankAccount || null,
        period_month: periodMonth,
        user_id: user?.id ?? null,
        file_path: filePath,
        module: "bank",
      }).select("id").single();
      if (bErr) throw bErr;

      const records = rows.map((r) => ({
        batch_id: batch.id,
        subsidiary,
        bank_name: bankName || null,
        bank_account: bankAccount || null,
        txn_date: r.txn_date,
        description: r.description,
        reference: r.reference,
        debit: r.debit,
        credit: r.credit,
        balance: r.balance,
        currency: "HKD",
        period_month: r.txn_date.slice(0, 7),
        user_id: user?.id ?? null,
      }));
      for (let i = 0; i < records.length; i += 500) {
        const { error } = await supabase.from("bank_transactions").insert(records.slice(i, i + 500));
        if (error) throw error;
      }
      return rows.length;
    },
    onSuccess: (n) => {
      toast({ title: "匯入完成 ✓", description: `${n} 行交易已入庫，可以去 Bank Recon 對數` });
      resetForm();
      qc.invalidateQueries({ queryKey: ["bank-upload-batches"] });
      qc.invalidateQueries({ queryKey: ["bank-transactions"] });
      qc.invalidateQueries({ queryKey: ["bank-recon-results"] });
      qc.invalidateQueries({ queryKey: ["bank-subsidiaries"] });
    },
    onError: (e: Error) => toast({ title: "匯入失敗", description: e.message, variant: "destructive" }),
  });

  // ---- history ----
  const { data: batches } = useQuery({
    queryKey: ["bank-upload-batches"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("upload_batches").select("*")
        .eq("module", "bank")
        .order("uploaded_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data as UploadBatch[];
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (batch: UploadBatch) => {
      // 1. This batch's txn ids
      const ids: string[] = [];
      for (;;) {
        const { data, error } = await supabase
          .from("bank_transactions").select("id").eq("batch_id", batch.id)
          .range(ids.length, ids.length + 999);
        if (error) throw error;
        ids.push(...(data || []).map((r: any) => r.id));
        if (!data || data.length < 1000) break;
      }
      // 2. Free NetSuite GL entries matched to these txns, then drop recon rows
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        const { data: recon } = await supabase
          .from("bank_recon_results").select("target_id, target_type")
          .in("source_id", chunk);
        const glIds = (recon || [])
          .filter((r: any) => r.target_type === "ns_gl_entry" && r.target_id)
          .map((r: any) => r.target_id);
        for (let j = 0; j < glIds.length; j += 200) {
          const { error } = await supabase.from("ns_gl_entries")
            .update({ is_matched: false }).in("id", glIds.slice(j, j + 200));
          if (error) throw error;
        }
        const { error: delErr } = await supabase.from("bank_recon_results").delete().in("source_id", chunk);
        if (delErr) throw delErr;
      }
      // 3. Batch row (bank_transactions cascade on batch_id FK) + stored file
      const { error } = await supabase.from("upload_batches").delete().eq("id", batch.id);
      if (error) throw error;
      if ((batch as any).file_path) {
        await supabase.storage.from("documents").remove([(batch as any).file_path]).catch(() => undefined);
      }
    },
    onSuccess: () => {
      toast({ title: "已刪除", description: "月結單、交易同對數紀錄已一併移除" });
      qc.invalidateQueries({ queryKey: ["bank-upload-batches"] });
      qc.invalidateQueries({ queryKey: ["bank-transactions"] });
      qc.invalidateQueries({ queryKey: ["bank-recon-results"] });
      qc.invalidateQueries({ queryKey: ["gl-pool"] });
    },
    onError: (e: Error) => toast({ title: "刪除失敗", description: e.message, variant: "destructive" }),
  });

  const histPg = usePagination(batches || [], 20);
  const histRows = histPg.pageItems;

  const previewPg = usePagination(rows, 50);
  const pageRows = previewPg.pageItems;

  return (
    <div className="p-6 space-y-6 max-w-[1200px]">
      <div>
        <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2" data-testid="text-page-title">
          <Landmark className="h-5 w-5 text-blue-600" />
          Bank Upload Centre
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload 銀行月結單 (XLSX / CSV / PDF) → Bank Recon 左邊嘅 statement lines
        </p>
      </div>

      {/* Upload form */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Upload 銀行月結單</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-3 flex-wrap">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">公司 Subsidiary *</label>
              <Select value={subsidiary} onValueChange={setSubsidiary}>
                <SelectTrigger className="w-[240px]" data-testid="select-bank-subsidiary">
                  <SelectValue placeholder="揀公司…" />
                </SelectTrigger>
                <SelectContent>
                  {SUBSIDIARIES.map((s) => (
                    <SelectItem key={s.code} value={s.code}>{s.code} — {s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">銀行 Bank</label>
              <Input className="w-[180px]" placeholder="e.g. Hang Seng" value={bankName}
                onChange={(e) => setBankName(e.target.value)} data-testid="input-bank-name" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">戶口號碼 Account</label>
              <Input className="w-[200px]" placeholder="e.g. 123-456789-001" value={bankAccount}
                onChange={(e) => setBankAccount(e.target.value)} data-testid="input-bank-account" />
            </div>
          </div>

          {/* Dropzone */}
          <label
            className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-border rounded-lg p-8 cursor-pointer hover:bg-muted/40 transition-colors"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) handleFile(f);
            }}
            data-testid="bank-dropzone"
          >
            {pdfBusy
              ? <Loader2 className="h-8 w-8 text-muted-foreground animate-spin" />
              : <FileSpreadsheet className="h-8 w-8 text-muted-foreground" />}
            <span className="text-sm">{file ? file.name : "撳呢度揀檔案，或者拖入嚟"}</span>
            <span className="text-xs text-muted-foreground">
              支援 .xlsx / .xls / .csv (銀行網上理財匯出) 同 .pdf 月結單 (AI 解析，掃描版都得)
            </span>
            {pdfBusy && <span className="text-xs text-primary">{pdfProgress || "AI 解析緊 PDF…"}</span>}
            <input type="file" className="hidden" accept=".csv,.xlsx,.xls,.pdf"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
          </label>

          {parseError && <p className="text-sm text-destructive">{parseError}</p>}

          {/* PDF 解析摘要 + 對數檢查 */}
          {pdfRows && pdfMeta && (
            <div className="text-xs text-muted-foreground space-y-0.5">
              <div>
                {[pdfMeta.bank, pdfMeta.account_number, pdfMeta.statement_period].filter(Boolean).join(" · ") || "PDF 月結單"}
                {pdfMeta.opening_balance != null && <> · 期初 {fmt(Number(pdfMeta.opening_balance))}</>}
                {pdfMeta.closing_balance != null && <> · 期末 {fmt(Number(pdfMeta.closing_balance))}</>}
              </div>
              {pdfBalanceDiff != null && pdfBalanceDiff !== 0 && (
                <div className="text-amber-600 dark:text-amber-500">
                  ⚠ 對數檢查唔平：期初 + 存入 − 支出 同期末結餘差 {fmt(Math.abs(pdfBalanceDiff))} — AI 可能讀漏/讀錯行，請逐行核對先匯入
                </div>
              )}
              {pdfBalanceDiff === 0 && (
                <div className="text-emerald-600 dark:text-emerald-400">✓ 對數檢查通過：期初 + 存入 − 支出 = 期末結餘</div>
              )}
            </div>
          )}

          {/* Column mapping */}
          {headers.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">欄位對應 (自動偵測，可以改)</p>
              <div className="flex gap-2 flex-wrap">
                {headers.map((h, i) => (
                  <div key={i} className="space-y-1">
                    <div className="text-[11px] text-muted-foreground truncate max-w-[140px]" title={h}>{h || `(欄 ${i + 1})`}</div>
                    <Select value={mapping[i]} onValueChange={(v) => {
                      setMapping((m) => m.map((x, j) => (j === i ? (v as FieldKey) : x)));
                    }}>
                      <SelectTrigger className="h-7 w-[150px] text-xs" data-testid={`map-col-${i}`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {FIELD_OPTIONS.map((o) => (
                          <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Preview */}
          {(headers.length > 0 || pdfRows) && (
            <div>
              <p className="text-sm font-medium mb-2 flex items-center gap-1.5">
                <Eye size={14} />
                {rows.length} 行交易
                {skipped > 0 && <span className="text-xs text-muted-foreground font-normal">(略過 {skipped} 行無日期/金額)</span>}
                <span className="text-xs text-muted-foreground font-normal ml-2">
                  支出合計 {fmt(totals.debit)} · 存入合計 {fmt(totals.credit)}
                </span>
              </p>
              <div className="overflow-x-auto max-h-96 border rounded-md">
                <table className="w-full table-dense text-xs">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr>
                      <th className="text-left px-2 py-1.5 font-medium">日期</th>
                      <th className="text-left px-2 py-1.5 font-medium">描述</th>
                      <th className="text-left px-2 py-1.5 font-medium">Ref</th>
                      <th className="text-right px-2 py-1.5 font-medium">支出</th>
                      <th className="text-right px-2 py-1.5 font-medium">存入</th>
                      <th className="text-right px-2 py-1.5 font-medium">結餘</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r, i) => (
                      <tr key={`${previewPg.page}-${i}`} className="border-t border-border/50">
                        <td className="px-2 py-1 tabular-nums whitespace-nowrap">{r.txn_date}</td>
                        <td className="px-2 py-1 truncate max-w-[280px]">{r.description}</td>
                        <td className="px-2 py-1 truncate max-w-[120px] text-muted-foreground">{r.reference}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-red-600 dark:text-red-400">{fmt(r.debit)}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{fmt(r.credit)}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{fmt(r.balance)}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr><td colSpan={6} className="text-center text-muted-foreground py-4">
                        未有可入庫嘅行 — 檢查上面欄位對應 (日期 + 支出/存入/金額 必須有)
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <PaginationFooter {...previewPg.footerProps} />
              <div className="flex gap-2 mt-3">
                <Button onClick={() => importMutation.mutate()}
                  disabled={importMutation.isPending || rows.length === 0 || !subsidiary}
                  data-testid="button-import-bank">
                  {importMutation.isPending
                    ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    : <Upload className="h-4 w-4 mr-2" />}
                  匯入 {rows.length} 行
                </Button>
                <Button variant="outline" onClick={resetForm} disabled={importMutation.isPending}>清除</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Upload History */}
      {(batches?.length || 0) > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Upload History ({batches!.length} batches)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full table-dense">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-xs font-medium text-muted-foreground">File</th>
                    <th className="text-left text-xs font-medium text-muted-foreground">公司</th>
                    <th className="text-left text-xs font-medium text-muted-foreground">銀行</th>
                    <th className="text-left text-xs font-medium text-muted-foreground">Period</th>
                    <th className="text-right text-xs font-medium text-muted-foreground">Rows</th>
                    <th className="text-left text-xs font-medium text-muted-foreground">Uploaded</th>
                    <th className="text-center text-xs font-medium text-muted-foreground w-[60px]"></th>
                  </tr>
                </thead>
                <tbody>
                  {histRows.map((b) => (
                    <tr key={b.id} className="border-t border-border/50 text-sm">
                      <td className="py-1.5 pr-2 truncate max-w-[280px]" title={b.file_name}>{b.file_name}</td>
                      <td className="py-1.5 pr-2">{(b as any).subsidiary}</td>
                      <td className="py-1.5 pr-2 text-muted-foreground">{(b as any).bank}</td>
                      <td className="py-1.5 pr-2 tabular-nums">{(b as any).period_month}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{b.row_count}</td>
                      <td className="py-1.5 pr-2 text-muted-foreground whitespace-nowrap">
                        {new Date(b.uploaded_at).toLocaleString("en-HK", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td className="py-1.5 text-center">
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive"
                          disabled={deleteMutation.isPending}
                          onClick={() => {
                            if (window.confirm(
                              `刪除「${b.file_name}」?\n\n會一併刪除呢個 batch 嘅 ${b.row_count} 行交易同對數紀錄，已配對嘅 NetSuite 紀錄會退回未對數。`
                            )) deleteMutation.mutate(b);
                          }}
                          data-testid={`button-delete-bank-batch-${b.id}`}>
                          <Trash2 size={14} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PaginationFooter {...histPg.footerProps} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
