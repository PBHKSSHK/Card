// Edge Function: Xero OAuth 2.0 連線（project code 檢查用，只讀）
//
//   POST {action:"start"}  (owner/admin JWT) → { url }  前端 window.location = url
//   GET  ?code=..&state=..  Xero 授權後 redirect 返嚟 → 存 token → 跳返 CardRecon
//
// Starter tier 冇 Bulk Connections：每次授權揀一間公司，五間公司做五次（或一次剔晒，視乎 Xero 畫面）。
// Secrets：XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_REDIRECT_URI
//          (= https://<project>.supabase.co/functions/v1/xero-oauth), APP_URL (https://cardrecon-pbhk.vercel.app)
// 部署要 --no-verify-jwt（Xero callback 冇 Supabase JWT）；start 自己驗 admin。
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
// 新 Xero app (2026-03-02 之後開) 只可以用 granular scopes
const SCOPES = 'openid profile email offline_access accounting.invoices.read accounting.contacts.read accounting.settings.read';

function guessEntity(name: string): string | null {
  const n = name.toLowerCase();
  if (n.includes('social strategy') || /\bsshk\b/.test(n)) return 'SSHK';
  if (n.includes('704')) return '704';
  if (n.includes('jervois m')) return 'JM';
  if (n.includes('cls')) return 'CLS';
  if (n.includes('photoblog')) return 'PBHK';
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const clientId = Deno.env.get('XERO_CLIENT_ID') || '';
  const clientSecret = Deno.env.get('XERO_CLIENT_SECRET') || '';
  const redirectUri = Deno.env.get('XERO_REDIRECT_URI') || '';
  const appUrl = Deno.env.get('APP_URL') || 'https://cardrecon-pbhk.vercel.app';
  const url = new URL(req.url);

  // ---------- callback ----------
  if (req.method === 'GET' && (url.searchParams.get('code') || url.searchParams.get('error'))) {
    const back = (q: string) => Response.redirect(`${appUrl}/#/projects?tab=settings&xero=${encodeURIComponent(q)}`, 302);
    try {
      if (url.searchParams.get('error')) return back('error:' + url.searchParams.get('error'));
      const state = url.searchParams.get('state') || '';
      const { data: st } = await svc.from('xero_oauth_states').select('user_id, created_at').eq('state', state).maybeSingle();
      if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60 * 1000) return back('error:state');
      await svc.from('xero_oauth_states').delete().eq('state', state);

      const tok = await fetch('https://identity.xero.com/connect/token', {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + btoa(`${clientId}:${clientSecret}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code')!, redirect_uri: redirectUri }),
      });
      if (!tok.ok) return back('error:token_' + tok.status);
      const t = await tok.json();
      const conns = await fetch('https://api.xero.com/connections', { headers: { Authorization: `Bearer ${t.access_token}` } });
      const list = conns.ok ? await conns.json() : [];
      const expires = new Date(Date.now() + (Number(t.expires_in) - 60) * 1000).toISOString();
      for (const c of list) {
        if (c.tenantType !== 'ORGANISATION') continue;
        const { data: existing } = await svc.from('xero_connections').select('entity_code').eq('tenant_id', c.tenantId).maybeSingle();
        const entity = existing?.entity_code || guessEntity(c.tenantName || '');
        await svc.from('xero_connections').upsert({
          tenant_id: c.tenantId, tenant_name: c.tenantName, entity_code: entity,
          refresh_token: t.refresh_token, access_token: t.access_token, expires_at: expires,
          connected_by: st.user_id, updated_at: new Date().toISOString(),
        }, { onConflict: 'tenant_id' });
        // 同一次授權嘅其他 tenant 共用 token — 統一更新
        await svc.from('xero_connections').update({ refresh_token: t.refresh_token, access_token: t.access_token, expires_at: expires })
          .in('tenant_id', list.map((x: any) => x.tenantId));
        if (entity) await svc.from('project_companies').update({ xero_tenant_id: c.tenantId }).eq('entity_code', entity);
      }
      return back('connected:' + list.length);
    } catch (e) {
      return back('error:' + String((e as Error)?.message || e).slice(0, 80));
    }
  }

  // ---------- start ----------
  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u } = await svc.auth.getUser(jwt);
    if (!u?.user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: CORS });
    const { data: prof } = await svc.from('user_profiles').select('role').eq('user_id', u.user.id).maybeSingle();
    if (!prof || !['owner', 'admin'].includes(prof.role)) {
      return new Response(JSON.stringify({ error: 'owner/admin only' }), { status: 403, headers: CORS });
    }
    if (!clientId || !redirectUri) {
      return new Response(JSON.stringify({ error: '未設定 XERO_CLIENT_ID / XERO_REDIRECT_URI' }), { status: 400, headers: CORS });
    }
    const state = crypto.randomUUID();
    await svc.from('xero_oauth_states').insert({ state, user_id: u.user.id });
    const auth = new URL('https://login.xero.com/identity/connect/authorize');
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('client_id', clientId);
    auth.searchParams.set('redirect_uri', redirectUri);
    auth.searchParams.set('scope', SCOPES);
    auth.searchParams.set('state', state);
    return new Response(JSON.stringify({ url: auth.toString() }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e) }), { status: 500, headers: CORS });
  }
});
