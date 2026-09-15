// Edge Function: post APPROVED Payment Requisitions (claim_type='payment')
// to NetSuite as Vendor BILLS (唔係 journal entry — supplier / freelancer 有
// 開發票，NetSuite 行 AP bills 入數，供應商發票號碼做 Reference No)。
//
// Per batch:
//   vendor  = payee_name (SuiteQL 對 companyname / entityid，唔分大小寫；
//             搵唔到 exact 先試 contains，要唯一先用)
//   bill    = { externalId: batch_no, tranId: supplier_invoice_no,
//               tranDate: invoice_date (fallback approved/submit date),
//               dueDate: payment_due_date,
//               expense lines: account ← expense_categories→COA internal id,
//               department ← line_charge_to 或表頭 charge_to, customer ← project (job) }
// 預付款 (is_prepayment)：bill 日期 = 發票日期，一次過 CR AP 全額；明細行按日期分三路 —
//   行日期 = 發票日期 → DR 費用科目 (一般入法)
//   行日期 < 發票日期 → bill 行 DR 37001010 Accrued Expenses，另出 JE (行日期) DR 費用 / CR 37001010
//   行日期 > 發票日期 → bill 行 DR 22005010 Prepaid Expenses，另出 JE (行日期) DR 費用 / CR 22005010
// JE 合併：同一次入數入面，同 subsidiary + 同日期 + 同類 (accrual / prepaid) 嘅行 —
//   跨批次都合成一張 JE (每張單一條 CR 行)，externalId PAYJE-<date>-<kind>-S<sub>-<hash of batch nos>。
//   幂等靠 payment_je_posts (batch, date, kind)：已入過嘅唔會再入，重按只補漏。
// 一般付款：明細日期 = 發票日期 (表格已驗證)，發票日期做 bill date。
// Success → claim_batches.status='exported' + netsuite_journal_no='BILL <id>'.
// Duplicate externalId → status 'duplicate' (幂等，可以放心重按)。
//
// Request body: { batch_ids: string[], dry_run?: true }
// Response: { ok, dry_run, warnings, created, duplicates, failed, results: [...], journals: [...] }
import { createClient } from 'jsr:@supabase/supabase-js@2';

function pctEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
function nonce(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmacSha256B64(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
async function authHeader(method: string, url: string, cfg: Record<string, string>): Promise<string> {
  const realm = (cfg.ns_account_id || '').toUpperCase();
  const oauth: Record<string, string> = {
    oauth_consumer_key: cfg.ns_tba_consumer_key,
    oauth_token: cfg.ns_tba_token_id,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: nonce(),
    oauth_version: '1.0',
  };
  const params = Object.keys(oauth).sort().map((k) => `${pctEncode(k)}=${pctEncode(oauth[k])}`).join('&');
  const base = [method.toUpperCase(), pctEncode(url), pctEncode(params)].join('&');
  const signingKey = `${pctEncode(cfg.ns_tba_consumer_secret)}&${pctEncode(cfg.ns_tba_token_secret)}`;
  const sig = await hmacSha256B64(signingKey, base);
  const parts = { realm, ...oauth, oauth_signature: sig };
  return 'OAuth ' + Object.entries(parts).map(([k, v]) => `${pctEncode(k)}="${pctEncode(v as string)}"`).join(', ');
}
function b64urlJson(seg: string): any {
  try { return JSON.parse(atob(seg.replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; }
}
function sqlq(s: string): string {
  return s.replace(/'/g, "''");
}
// 發票 OCR 會將明細 description 寫成 "[Vendor] Summary"；bill 本身已經有 vendor，
// memo 唔要開頭嘅 [Vendor] tag
function stripVendorTag(s: string): string {
  return s.replace(/^\s*\[[^\]]{1,120}\]\s*[-–:]?\s*/, '');
}
// timestamptz → HK-local YYYY-MM-DD
function toHKDate(ts: string | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
// deterministic 8-hex hash (FNV-1a) — 合併 JE externalId 用
function hash8(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
const r2 = (n: number) => Math.round(n * 100) / 100;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Kind = 'expense' | 'accrual' | 'prepaid';
type JeSpec = {
  batchId: string; batchNo: string; sid: number; date: string; kind: 'accrual' | 'prepaid';
  dr: any; amt: number; memo: string; deptId?: number; deptCode: string; preview: any;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    // ---- auth: owner/admin or service role ----
    const authz = req.headers.get('Authorization') || '';
    const jwt = authz.replace(/^Bearer\s+/i, '');
    const claims = jwt.split('.').length === 3 ? b64urlJson(jwt.split('.')[1]) : {};
    let okAuth = claims.role === 'service_role';
    if (!okAuth && claims.sub) {
      const { data: prof } = await svc.from('user_profiles').select('role').eq('user_id', claims.sub).maybeSingle();
      okAuth = prof != null && ['owner', 'admin'].includes(prof.role);
    }
    if (!okAuth) return new Response(JSON.stringify({ error: 'forbidden: owner/admin only' }), { status: 403, headers: CORS });

    const body = await req.json().catch(() => ({}));
    const dryRun = body.dry_run === true;
    const batchIds: string[] = Array.isArray(body.batch_ids) ? body.batch_ids.filter((x: any) => typeof x === 'string') : [];
    if (batchIds.length === 0) return new Response(JSON.stringify({ error: 'batch_ids required' }), { status: 400, headers: CORS });
    if (batchIds.length > 50) return new Response(JSON.stringify({ error: 'too many batches (max 50)' }), { status: 400, headers: CORS });

    // ---- config ----
    const { data: cfg, error: cfgErr } = await svc.rpc('ns_get_config');
    if (cfgErr) throw cfgErr;
    for (const k of ['ns_account_id', 'ns_tba_consumer_key', 'ns_tba_consumer_secret', 'ns_tba_token_id', 'ns_tba_token_secret']) {
      if (!cfg?.[k]) return new Response(JSON.stringify({ error: `missing config: ${k}` }), { status: 500, headers: CORS });
    }
    const host = String(cfg.ns_account_id).toLowerCase().replace(/_/g, '-');
    const suiteql = async (q: string): Promise<any[]> => {
      const url = `https://${host}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
      const header = await authHeader('POST', url, cfg as Record<string, string>);
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: header, 'Content-Type': 'application/json', Prefer: 'transient' },
        body: JSON.stringify({ q }),
      });
      if (!res.ok) throw new Error(`SuiteQL ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return (await res.json()).items || [];
    };
    // 權限 probe：POST 空 payload (一定建唔到 record，安全)。NetSuite 會先做 required-field
    // validation (400 FIELD_PARAM_REQD) 先至 check Create 權限，所以呢個 probe 只捕捉到
    // 「role 完全冇該 record 權限」嘅 403；「有 View 冇 Create」要真正 post 先會 403 —
    // 嗰種情況由 postRecord → friendlyNsError 俾清楚指引。
    const nsProbe = async (type: 'vendorBill' | 'journalEntry'): Promise<{ status: number; text: string }> => {
      const url = `https://${host}.suitetalk.api.netsuite.com/services/rest/record/v1/${type}`;
      const header = await authHeader('POST', url, cfg as Record<string, string>);
      const res = await fetch(url, { method: 'POST', headers: { Authorization: header, 'Content-Type': 'application/json', Prefer: 'transient' }, body: '{}' });
      return { status: res.status, text: res.ok ? '' : (await res.text()).slice(0, 800) };
    };
    // NetSuite 403 INSUFFICIENT_PERMISSION → 講清楚 admin 要加咩權限
    const friendlyNsError = (status: number, text: string): string => {
      if (status === 403 && /INSUFFICIENT_PERMISSION|Permission Violation/i.test(text)) {
        const m = text.match(/'([^']+)'\s*permission/i);
        const perm = m ? m[1].replace(/\s*->\s*/g, ' → ') : 'Transactions → Bills';
        return `NetSuite 權限不足 (403)：integration token 個 role 冇「${perm}」權限。`
          + `請 NetSuite Administrator 去 Setup → Users/Roles → Manage Roles → 揀 CardRecon token 用嘅 role → Permissions → Transactions，`
          + `加「Bills」= Create (或 Full)；預付款仲要「Make Journal Entry」= Create。改完唔使重新產生 token。`;
      }
      return `NetSuite ${status}: ${text}`;
    };
    const postRecord = async (type: 'vendorBill' | 'journalEntry', payload: any): Promise<{ ok: boolean; id?: string; duplicate?: boolean; error?: string }> => {
      const url = `https://${host}.suitetalk.api.netsuite.com/services/rest/record/v1/${type}`;
      const header = await authHeader('POST', url, cfg as Record<string, string>);
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: header, 'Content-Type': 'application/json', Prefer: 'transient' },
        body: JSON.stringify(payload),
      });
      if (res.status === 204 || res.status === 201 || res.ok) {
        const loc = res.headers.get('Location') || '';
        return { ok: true, id: loc.split('/').pop() || 'created' };
      }
      const errText = (await res.text()).slice(0, 800);
      if (/already exists|duplicate/i.test(errText)) return { ok: false, duplicate: true, error: errText };
      return { ok: false, error: friendlyNsError(res.status, errText) };
    };

    // ---- load batches + lines ----
    const { data: batches, error: bErr } = await svc.from('claim_batches')
      .select('id,batch_no,claim_type,status,full_name,charge_to_code,entity_code,subsidiary_full_name,department_name,submit_date,approved_at,payee_name,payee_type,payment_due_date,supplier_invoice_no,netsuite_journal_no,invoice_date,is_prepayment')
      .in('id', batchIds).eq('claim_type', 'payment');
    if (bErr) throw bErr;
    const { data: allLines, error: lErr } = await svc.from('claim_lines')
      .select('batch_id,item_no,line_date,project_code,description,client_name,hkd_amount,expense_category_code,line_status,line_charge_to')
      .in('batch_id', batchIds).order('item_no');
    if (lErr) throw lErr;
    const linesByBatch = new Map<string, any[]>();
    for (const l of allLines || []) {
      if (l.line_status === 'rejected') continue;
      if (!linesByBatch.has(l.batch_id)) linesByBatch.set(l.batch_id, []);
      linesByBatch.get(l.batch_id)!.push(l);
    }

    // ---- reference maps ----
    const [{ data: cats }, { data: coa }, { data: subs }, { data: depts }] = await Promise.all([
      svc.from('expense_categories').select('category_key,ns_account_number'),
      svc.from('ns_chart_of_accounts').select('account_number,account_name,internal_id'),
      svc.from('ns_subsidiaries').select('internal_id,name,full_name,short_code'),
      svc.from('ns_departments').select('charge_to,name,internal_id'),
    ]);
    const catAcct = new Map((cats || []).map((c: any) => [String(c.category_key), String(c.ns_account_number || '')]));
    const acctId = new Map((coa || []).filter((a: any) => a.internal_id != null).map((a: any) => [String(a.account_number), a.internal_id]));
    const acctName = new Map((coa || []).map((a: any) => [String(a.account_number), String(a.account_name || '')]));
    const acctLabel = (num: string) => `${num} ${acctName.get(num) || ''}`.trim();
    const subId = new Map<string, number>();
    for (const s of subs || []) {
      for (const k of [s.full_name, s.name, s.short_code]) if (k) subId.set(String(k), s.internal_id);
    }
    const subShort = new Map<number, string>();
    for (const s of subs || []) subShort.set(Number(s.internal_id), String(s.short_code || s.name || s.internal_id));
    const deptByChargeTo = new Map<string, number>();
    for (const d of depts || []) if (d.charge_to && d.internal_id != null) deptByChargeTo.set(String(d.charge_to), d.internal_id);
    const deptName = new Map<string, string>();
    for (const d of depts || []) if (d.charge_to) deptName.set(String(d.charge_to), String(d.name || d.charge_to));
    const deptLabel = (ct: string) => ct ? `${ct}${deptName.get(ct) && deptName.get(ct) !== ct ? ' ' + deptName.get(ct) : ''}` : '';

    // project (job) ids from mirror + SuiteQL fallback
    const projectIds = [...new Set((allLines || []).map((l: any) => (l.project_code || '').trim()).filter(Boolean))];
    const jobId = new Map<string, string>();
    if (projectIds.length > 0) {
      const { data: projRows } = await svc.from('ns_project_codes')
        .select('project_id, internal_id').in('project_id', projectIds).not('internal_id', 'is', null);
      for (const r of projRows || []) jobId.set(String(r.project_id), String(r.internal_id));
      const missing = projectIds.filter((p) => !jobId.has(p));
      if (missing.length > 0) {
        const inList = missing.map((c) => `'${sqlq(c)}'`).join(',');
        for (const r of await suiteql(`SELECT id, entityid FROM job WHERE entityid IN (${inList})`)) {
          jobId.set(String(r.entityid), String(r.id));
        }
      }
    }

    // vendor resolution: payee_name → vendor internal id (exact 先，contains 後備)
    const payeeNames = [...new Set((batches || []).map((b: any) => (b.payee_name || '').trim()).filter(Boolean))];
    const vendorByName = new Map<string, { id: string; label: string }>();
    const vendorProblems = new Map<string, string>();
    for (const name of payeeNames) {
      const exact = await suiteql(
        `SELECT id, entityid, companyname FROM vendor WHERE isinactive = 'F' AND (UPPER(companyname) = UPPER('${sqlq(name)}') OR UPPER(entityid) = UPPER('${sqlq(name)}'))`,
      );
      if (exact.length === 1) {
        vendorByName.set(name, { id: String(exact[0].id), label: `${exact[0].entityid || ''} ${exact[0].companyname || ''}`.trim() });
        continue;
      }
      if (exact.length > 1) {
        vendorProblems.set(name, `multiple vendors match "${name}": ${exact.slice(0, 5).map((v: any) => v.entityid).join(', ')}`);
        continue;
      }
      const fuzzy = await suiteql(
        `SELECT id, entityid, companyname FROM vendor WHERE isinactive = 'F' AND UPPER(companyname) LIKE UPPER('%${sqlq(name)}%')`,
      );
      if (fuzzy.length === 1) {
        vendorByName.set(name, { id: String(fuzzy[0].id), label: `${fuzzy[0].entityid || ''} ${fuzzy[0].companyname || ''}`.trim() });
      } else if (fuzzy.length === 0) {
        vendorProblems.set(name, `vendor not found in NetSuite: "${name}" — 請先喺 NetSuite 開 vendor，或者將收款人名改成同 NetSuite 一致`);
      } else {
        vendorProblems.set(name, `"${name}" 對到 ${fuzzy.length} 個 vendors: ${fuzzy.slice(0, 5).map((v: any) => v.companyname || v.entityid).join(' | ')} — 請用完整名`);
      }
    }
    // OneWorld：bill 只可以開喺 vendor 所屬 subsidiary (primary + secondary)，
    // 否則 NetSuite 400 "Invalid combination of entity and subsidiary" — preview 先擋住
    const vendorSubs = new Map<string, Set<number>>();
    const vendorIds = [...new Set([...vendorByName.values()].map((v) => v.id))];
    if (vendorIds.length > 0) {
      const inIds = vendorIds.join(',');
      for (const r of await suiteql(`SELECT id, subsidiary FROM vendor WHERE id IN (${inIds})`)) {
        if (r.subsidiary == null) continue;
        if (!vendorSubs.has(String(r.id))) vendorSubs.set(String(r.id), new Set());
        vendorSubs.get(String(r.id))!.add(Number(r.subsidiary));
      }
      for (const r of await suiteql(`SELECT entity, subsidiary FROM vendorSubsidiaryRelationship WHERE entity IN (${inIds})`)) {
        if (!vendorSubs.has(String(r.entity))) vendorSubs.set(String(r.entity), new Set());
        vendorSubs.get(String(r.entity))!.add(Number(r.subsidiary));
      }
    }

    // ---- constants ----
    const ACCRUED_ACCT = '37001010';   // Accrued Expenses - General
    const PREPAID_ACCT = '22005010';   // Prepaid Expenses
    // legacy tax：bill 每行都要 tax code。費用科目 NetSuite 會 default VAT_HK:UNDEF-HK，
    // 但 37001010 / 22005010 (balance sheet) 冇 default → 400 "Please enter value(s) for: Tax Code"
    // → 一律明確俾 VAT_HK:UNDEF-HK (0%，internal id 5，同 bill 68892 嘅費用行一樣)
    const TAX_CODE_ID = '5';
    const today = new Date().toISOString().slice(0, 10);
    const accruedId = acctId.get(ACCRUED_ACCT);
    const prepaidId = acctId.get(PREPAID_ACCT);

    // dry_run：預先 probe Bills / JE 權限
    const warnings: string[] = [];
    const probeInfo: Record<string, { status: number; text: string }> = {};
    if (dryRun && (batches || []).length > 0) {
      const probe = await nsProbe('vendorBill');
      probeInfo.vendorBill = { status: probe.status, text: probe.text.slice(0, 400) };
      if (probe.status === 403) warnings.push(`Vendor Bill — ${friendlyNsError(probe.status, probe.text)}`);
      if ((batches || []).some((b: any) => b.is_prepayment)) {
        const p2 = await nsProbe('journalEntry');
        probeInfo.journalEntry = { status: p2.status, text: p2.text.slice(0, 400) };
        if (p2.status === 403) warnings.push(`Journal Entry (預付款) — ${friendlyNsError(p2.status, p2.text)}`);
      }
    }

    // ---- phase 1: validate + build bill per batch; collect JE line specs ----
    type Pending = { batch: any; label: string; vendorLabel: string; sid: number; billDate: string; payload: any; lines: number; total: number; headerMemo: string; billPreview: any[] };
    const pendings: Pending[] = [];
    const jeSpecs: JeSpec[] = [];
    const results: any[] = [];
    let created = 0, duplicates = 0, failed = 0;

    for (const batch of batches || []) {
      const label = `${batch.batch_no || batch.id.slice(0, 8)} · ${batch.payee_name || '?'}`;
      const problems: string[] = [];
      const lines = linesByBatch.get(batch.id) || [];

      // dry_run 純預覽 (唔寫 NetSuite)，草稿都可以睇入數計劃
      if (!dryRun && !['approved', 'exported'].includes(batch.status)) problems.push(`status 係 ${batch.status}，要 approved 先可以入數`);
      if (lines.length === 0) problems.push('冇 approved 明細行');
      if (!batch.batch_no) problems.push('冇 batch no');

      const vendor = batch.payee_name ? vendorByName.get(batch.payee_name.trim()) : undefined;
      if (!vendor) problems.push(vendorProblems.get((batch.payee_name || '').trim()) || 'missing payee name');

      const sid = subId.get(String(batch.entity_code || '')) ?? subId.get(String(batch.subsidiary_full_name || ''));
      if (sid == null) problems.push(`subsidiary not mapped: ${batch.entity_code || batch.subsidiary_full_name || '?'}`);
      if (vendor && sid != null) {
        const allowed = vendorSubs.get(vendor.id);
        if (allowed && allowed.size > 0 && !allowed.has(Number(sid))) {
          const names = [...allowed].map((i) => subShort.get(i) || String(i)).join(' / ');
          const want = batch.entity_code || subShort.get(Number(sid)) || String(sid);
          problems.push(`vendor ${vendor.label} 喺 NetSuite 只屬於 subsidiary ${names}，張單係 ${want} — `
            + `請 NetSuite Administrator 開 vendor record → Subsidiaries 加 ${want}（Multi-Subsidiary Vendor），或者改單嘅 Charge To`);
        }
      }

      // 發票日期 = bill date；冇先用批核日/提交日
      const billDate = String(batch.invoice_date || toHKDate(batch.approved_at) || batch.submit_date || today).slice(0, 10);
      if (batch.is_prepayment && (accruedId == null || prepaidId == null)) {
        problems.push(`預付款科目 ${ACCRUED_ACCT} / ${PREPAID_ACCT} 冇 internal id — 請先同步 Chart of Accounts`);
      }
      const batchDeptId = batch.charge_to_code ? deptByChargeTo.get(String(batch.charge_to_code)) : undefined;

      const items: any[] = [];
      const billPreview: any[] = [];
      const rawMemos: string[] = [];   // 表頭 memo 跟明細行 description
      const batchSpecs: JeSpec[] = [];
      let total = 0;
      for (const l of lines) {
        const amt = r2(Number(l.hkd_amount || 0));
        if (amt === 0) continue;
        if (amt < 0) { problems.push(`行 #${l.item_no} 金額係負數 — bill 唔接受負數行`); continue; }
        const acctNum = l.expense_category_code ? catAcct.get(l.expense_category_code) : '';
        if (!acctNum) { problems.push(`行 #${l.item_no} 冇 expense category`); continue; }
        const aid = acctId.get(acctNum);
        if (aid == null) { problems.push(`account ${acctNum} 冇 internal id (行 #${l.item_no})`); continue; }
        const memo = [l.description ? stripVendorTag(String(l.description)) : '', l.client_name ? `(${l.client_name})` : '']
          .filter(Boolean).join(' ').trim().slice(0, 4000) || undefined;
        if (memo && !rawMemos.includes(memo)) rawMemos.push(memo);
        // 一張發票拆多個 department：行有自己嘅 charge to 就用行嘅，否則跟表頭
        const chargeTo = (l.line_charge_to || batch.charge_to_code || '').trim();
        const did = chargeTo ? deptByChargeTo.get(chargeTo) : undefined;
        if (did == null && l.line_charge_to) problems.push(`行 #${l.item_no} 嘅 charge to ${l.line_charge_to} 冇 department internal id`);
        const cp = (l.project_code || '').trim();
        let jid: string | undefined;
        if (cp) {
          jid = jobId.get(cp);
          if (!jid) problems.push(`project (job) not found: ${cp}`);
        }

        const lineDate = String(l.line_date || billDate).slice(0, 10);
        const kind: Kind =
          !batch.is_prepayment || lineDate === billDate ? 'expense'
          : lineDate < billDate ? 'accrual' : 'prepaid';

        // 每行 memo (包括 Accrued / Prepaid 行) 一律 = 明細行 description
        const billItem: any = {
          account: { id: String(kind === 'expense' ? aid : kind === 'accrual' ? accruedId : prepaidId) },
          amount: amt,
          taxCode: { id: TAX_CODE_ID },
          memo,
        };
        if (did != null) billItem.department = { id: String(did) };
        if (kind === 'expense' && jid) billItem.customer = { id: jid };  // bill expense line books project 經 customer(job) field
        total += amt;
        items.push(billItem);
        const billAcctNum = kind === 'expense' ? acctNum : kind === 'accrual' ? ACCRUED_ACCT : PREPAID_ACCT;
        billPreview.push({
          doc: 'BILL', date: billDate, kind, account: acctLabel(billAcctNum), debit: amt, credit: null,
          department: deptLabel(chargeTo), project: kind === 'expense' ? cp : '', memo: billItem.memo || '', batch_no: batch.batch_no,
        });

        if (kind !== 'expense' && sid != null) {
          const dr: any = { account: { id: String(aid) }, debit: amt, memo };
          if (did != null) dr.department = { id: String(did) };
          if (jid) dr.entity = { id: jid };  // JE 行 project 經 entity (job)
          batchSpecs.push({
            batchId: batch.id, batchNo: String(batch.batch_no), sid: Number(sid), date: lineDate, kind, dr, amt,
            memo: memo || '', deptId: batchDeptId, deptCode: String(batch.charge_to_code || ''),
            preview: {
              doc: 'JE', date: lineDate, kind, account: acctLabel(acctNum), debit: amt, credit: null,
              department: deptLabel(chargeTo), project: cp, memo: memo || '', batch_no: batch.batch_no,
            },
          });
        }
      }
      if (items.length === 0 && problems.length === 0) problems.push('冇有效明細行');

      if (problems.length > 0) {
        failed++;
        results.push({ batch_id: batch.id, batch_no: batch.batch_no, label, status: 'error', error: problems.join('; ') });
        continue;
      }

      // bill 表頭 memo 跟返第一行明細 description；冇 description 先用 batch 資料
      const headerMemo = (rawMemos[0]
        || `CardRecon payment requisition ${batch.batch_no} - req by ${batch.full_name || '?'}`).slice(0, 4000);
      const payload: any = {
        externalId: batch.batch_no,
        entity: { id: vendor!.id },
        subsidiary: { id: String(sid) },
        currency: { id: '1' },
        tranDate: billDate,
        memo: headerMemo,
        expense: { items },
      };
      if (batch.supplier_invoice_no) payload.tranId = String(batch.supplier_invoice_no).slice(0, 45);
      if (batch.payment_due_date) payload.dueDate = batch.payment_due_date;

      pendings.push({ batch, label, vendorLabel: vendor!.label, sid: Number(sid), billDate, payload, lines: items.length, total: r2(total), headerMemo, billPreview });
      jeSpecs.push(...batchSpecs);
    }

    // ---- phase 2: combined JE groups (同 subsidiary + 日期 + 類)，幂等 by payment_je_posts ----
    const okIds = pendings.map((p) => p.batch.id);
    const alreadyPosted = new Map<string, { external_id: string; netsuite_id: string | null }>();
    if (okIds.length > 0) {
      const { data: prev } = await svc.from('payment_je_posts').select('batch_id,je_date,kind,external_id,netsuite_id').in('batch_id', okIds);
      for (const r of prev || []) alreadyPosted.set(`${r.batch_id}|${String(r.je_date).slice(0, 10)}|${r.kind}`, { external_id: r.external_id, netsuite_id: r.netsuite_id });
    }
    const skippedByBatch = new Map<string, number>();
    const groups = new Map<string, { sid: number; date: string; kind: 'accrual' | 'prepaid'; specs: JeSpec[] }>();
    for (const s of jeSpecs) {
      if (alreadyPosted.has(`${s.batchId}|${s.date}|${s.kind}`)) {
        skippedByBatch.set(s.batchId, (skippedByBatch.get(s.batchId) || 0) + 1);
        continue;
      }
      const key = `${s.sid}|${s.date}|${s.kind}`;
      if (!groups.has(key)) groups.set(key, { sid: s.sid, date: s.date, kind: s.kind, specs: [] });
      groups.get(key)!.specs.push(s);
    }
    const journals = [...groups.values()]
      .sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.sid - b.sid)
      .map((g) => {
        const batchNos = [...new Set(g.specs.map((s) => s.batchNo))].sort();
        const batchIdsIn = [...new Set(g.specs.map((s) => s.batchId))];
        const externalId = `PAYJE-${g.date.replace(/-/g, '')}-${g.kind}-S${g.sid}-${hash8(batchNos.join('+'))}`;
        const crAcctNum = g.kind === 'accrual' ? ACCRUED_ACCT : PREPAID_ACCT;
        const crAcctId = g.kind === 'accrual' ? accruedId : prepaidId;
        const kindLabel = g.kind === 'accrual' ? 'Accrued expenses' : 'Prepaid amortisation';
        // 每張單一條 CR 行 (memo = 該單該日明細 description)，方便追返邊張單
        const crItems: any[] = [];
        const crPreview: any[] = [];
        const perBatch = new Map<string, number>();
        for (const bn of batchNos) {
          const ss = g.specs.filter((s) => s.batchNo === bn);
          const tot = r2(ss.reduce((a, s) => a + s.amt, 0));
          perBatch.set(ss[0].batchId, tot);
          const memo = (ss[0].memo || `${kindLabel} ${bn}`).slice(0, 4000);
          const cr: any = { account: { id: String(crAcctId) }, credit: tot, memo };
          if (ss[0].deptId != null) cr.department = { id: String(ss[0].deptId) };
          crItems.push(cr);
          crPreview.push({
            doc: 'JE', date: g.date, kind: g.kind, account: acctLabel(crAcctNum), debit: null, credit: tot,
            department: deptLabel(ss[0].deptCode), project: '', memo, batch_no: bn,
          });
        }
        const total = r2(g.specs.reduce((a, s) => a + s.amt, 0));
        const single = batchNos.length === 1;
        const memo = (single
          ? (g.specs[0].memo || `${kindLabel} ${g.date} - ${batchNos[0]}`)
          : `${kindLabel} ${g.date} - ${batchNos.join(', ')}`).slice(0, 4000);
        return {
          external_id: externalId, date: g.date, kind: g.kind, sid: g.sid, subsidiary: subShort.get(g.sid) || String(g.sid),
          batches: batchNos, batch_ids: batchIdsIn, per_batch: perBatch, lines: g.specs.length, total, memo,
          preview: [...g.specs.map((s) => s.preview), ...crPreview],
          payload: {
            externalId, subsidiary: { id: String(g.sid) }, currency: { id: '1' }, tranDate: g.date, memo, approved: false,
            line: { items: [...g.specs.map((s) => s.dr), ...crItems] },
          },
        };
      });

    const batchJournals = (batchId: string, withStatus?: Map<string, any>) =>
      journals.filter((j) => j.batch_ids.includes(batchId)).map((j) => {
        const st = withStatus?.get(j.external_id);
        return {
          date: j.date, kind: j.kind, external_id: j.external_id, combined: j.batches.length,
          total: j.per_batch.get(batchId) || 0,
          ...(st ? { status: st.status, netsuite_id: st.netsuite_id, error: st.error } : {}),
        };
      });

    if (dryRun) {
      for (const p of pendings) {
        results.push({
          batch_id: p.batch.id, batch_no: p.batch.batch_no, label: p.label, vendor: p.vendorLabel, status: 'dry_run',
          bill_date: p.billDate, lines: p.lines, total: p.total, header_memo: p.headerMemo,
          invoice_no: p.batch.supplier_invoice_no || null, due_date: p.batch.payment_due_date || null, is_prepayment: !!p.batch.is_prepayment,
          journals: batchJournals(p.batch.id),
          already_posted: skippedByBatch.get(p.batch.id) || 0,
          // bill 分錄 preview：bill 行 + AP 貸方 (JE 喺 top-level journals，同日期跨批次合併)
          preview: [
            ...p.billPreview,
            { doc: 'BILL', date: p.billDate, kind: 'ap', account: acctLabel('33000010'), debit: null, credit: p.total,
              department: '', project: '', memo: `Accounts Payable - ${p.vendorLabel}`, batch_no: p.batch.batch_no },
          ],
        });
      }
      return new Response(
        JSON.stringify({
          ok: failed === 0, dry_run: true, warnings, probe: probeInfo, batches: (batches || []).length, created, duplicates, failed, results,
          journals: journals.map((j) => ({ external_id: j.external_id, date: j.date, kind: j.kind, subsidiary: j.subsidiary, batches: j.batches, lines: j.lines, total: j.total, memo: j.memo, preview: j.preview })),
        }, null, 2),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    // ---- phase 3: post bills ----
    const billOut = new Map<string, { status: 'created' | 'duplicate'; id?: string; dbProblem: string }>();
    for (const p of pendings) {
      const bill = await postRecord('vendorBill', p.payload);
      if (!bill.ok && !bill.duplicate) {
        failed++;
        results.push({ batch_id: p.batch.id, batch_no: p.batch.batch_no, label: p.label, status: 'error', error: bill.error });
        continue;
      }
      const billStatus: 'created' | 'duplicate' = bill.ok ? 'created' : 'duplicate';
      // CardRecon 狀態更新 — 失敗一定要報出嚟 (bill 已經喺 NetSuite，唔可以靜靜地留喺 approved)
      let dbProblem = '';
      if (billStatus === 'created') {
        created++;
        const upd = await svc.from('claim_batches').update({
          status: 'exported',
          netsuite_journal_no: `BILL ${bill.id}`,
          exported_at: new Date().toISOString(),
          exported_by_user_id: claims.sub || null,
        }).eq('id', p.batch.id).in('status', ['approved', 'exported']).select('id');
        if (upd.error) dbProblem = `CardRecon 狀態更新失敗 (bill ${bill.id} 已喺 NetSuite): ${upd.error.message}`;
        else if (!upd.data?.length) dbProblem = `CardRecon 狀態更新失敗 (bill ${bill.id} 已喺 NetSuite): 批次狀態已變`;
      } else {
        duplicates++;
        const upd = await svc.from('claim_batches').update({
          status: 'exported',
          exported_at: new Date().toISOString(),
          exported_by_user_id: claims.sub || null,
        }).eq('id', p.batch.id).eq('status', 'approved');
        if (upd.error) dbProblem = `CardRecon 狀態更新失敗: ${upd.error.message}`;
      }
      billOut.set(p.batch.id, { status: billStatus, id: bill.id, dbProblem });
    }

    // ---- phase 4: post combined JEs (只計 bill 成功 / 已存在嘅批次) ----
    const jeOut = new Map<string, { status: 'created' | 'duplicate' | 'error'; netsuite_id?: string; error?: string }>();
    for (const j of journals) {
      const activeIds = j.batch_ids.filter((id) => billOut.has(id));
      if (activeIds.length === 0) continue;
      let payload = j.payload;
      let externalId = j.external_id;
      let batchesNow = j.batches;
      if (activeIds.length !== j.batch_ids.length) {
        // 有批次 bill 失敗 → 只入其餘批次嘅行，externalId 跟返實際包含嘅批次
        const idOfNo = new Map(jeSpecs.map((s) => [s.batchNo, s.batchId]));
        batchesNow = j.batches.filter((bn) => activeIds.includes(idOfNo.get(bn) || ''));
        externalId = `PAYJE-${j.date.replace(/-/g, '')}-${j.kind}-S${j.sid}-${hash8(batchesNow.join('+'))}`;
        const drItems = jeSpecs.filter((s) => s.date === j.date && s.kind === j.kind && s.sid === j.sid && activeIds.includes(s.batchId)).map((s) => s.dr);
        // CR 行同 j.batches 一一對應 (phase 2 按 batchNos 順序建)
        const crItems = payload.line.items.slice(j.lines).filter((_: any, idx: number) => batchesNow.includes(j.batches[idx]));
        payload = { ...payload, externalId, line: { items: [...drItems, ...crItems] } };
      }
      const r = await postRecord('journalEntry', payload);
      const status: 'created' | 'duplicate' | 'error' = r.ok ? 'created' : r.duplicate ? 'duplicate' : 'error';
      jeOut.set(j.external_id, { status, netsuite_id: r.id, error: r.error });
      if (status !== 'error') {
        const rows = activeIds.map((id) => ({
          batch_id: id, je_date: j.date, kind: j.kind, external_id: externalId, netsuite_id: r.id || null,
          amount: j.per_batch.get(id) || 0, posted_by_user_id: claims.sub || null,
        }));
        const ins = await svc.from('payment_je_posts').upsert(rows, { onConflict: 'batch_id,je_date,kind' });
        if (ins.error) jeOut.set(j.external_id, { status, netsuite_id: r.id, error: `JE 已入 NetSuite 但 payment_je_posts 記錄失敗: ${ins.error.message}` });
      }
    }

    // ---- phase 5: per-batch results + audit ----
    for (const p of pendings) {
      const bo = billOut.get(p.batch.id);
      if (!bo) continue;
      const mine = batchJournals(p.batch.id, jeOut);
      const jeFailed = mine.filter((m: any) => m.status === 'error').length;
      const jeIds = mine.filter((m: any) => m.netsuite_id).map((m: any) => m.netsuite_id);
      const jeNote = (jeIds.length ? `; JE ${[...new Set(jeIds)].join(', ')}` : '') + (jeFailed ? `; ${jeFailed} JE 失敗` : '');
      if (bo.status === 'created') {
        const aud = await svc.from('claim_audit_log').insert({
          batch_id: p.batch.id, action: 'exported', from_status: p.batch.status, to_status: 'exported',
          actor_user_id: claims.sub || null, comment: `NetSuite vendor bill ${bo.id} (${p.vendorLabel})${jeNote}`,
        });
        if (aud.error && !bo.dbProblem) bo.dbProblem = `audit log 寫入失敗: ${aud.error.message}`;
      } else if (jeIds.length) {
        await svc.from('claim_audit_log').insert({
          batch_id: p.batch.id, action: 'exported', from_status: 'exported', to_status: 'exported',
          actor_user_id: claims.sub || null, comment: `NetSuite bill 已存在${jeNote}`,
        });
      }
      if (jeFailed > 0 || bo.dbProblem) failed++;
      const errParts: string[] = [];
      if (jeFailed > 0) errParts.push(`${jeFailed} 張 JE 入唔到: ` + mine.filter((m: any) => m.status === 'error').map((m: any) => `${m.date} ${m.error}`).join(' | '));
      if (bo.dbProblem) errParts.push(bo.dbProblem);
      if (!errParts.length && bo.status === 'duplicate') errParts.push('externalId already posted (bill 已存在 NetSuite)');
      results.push({
        batch_id: p.batch.id, batch_no: p.batch.batch_no, label: p.label, vendor: p.vendorLabel,
        status: jeFailed > 0 || bo.dbProblem ? 'partial' : bo.status,
        netsuite_id: bo.id, bill_date: p.billDate, lines: p.lines, total: p.total,
        journals: mine, already_posted: skippedByBatch.get(p.batch.id) || 0,
        error: errParts.length ? errParts.join(' | ') : undefined,
      });
    }

    return new Response(
      JSON.stringify({
        ok: failed === 0, dry_run: false, warnings, probe: probeInfo, batches: (batches || []).length, created, duplicates, failed, results,
        journals: journals.filter((j) => jeOut.has(j.external_id)).map((j) => ({
          external_id: j.external_id, date: j.date, kind: j.kind, subsidiary: j.subsidiary, batches: j.batches, lines: j.lines, total: j.total,
          ...jeOut.get(j.external_id),
        })),
      }, null, 2),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e).slice(0, 1500) }), { status: 500, headers: CORS });
  }
});
