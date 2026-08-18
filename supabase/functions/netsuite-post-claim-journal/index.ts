// Edge Function: post APPROVED claim journals (Claim Journal Export page) to
// NetSuite as unapproved-draft Journal Entries — 同卡數 journal 一樣嘅管道。
//
// Client 送嚟嘅 entries = CSV 預覽同一批行 (per batch 一個 entry_no group):
//   CR = Accounts Payable (Name = employee code 同 sub / IC vendor code 跨 sub)
//   DR = expense lines (department per line, project 經 entity/job)
// externalId = CLMJE-<batch_no> — NetSuite 拒絕重複，重按報 "已 post 過"。
// 成功/重複都會將 claim_batches (by batch_no) 標記 exported + 記 JE id + audit。
//
// Request body: { entries: [...], dry_run?: true }
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
  class_project: string;    // project id (may be "P… · name" display) or ''
  name: string;             // "PBL0008 Lam, …" / "V10000353 A/P…" or ''
  batch_no: string;         // claim batch no — externalId 來源
};

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
    const [{ data: coa }, { data: subs }, { data: depts }, { data: emps }] = await Promise.all([
      svc.from('ns_chart_of_accounts').select('account_number,internal_id'),
      svc.from('ns_subsidiaries').select('internal_id,name,full_name,short_code'),
      svc.from('ns_departments').select('name,internal_id'),
      svc.from('ns_employees').select('code,internal_id'),
    ]);
    const acctId = new Map((coa || []).map((a: any) => [String(a.account_number), a.internal_id]));
    const subId = new Map<string, number>();
    for (const s of subs || []) {
      for (const k of [s.full_name, s.name, s.short_code]) if (k) subId.set(String(k), s.internal_id);
    }
    const deptId = new Map<string, number>();
    for (const d of depts || []) if (d.name && d.internal_id != null) deptId.set(String(d.name), d.internal_id);
    const empId = new Map<string, number>();
    for (const e of emps || []) if (e.code && e.internal_id != null) empId.set(String(e.code).toUpperCase(), e.internal_id);

    // ---- group lines into entries ----
    const groups = new Map<number, InEntry[]>();
    for (const e of entries) {
      if (!groups.has(e.entry_no)) groups.set(e.entry_no, []);
      groups.get(e.entry_no)!.push(e);
    }

    // ---- resolve Project (job) + Name (employee / vendor / customer) internal ids ----
    const projCode = (s: string) => (s || '').trim().split(/[\s·]/)[0];
    const nameCode = (s: string) => (s || '').trim().split(/\s+/)[0];
    const projectIds = [...new Set(entries.map((e) => projCode(e.class_project)).filter(Boolean))];
    const nameCodes = [...new Set(entries.map((e) => nameCode(e.name)).filter(Boolean))];
    const jobId = new Map<string, string>();
    const entityRef = new Map<string, { id: string }>();
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
    if (nameCodes.length > 0) {
      // V/C 由 ns_entity_ids；其他 (employee code) 由 ns_employees；SuiteQL 後備
      const vc = nameCodes.filter((c) => /^[VC]\d/i.test(c));
      const empCodes = nameCodes.filter((c) => !/^[VC]\d/i.test(c));
      if (vc.length > 0) {
        const { data: entRows } = await svc.from('ns_entity_ids')
          .select('entityid, internal_id').in('entityid', vc);
        for (const r of entRows || []) entityRef.set(String(r.entityid).toUpperCase(), { id: String(r.internal_id) });
        const missV = vc.filter((c) => !entityRef.has(c.toUpperCase()) && /^V/i.test(c));
        const missC = vc.filter((c) => !entityRef.has(c.toUpperCase()) && /^C/i.test(c));
        if (missV.length > 0) {
          const inList = missV.map((c) => `'${sqlq(c)}'`).join(',');
          for (const r of await suiteql(`SELECT id, entityid FROM vendor WHERE entityid IN (${inList})`)) {
            entityRef.set(String(r.entityid).toUpperCase(), { id: String(r.id) });
          }
        }
        if (missC.length > 0) {
          const inList = missC.map((c) => `'${sqlq(c)}'`).join(',');
          for (const r of await suiteql(`SELECT id, entityid FROM customer WHERE entityid IN (${inList})`)) {
            entityRef.set(String(r.entityid).toUpperCase(), { id: String(r.id) });
          }
        }
      }
      for (const c of empCodes) {
        const hit = empId.get(c.toUpperCase());
        if (hit != null) entityRef.set(c.toUpperCase(), { id: String(hit) });
      }
      const missEmp = empCodes.filter((c) => !entityRef.has(c.toUpperCase()));
      if (missEmp.length > 0) {
        const inList = missEmp.map((c) => `'${sqlq(c)}'`).join(',');
        for (const r of await suiteql(`SELECT id, entityid FROM employee WHERE entityid IN (${inList})`)) {
          entityRef.set(String(r.entityid).toUpperCase(), { id: String(r.id) });
        }
      }
    }

    // ---- build + post per entry (per claim batch) ----
    const results: any[] = [];
    let created = 0, duplicates = 0, failed = 0;
    for (const [entryNo, lines] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      const batchNo = (lines[0].batch_no || '').trim();
      const extId = batchNo ? `CLMJE-${batchNo.replace(/[^A-Za-z0-9-]+/g, '')}` : null;
      const label = batchNo || `entry ${entryNo}`;
      const problems: string[] = [];

      const dates = [...new Set(lines.map((l) => l.date))];
      const subNames = [...new Set(lines.map((l) => l.subsidiary))];
      if (dates.length > 1) problems.push(`multiple dates: ${dates.join(', ')}`);
      if (subNames.length > 1) problems.push(`multiple subsidiaries: ${subNames.join(' | ')}`);
      const sid = subId.get(subNames[0]);
      if (!sid) problems.push(`subsidiary not mapped: ${subNames[0]}`);
      if (!extId) problems.push('missing batch_no');

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
        // Name (entity): employee / IC vendor / customer；project line 用 job id
        const nm = nameCode(l.name);
        const cp = projCode(l.class_project);
        if (nm) {
          const ref = entityRef.get(nm.toUpperCase());
          if (ref) item.entity = { id: ref.id };
          else problems.push(`name not found in NetSuite: ${nm}`);
        } else if (cp) {
          const jid = jobId.get(cp);
          if (jid) item.entity = { id: jid };
          else problems.push(`project (job) not found: ${cp}`);
        }
        items.push(item);
      }

      if (problems.length > 0) {
        failed++;
        results.push({ entry_no: entryNo, batch_no: batchNo, label, external_id: extId, status: 'error', error: problems.join('; ') });
        continue;
      }

      const payload: any = {
        externalId: extId,
        subsidiary: { id: String(sid) },
        currency: { id: '1' },
        tranDate: dates[0],
        memo: `CardRecon claim journal - ${label}`.slice(0, 4000),
        approved: false,
        line: { items },
      };

      if (dryRun) {
        results.push({ entry_no: entryNo, batch_no: batchNo, label, external_id: extId, status: 'dry_run', lines: items.length, total_dr: Math.round(dr * 100) / 100 });
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
        await svc.from('ns_card_journal_posts').upsert(
          { external_id: extId, netsuite_id: nsInternalId, label, posted_by: claims.sub || null },
          { onConflict: 'external_id' },
        );
        // batch → exported + 記 JE id + audit
        const { data: bRows } = await svc.from('claim_batches')
          .update({
            status: 'exported',
            netsuite_journal_no: `JE ${nsInternalId}`,
            exported_at: new Date().toISOString(),
            exported_by_user_id: claims.sub || null,
          })
          .eq('batch_no', batchNo).in('status', ['approved', 'exported'])
          .select('id, status');
        for (const b of bRows || []) {
          await svc.from('claim_audit_log').insert({
            batch_id: b.id, action: 'exported', from_status: 'approved', to_status: 'exported',
            actor_user_id: claims.sub || null, comment: `NetSuite journal entry ${nsInternalId} (draft)`,
          });
        }
        results.push({ entry_no: entryNo, batch_no: batchNo, label, external_id: extId, status: 'created', netsuite_id: nsInternalId, lines: items.length, total_dr: Math.round(dr * 100) / 100 });
      } else {
        const errText = (await nsRes.text()).slice(0, 800);
        if (/already exists|duplicate/i.test(errText)) {
          duplicates++;
          await svc.from('ns_card_journal_posts').upsert(
            { external_id: extId, label, posted_by: claims.sub || null },
            { onConflict: 'external_id', ignoreDuplicates: true },
          );
          await svc.from('claim_batches')
            .update({ status: 'exported', exported_at: new Date().toISOString(), exported_by_user_id: claims.sub || null })
            .eq('batch_no', batchNo).eq('status', 'approved');
          results.push({ entry_no: entryNo, batch_no: batchNo, label, external_id: extId, status: 'duplicate', error: '已 post 過 (externalId 已存在 NetSuite)' });
        } else {
          failed++;
          results.push({ entry_no: entryNo, batch_no: batchNo, label, external_id: extId, status: 'error', error: `NetSuite ${nsRes.status}: ${errText}` });
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
