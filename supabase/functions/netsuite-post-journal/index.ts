// Edge Function: post a CardRecon claim batch to NetSuite as a Journal Entry.
//
// App-native NetSuite sync (does NOT go through any Claude/MCP layer). Called
// with a super-user (owner/admin) Supabase JWT, or the service-role key.
//
// Flow: authorize -> load TBA creds + account id from Vault (via ns_get_config)
// -> resolve the claim batch + approved lines -> map expense categories,
// subsidiary and department to NetSuite internal IDs -> build a balanced
// journal entry (CR Accounts Payable, DR each expense line) -> sign with
// TBA OAuth 1.0a (HMAC-SHA256) -> POST to the NetSuite REST record API ->
// mark the batch `exported` with its NetSuite id.
//
// Idempotency: externalId = batch_no (NetSuite rejects duplicates) AND the
// function refuses a batch that already has netsuite_journal_no.
// Safety: the JE is created with approved=false, so a human still approves it
// inside NetSuite before it posts to the ledger.
//
// Request body: { "batch_id": "<uuid>" } or { "batch_no": "CLM-YYYYMM-####" },
//               optional { "dry_run": true } to return the built payload only.
import { createClient } from 'jsr:@supabase/supabase-js@2';

// ---------- OAuth 1.0a (TBA, HMAC-SHA256) ----------
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

