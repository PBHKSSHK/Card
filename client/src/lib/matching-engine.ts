import type { CardTransaction, MetaInvoice, MatchingRule, JournalSettings, MatchStatus, MatchType, BankTransaction, NsGlEntry } from "@shared/schema";
import { supabase } from "./supabase";

export interface MatchResult {
  transactionId: string;
  invoiceId: string | null;
  status: MatchStatus;
  matchType: MatchType | null;
  confidence: number;
  entityId: string;
  departmentId: string;
  drAccount: string;
  notes: string;
}

function wildcardMatch(pattern: string, text: string): boolean {
  const raw = (pattern || '').toUpperCase();
  // A keyword consisting solely of wildcards (e.g. "*") must match NOTHING —
  // previously it stripped all "*" leaving "", which matched every transaction.
  if (raw.replace(/\*/g, '').length === 0) return false;
  const t = text.toUpperCase();
  // No wildcard present: keep original "contains" behavior.
  if (!raw.includes('*')) return t.startsWith(raw) || t.includes(raw);
  // Treat "*" as a real wildcard so patterns like "FACEBK*ADS" match:
  // escape regex metachars, then convert the escaped \* back into .* (unanchored contains).
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(escaped).test(t);
}

// ============ Merchant aliases ============
// CC statement 嘅 merchant 名 (左) 與 invoice 嘅 account_name/description (右)
// 常常都不同字眼。這裡加可能包含到 invoice 嘅關鍵字，
// fuzzy similarity 就能揭到 (eg ALIPAY SINGAPORE -> Alibaba Cloud).
const MERCHANT_ALIASES: { pattern: RegExp; aliases: string[] }[] = [
  // 阿里雲 (Alipay Singapore = Alibaba Cloud Singapore billing)
  { pattern: /alipay\s*singapore/i, aliases: ["alibaba cloud", "alibaba", "阿里雲"] },
  // Facebook Ads
  { pattern: /(facebk|facebook|fb\.me)/i, aliases: ["meta platforms", "meta", "facebook"] },
  // LinkedIn
  { pattern: /linkedin/i, aliases: ["linkedin", "microsoft"] },
  // Google Ads / Google Cloud
  { pattern: /google\*/i, aliases: ["google", "google cloud", "google ads"] },
  // OpenAI
  { pattern: /openai/i, aliases: ["openai"] },
  // Anthropic
  { pattern: /anthropic/i, aliases: ["anthropic", "claude"] },
];

function expandMerchantNames(merchant: string): string[] {
  const names = [merchant];
  for (const { pattern, aliases } of MERCHANT_ALIASES) {
    if (pattern.test(merchant)) {
      names.push(...aliases);
    }
  }
  return names;
}

