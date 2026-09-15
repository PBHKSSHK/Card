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
//   同日期嘅行合成一張 JE (unapproved draft)，externalId PAYJE-<batch_no>-<YYYYMMDD>，幂等。
// 一般付款：明細日期 = 發票日期 (表格已驗證)，發票日期做 bill date。
// Success → claim_batches.status='exported' + netsuite_journal_no='BILL <id>'.
// Duplicate externalId → status 'duplicate' (幂等，可以放心重按)。
//
// Request body: { batch_ids: string[], dry_run?: true }
// Response: { ok, created, duplicates, failed, results: [...] }
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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
    const subShort = new Map<number, string>();
    for (const s of subs || []) subShort.set(Number(s.internal_id), String(s.short_code || s.name || s.internal_id));

    // ---- build + post per batch ----
    const ACCRUED_ACCT = '37001010';   // Accrued Expenses - General
    const PREPAID_ACCT = '22005010';   // Prepaid Expenses
    // legacy tax：bill 每行都要 tax code。費用科目 NetSuite 會 default VAT_HK:UNDEF-HK，
    // 但 37001010 / 22005010 (balance sheet) 冇 default → 400 "Please enter value(s) for: Tax Code"
    // → 一律明確俾 VAT_HK:UNDEF-HK (0%，internal id 5，同 bill 68892 嘅費用行一樣)
    const TAX_CODE_ID = '5';
    const today = new Date().toISOString().slice(0, 10);
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

    // dry_run：預先 probe Bills / JE 權限，preview 即刻話你知入數會唔會 403
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
      const accruedId = acctId.get(ACCRUED_ACCT);
      const prepaidId = acctId.get(PREPAID_ACCT);
      if (batch.is_prepayment && (accruedId == null || prepaidId == null)) {
        problems.push(`預付款科目 ${ACCRUED_ACCT} / ${PREPAID_ACCT} 冇 internal id — 請先同步 Chart of Accounts`);
      }
      const batchDeptId = batch.charge_to_code ? deptByChargeTo.get(String(batch.charge_to_code)) : undefined;

      const items: any[] = [];
      // 預付款：行日期 ≠ 發票日期嘅行另出 JE，同日期合成一張
      const jeGroups = new Map<string, { date: string; kind: 'accrual' | 'prepaid'; items: any[]; total: number; preview: any[]; memo: string }>();
      // preview (dry_run 用)：入 NetSuite 前俾用戶睇分錄 — 日期 / 科目 / 借 / 貸 / 部門 / project
      const billPreview: any[] = [];
      const rawMemos: string[] = [];   // 表頭 memo 跟明細行 description
      let total = 0;
      for (const l of lines) {
        const amt = Math.round(Number(l.hkd_amount || 0) * 100) / 100;
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
        const kind: 'expense' | 'accrual' | 'prepaid' =
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
          department: deptLabel(chargeTo), project: kind === 'expense' ? cp : '', memo: billItem.memo || '',
        });

        if (kind !== 'expense') {
          let g = jeGroups.get(lineDate);
          if (!g) { g = { date: lineDate, kind, items: [], total: 0, preview: [], memo: memo || '' }; jeGroups.set(lineDate, g); }
          const dr: any = { account: { id: String(aid) }, debit: amt, memo };
          if (did != null) dr.department = { id: String(did) };
          if (jid) dr.entity = { id: jid };  // JE 行 project 經 entity (job)
          g.items.push(dr);
          g.total += amt;
          g.preview.push({
            doc: 'JE', date: lineDate, kind, account: acctLabel(acctNum), debit: amt, credit: null,
            department: deptLabel(chargeTo), project: cp, memo: memo || '',
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

      const journals = [...jeGroups.values()].sort((a, b) => a.date.localeCompare(b.date)).map((g) => {
        const crAcct = g.kind === 'accrual' ? accruedId : prepaidId;
        // JE 貸方 (22005010 / 37001010) 同 JE 表頭 memo 都跟返明細行 description
        const jeMemo = (g.memo || `${g.kind === 'accrual' ? 'Accrued expenses' : 'Prepaid amortisation'} ${batch.batch_no} - ${batch.payee_name || ''}`).slice(0, 4000);
        const cr: any = {
          account: { id: String(crAcct) },
          credit: Math.round(g.total * 100) / 100,
          memo: jeMemo,
        };
        if (batchDeptId != null) cr.department = { id: String(batchDeptId) };
        const crPreview = {
          doc: 'JE', date: g.date, kind: g.kind, account: acctLabel(g.kind === 'accrual' ? ACCRUED_ACCT : PREPAID_ACCT),
          debit: null, credit: Math.round(g.total * 100) / 100,
          department: deptLabel(String(batch.charge_to_code || '')), project: '', memo: cr.memo,
        };
        return {
          date: g.date, kind: g.kind, total: Math.round(g.total * 100) / 100,
          preview: [...g.preview, crPreview],
          payload: {
            externalId: `PAYJE-${String(batch.batch_no).replace(/[^A-Za-z0-9-]+/g, '')}-${g.date.replace(/-/g, '')}`,
            subsidiary: { id: String(sid) },
            currency: { id: '1' },
            tranDate: g.date,
            memo: jeMemo,
            approved: false,
            line: { items: [...g.items, cr] },
          },
        };
      });

      if (dryRun) {
        results.push({
          batch_id: batch.id, batch_no: batch.batch_no, label, vendor: vendor!.label, status: 'dry_run',
          bill_date: billDate, lines: items.length, total: Math.round(total * 100) / 100, header_memo: headerMemo,
          invoice_no: batch.supplier_invoice_no || null, due_date: batch.payment_due_date || null, is_prepayment: !!batch.is_prepayment,
          journals: journals.map((j) => ({ date: j.date, kind: j.kind, total: j.total, lines: j.payload.line.items.length })),
          // 完整分錄 preview：bill 行 + AP 貸方 + 每張 JE
          preview: [
            ...billPreview,
            { doc: 'BILL', date: billDate, kind: 'ap', account: acctLabel('33000010'), debit: null, credit: Math.round(total * 100) / 100,
              department: '', project: '', memo: `Accounts Payable - ${vendor!.label}` },
            ...journals.flatMap((j) => j.preview),
          ],
        });
        continue;
      }

      const bill = await postRecord('vendorBill', payload);
      if (!bill.ok && !bill.duplicate) {
        failed++;
        results.push({ batch_id: batch.id, batch_no: batch.batch_no, label, status: 'error', error: bill.error });
        continue;
      }
      const billStatus: 'created' | 'duplicate' = bill.ok ? 'created' : 'duplicate';

      // 預付款 JE — bill 新建或已存在都照 post (externalId 幂等，重按只會補漏)
      const jeResults: any[] = [];
      let jeFailed = 0;
      for (const j of journals) {
        const r = await postRecord('journalEntry', j.payload);
        if (r.ok) jeResults.push({ date: j.date, kind: j.kind, total: j.total, status: 'created', netsuite_id: r.id });
        else if (r.duplicate) jeResults.push({ date: j.date, kind: j.kind, total: j.total, status: 'duplicate' });
        else { jeFailed++; jeResults.push({ date: j.date, kind: j.kind, total: j.total, status: 'error', error: r.error }); }
      }
      const jeIds = jeResults.filter((r) => r.netsuite_id).map((r) => r.netsuite_id);
      const jeNote = (jeIds.length ? `; JE ${jeIds.join(', ')}` : '') + (jeFailed ? `; ${jeFailed} JE 失敗` : '');

      // CardRecon 狀態更新 — 失敗一定要報出嚟 (bill 已經喺 NetSuite，唔可以靜靜地留喺 approved)
      let dbProblem = '';
      if (billStatus === 'created') {
        created++;
        const upd = await svc.from('claim_batches').update({
          status: 'exported',
          netsuite_journal_no: `BILL ${bill.id}`,
          exported_at: new Date().toISOString(),
          exported_by_user_id: claims.sub || null,
        }).eq('id', batch.id).in('status', ['approved', 'exported']).select('id');
        if (upd.error) dbProblem = `CardRecon 狀態更新失敗 (bill ${bill.id} 已喺 NetSuite): ${upd.error.message}`;
        else if (!upd.data?.length) dbProblem = `CardRecon 狀態更新失敗 (bill ${bill.id} 已喺 NetSuite): 批次狀態已變`;
        const aud = await svc.from('claim_audit_log').insert({
          batch_id: batch.id, action: 'exported', from_status: batch.status, to_status: 'exported',
          actor_user_id: claims.sub || null, comment: `NetSuite vendor bill ${bill.id} (${vendor!.label})${jeNote}`,
        });
        if (aud.error && !dbProblem) dbProblem = `audit log 寫入失敗: ${aud.error.message}`;
      } else {
        duplicates++;
        const upd = await svc.from('claim_batches').update({
          status: 'exported',
          exported_at: new Date().toISOString(),
          exported_by_user_id: claims.sub || null,
        }).eq('id', batch.id).eq('status', 'approved');
        if (upd.error) dbProblem = `CardRecon 狀態更新失敗: ${upd.error.message}`;
        if (jeIds.length) {
          await svc.from('claim_audit_log').insert({
            batch_id: batch.id, action: 'exported', from_status: 'exported', to_status: 'exported',
            actor_user_id: claims.sub || null, comment: `NetSuite bill 已存在${jeNote}`,
          });
        }
      }
      if (jeFailed > 0 || dbProblem) failed++;
      const errParts: string[] = [];
      if (jeFailed > 0) errParts.push(`${jeFailed} 張 JE 入唔到: ` + jeResults.filter((r) => r.status === 'error').map((r) => `${r.date} ${r.error}`).join(' | '));
      if (dbProblem) errParts.push(dbProblem);
      if (!errParts.length && billStatus === 'duplicate') errParts.push('externalId already posted (bill 已存在 NetSuite)');
      results.push({
        batch_id: batch.id, batch_no: batch.batch_no, label, vendor: vendor!.label,
        status: jeFailed > 0 || dbProblem ? 'partial' : billStatus,
        netsuite_id: bill.id, bill_date: billDate, lines: items.length, total: Math.round(total * 100) / 100,
        journals: jeResults,
        error: errParts.length ? errParts.join(' | ') : undefined,
      });
    }

    return new Response(
      JSON.stringify({ ok: failed === 0, dry_run: dryRun, warnings, probe: probeInfo, batches: (batches || []).length, created, duplicates, failed, results }, null, 2),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e).slice(0, 1500) }), { status: 500, headers: CORS });
  }
});
