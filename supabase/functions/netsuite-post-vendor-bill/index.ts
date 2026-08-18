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
// 預付款 (is_prepayment) 唔會自動開 bill — NetSuite 用 Vendor Prepayment 手動入。
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
      svc.from('ns_chart_of_accounts').select('account_number,internal_id'),
      svc.from('ns_subsidiaries').select('internal_id,name,full_name,short_code'),
      svc.from('ns_departments').select('charge_to,internal_id'),
    ]);
    const catAcct = new Map((cats || []).map((c: any) => [String(c.category_key), String(c.ns_account_number || '')]));
    const acctId = new Map((coa || []).filter((a: any) => a.internal_id != null).map((a: any) => [String(a.account_number), a.internal_id]));
    const subId = new Map<string, number>();
    for (const s of subs || []) {
      for (const k of [s.full_name, s.name, s.short_code]) if (k) subId.set(String(k), s.internal_id);
    }
    const deptByChargeTo = new Map<string, number>();
    for (const d of depts || []) if (d.charge_to && d.internal_id != null) deptByChargeTo.set(String(d.charge_to), d.internal_id);

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

    // ---- build + post per batch ----
    const results: any[] = [];
    let created = 0, duplicates = 0, failed = 0;
    for (const batch of batches || []) {
      const label = `${batch.batch_no || batch.id.slice(0, 8)} · ${batch.payee_name || '?'}`;
      const problems: string[] = [];
      const lines = linesByBatch.get(batch.id) || [];

      // 預付款/按金 — 唔係一般費用，唔會自動開 bill；NetSuite 用 Vendor
      // Prepayment / 預付科目手動入數，之後對沖。
      if (batch.is_prepayment) {
        results.push({ batch_id: batch.id, batch_no: batch.batch_no, label, status: 'prepayment', error: '預付款 — 請喺 NetSuite 用 Vendor Prepayment 入數，App 度撳「標記已入數」' });
        continue;
      }
      if (!['approved', 'exported'].includes(batch.status)) problems.push(`status 係 ${batch.status}，要 approved 先可以入數`);
      if (lines.length === 0) problems.push('冇 approved 明細行');
      if (!batch.batch_no) problems.push('冇 batch no');

      const vendor = batch.payee_name ? vendorByName.get(batch.payee_name.trim()) : undefined;
      if (!vendor) problems.push(vendorProblems.get((batch.payee_name || '').trim()) || 'missing payee name');

      const sid = subId.get(String(batch.entity_code || '')) ?? subId.get(String(batch.subsidiary_full_name || ''));
      if (sid == null) problems.push(`subsidiary not mapped: ${batch.entity_code || batch.subsidiary_full_name || '?'}`);

      const items: any[] = [];
      let total = 0;
      for (const l of lines) {
        const amt = Math.round(Number(l.hkd_amount || 0) * 100) / 100;
        if (amt === 0) continue;
        if (amt < 0) { problems.push(`行 #${l.item_no} 金額係負數 — bill 唔接受負數行`); continue; }
        const acctNum = l.expense_category_code ? catAcct.get(l.expense_category_code) : '';
        if (!acctNum) { problems.push(`行 #${l.item_no} 冇 expense category`); continue; }
        const aid = acctId.get(acctNum);
        if (aid == null) { problems.push(`account ${acctNum} 冇 internal id (行 #${l.item_no})`); continue; }
        const item: any = {
          account: { id: String(aid) },
          amount: amt,
          memo: [l.description, l.client_name ? `(${l.client_name})` : ''].filter(Boolean).join(' ').slice(0, 4000) || undefined,
        };
        // 一張發票拆多個 department：行有自己嘅 charge to 就用行嘅，否則跟表頭
        const chargeTo = (l.line_charge_to || batch.charge_to_code || '').trim();
        const did = chargeTo ? deptByChargeTo.get(chargeTo) : undefined;
        if (did != null) item.department = { id: String(did) };
        else if (l.line_charge_to) problems.push(`行 #${l.item_no} 嘅 charge to ${l.line_charge_to} 冇 department internal id`);
        const cp = (l.project_code || '').trim();
        if (cp) {
          const jid = jobId.get(cp);
          if (jid) item.customer = { id: jid };  // bill expense line books project 經 customer(job) field
          else problems.push(`project (job) not found: ${cp}`);
        }
        total += amt;
        items.push(item);
      }
      if (items.length === 0 && problems.length === 0) problems.push('冇有效明細行');

      if (problems.length > 0) {
        failed++;
        results.push({ batch_id: batch.id, batch_no: batch.batch_no, label, status: 'error', error: problems.join('; ') });
        continue;
      }

      const payload: any = {
        externalId: batch.batch_no,
        entity: { id: vendor!.id },
        subsidiary: { id: String(sid) },
        currency: { id: '1' },
        // 發票日期優先做 bill date；冇先用批核日/提交日
        tranDate: batch.invoice_date || toHKDate(batch.approved_at) || batch.submit_date || new Date().toISOString().slice(0, 10),
        memo: `CardRecon payment requisition ${batch.batch_no} - req by ${batch.full_name || '?'}`.slice(0, 4000),
        expense: { items },
      };
      if (batch.supplier_invoice_no) payload.tranId = String(batch.supplier_invoice_no).slice(0, 45);
      if (batch.payment_due_date) payload.dueDate = batch.payment_due_date;

      if (dryRun) {
        results.push({ batch_id: batch.id, batch_no: batch.batch_no, label, vendor: vendor!.label, status: 'dry_run', lines: items.length, total: Math.round(total * 100) / 100 });
        continue;
      }

      const url = `https://${host}.suitetalk.api.netsuite.com/services/rest/record/v1/vendorBill`;
      const header = await authHeader('POST', url, cfg as Record<string, string>);
      const nsRes = await fetch(url, {
        method: 'POST',
        headers: { Authorization: header, 'Content-Type': 'application/json', Prefer: 'transient' },
        body: JSON.stringify(payload),
      });
      if (nsRes.status === 204 || nsRes.status === 201 || nsRes.ok) {
        const loc = nsRes.headers.get('Location') || '';
        const nsInternalId = loc.split('/').pop() || 'created';
        created++;
        // approved → exported + 記低 bill id；audit log 一條
        await svc.from('claim_batches').update({
          status: 'exported',
          netsuite_journal_no: `BILL ${nsInternalId}`,
          exported_at: new Date().toISOString(),
          exported_by_user_id: claims.sub || null,
        }).eq('id', batch.id).in('status', ['approved', 'exported']);
        await svc.from('claim_audit_log').insert({
          batch_id: batch.id, action: 'exported', from_status: batch.status, to_status: 'exported',
          actor_user_id: claims.sub || null, comment: `NetSuite vendor bill ${nsInternalId} (${vendor!.label})`,
        });
        results.push({ batch_id: batch.id, batch_no: batch.batch_no, label, vendor: vendor!.label, status: 'created', netsuite_id: nsInternalId, lines: items.length, total: Math.round(total * 100) / 100 });
      } else {
        const errText = (await nsRes.text()).slice(0, 800);
        if (/already exists|duplicate/i.test(errText)) {
          duplicates++;
          await svc.from('claim_batches').update({
            status: 'exported',
            exported_at: new Date().toISOString(),
            exported_by_user_id: claims.sub || null,
          }).eq('id', batch.id).eq('status', 'approved');
          results.push({ batch_id: batch.id, batch_no: batch.batch_no, label, status: 'duplicate', error: 'externalId already posted (bill 已存在 NetSuite)' });
        } else {
          failed++;
          results.push({ batch_id: batch.id, batch_no: batch.batch_no, label, status: 'error', error: `NetSuite ${nsRes.status}: ${errText}` });
        }
      }
    }

    return new Response(
      JSON.stringify({ ok: failed === 0, dry_run: dryRun, batches: (batches || []).length, created, duplicates, failed, results }, null, 2),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e).slice(0, 1500) }), { status: 500, headers: CORS });
  }
});
