// Edge Function: 每晚檢查五間公司 Xero 嘅 sales invoice 同 bill 有冇用啱 project code。
// Xero 本身冇辦法喺入數嗰刻 block，所以呢度做「事後即日 ban」：
//   錯嘅單 → 寫入 project_code_violations（CardRecon → Project Codes → 違規）
//          → email 會計（project_register_settings.notify_emails）
//   會計喺 Xero 改正（或 void）後，下一輪自動標記 resolved。
//
// 規則（rule 欄）：
//   missing        sales invoice 冇 project code（公司 require_code_invoice = true 先檢查；bill 睇 require_code_bill）
//   unknown        code 唔存在（打錯字、自己作 code）
//   closed         code 已 Closed / Cancelled，單據日期喺關閉之後
//   outside_period retainer 單據日期超過合約完結日（續約冇開新 code）
//   wrong_company  sales invoice 用咗第二間公司嘅 code，而客戶唔係集團公司
//   multiple       一張 sales invoice 有多過一個 project code
//
// Auth：owner/admin JWT、service role 或 x-cron-secret。Body: { days?: number }（重新檢查最近 N 日改過嘅單）
// API 用量：每間公司每次 1 次 /connections 以外，按 100 張一頁；Starter tier 每日 1,000 次夠用。
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const NEW_CODE = /\bP\d{2}(?:PB|SS|PR|JM|CG)-[RCEI]\d{4}(?:-\d{2})?\b/gi;
const LEGACY_CODE = /\bP\d{8,10}\b/gi;
const GROUP_CONTACT = /photoblog|social strategy|\bsshk\b|704 production|jervois|cls garage|cls production|go asia/i;
const MAX_PAGES_PER_TENANT = 8;

