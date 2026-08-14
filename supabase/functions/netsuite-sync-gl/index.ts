// Edge Function: sync NetSuite GL lines on BANK accounts into ns_gl_entries,
// so Bank Recon's right-hand "NetSuite records" panel is fed automatically
// (no more manual XLSX imports).
//
// Pulls posting transactionAccountingLine rows whose account is accttype
// 'Bank' since a cutoff date (default: first day of the month 3 months ago),
// via SuiteQL with the app's TBA credentials (same pipeline as the journal
// post functions). Idempotent: each line carries ns_line_key
// '<transaction id>:<line id>' with a unique index — re-runs only insert NEW
// lines and never touch existing rows (so is_matched flags survive).
//
// Request body: { months?: number }  (or { since: 'YYYY-MM-DD' })
// Response: { ok, since, fetched, inserted, pages }
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
    let since: string;
    if (typeof body.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.since)) {
      since = body.since;
    } else {
      const months = Number.isFinite(body.months) ? Math.min(Math.max(Number(body.months), 1), 24) : 3;
      const d = new Date();
      d.setUTCMonth(d.getUTCMonth() - months, 1);
      since = d.toISOString().slice(0, 10);
    }

    // ---- config + SuiteQL ----
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

    // subsidiary internal id -> app short_code
    const { data: subs } = await svc.from('ns_subsidiaries').select('internal_id, short_code');
    const subCode = new Map((subs || []).map((s: any) => [Number(s.internal_id), String(s.short_code)]));

    // ---- keyset-paginated pull of bank-account GL lines ----
    let lastT = -1, lastL = -1;
    let fetched = 0, inserted = 0, pages = 0;
    for (;;) {
      pages++;
      if (pages > 60) break; // hard stop ~60k lines
      const q = `
        SELECT t.id AS tid, tl.id AS lid, t.tranid, t.type,
               TO_CHAR(t.trandate,'YYYY-MM-DD') AS trandate,
               a.acctnumber, a.accountsearchdisplayname AS acct_name,
               tal.debit, tal.credit, tl.subsidiary,
               BUILTIN.DF(tl.entity) AS entity_name, tl.memo
        FROM transactionAccountingLine tal
        JOIN transaction t ON t.id = tal.transaction
        JOIN transactionLine tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline
        JOIN account a ON a.id = tal.account
        WHERE a.accttype = 'Bank' AND tal.posting = 'T'
          AND t.trandate >= TO_DATE('${since}','YYYY-MM-DD')
          AND (t.id > ${lastT} OR (t.id = ${lastT} AND tl.id > ${lastL}))
        ORDER BY t.id, tl.id`;
      const rows = await suiteql(q);
      if (rows.length === 0) break;
      fetched += rows.length;
      const last = rows[rows.length - 1];
      lastT = Number(last.tid); lastL = Number(last.lid);

      const records = rows.map((r: any) => {
        const trandate = String(r.trandate || '');
        return {
          ns_line_key: `${r.tid}:${r.lid}`,
          subsidiary: subCode.get(Number(r.subsidiary)) || String(r.subsidiary ?? ''),
          account: String(r.acct_name || r.acctnumber || ''),
          entry_type: r.type || null,
          txn_date: trandate || null,
          transaction_number: r.tranid || null,
          entity_name: r.entity_name || null,
          description: r.memo || r.entity_name || null,
          debit: r.debit != null ? Number(r.debit) : null,
          credit: r.credit != null ? Number(r.credit) : null,
          memo: r.memo || null,
          period_month: trandate ? trandate.slice(0, 7) : null,
          is_matched: false,
        };
      }).filter((r: any) => r.txn_date);

      // insert only NEW lines — existing rows (and their is_matched) untouched
      const { data: ins, error } = await svc
        .from('ns_gl_entries')
        .upsert(records, { onConflict: 'ns_line_key', ignoreDuplicates: true })
        .select('id');
      if (error) throw error;
      inserted += (ins || []).length;

      if (rows.length < 1000) break;
    }

    return new Response(JSON.stringify({ ok: true, since, fetched, inserted, pages }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e).slice(0, 1500) }), { status: 500, headers: CORS });
  }
});
