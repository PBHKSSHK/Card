// Edge Function: 送出 project_notifications 入面 pending 嘅 email。
// 觸發：(1) 前端開 code / 續約後即刻 invoke；(2) pg_cron 每 10 分鐘補送。
//
// 郵件供應（揀一個，設 Supabase secret）：
//   A. Google Apps Script（建議，用公司 Google Workspace 帳戶寄出）
//      APPS_SCRIPT_MAIL_URL    = Apps Script web app URL (.../exec)
//      APPS_SCRIPT_MAIL_SECRET = 同 Apps Script Script Properties 入面 SECRET 一樣
//   B. Resend
//      RESEND_API_KEY, MAIL_FROM (例："CardRecon <noreply@pbhk.info>"，domain 要喺 Resend verify)
// 未設定任何一個 → email 留喺 pending，設定好之後下一輪自動補送。
//
// Auth：任何已登入用戶 (只會送已排隊嘅 email，冇其他作用)、service role，或 x-cron-secret。
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const MAX_ATTEMPTS = 5;

function b64urlJson(seg: string): any {
  try { return JSON.parse(atob(seg.replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; }
}

async function sendMail(to: string[], subject: string, html: string): Promise<void> {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  const gasUrl = Deno.env.get('APPS_SCRIPT_MAIL_URL');
  if (resendKey) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: Deno.env.get('MAIL_FROM') || 'CardRecon <onboarding@resend.dev>',
        to, subject, html,
      }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return;
  }
  if (gasUrl) {
    const r = await fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: Deno.env.get('APPS_SCRIPT_MAIL_SECRET') || '', to: to.join(','), subject, html }),
      redirect: 'follow',
    });
    const text = await r.text();
    if (!r.ok || !text.includes('"ok":true')) throw new Error(`Apps Script ${r.status}: ${text.slice(0, 300)}`);
    return;
  }
  throw new Error('NO_PROVIDER');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const claims = jwt.split('.').length === 3 ? b64urlJson(jwt.split('.')[1]) : {};
    let okAuth = claims.role === 'service_role' || (claims.role === 'authenticated' && !!claims.sub);
    if (!okAuth) {
      const cronSecret = req.headers.get('x-cron-secret');
      if (cronSecret) {
        const { data: expected } = await svc.rpc('ns_get_cron_secret');
        okAuth = !!expected && cronSecret === expected;
      }
    }
    if (!okAuth) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: CORS });

    const { data: rows, error } = await svc.from('project_notifications')
      .select('id, recipients, subject, body_html, attempts')
      .eq('status', 'pending').lt('attempts', MAX_ATTEMPTS)
      .order('id').limit(50);
    if (error) throw error;

    let sent = 0, failed = 0, noProvider = false;
    for (const n of rows || []) {
      try {
        await sendMail(n.recipients, n.subject, n.body_html);
        await svc.from('project_notifications')
          .update({ status: 'sent', sent_at: new Date().toISOString(), error: null, attempts: n.attempts + 1 })
          .eq('id', n.id);
        sent++;
      } catch (e) {
        const msg = String((e as Error)?.message || e);
        if (msg === 'NO_PROVIDER') {
          noProvider = true;
          await svc.from('project_notifications')
            .update({ error: '未設定 email 供應 (APPS_SCRIPT_MAIL_URL 或 RESEND_API_KEY)' }).eq('id', n.id);
          break;
        }
        const attempts = n.attempts + 1;
        await svc.from('project_notifications')
          .update({ attempts, error: msg.slice(0, 1000), status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending' })
          .eq('id', n.id);
        failed++;
      }
    }
    return new Response(JSON.stringify({ ok: true, sent, failed, no_provider: noProvider }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e).slice(0, 1500) }), { status: 500, headers: CORS });
  }
});