Deno.serve(async (req) => {
  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    // ---- authorize caller: service_role JWT, or owner/admin user ----
    const authz = req.headers.get('Authorization') || '';
    const jwt = authz.replace(/^Bearer\s+/i, '');
    const claims = jwt.split('.').length === 3 ? b64urlJson(jwt.split('.')[1]) : {};
    let ok = claims.role === 'service_role';
    if (!ok && claims.sub) {
      const { data: prof } = await svc.from('user_profiles').select('role').eq('user_id', claims.sub).maybeSingle();
      ok = prof != null && ['owner', 'admin'].includes(prof.role);
    }
    if (!ok) return new Response(JSON.stringify({ error: 'forbidden: owner/admin only' }), { status: 403 });

    const body = await req.json().catch(() => ({}));
    const dryRun = body.dry_run === true;

    // ---- load config ----
    const { data: cfg, error: cfgErr } = await svc.rpc('ns_get_config');
    if (cfgErr) throw cfgErr;
    for (const k of ['ns_account_id', 'ns_tba_consumer_key', 'ns_tba_consumer_secret', 'ns_tba_token_id', 'ns_tba_token_secret']) {
      if (!cfg?.[k]) return new Response(JSON.stringify({ error: `missing config: ${k}` }), { status: 500 });
    }

    // ---- resolve batch ----
    let bq = svc.from('claim_batches').select('*');
    if (body.batch_id) bq = bq.eq('id', body.batch_id);
    else if (body.batch_no) bq = bq.eq('batch_no', body.batch_no);
    else return new Response(JSON.stringify({ error: 'batch_id or batch_no required' }), { status: 400 });
    const { data: batch, error: bErr } = await bq.maybeSingle();
    if (bErr) throw bErr;
    if (!batch) return new Response(JSON.stringify({ error: 'batch not found' }), { status: 404 });
    if (!['approved', 'exported'].includes(batch.status))
      return new Response(JSON.stringify({ error: `batch status is '${batch.status}', must be approved` }), { status: 409 });
    if (batch.netsuite_journal_no && !dryRun)
      return new Response(JSON.stringify({ error: `already posted as ${batch.netsuite_journal_no}` }), { status: 409 });

    // ---- subsidiary + department internal ids ----
    const { data: sub } = await svc.from('ns_subsidiaries').select('internal_id')
      .or(`full_name.eq.${batch.subsidiary_full_name},short_code.eq.${batch.entity_code}`).limit(1).maybeSingle();
    const { data: dept } = await svc.from('ns_departments').select('internal_id').eq('charge_to', batch.charge_to_code).limit(1).maybeSingle();
    if (!sub?.internal_id) return new Response(JSON.stringify({ error: `subsidiary not mapped for ${batch.entity_code}` }), { status: 422 });

    // ---- lines (approved) + expense-account internal ids ----
    const { data: lines, error: lErr } = await svc.from('claim_lines')
      .select('item_no,line_date,hkd_amount,description,expense_category_code,line_status').eq('batch_id', batch.id).neq('line_status', 'rejected').order('item_no');
    if (lErr) throw lErr;
    if (!lines || lines.length === 0) return new Response(JSON.stringify({ error: 'no postable lines' }), { status: 422 });

    const { data: cats } = await svc.from('expense_categories').select('category_key,ns_account_number');
    const catMap = new Map((cats || []).map((c: any) => [c.category_key, c.ns_account_number]));
    const acctNums = [...new Set(lines.map((l: any) => catMap.get(l.expense_category_code)).filter(Boolean))];
    const { data: coa } = await svc.from('ns_chart_of_accounts').select('account_number,internal_id').in('account_number', acctNums as string[]);
    const acctMap = new Map((coa || []).map((a: any) => [a.account_number, a.internal_id]));
    const { data: apAcct } = await svc.from('ns_chart_of_accounts').select('internal_id').eq('account_number', '33000010').maybeSingle();
    if (!apAcct?.internal_id) return new Response(JSON.stringify({ error: 'AP account 33000010 not mapped' }), { status: 422 });

    // ---- build balanced JE ----
    const deptRef = dept?.internal_id ? { id: String(dept.internal_id) } : undefined;
    const claimant = batch.full_name || 'claimant';
    const drItems: any[] = [];
    let total = 0;
    const unmapped: string[] = [];
    for (const l of lines as any[]) {
      const amt = Number(l.hkd_amount) || 0;
      total += amt;
      const an = catMap.get(l.expense_category_code);
      const aid = an ? acctMap.get(an) : null;
      if (!aid) { unmapped.push(`item ${l.item_no}: category ${l.expense_category_code}`); continue; }
      const line: any = { account: { id: String(aid) }, memo: `[${claimant}] ${l.description || ''}`.slice(0, 4000) };
      if (amt < 0) line.credit = Math.abs(amt); else line.debit = amt;
      if (deptRef) line.department = deptRef;
      drItems.push(line);
    }
    if (unmapped.length) return new Response(JSON.stringify({ error: 'unmapped expense accounts', detail: unmapped }), { status: 422 });

    const crLine: any = { account: { id: String(apAcct.internal_id) }, credit: total, memo: `Accounts payable - ${claimant}` };
    if (deptRef) crLine.department = deptRef;

    const payload: any = {
      externalId: batch.batch_no,
      subsidiary: { id: String(sub.internal_id) },
      currency: { id: '1' },
      tranDate: batch.submit_date || new Date().toISOString().slice(0, 10),
      memo: `CardRecon claim ${batch.batch_no} - ${claimant}`,
      approved: false,
      line: { items: [crLine, ...drItems] },
    };

    if (dryRun) return new Response(JSON.stringify({ dry_run: true, payload }, null, 2), { headers: { 'Content-Type': 'application/json' } });

    // ---- sign + POST to NetSuite ----
    const host = String(cfg.ns_account_id).toLowerCase().replace(/_/g, '-');
    const url = `https://${host}.suitetalk.api.netsuite.com/services/rest/record/v1/journalEntry`;
    const header = await authHeader('POST', url, cfg as Record<string, string>);
    const nsRes = await fetch(url, { method: 'POST', headers: { Authorization: header, 'Content-Type': 'application/json', Prefer: 'transient' }, body: JSON.stringify(payload) });

    if (!(nsRes.status === 204 || nsRes.status === 201 || nsRes.ok)) {
      const errText = await nsRes.text();
      return new Response(JSON.stringify({ error: 'NetSuite rejected', status: nsRes.status, detail: errText.slice(0, 1500) }), { status: 502 });
    }
    const loc = nsRes.headers.get('Location') || '';
    const nsId = loc.split('/').pop() || 'created';
    const je = `NS-${nsId}`;

    const { data: marked } = await svc.rpc('ns_mark_batch_exported', { p_batch_id: batch.id, p_je: je });
    return new Response(JSON.stringify({ ok: true, netsuite_id: nsId, batch_no: batch.batch_no, marked, total }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e).slice(0, 1500) }), { status: 500 });
  }
});