function b64urlJson(seg: string): any {
  try { return JSON.parse(atob(seg.replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; }
}
function xeroDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /\/Date\((\d+)/.exec(s);
  if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
  return s.slice(0, 10);
}
function extractCodes(inv: any): string[] {
  const texts = [inv.Reference || '', ...((inv.LineItems || []).map((l: any) => l.Description || ''))];
  const set = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(NEW_CODE)) set.add(m[0].toUpperCase());
    for (const m of t.matchAll(LEGACY_CODE)) set.add(m[0].toUpperCase());
  }
  return [...set];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const clientId = Deno.env.get('XERO_CLIENT_ID') || '';
  const clientSecret = Deno.env.get('XERO_CLIENT_SECRET') || '';
  try {
    // ---- auth ----
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
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
    if (!okAuth) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: CORS });

    const body = await req.json().catch(() => ({}));
    const days = Number(body?.days) > 0 ? Math.min(Number(body.days), 400) : null;

    const { data: settings } = await svc.from('project_register_settings').select('*').eq('id', 1).maybeSingle();
    if (settings && settings.xero_check_enabled === false) {
      return new Response(JSON.stringify({ ok: true, skipped: 'disabled' }), { headers: CORS });
    }
    const { data: companies } = await svc.from('project_companies').select('*');
    const compByEntity = new Map((companies || []).map((c: any) => [c.entity_code, c]));
    const { data: conns } = await svc.from('xero_connections').select('*').not('entity_code', 'is', null);
    if (!conns || conns.length === 0) {
      return new Response(JSON.stringify({ ok: true, skipped: '未連 Xero' }), { headers: CORS });
    }

    // code → lookup cache
    const lookupCache = new Map<string, any>();
    async function lookup(code: string) {
      if (!lookupCache.has(code)) {
        const { data } = await svc.rpc('project_code_lookup', { p_code: code });
        lookupCache.set(code, data);
      }
      return lookupCache.get(code);
    }

    async function accessToken(conn: any): Promise<string> {
      if (conn.access_token && conn.expires_at && new Date(conn.expires_at).getTime() > Date.now() + 60000) {
        return conn.access_token;
      }
      // 另一個 tenant 可能啱啱 refresh 咗同一個 grant — 重新讀
      const { data: fresh } = await svc.from('xero_connections').select('*').eq('tenant_id', conn.tenant_id).maybeSingle();
      if (fresh?.access_token && fresh.expires_at && new Date(fresh.expires_at).getTime() > Date.now() + 60000) {
        return fresh.access_token;
      }
      const old = fresh?.refresh_token || conn.refresh_token;
      const r = await fetch('https://identity.xero.com/connect/token', {
        method: 'POST',
        headers: { Authorization: 'Basic ' + btoa(`${clientId}:${clientSecret}`), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: old }),
      });
      if (!r.ok) throw new Error(`Xero token refresh ${r.status} — 請喺 Settings 重新連接 Xero`);
      const t = await r.json();
      const expires = new Date(Date.now() + (Number(t.expires_in) - 60) * 1000).toISOString();
      await svc.from('xero_connections')
        .update({ refresh_token: t.refresh_token, access_token: t.access_token, expires_at: expires, updated_at: new Date().toISOString() })
        .eq('refresh_token', old);
      return t.access_token;
    }

    const stats: Record<string, any> = {};
    let newViolations = 0;
    const runStart = new Date().toISOString();

    for (const conn of conns) {
      const comp: any = compByEntity.get(conn.entity_code);
      const st = { docs: 0, violations: 0, resolved: 0, pages: 0, error: null as string | null };
      stats[conn.entity_code] = st;
      try {
        const token = await accessToken(conn);
        const since = days
          ? new Date(Date.now() - days * 86400000)
          : conn.last_checked_at ? new Date(new Date(conn.last_checked_at).getTime() - 3600000)
          : new Date(Date.now() - 120 * 86400000);
        const ims = since.toUTCString();

        for (let page = 1; page <= MAX_PAGES_PER_TENANT; page++) {
          const u = new URL('https://api.xero.com/api.xro/2.0/Invoices');
          u.searchParams.set('page', String(page));
          u.searchParams.set('order', 'UpdatedDateUTC ASC');
          const r = await fetch(u.toString(), {
            headers: { Authorization: `Bearer ${token}`, 'xero-tenant-id': conn.tenant_id, Accept: 'application/json', 'If-Modified-Since': ims },
          });
          st.pages++;
          if (r.status === 429) { st.error = 'Xero rate limit — 聽日再試'; break; }
          if (!r.ok) throw new Error(`Xero Invoices ${r.status}: ${(await r.text()).slice(0, 200)}`);
          const invs = (await r.json()).Invoices || [];
          for (const inv of invs) {
            st.docs++;
            const isSales = inv.Type === 'ACCREC';
            const docDate = xeroDate(inv.DateString || inv.Date);
            const codes = extractCodes(inv);
            const found: { rule: string; message: string }[] = [];
            const dead = ['VOIDED', 'DELETED'].includes(inv.Status);

            if (!dead) {
              const contact = inv.Contact?.Name || '';
              const isGroupContact = GROUP_CONTACT.test(contact);
              const required = isSales ? comp?.require_code_invoice !== false : comp?.require_code_bill === true;
              if (codes.length === 0 && required) {
                found.push({ rule: 'missing', message: `${isSales ? 'Invoice' : 'Bill'} 冇 project code` });
              }
              if (isSales && codes.length > 1) {
                found.push({ rule: 'multiple', message: `一張 invoice 有 ${codes.length} 個 project code：${codes.join(', ')}` });
              }
              for (const code of codes) {
                const info = await lookup(code);
                if (!info?.found) { found.push({ rule: 'unknown', message: `${code} 唔存在` }); continue; }
                if (['Closed', 'Cancelled'].includes(info.status)) {
                  // 收尾期內 (完結日 + close_after_days) 嘅單照接受
                  const lastOk = info.end_date
                    ? new Date(new Date(info.end_date).getTime() + (info.close_after_days || 0) * 86400000).toISOString().slice(0, 10)
                    : null;
                  if (info.status === 'Cancelled' || !lastOk || (docDate && docDate > lastOk)) {
                    found.push({ rule: 'closed', message: `${code} 已${info.status === 'Closed' ? '關閉' : '取消'}` });
                  }
                }
                if (isSales && info.type_code === 'R' && info.end_date && docDate && docDate > info.end_date) {
                  found.push({ rule: 'outside_period', message: `${code} 合約 ${info.end_date} 完結，invoice 日期 ${docDate} — 續約要開新 code` });
                }
                if (isSales && info.entity_code && info.entity_code !== conn.entity_code && info.type_code !== 'I' && !isGroupContact) {
                  found.push({ rule: 'wrong_company', message: `${code} 屬 ${info.entity_code}，但 invoice 開喺 ${conn.entity_code}` });
                }
              }
            }

            const rules = new Set(found.map((f) => f.rule));
            // resolve：今次冇再犯嘅規則
            const { data: openRows } = await svc.from('project_code_violations')
              .select('id, rule').eq('doc_id', inv.InvoiceID).is('resolved_at', null);
            for (const o of openRows || []) {
              if (!rules.has(o.rule)) {
                await svc.from('project_code_violations').update({ resolved_at: runStart }).eq('id', o.id);
                st.resolved++;
              }
            }
            for (const f of found) {
              const isNew = !(openRows || []).some((o: any) => o.rule === f.rule);
              const row = {
                entity_code: conn.entity_code, tenant_id: conn.tenant_id, doc_type: inv.Type, doc_id: inv.InvoiceID,
                doc_number: inv.InvoiceNumber || null, reference: inv.Reference || null, contact_name: inv.Contact?.Name || null,
                doc_date: docDate, total: inv.Total ?? null, doc_status: inv.Status, codes_found: codes,
                rule: f.rule, message: f.message, last_seen: runStart, resolved_at: null,
                xero_url: isSales
                  ? `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${inv.InvoiceID}`
                  : `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${inv.InvoiceID}`,
              };
              const { error: upErr } = await svc.from('project_code_violations').upsert(row, { onConflict: 'doc_id,rule' });
              if (upErr) throw upErr;
              st.violations++;
              if (isNew) newViolations++;
            }
          }
          if (invs.length < 100) break;
        }
        if (!st.error) {
          await svc.from('xero_connections').update({ last_checked_at: runStart }).eq('tenant_id', conn.tenant_id);
        }
      } catch (e) {
        st.error = String((e as Error)?.message || e).slice(0, 300);
      }
    }

    // ---- email 摘要：新違規 ----
    const { data: unnotified } = await svc.from('project_code_violations')
      .select('id, entity_code, doc_type, doc_number, contact_name, doc_date, total, reference, message, xero_url')
      .is('resolved_at', null).is('notified_at', null).order('entity_code').limit(200);
    if (unnotified && unnotified.length > 0 && settings?.notify_emails?.length) {
      const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const rows = unnotified.map((v: any) =>
        `<tr><td>${esc(v.entity_code)}</td><td>${v.doc_type === 'ACCREC' ? 'Invoice' : 'Bill'}</td>` +
        `<td><a href="${esc(v.xero_url)}">${esc(v.doc_number || '(未有號碼)')}</a></td><td>${esc(v.contact_name)}</td>` +
        `<td>${esc(v.doc_date)}</td><td style="text-align:right">${esc(v.total)}</td><td>${esc(v.reference)}</td><td>${esc(v.message)}</td></tr>`).join('');
      const html = `<div style="font-family:Arial,sans-serif;font-size:13px"><p>Xero 有 <b>${unnotified.length}</b> 張單 project code 有問題，請喺 Xero 改正（改好後下一輪自動消除）：</p>` +
        `<table border="1" cellpadding="4" style="border-collapse:collapse;font-size:12px"><tr><th>公司</th><th>類型</th><th>單號</th><th>對手方</th><th>日期</th><th>金額</th><th>Reference</th><th>問題</th></tr>${rows}</table>` +
        `<p style="color:#666">CardRecon → Project Codes → 違規 可以睇晒所有未處理項目。</p></div>`;
      await svc.from('project_notifications').insert({
        kind: 'violations', recipients: settings.notify_emails,
        subject: `[Project code 違規] Xero 有 ${unnotified.length} 張單要改`, body_html: html,
      });
      await svc.from('project_code_violations').update({ notified_at: runStart }).in('id', unnotified.map((v: any) => v.id));
      // 即刻送
      await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/project-code-notify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
        body: '{}',
      }).catch(() => null);
    }

    return new Response(JSON.stringify({ ok: true, new_violations: newViolations, stats }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e).slice(0, 1500) }), { status: 500, headers: CORS });
  }
});
