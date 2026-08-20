// Edge Function: mirror NetSuite projects (job) + 對應 customer 名 into
// ns_project_codes — credit card recon / claims / payments 嘅 project picker
// 都讀呢張表。
//   project_id    = job.entityid   (e.g. P2410001148)
//   project_name  = job.companyname
//   customer_name = job.customer → customer.companyname
//   charge_to     = 現有行保留人手 mapping；新 project 由 subsidiary derive
//                   (PBHK→PB, SSHK→SS, CLS/JM/704 照用)
// Full-refresh semantics: 今次 run 冇觸及嘅行 is_active=false (NetSuite 已
// 停用/刪除)，pickers 唔再顯示但歷史紀錄保留。
//
// Auth: service_role JWT / owner/admin profile / x-cron-secret header
// (pg_cron 每日排程用)。 Request body: {}
// Response: { ok, projects, new_projects, customers_mapped, deactivated }
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

// ns_subsidiaries.short_code → 新 project 嘅 charge_to base
const SHORT_TO_CHARGE: Record<string, string> = {
  PBHK: 'PB', SSHK: 'SS', CLS: 'CLS', JM: 'JM', '704': '704', GoAsia: 'GoAsia',
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

    // keyset pagination helper (id ascending, 1000/page)
    const fetchAll = async (buildQ: (lastId: number) => string, maxPages = 30): Promise<any[]> => {
      const out: any[] = [];
      let lastId = -1;
      for (let page = 0; page < maxPages; page++) {
        const rows = await suiteql(buildQ(lastId));
        if (rows.length === 0) break;
        out.push(...rows);
        lastId = Number(rows[rows.length - 1].id);
        if (rows.length < 1000) break;
      }
      return out;
    };

    const runStart = new Date().toISOString();

    // ---- customers: id → 名 (job.customer 對返出嚟做 customer_name) ----
    const custRows = await fetchAll((lastId) => `
      SELECT id, entityid, companyname, firstname, lastname
      FROM customer
      WHERE id > ${lastId}
      ORDER BY id`);
    const custName = new Map<number, string>();
    for (const c of custRows) {
      const personName = [c.firstname, c.lastname].filter(Boolean).join(' ').trim();
      custName.set(Number(c.id), c.companyname || personName || c.entityid || String(c.id));
    }

    // ---- 現有 mapping：保留人手設定嘅 charge_to (e.g. PB-Prod / PB-Admin) ----
    const existingChargeTo = new Map<number, string>();
    for (let from = 0; ; from += 1000) {
      const { data: rows, error } = await svc.from('ns_project_codes')
        .select('internal_id, charge_to').range(from, from + 999);
      if (error) throw error;
      for (const r of rows || []) {
        if (r.internal_id != null && r.charge_to) existingChargeTo.set(Number(r.internal_id), String(r.charge_to));
      }
      if (!rows || rows.length < 1000) break;
    }

    // ---- subsidiaries → entity_name / subsidiary / 新 project charge_to ----
    const { data: subs, error: subErr } = await svc.from('ns_subsidiaries')
      .select('internal_id, name, full_name, short_code');
    if (subErr) throw subErr;
    const subById = new Map<number, any>();
    for (const s of subs || []) subById.set(Number(s.internal_id), s);

    // ---- projects (job) ----
    const jobRows = await fetchAll((lastId) => `
      SELECT id, entityid, companyname, customer, subsidiary
      FROM job
      WHERE isinactive = 'F' AND id > ${lastId}
      ORDER BY id`);

    let newProjects = 0;
    const records = jobRows.map((j) => {
      const iid = Number(j.id);
      const sub = subById.get(Number(j.subsidiary));
      const kept = existingChargeTo.get(iid);
      if (!kept) newProjects++;
      const derived = sub ? (SHORT_TO_CHARGE[String(sub.short_code)] || String(sub.short_code || '')) : '';
      return {
        internal_id: iid,
        project_id: j.entityid || String(iid),
        project_name: j.companyname || j.entityid || String(iid),
        customer_name: custName.get(Number(j.customer)) || null,
        charge_to: kept || derived || null,
        // mirror 表冇對應 subsidiary (e.g. Elimination) — entity_name NOT NULL，用 fallback
        entity_name: sub?.name || `Subsidiary ${j.subsidiary ?? '?'}`,
        subsidiary: sub?.full_name || sub?.name || null,
        is_active: true,
        synced_at: runStart,
      };
    });

    for (let i = 0; i < records.length; i += 500) {
      const { error } = await svc.from('ns_project_codes')
        .upsert(records.slice(i, i + 500), { onConflict: 'internal_id' });
      if (error) throw error;
    }

    // 今次 run 冇觸及嘅 = NetSuite 已停用/刪除 → 收起佢 (picker 唔再出)
    const { data: deactRows } = await svc.from('ns_project_codes')
      .update({ is_active: false })
      .or(`synced_at.lt.${runStart},synced_at.is.null`)
      .eq('is_active', true)
      .select('internal_id');

    return new Response(JSON.stringify({
      ok: true,
      projects: records.length,
      new_projects: newProjects,
      customers_mapped: custName.size,
      deactivated: (deactRows || []).length,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e).slice(0, 1500) }), { status: 500, headers: CORS });
  }
});
