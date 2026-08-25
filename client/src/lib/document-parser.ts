import * as pdfjsLib from "pdfjs-dist";
import { supabase } from "./supabase";

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).toString();

export type DocType = "cc_statement" | "meta_invoice" | "bank_statement" | "auto";

export interface ParsedTransaction {
  date: string;
  post_date?: string | null;
  merchant: string;
  amount: number;
  amount_hkd?: number | null;  // HKD equivalent when transaction is in foreign currency
  currency: string;
  fx_rate?: number | null;     // Exchange rate if shown on statement (e.g. 7.82 for USD→HKD)
  reference?: string;
  card_last4?: string;
  description?: string;
}

export interface ParsedInvoice {
  invoice_number: string;
  billing_period?: string;
  amount: number;
  currency: string;
  invoice_date?: string;
  account_name?: string;
  account_id?: string;
  description?: string;
  children?: ParsedInvoice[];
}

// 銀行月結單 (bank_statement) 每行交易 — Bank Upload Centre PDF 上載用
export interface BankStatementRow {
  date: string;
  description: string;
  reference?: string | null;
  debit?: number | null;
  credit?: number | null;
  balance?: number | null;
}

export interface ParseResult {
  type: DocType;
  transactions?: ParsedTransaction[];
  invoices?: ParsedInvoice[];
  bank_rows?: BankStatementRow[];
  metadata?: Record<string, any>;
  rawText?: string;
}

/**
 * Extract text from an electronic PDF using pdf.js
 */
async function extractPdfText(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const typedArray = new Uint8Array(arrayBuffer);
  const pdf = await pdfjsLib.getDocument(typedArray).promise;

  const pageTexts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item: any) => item.str)
      .join(" ");
    pageTexts.push(pageText);
  }

  return pageTexts.join("\n\n--- PAGE BREAK ---\n\n");
}

/**
 * Convert a file to a base64 data URL
 */
async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Convert PDF pages to images for OCR (for scanned PDFs).
 * Uses scale 1.5 and JPEG quality 0.7 to keep payload under 6 MB.
 */
async function pdfToImages(file: File): Promise<string[]> {
  const arrayBuffer = await file.arrayBuffer();
  const typedArray = new Uint8Array(arrayBuffer);
  const pdf = await pdfjsLib.getDocument(typedArray).promise;

  const images: string[] = [];
  const scale = 1.5;
  const jpegQuality = 0.7;

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d")!;

    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const dataUrl = canvas.toDataURL("image/jpeg", jpegQuality);
    console.log(`[CardRecon] Page ${i}: ${(dataUrl.length / 1024).toFixed(0)} KB base64`);
    images.push(dataUrl);
  }

  return images;
}

/**
 * Check if extracted text has meaningful, readable content.
 * Returns false for:
 * - Scanned PDFs with no text
 * - PDFs with garbled/encoded fonts (common with AE/AMEX statements)
 * - Web page PDFs (HKTVmall etc.) where amounts are truncated in text mode
 *
 * Detection strategy:
 * 1. Too short = scanned
 * 2. Extended Latin chars (Ã,Â,Å,Ä,Æ,È,Ö,Ù,Ò,Ñ,Ô etc.) ratio > 0.15 = garbled font
 * 3. Control-like chars (¢,£,¤,¥,¨,©,«,¬,®,±,¶,·,»,¼,½,¾) ratio > 0.05 = garbled font
 * 4. Very few alphanumeric chars relative to total = garbled
 * 5. HKTVmall / web page receipts = amounts truncated in text, use image mode
 */
