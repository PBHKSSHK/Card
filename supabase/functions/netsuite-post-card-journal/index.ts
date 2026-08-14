// Edge Function: post the CardRecon CARD journal (Journal Export page) to
// NetSuite as unapproved-draft Journal Entries.
//
// The client sends the SAME entries it previews/exports as CSV (built by the
// shared generator in JournalExport.tsx), grouped by entry_no. This function:
//   authorize (owner/admin or service_role)
//   -> load TBA creds from Vault (ns_get_config)
//   -> validate each entry (balanced, no UNMAPPED account, one date/subsidiary)
//   -> resolve internal ids: accounts/subsidiaries/departments from the ns_*
//      mirror tables; Class (project) and Customer/Vendor (Name column) live
//      via SuiteQL at post time
//   -> POST one journalEntry per entry_no, approved:false (human approves in
//      NetSuite before it hits the ledger)
//
// Idempotency: externalId derived from the entry's cardholder label —
// CARDJE-<last4>-<YYYY-MM> for the card entry, plus -IC-<entity> for the IC
// counterparty entries. NetSuite rejects duplicate externalIds, and this
// function reports those as status:"duplicate" instead of failing the run.
//
// Request body: { entries: [...], dry_run?: true }
// Response: { ok, created, duplicates, failed, results: [...] }
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

type InEntry = {
  entry_no: number;
  date: string;
  account: string;          // display string, starts with the account number
  currency: string;
  debit: number | null;
  credit: number | null;
  memo: string;
  subsidiary: string;       // display name or full path
  department: string;       // NetSuite department display name ('' = none)
  class_project: string;    // project id (e.g. P2410001169) or ''
  name: string;             // customer/vendor entityid (C…/V…) or ''
  cardholder: string;       // group label — used to derive the stable externalId
};

// "Rex (····7428) · 2025-11"          -> CARDJE-7428-2025-11
// "IC SSHK ← Rex (····7428) · 2025-11" -> CARDJE-7428-2025-11-IC-SSHK
function externalIdFor(cardholder: string): string | null {
  const last4 = cardholder.match(/\(····([^)]+)\)/)?.[1];
  const month = cardholder.match(/·\s*(\d{4}-\d{2})\s*$/)?.[1];
  if (!last4 || !month) return null;
  const ic = cardholder.match(/^IC\s+(.+?)\s+←/)?.[1];
  const icTag = ic ? `-IC-${ic.replace(/[^A-Za-z0-9]+/g, '').slice(0, 20)}` : '';
  return `CARDJE-${last4}-${month}${icTag}`;
}

