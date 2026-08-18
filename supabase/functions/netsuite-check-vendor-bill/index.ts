// Edge Function: check whether a supplier invoice number already exists as a
// NetSuite Vendor Bill for the given payee — 付款申請提交前嘅發票查重。
// 任何登入同事都可以 call (只讀存在與否，唔會回傳金額等內容)。
//
// Request body: { payee_name: string, invoice_no: string }
// Response: { vendor_found: boolean, exists: boolean, bill?: { tranid, trandate } }
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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    // ---- auth: 任何有 profile 嘅登入用戶 (BU user 提交表格都要用) ----
    const authz = req.headers.get('Authorization') || '';
    const jwt = authz.replace(/^Bearer\s+/i, '');
    const claims = jwt.split('.').length === 3 ? b64urlJson(jwt.split('.')[1]) : {};
    let okAuth = claims.role === 'service_role';
    if (!okAuth && claims.sub) {
      const { data: prof } = await svc.from('user_profiles').select('user_id').eq('user_id', claims.sub).maybeSingle();
      okAuth = prof != null;
    }
    if (!okAuth) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: CORS });

    const body = await req.json().catch(() => ({}));
    const payeeName = String(body.payee_name || '').trim();
    const invoiceNo = String(body.invoice_no || '').trim();
    if (!payeeName || !invoiceNo) {
      return new Response(JSON.stringify({ error: 'payee_name and invoice_no required' }), { status: 400, headers: CORS });
    }

    const { data: cfg, error: cfgErr } = await svc.rpc('ns_get_config');
    if (cfgErr) throw cfgErr;
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

    // vendor：先查鏡射表 (快)，唔得先 SuiteQL
    let vendorId: string | null = null;
    const { data: mirror } = await svc.from('ns_vendor_directory')
      .select('internal_id, entityid, company_name')
      .eq('is_inactive', false);
    const q = payeeName.toLowerCase();
    const hit = (mirror || []).find((v: any) =>
      String(v.company_name || '').trim().toLowerCase() === q ||
      String(v.entityid || '').trim().toLowerCase() === q);
    if (hit) vendorId = String(hit.internal_id);
    if (!vendorId) {
      const rows = await suiteql(
        `SELECT id FROM vendor WHERE isinactive = 'F' AND (UPPER(companyname) = UPPER('${sqlq(payeeName)}') OR UPPER(entityid) = UPPER('${sqlq(payeeName)}'))`,
      );
      if (rows.length === 1) vendorId = String(rows[0].id);
    }
    if (!vendorId) {
      return new Response(JSON.stringify({ vendor_found: false, exists: false }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const bills = await suiteql(
      `SELECT t.tranid, TO_CHAR(t.trandate,'YYYY-MM-DD') AS trandate
       FROM transaction t
       WHERE t.type = 'VendBill' AND t.entity = ${Number(vendorId)}
         AND UPPER(t.tranid) = UPPER('${sqlq(invoiceNo)}')`,
    );
    return new Response(JSON.stringify({
      vendor_found: true,
      exists: bills.length > 0,
      bill: bills[0] ? { tranid: bills[0].tranid, trandate: bills[0].trandate } : undefined,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e).slice(0, 1000) }), { status: 500, headers: CORS });
  }
});