function hasUsableText(text: string, fileName?: string): boolean {
  const cleaned = text.replace(/--- PAGE BREAK ---/g, "").replace(/\s+/g, " ").trim();
  if (cleaned.length < 50) return false;

  // Web page receipts (HKTVmall, etc.) — text extraction truncates amounts
  // These are better parsed via image/vision mode
  const isWebPageReceipt = /hktvmall|HKTVmall|香港最大網購平台|訂單摘要|付款總額/.test(cleaned)
    || (fileName && /hktvmall/i.test(fileName));
  if (isWebPageReceipt) {
    console.log(`[CardRecon] Web page receipt detected (HKTVmall) — forcing image mode for accurate amounts`);
    return false;
  }

  // Count character classes
  const extendedLatin = (cleaned.match(/[\u00C0-\u00FF]/g) || []).length;
  const controlLike = (cleaned.match(/[\u00A0-\u00BF]/g) || []).length; // ¢£¤¥¨©«¬®±¶·»¼½¾
  const alphanum = (cleaned.match(/[a-zA-Z0-9]/g) || []).length;
  const cjk = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
  const readableChars = alphanum + cjk;

  // Detect (cid:xxx) garbled font encoding (common in AE/AMEX statements)
  const cidMatches = (cleaned.match(/\(cid:\d+\)/g) || []).length;

  console.log(`[CardRecon] Text analysis: len=${cleaned.length}, extLatin=${extendedLatin}, ctrlLike=${controlLike}, alphanum=${alphanum}, cjk=${cjk}, cidRefs=${cidMatches}`);

  // If almost no readable text
  if (readableChars < 20 && cleaned.length > 100) return false;

  // (cid:xxx) references indicate garbled PDF font encoding — use image mode
  if (cidMatches > 10) return false;

  // Extended Latin ratio (lowered from 0.3 to 0.15 to catch AE cards)
  if (readableChars > 0 && extendedLatin / readableChars > 0.15) return false;

  // Control-like chars ratio — normal text has very few of these
  if (readableChars > 0 && controlLike / readableChars > 0.05) return false;

  return true;
}

/**
 * Parse a document (PDF or image) by extracting data and calling the Edge Function
 */
