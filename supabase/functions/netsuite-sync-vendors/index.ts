// Edge Function: mirror NetSuite vendors into ns_vendor_directory, feeding
// the payment-requisition payee picker.
//   individual vendor (isperson=T) = 自由工作者 (freelancer)
//   company vendor    (isperson=F) = 供應商 (supplier)
// Full-refresh semantics: every active vendor is upserted with a fresh
// synced_at; anything not touched this run is flagged is_inactive so it
// drops out of the picker without losing history.
//
// Request body: {}  Response: { ok, fetched, pages, deactivated }
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
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    // ---- auth: owner/admin、service role，或 pg_cron 嘅 x-cron-secret ----
    const authz = req.headers.get('Authorization') || '';
    const jwt = authz.replace(/^Bearer\s+/i, '');
    const claims = jwt.split('.').length === 3 ? b64urlJson(jwt.split('.')[1]) : {};
    let okAuth = claims.role === 'service_role';
    if (!okAuth && claims.sub) {
      const { data: prof } = await svc.from('user_profiles').select('role').eq('user_id', claims.sub).maybeSingle();
      okAuth = prof != null && ['owner', 'admin'].includes(prof.role);
    }
    if (!okAuth) {
      const cronSecret = req.headers.get('x-cron-secret');
      if (cronSecret) {
        const { data: expected } = await svc.rpc('ns_get_cron_secret');
        okAuth = !!expected && cronSecret === expected;
      }
    }
    if (!okAuth) return new Response(JSON.stringify({ error: 'forbidden: owner/admin only' }), { status: 403, headers: CORS });

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

    const runStart = new Date().toISOString();
    let lastId = -1;
    let fetched = 0, pages = 0;
    const allRecords: any[] = [];
    for (;;) {
      pages++;
      if (pages > 30) break; // ~30k vendors hard stop
      const rows = await suiteql(`
        SELECT id, entityid, companyname, isperson, firstname, lastname
        FROM vendor
        WHERE isinactive = 'F' AND id > ${lastId}
        ORDER BY id`);
      if (rows.length === 0) break;
      fetched += rows.length;
      lastId = Number(rows[rows.length - 1].id);

      for (const r of rows) {
        const personName = [r.firstname, r.lastname].filter(Boolean).join(' ').trim();
        allRecords.push({
          internal_id: Number(r.id),
          entityid: r.entityid || null,
          company_name: r.companyname || personName || r.entityid || String(r.id),
          is_person: r.isperson === 'T',
          is_inactive: false,
          last_payment_date: null as string | null,
          synced_at: runStart,
        });
      }
      if (rows.length < 1000) break;
    }

    // 最後銀行交易日期 per vendor (vendor payment / cheque) —
    // 自由工作者超過兩年冇交易要重新交 IR56M 個人資料，就係靠呢個日期判斷
    const lastPay = new Map<number, string>();
    for (const r of await suiteql(`
      SELECT t.entity AS vid, TO_CHAR(MAX(t.trandate),'YYYY-MM-DD') AS last_pay
      FROM transaction t
      WHERE t.type IN ('VendPymt', 'Check') AND t.entity IS NOT NULL
      GROUP BY t.entity`)) {
      lastPay.set(Number(r.vid), String(r.last_pay));
    }
    for (const rec of allRecords) {
      rec.last_payment_date = lastPay.get(rec.internal_id) || null;
    }

    for (let i = 0; i < allRecords.length; i += 500) {
      const { error } = await svc.from('ns_vendor_directory')
        .upsert(allRecords.slice(i, i + 500), { onConflict: 'internal_id' });
      if (error) throw error;
    }

    // 今次 run 冇觸及嘅 = NetSuite 已停用/刪除 → 收起佢
    const { data: deactRows } = await svc.from('ns_vendor_directory')
      .update({ is_inactive: true })
      .lt('synced_at', runStart)
      .eq('is_inactive', false)
      .select('internal_id');

    return new Response(JSON.stringify({ ok: true, fetched, pages, deactivated: (deactRows || []).length }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e).slice(0, 1500) }), { status: 500, headers: CORS });
  }
});