function similarity(a: string, b: string): number {
  const aUp = a.toUpperCase();
  const bUp = b.toUpperCase();
  if (aUp === bUp) return 1;
  const longer = aUp.length > bUp.length ? aUp : bUp;
  const shorter = aUp.length > bUp.length ? bUp : aUp;
  if (longer.length === 0) return 1;
  const costs: number[] = [];
  for (let i = 0; i <= longer.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= shorter.length; j++) {
      if (i === 0) { costs[j] = j; }
      else if (j > 0) {
        let newValue = costs[j - 1];
        if (longer.charAt(i - 1) !== shorter.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[shorter.length] = lastValue;
  }
  return (longer.length - costs[shorter.length]) / longer.length;
}

function daysBetween(d1: string, d2: string): number {
  const date1 = new Date(d1);
  const date2 = new Date(d2);
  return Math.abs(Math.floor((date1.getTime() - date2.getTime()) / (1000 * 60 * 60 * 24)));
}

/**
 * Find the best matching rule for a merchant name.
 * Returns the rule + resolved entity/department IDs.
 */
function findRule(
  merchant: string,
  sortedRules: MatchingRule[],
  entities: { id: string; code: string }[],
  departments: { id: string; entity_id: string; code: string; dr_account: string }[]
): { rule: MatchingRule; entityId: string; departmentId: string; drAccount: string } | null {
  // MatchingRule uses 'keyword' field (not 'merchant_pattern')
  // and 'target_entity' + 'dept_code' (codes, not IDs)
  for (const r of sortedRules) {
    if (!wildcardMatch(r.keyword, merchant)) continue;

    // Resolve entity code → ID
    const entity = r.target_entity
      ? entities.find(e => e.code === r.target_entity)
      : null;

    // Resolve dept code → ID (scoped to entity if possible)
    const dept = r.dept_code
      ? departments.find(d => d.code === r.dept_code && (!entity || d.entity_id === entity?.id))
        || departments.find(d => d.code === r.dept_code)
      : null;

    return {
      rule: r,
      entityId: entity?.id || '',
      departmentId: dept?.id || '',
      drAccount: r.dr_account_code || dept?.dr_account || '6000',
    };
  }
  return null;
}

export function runMatchingEngine(
  transactions: CardTransaction[],
  invoices: MetaInvoice[],
  rules: MatchingRule[],
  settings: JournalSettings,
  entities: { id: string; code: string }[],
  departments: { id: string; entity_id: string; code: string; dr_account: string }[]
): MatchResult[] {
  const sortedRules = [...rules].filter(r => r.is_active).sort((a, b) => a.priority - b.priority);
  const results: MatchResult[] = [];

  // Track which invoices have been claimed in THIS run to prevent double-matching
  const claimedInvoiceIds = new Set<string>();

  function isInvoiceAvailable(inv: MetaInvoice): boolean {
    return !inv.is_matched && !claimedInvoiceIds.has(inv.id);
  }

  for (const txn of transactions) {
    let matched = false;
    const ruleMatch = findRule(txn.merchant, sortedRules, entities, departments);

    // Use HKD-equivalent amounts for cross-currency matching
    const txnHkd = Number(txn.amount_hkd) || Number(txn.amount);

    // FX tolerance: allow 5% diff for cross-currency (bank FX rate ≠ 7.8 estimate)
    const FX_TOLERANCE_PCT = 5;

    // 1. EXACT MATCH — amount (HKD) + date exact
    // Prefer the candidate CLOSEST in date instead of the first array element
    // (exact-stage candidates are all day-0, but keep nearest-date selection for consistency).
    let bestExact: { inv: MetaInvoice; days: number; isCrossCurrency: boolean } | null = null;
    for (const inv of invoices) {
      if (!isInvoiceAvailable(inv)) continue;
      const invHkd = Number(inv.amount_hkd) || Number(inv.amount);
      const isCrossCurrency = inv.currency && inv.currency !== 'HKD';
      const amountMatch = isCrossCurrency
        ? (invHkd > 0 && Math.abs((txnHkd - invHkd) / invHkd) * 100 <= FX_TOLERANCE_PCT)
        : Math.abs(txnHkd - invHkd) < 0.01;
      const dateMatch = inv.invoice_date ? daysBetween(txn.txn_date, inv.invoice_date) === 0 : false;

      if (amountMatch && dateMatch) {
        const days = inv.invoice_date ? daysBetween(txn.txn_date, inv.invoice_date) : 0;
        if (!bestExact || days < bestExact.days) {
          bestExact = { inv, days, isCrossCurrency: !!isCrossCurrency };
        }
      }
    }
    if (bestExact) {
      const inv = bestExact.inv;
      const isCrossCurrency = bestExact.isCrossCurrency;
      claimedInvoiceIds.add(inv.id);
      results.push({
        transactionId: txn.id,
        invoiceId: inv.id,
        status: 'matched',
        matchType: 'exact',
        confidence: isCrossCurrency ? 90 : 100,
        entityId: ruleMatch?.entityId || '',
        departmentId: ruleMatch?.departmentId || '',
        drAccount: ruleMatch?.drAccount || '6000',
        notes: isCrossCurrency
          ? `FX match: Invoice ${inv.invoice_number} (${inv.currency}→HKD)`
          : `Exact match: Invoice ${inv.invoice_number}`,
      });
      matched = true;
    }
    if (matched) continue;

    // 2. NEAR DATE — amount (HKD) match, date within tolerance
    // Among all amount-matching invoices in the window, prefer the one CLOSEST
    // in date (was taking the first array element, which could pick a wrong month).
    let bestNear: { inv: MetaInvoice; days: number; isCrossCurrency: boolean } | null = null;
    for (const inv of invoices) {
      if (!isInvoiceAvailable(inv)) continue;
      const invHkd = Number(inv.amount_hkd) || Number(inv.amount);
      const isCrossCurrency = inv.currency && inv.currency !== 'HKD';
      const amountMatch = isCrossCurrency
        ? (invHkd > 0 && Math.abs((txnHkd - invHkd) / invHkd) * 100 <= FX_TOLERANCE_PCT)
        : Math.abs(txnHkd - invHkd) < 0.01;
      const dateNear = inv.invoice_date
        ? daysBetween(txn.txn_date, inv.invoice_date) <= settings.date_tolerance_days
        : false;

      if (amountMatch && dateNear) {
        const days = inv.invoice_date ? daysBetween(txn.txn_date, inv.invoice_date) : 0;
        if (!bestNear || days < bestNear.days) {
          bestNear = { inv, days, isCrossCurrency: !!isCrossCurrency };
        }
      }
    }
    if (bestNear) {
      const inv = bestNear.inv;
      const days = bestNear.days;
      const isCrossCurrency = bestNear.isCrossCurrency;
      claimedInvoiceIds.add(inv.id);
      results.push({
        transactionId: txn.id,
        invoiceId: inv.id,
        status: 'matched',
        matchType: 'near_date',
        confidence: Math.max(70, (isCrossCurrency ? 90 : 100) - days * 6),
        entityId: ruleMatch?.entityId || '',
        departmentId: ruleMatch?.departmentId || '',
        drAccount: ruleMatch?.drAccount || '6000',
        notes: isCrossCurrency
          ? `FX near date match: Invoice ${inv.invoice_number} (${days} days, ${inv.currency}→HKD)`
          : `Near date match: Invoice ${inv.invoice_number} (${days} days diff)`,
      });
      matched = true;
    }
    if (matched) continue;

    // 3. FUZZY MATCH — merchant similarity + amount (HKD) within tolerance %
    // Generous date window so a recurring vendor's wrong-month invoice can't fuzzy-match.
    const FUZZY_DATE_WINDOW_DAYS = 62;
    let bestFuzzy: { inv: MetaInvoice; sim: number; days: number } | null = null;
    for (const inv of invoices) {
      if (!isInvoiceAvailable(inv)) continue;
      const invHkd = Number(inv.amount_hkd) || Number(inv.amount);
      if (invHkd === 0) continue;
      // Date guard: reject candidates far outside the window. Only applied when the
      // invoice has a date — missing dates keep prior behavior (no silent reject).
      const dDays = inv.invoice_date ? daysBetween(txn.txn_date, inv.invoice_date) : 0;
      if (inv.invoice_date && dDays > FUZZY_DATE_WINDOW_DAYS) continue;
      const isCrossCurrency = inv.currency && inv.currency !== 'HKD';
      const tolerancePct = isCrossCurrency ? Math.max(FX_TOLERANCE_PCT, Number(settings.amount_tolerance_pct)) : Number(settings.amount_tolerance_pct);
      const amountDiff = Math.abs((txnHkd - invHkd) / invHkd) * 100;
      if (amountDiff > tolerancePct) continue;

      // Check similarity against both account_name and description.
      // Also expand merchant via alias map (eg ALIPAY SINGAPORE -> alibaba cloud)
      // so CC bank-side merchant names match invoice billing entity names.
      const merchantNames = expandMerchantNames(txn.merchant);
      let sim = 0;
      for (const name of merchantNames) {
        const simName = inv.account_name ? similarity(name, inv.account_name) : 0;
        const simDesc = inv.description ? similarity(name, inv.description) : 0;
        const s = Math.max(simName, simDesc);
        if (s > sim) sim = s;
      }

      // Cross-currency invoices often have bank-side truncation / marketing prefixes that kill
      // Levenshtein similarity (e.g. "MOTIONARRY* MOTION ARR" vs "Motion Array",
      // or "ALIPAY SINGAPORE" vs "Alibaba Cloud"). Loosen threshold further.
      const FX_FUZZY_THRESHOLD = 0.3;
      const fuzzyThreshold = isCrossCurrency
        ? Math.min(Number(settings.fuzzy_threshold), FX_FUZZY_THRESHOLD)
        : Number(settings.fuzzy_threshold);

      if (sim >= fuzzyThreshold) {
        // Prefer higher similarity; on equal similarity prefer the candidate CLOSEST in date.
        if (!bestFuzzy || sim > bestFuzzy.sim || (sim === bestFuzzy.sim && dDays < bestFuzzy.days)) {
          bestFuzzy = { inv, sim, days: dDays };
        }
      }
    }
    if (bestFuzzy) {
      claimedInvoiceIds.add(bestFuzzy.inv.id);
      results.push({
        transactionId: txn.id,
        invoiceId: bestFuzzy.inv.id,
        status: 'matched',
        matchType: 'fuzzy',
        confidence: Math.round(bestFuzzy.sim * 100),
        entityId: ruleMatch?.entityId || '',
        departmentId: ruleMatch?.departmentId || '',
        drAccount: ruleMatch?.drAccount || '6000',
        notes: `Fuzzy match: Invoice ${bestFuzzy.inv.invoice_number} (${Math.round(bestFuzzy.sim * 100)}% similar)`,
      });
      matched = true;
    }
    if (matched) continue;

    // 4. RULE MATCH — match by keyword pattern to assign entity/department (no invoice)
    if (ruleMatch) {
      results.push({
        transactionId: txn.id,
        invoiceId: null,
        status: 'matched',
        matchType: 'exact',
        confidence: 85,
        entityId: ruleMatch.entityId,
        departmentId: ruleMatch.departmentId,
        drAccount: ruleMatch.drAccount,
        notes: `Rule match: Pattern "${ruleMatch.rule.keyword}"`,
      });
    } else {
      results.push({
        transactionId: txn.id,
        invoiceId: null,
        status: 'unmatched',
        matchType: null,
        confidence: 0,
        entityId: '',
        departmentId: '',
        drAccount: '6000',
        notes: 'No matching rule or invoice found',
      });
    }
  }

  return results;
}

// ============ Hang Seng fee detection helpers ============

const HANG_SENG_KEYWORDS = ["hang seng", "恆生", "hangseng"];

function isHangSengAccount(accountOrBank: string): boolean {
  const lower = accountOrBank.toLowerCase();
  return HANG_SENG_KEYWORDS.some(k => lower.includes(k));
}

function extractHdRef(desc: string): string | null {
  const m = (desc || "").match(/(HD\d{10,})/i);
  return m ? m[1].toUpperCase() : null;
}

function isChargesLine(desc: string): boolean {
  return (desc || "").toUpperCase().startsWith("CHARGES ");
}

function buildChargesMap(txns: BankTransaction[]): Map<string, BankTransaction> {
  const map = new Map<string, BankTransaction>();
  for (const txn of txns) {
    if (isChargesLine(txn.description) && (txn.debit ?? 0) > 0) {
      const ref = extractHdRef(txn.description);
      if (ref) map.set(ref, txn);
    }
  }
  return map;
}

// Subsidiary name → short code mapping for GL matching
const SUBSIDIARY_SHORT_MAP: Record<string, string[]> = {
  SSHK: ["social strategy"],
  PBHK: ["photoblog"],
  CLS: ["cls production"],
  JM: ["jm production", "j m production"],
  "704": ["704 production"],
};

function glMatchesSubsidiary(glSubsidiary: string, subsidiary: string): boolean {
  const glLower = glSubsidiary.toLowerCase();
  const keywords = SUBSIDIARY_SHORT_MAP[subsidiary] || [subsidiary.toLowerCase()];
  return keywords.some(k => glLower.includes(k));
}

// ============ Paginated Supabase fetch ============
async function fetchAllRows<T>(table: string, buildQuery: (q: any) => any): Promise<T[]> {
  const PAGE = 1000;
  let all: T[] = [];
  let from = 0;
  while (true) {
    // Stable ordering by primary key so range-based pagination cannot skip/dupe rows beyond 1000.
    let q = supabase.from(table).select("*").order("id", { ascending: true }).range(from, from + PAGE - 1);
    q = buildQuery(q);
    const { data } = await q;
    if (!data?.length) break;
    all = all.concat(data as T[]);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// ============ Bank Matching Engine ============
export async function runBankMatching(
  subsidiary?: string,
  periodMonth?: string
): Promise<{ matched: number; unmatched: number; ruleMatched: number; total: number }> {
  // Fetch bank transactions (paginated)
  const transactions = await fetchAllRows<BankTransaction>("bank_transactions", (q: any) => {
    if (subsidiary) q = q.eq("subsidiary", subsidiary);
    if (periodMonth) q = q.eq("period_month", periodMonth);
    return q;
  });
  if (!transactions.length) return { matched: 0, unmatched: 0, ruleMatched: 0, total: 0 };

  // Fetch NS GL entries (unmatched, paginated)
  const glEntries = await fetchAllRows<NsGlEntry>("ns_gl_entries", (q: any) => q.eq("is_matched", false));

  // Fetch matching rules (bank + all modules)
  const { data: rules } = await supabase
    .from("matching_rules")
    .select("*")
    .eq("is_active", true)
    .in("module", ["bank", "all"])
    .order("priority", { ascending: true });

  // Build Hang Seng charges maps per subsidiary that uses Hang Seng
  const hangSengSubs = new Set<string>();
  for (const txn of transactions) {
    if (isHangSengAccount(txn.bank_name || "") || isHangSengAccount(txn.bank_account || "")) {
      hangSengSubs.add(txn.subsidiary);
    }
  }
  const chargesMaps = new Map<string, Map<string, BankTransaction>>();
  for (const sub of hangSengSubs) {
    const subTxns = (transactions).filter(t => t.subsidiary === sub);
    chargesMaps.set(sub, buildChargesMap(subTxns));
  }

  // Clear old bank_recon_results for these txns.
  // Chunk the .in() delete at 200 like BankRecon.tsx to avoid URL-length limits (an
  // unchunked delete silently fails on large sets, leaving stale recon rows), and
  // surface any error instead of ignoring it.
  const txnIds = (transactions).map(t => t.id);
  const DELETE_CHUNK = 200;
  for (let i = 0; i < txnIds.length; i += DELETE_CHUNK) {
    const chunk = txnIds.slice(i, i + DELETE_CHUNK);
    const { error: delError } = await supabase.from("bank_recon_results").delete().in("source_id", chunk);
    if (delError) throw new Error(`Failed to clear old bank recon results: ${delError.message}`);
  }

  // Reset is_matched on GL entries we might re-match
  if (glEntries?.length) {
    // We don't mass-reset because other modules may have matched them
  }

  let matched = 0, unmatched = 0, ruleMatched = 0;
  const claimedGlIds = new Set<string>();
  const claimedFeeTxnIds = new Set<string>();
  const results: any[] = [];

  const DATE_TOLERANCE = 5;
  const AMOUNT_TOLERANCE_PCT = 5;
  const FUZZY_THRESHOLD = 0.6;

  for (const txn of transactions) {
    const txnIsDebit = (txn.debit ?? 0) > 0;
    const txnAmount = txnIsDebit ? Math.abs(txn.debit!) : Math.abs(txn.credit ?? 0);
    if (txnAmount === 0) {
      results.push({
        module: "bank", source_type: "bank_transaction", source_id: txn.id,
        status: "unmatched", matched_by: "engine", notes: "Zero amount",
      });
      unmatched++;
      continue;
    }

    // Skip CHARGES lines in Hang Seng — they'll be matched via paired payment
    const isHS = hangSengSubs.has(txn.subsidiary);
    const txnIsCharges = isHS && isChargesLine(txn.description);
    if (txnIsCharges && claimedFeeTxnIds.has(txn.id)) continue;

    let bestMatch: any = null;

    // ── Stage 1: Match against NS GL entries ──
    if (glEntries?.length) {
      for (const gl of glEntries) {
        if (claimedGlIds.has(gl.id)) continue;
        if (!glMatchesSubsidiary(gl.subsidiary, txn.subsidiary)) continue;

        const glIsDebit = (gl.debit ?? 0) > 0;
        const glAmount = glIsDebit ? Math.abs(gl.debit!) : Math.abs(gl.credit ?? 0);
        if (glAmount === 0) continue;
        // Direction: bank debit (outflow) should match GL credit (money leaving bank account)
        // bank credit (inflow) should match GL debit (money entering bank account)
        if (txnIsDebit === glIsDebit) continue;

        const amtDiff = Math.abs(txnAmount - glAmount);
        const amtPctDiff = (amtDiff / Math.max(txnAmount, glAmount, 0.01)) * 100;

        // Exact amount match
        if (amtDiff < 0.01) {
          const days = gl.txn_date ? daysBetween(txn.txn_date, gl.txn_date) : 999;
          if (days === 0) {
            bestMatch = { entry: gl, type: "exact", confidence: 100 };
            break;
          }
          if (days <= DATE_TOLERANCE) {
            const conf = Math.max(70, 100 - days * 6);
            if (!bestMatch || conf > bestMatch.confidence) {
              bestMatch = { entry: gl, type: "near_date", confidence: conf };
            }
          }
        }

        // Hang Seng fee match: txnAmount + fee = glAmount
        if (isHS && !txnIsCharges && txnIsDebit) {
          const hdRef = extractHdRef(txn.description);
          if (hdRef) {
            const cMap = chargesMaps.get(txn.subsidiary);
            const chargeTxn = cMap?.get(hdRef);
            if (chargeTxn && !claimedFeeTxnIds.has(chargeTxn.id)) {
              const combinedAmount = txnAmount + Math.abs(chargeTxn.debit ?? 0);
              if (Math.abs(combinedAmount - glAmount) < 0.01) {
                const days = gl.txn_date ? daysBetween(txn.txn_date, gl.txn_date) : 999;
                const conf = days <= DATE_TOLERANCE ? 95 : 85;
                if (!bestMatch || conf > bestMatch.confidence) {
                  bestMatch = { entry: gl, type: "hs_fee", confidence: conf, feeTxn: chargeTxn, feeAmt: Math.abs(chargeTxn.debit ?? 0) };
                }
              }
            }
          }
        }

        // Fuzzy name match
        if (amtPctDiff <= AMOUNT_TOLERANCE_PCT) {
          const nameA = (txn.description || txn.reference || "").toUpperCase();
          const nameB = (gl.description || gl.entity_name || gl.memo || "").toUpperCase();
          const sim = similarity(nameA, nameB);
          if (sim >= FUZZY_THRESHOLD) {
            const conf = Math.round(sim * 90);
            if (!bestMatch || conf > bestMatch.confidence) {
              bestMatch = { entry: gl, type: "fuzzy", confidence: conf };
            }
          }
        }
      }
    }

    // Record match result
    if (bestMatch) {
      const gl = bestMatch.entry as NsGlEntry;
      claimedGlIds.add(gl.id);
      results.push({
        module: "bank", source_type: "bank_transaction", source_id: txn.id,
        target_type: "ns_gl_entry", target_id: gl.id,
        status: "matched", match_type: bestMatch.type, confidence: bestMatch.confidence,
        matched_at: new Date().toISOString(), matched_by: "engine",
        notes: bestMatch.type === "hs_fee"
          ? `恆生手續費 $${bestMatch.feeAmt}: 付款 ${txnAmount} + 手續費 ${bestMatch.feeAmt} = GL ${Math.abs(gl.debit ?? gl.credit ?? 0)}`
          : `GL: ${gl.transaction_number} — ${gl.description || gl.memo || ""}`.slice(0, 200),
      });
      // Mark GL entry as matched
      await supabase.from("ns_gl_entries").update({ is_matched: true }).eq("id", gl.id);
      matched++;

      // If Hang Seng fee, also mark fee txn
      if (bestMatch.feeTxn) {
        claimedFeeTxnIds.add(bestMatch.feeTxn.id);
        results.push({
          module: "bank", source_type: "bank_transaction", source_id: bestMatch.feeTxn.id,
          target_type: "ns_gl_entry", target_id: gl.id,
          status: "matched", match_type: "hs_fee", confidence: bestMatch.confidence,
          matched_at: new Date().toISOString(), matched_by: "engine",
          notes: `恆生轉帳手續費 $${bestMatch.feeAmt}`,
        });
        matched++;
      }
      continue;
    }

    // Skip fee txns already consumed
    if (claimedFeeTxnIds.has(txn.id)) continue;

    // ── Stage 2: Rule match ──
    let ruleMatch: any = null;
    if (rules?.length) {
      for (const rule of rules) {
        if (wildcardMatch(rule.keyword, txn.description || txn.reference || "")) {
          ruleMatch = rule;
          break;
        }
      }
    }

    if (ruleMatch) {
      results.push({
        module: "bank", source_type: "bank_transaction", source_id: txn.id,
        status: "matched", match_type: "rule", confidence: 85,
        matched_at: new Date().toISOString(), matched_by: "engine",
        notes: `Rule: ${ruleMatch.keyword} → ${ruleMatch.dr_account_code || ruleMatch.account_name}`,
      });
      ruleMatched++;
      continue;
    }

    // Unmatched
    results.push({
      module: "bank", source_type: "bank_transaction", source_id: txn.id,
      status: "unmatched", matched_by: "engine",
    });
    unmatched++;
  }

  // Insert results in batches; surface errors instead of silently dropping recon rows.
  for (let i = 0; i < results.length; i += 50) {
    const chunk = results.slice(i, i + 50);
    const { error: insError } = await supabase.from("bank_recon_results").insert(chunk);
    if (insError) throw new Error(`Failed to insert bank recon results: ${insError.message}`);
  }

  return { matched, unmatched, ruleMatched, total: (transactions).length };
}