export async function parseDocument(
  file: File,
  type: DocType = "auto",
  onProgress?: (step: string) => void
): Promise<ParseResult> {
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  const isImage = file.type.startsWith("image/") || /\.(jpg|jpeg|png|webp)$/i.test(file.name);

  let text: string | undefined;
  let images: string[] | undefined;

  if (isPdf) {
    onProgress?.("Extracting text from PDF...");
    let extractedText = "";
    try {
      extractedText = await extractPdfText(file);
    } catch (e) {
      console.warn("[CardRecon] Text extraction failed, using image mode:", e);
    }

    const usable = hasUsableText(extractedText, file.name);
    console.log(`[CardRecon] hasUsableText = ${usable}, textLen = ${extractedText.length}`);

    if (usable) {
      // Electronic PDF with readable text — use text mode
      text = extractedText;
      onProgress?.("Text extracted. Parsing with AI...");
    } else {
      // Scanned PDF or garbled font encoding — convert to images for OCR
      onProgress?.(extractedText.length > 50
        ? "Font encoding issue detected. Converting to images for OCR..."
        : "Scanned PDF detected. Converting pages to images...");
      try {
        images = await pdfToImages(file);
        console.log(`[CardRecon] Converted ${images.length} pages to images`);
        const totalB64 = images.reduce((s, img) => s + img.length, 0);
        console.log(`[CardRecon] Total image payload: ${(totalB64 / 1024 / 1024).toFixed(2)} MB`);
      } catch (imgErr) {
        console.error("[CardRecon] pdfToImages failed:", imgErr);
        throw new Error(`Failed to convert PDF to images: ${(imgErr as Error).message}`);
      }
      onProgress?.(`${images.length} page(s) converted. Parsing with AI...`);
    }
  } else if (isImage) {
    onProgress?.("Processing image...");
    const base64 = await fileToBase64(file);
    images = [base64];
    onProgress?.("Image loaded. Parsing with AI...");
  } else {
    throw new Error(`Unsupported file type: ${file.type || file.name}`);
  }

  // Call the Edge Function — it requires a real signed-in user (the anon key
  // alone is rejected since it could otherwise spend the project's OpenAI quota).
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  if (!accessToken) {
    throw new Error("Not signed in — please log in before uploading documents (請先登入).");
  }
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;

  // Get API key from localStorage (set in Settings page).
  // If empty, the Edge Function will fall back to the OPENAI_API_KEY Supabase secret.
  const apiKey = localStorage.getItem("cardrecon_api_key") || undefined;

  const payload = JSON.stringify({
    type,
    text,
    images,
    file_name: file.name,
    api_key: apiKey,
  });
  console.log(`[CardRecon] Sending to Edge Function: mode=${images ? 'vision' : 'text'}, payload=${(payload.length / 1024 / 1024).toFixed(2)} MB`);

  // Retry logic for rate-limited or transient errors
  let response: Response | null = null;
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    response = await fetch(`${supabaseUrl}/functions/v1/parse-document`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        apikey: anonKey,
      },
      body: payload,
    });

    if (response.ok) break;

    // Retry on 429 (rate limit) or 502/503/504/546 (transient server errors)
    const retryable = [429, 502, 503, 504, 546].includes(response.status);
    if (retryable && attempt < maxRetries) {
      // Exponential backoff with jitter: 3-5s, 6-10s, 12-20s
      const baseSec = (attempt + 1) * 3;
      const jitter = Math.random() * 2;
      const waitSec = baseSec + jitter;
      console.warn(`[CardRecon] Got ${response.status}, retrying in ${waitSec.toFixed(1)}s (attempt ${attempt + 1}/${maxRetries})`);
      onProgress?.(`Server busy. Retrying in ${Math.ceil(waitSec)}s...`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      continue;
    }

    const errBody = await response.json().catch(() => ({ error: "Unknown error" }));
    console.error(`[CardRecon] Edge Function error:`, response.status, errBody);
    throw new Error(errBody.error || `Parse failed: ${response.status}`);
  }

  const result = await response!.json();

  if (!result.success) {
    throw new Error(result.error || "Parse failed");
  }

  // Use the type returned by Edge Function (may differ from request if auto-classified)
  const detectedType: DocType = result.type || type;
  onProgress?.(`Parsing complete! Detected: ${
    detectedType === "cc_statement" ? "CC Statement"
    : detectedType === "bank_statement" ? "Bank Statement"
    : "Invoice"}`);

  // Edge Function may return metadata at top level or nested under .metadata
  const md = result.data.metadata || result.data;

  if (detectedType === "cc_statement") {
    return {
      type: detectedType,
      transactions: result.data.transactions || [],
      metadata: {
        statement_period: md.statement_period || result.data.statement_period,
        statement_date: md.statement_date || result.data.statement_date,
        statement_due_date: md.statement_due_date || result.data.statement_due_date,
        card_last4: md.card_last4 || result.data.card_last4,
        total_amount: md.total_amount ?? result.data.total_amount,
        previous_balance: md.previous_balance ?? result.data.previous_balance ?? 0,
        transactions_sum: md.transactions_sum ?? result.data.transactions_sum,
        bank: md.bank || result.data.bank,
        cardholder: md.cardholder,
        account_number: md.account_number,
      },
      rawText: text,
    };
  } else if (detectedType === "bank_statement") {
    return {
      type: detectedType,
      bank_rows: result.data.transactions || [],
      metadata: {
        bank: md.bank || result.data.bank,
        account_number: md.account_number,
        statement_period: md.statement_period,
        currency: md.currency,
        opening_balance: md.opening_balance,
        closing_balance: md.closing_balance,
        total_debits: md.total_debits,
        total_credits: md.total_credits,
      },
      rawText: text,
    };
  } else {
    // Attach children (Meta campaign line items) to the parent invoice
    const invoices: ParsedInvoice[] = result.data.invoices || [];
    const children: ParsedInvoice[] = result.data.children || [];
    if (invoices.length > 0 && children.length > 0) {
      invoices[0].children = children;
    }
    return {
      type: detectedType,
      invoices,
      metadata: {
        vendor: md.vendor || result.data.vendor,
        total_amount: md.total_amount ?? result.data.total_amount,
        // 發票上印嘅收款銀行資料 / FPS (付款申請自動填付款資料用)
        payment_info: md.payment_info ?? result.data.payment_info ?? null,
      },
      rawText: text,
    };
  }
}