// Browser calls need CORS — supabase.functions.invoke sends an OPTIONS
// preflight first; without these headers the browser blocks the request
// ("Failed to send a request to the Edge Function").
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    // ---- authorize caller: service_role JWT, or owner/admin user ----
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
    const entries: InEntry[] = Array.isArray(body.entries) ? body.entries : [];
    if (entries.length === 0) return new Response(JSON.stringify({ error: 'entries required' }), { status: 400, headers: CORS });
    if (entries.length > 2000) return new Response(JSON.stringify({ error: 'too many lines (max 2000)' }), { status: 400, headers: CORS });

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

    // ---- reference maps from the ns_* mirrors ----
    const [{ data: coa }, { data: subs }, { data: depts }] = await Promise.all([
      svc.from('ns_chart_of_accounts').select('account_number,internal_id'),
      svc.from('ns_subsidiaries').select('internal_id,name,full_name,short_code'),
      svc.from('ns_departments').select('name,internal_id'),
    ]);
    const acctId = new Map((coa || []).map((a: any) => [String(a.account_number), a.internal_id]));
    const subId = new Map<string, number>();
    for (const s of subs || []) {
      for (const k of [s.full_name, s.name, s.short_code]) if (k) subId.set(String(k), s.internal_id);
    }
    const deptId = new Map<string, number>();
    for (const d of depts || []) if (d.name && d.internal_id != null) deptId.set(String(d.name), d.internal_id);

    // ---- group lines into entries ----
    const groups = new Map<number, InEntry[]>();
    for (const e of entries) {
      if (!groups.has(e.entry_no)) groups.set(e.entry_no, []);
      groups.get(e.entry_no)!.push(e);
    }

    // ---- resolve Project (job) + Customer/Vendor ids via SuiteQL ----
    // In this NetSuite account the P-codes are JOB (Project) records, not
    // Classes — a JE line books to a project via its entity (Name) field.
    const projectIds = [...new Set(entries.map((e) => (e.class_project || '').trim()).filter(Boolean))];
    const entityCodes = [...new Set(entries.map((e) => (e.name || '').trim()).filter(Boolean))];
    const jobId = new Map<string, string>();
    const entityRef = new Map<string, { id: string; kind: 'customer' | 'vendor' }>();
    if (projectIds.length > 0) {
      const inList = projectIds.map((c) => `'${c.replace(/'/g, "''")}'`).join(',');
      for (const r of await suiteql(`SELECT id, entityid FROM job WHERE entityid IN (${inList})`)) {
        jobId.set(String(r.entityid), String(r.id));
      }
    }
    const custCodes = entityCodes.filter((c) => /^C/i.test(c));
    const vendCodes = entityCodes.filter((c) => /^V/i.test(c));
    if (custCodes.length > 0) {
      const inList = custCodes.map((c) => `'${c.replace(/'/g, "''")}'`).join(',');
      for (const r of await suiteql(`SELECT id, entityid FROM customer WHERE entityid IN (${inList})`)) {
        entityRef.set(String(r.entityid), { id: String(r.id), kind: 'customer' });
      }
    }
    if (vendCodes.length > 0) {
      const inList = vendCodes.map((c) => `'${c.replace(/'/g, "''")}'`).join(',');
      for (const r of await suiteql(`SELECT id, entityid FROM vendor WHERE entityid IN (${inList})`)) {
        entityRef.set(String(r.entityid), { id: String(r.id), kind: 'vendor' });
      }
    }

    // ---- build + post per entry ----
    const results: any[] = [];
    let created = 0, duplicates = 0, failed = 0;
    for (const [entryNo, lines] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      const extId = externalIdFor(lines[0].cardholder || '');
      const label = lines[0].cardholder || `entry ${entryNo}`;
      const problems: string[] = [];

      // one JE = one date + one subsidiary
      const dates = [...new Set(lines.map((l) => l.date))];
      const subNames = [...new Set(lines.map((l) => l.subsidiary))];
      if (dates.length > 1) problems.push(`multiple dates: ${dates.join(', ')}`);
      if (subNames.length > 1) problems.push(`multiple subsidiaries: ${subNames.join(' | ')}`);
      const sid = subId.get(subNames[0]);
      if (!sid) problems.push(`subsidiary not mapped: ${subNames[0]}`);
      if (!extId) problems.push(`cannot derive externalId from label "${label}"`);

      const dr = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
      const cr = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
      if (Math.abs(dr - cr) > 0.01) problems.push(`unbalanced: DR ${dr.toFixed(2)} vs CR ${cr.toFixed(2)}`);

      const items: any[] = [];
      for (const l of lines) {
        const acctNum = (l.account || '').split(' ')[0];
        const aid = acctId.get(acctNum);
        if (!aid) { problems.push(`account not mapped: ${l.account?.slice(0, 40)}`); continue; }
        const item: any = { account: { id: String(aid) }, memo: (l.memo || '').slice(0, 4000) };
        const debit = Number(l.debit) || 0;
        const credit = Number(l.credit) || 0;
        if (debit > 0) item.debit = Math.round(debit * 100) / 100;
        else item.credit = Math.round(credit * 100) / 100;
        const did = l.department ? deptId.get(l.department) : undefined;
        if (did != null) item.department = { id: String(did) };
        // Name (entity): Due-From/To lines carry a customer/vendor code;
        // project lines book to the JOB via the same entity field.
        const nm = (l.name || '').trim();
        const cp = (l.class_project || '').trim();
        if (nm) {
          const ref = entityRef.get(nm);
          if (ref) item.entity = { id: ref.id };
          else problems.push(`customer/vendor not found: ${nm}`);
        } else if (cp) {
          const jid = jobId.get(cp);
          if (jid) item.entity = { id: jid };
          else problems.push(`project (job) not found in NetSuite: ${cp}`);
        }
        items.push(item);
      }

      if (problems.length > 0) {
        failed++;
        results.push({ entry_no: entryNo, label, external_id: extId, status: 'error', error: problems.join('; ') });
        continue;
      }

      const payload: any = {
        externalId: extId,
        subsidiary: { id: String(sid) },
        currency: { id: '1' },
        tranDate: dates[0],
        memo: `CardRecon card journal - ${label}`.slice(0, 4000),
        approved: false,
        line: { items },
      };

      if (dryRun) {
        results.push({ entry_no: entryNo, label, external_id: extId, status: 'dry_run', lines: items.length, total_dr: Math.round(dr * 100) / 100 });
        continue;
      }

      const url = `https://${host}.suitetalk.api.netsuite.com/services/rest/record/v1/journalEntry`;
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
        // Record the post so the UI can badge this card/month as already posted.
        await svc.from('ns_card_journal_posts').upsert(
          { external_id: extId, netsuite_id: nsInternalId, label, posted_by: claims.sub || null },
          { onConflict: 'external_id' },
        );
        results.push({ entry_no: entryNo, label, external_id: extId, status: 'created', netsuite_id: nsInternalId, lines: items.length, total_dr: Math.round(dr * 100) / 100 });
      } else {
        const errText = (await nsRes.text()).slice(0, 800);
        if (/already exists|duplicate/i.test(errText)) {
          duplicates++;
          // It exists in NetSuite — make sure our tracking table knows too.
          await svc.from('ns_card_journal_posts').upsert(
            { external_id: extId, label, posted_by: claims.sub || null },
            { onConflict: 'external_id', ignoreDuplicates: true },
          );
          results.push({ entry_no: entryNo, label, external_id: extId, status: 'duplicate', error: 'externalId already posted' });
        } else {
          failed++;
          results.push({ entry_no: entryNo, label, external_id: extId, status: 'error', error: `NetSuite ${nsRes.status}: ${errText}` });
        }
      }
    }

    return new Response(
      JSON.stringify({ ok: failed === 0, dry_run: dryRun, entries: groups.size, created, duplicates, failed, results }, null, 2),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e).slice(0, 1500) }), { status: 500, headers: CORS });
  }
});
