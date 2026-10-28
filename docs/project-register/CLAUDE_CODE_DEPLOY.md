# Project Codes — Claude Code 部署及跟進指示

> 用法：喺 Claude Code 開 `PBHKSSHK/Card` repo，checkout branch `claude/project-code-register`，
> 將呢份文件交俾 Claude Code：「跟 docs/project-register/CLAUDE_CODE_DEPLOY.md 做」。
> 每一節做完先做下一節；凡係改 live database 或 production 嘅步驟，做之前先問用戶確認。

## 0. 背景

- 系統：CardRecon（Vite SPA on Vercel `cardrecon`，Supabase project `nyooltqhmrdnippfikes`）。
- 目的：Sales 自助取 project code；按 project 性質（C Campaign / R Retainer / E Event / I 集團內部）驗證；
  狀態自動更新；出 code 即 email accounts@pbhk.info；用錯 code 會被 ban。
- NetSuite 2026-10-30 到期，之後 `netsuite-sync-projects` 唔會再有新 code，新 code 全部由呢個功能出。
- 舊 NetSuite code（`P2610001397` 格式，現有 1,399 個，全部 active）保留喺 `ns_project_codes` 照用。

## 1. PR 內容（branch `claude/project-code-register`）

| 檔案 | 內容 |
| --- | --- |
| `supabase/migrations/00000000000040_project_register.sql` | 新表、規則、RPC、狀態更新、email outbox、Xero 連線 / 違規表、ban trigger、pg_cron |
| `supabase/functions/project-code-notify/` | 送 email（Apps Script 或 Resend） |
| `supabase/functions/xero-oauth/` | Xero OAuth 2.0（granular read scopes） |
| `supabase/functions/xero-project-check/` | 每晚檢查 Xero invoice / bill 嘅 project code |
| `supabase/functions/netsuite-sync-projects/index.ts` | 改：只收起 NetSuite 嚟嘅行（`internal_id is not null`），唔會收起新 code |
| `client/src/pages/ProjectCodesPage.tsx` | 新頁面：取 Code / 項目清單 / 違規 / 設定 |
| `client/src/App.tsx`、`AppLayout.tsx`、`lib/auth.tsx`、`SettingsPage.tsx` | 加 route `/projects`、sidebar、`projects` 模組 |
| `docs/project-register/README.md`、`apps-script-mailer.gs` | 功能說明、email relay |

### Code 格式

`P` + 開 code 年（YY）+ 公司碼 + `-` + 性質 + 4 位流水號 [+ `-` + 合約完結年 YY]

| 公司 | entity_code | 公司碼 | ns charge_to |
| --- | --- | --- | --- |
| Social Strategy Hong Kong | SSHK | SS | SS |
| Photoblog.hk | PBHK | PB | PB |
| 704 Production | 704 | PR | 704 |
| Jervois M | JM | JM | JM |
| CLS Garage | CLS | CG | CLS |

例：`P26SS-C0012`、`P26SS-R0003-27`（續約 → `P26SS-R0003-28`）。流水號每間公司每個性質每年各自計。

### 性質規則（預設，`project_type_rules`，可喺頁面「設定」改）

| 性質 | 要 quote | 要金額 | 要完結日 | 要月費 | 年份尾碼 | 最長 | 提醒 | 自動關閉 | 只限 admin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C Campaign | ✓ | ✓ | ✓ | | | 12 月 | 完結前 14 日 | 完結後 90 日 | |
| R Retainer | ✓ | ✓ | ✓ | ✓ | ✓ | 12 月 | 完結前 30 日 | 完結後 60 日 | |
| E Event | ✓ | ✓ | ✓ | | | 6 月 | 完結前 7 日 | 完結後 60 日 | |
| I 集團內部 | | | | | | — | — | — | ✓ |

### 狀態

Active → Expiring（自動，email sales + 會計）→ Closed（自動，picker 收起，ban）。
Sales 可以標記 Completed；會計可以 Close / Cancel（要原因）/ 重開 / 修改。

## 2. Review PR（唔改任何 live 嘢）

1. `npm install --include=dev`（`xlsx` 由 cdn.sheetjs.com 下載；如被擋，暫時用 npm 版 `xlsx@0.18.5 --no-save` 做檢查）
2. `npx tsc --noEmit -p .` → 0 error
3. `npx vite build` → 成功
4. Edge functions：`deno check supabase/functions/{project-code-notify,xero-oauth,xero-project-check,netsuite-sync-projects}/index.ts`
5. 睇 migration 有冇同現有 schema 衝突：
   ```sql
   select table_name from information_schema.tables
    where table_schema = 'public'
      and table_name in ('project_companies','project_type_rules','project_register','project_code_sequences',
                         'project_events','project_register_settings','project_notifications',
                         'xero_connections','xero_oauth_states','project_code_violations');
   -- 預期：0 行
   select count(*) from claim_lines where coalesce(project_code,'') <> ''
     and project_code not in (select project_id from ns_project_codes where is_active);
   -- 預期：0（2026-10-28 查過 claim_lines / meta_invoices / meta_invoice_splits / accounting_lines 全部 0）
   ```

## 3. 部署 DB（⚠ 改 live，先問用戶）

1. 用 Supabase MCP `apply_migration`（name `project_register`）或 `supabase db push` apply migration 40。
2. 檢查：
   ```sql
   select * from project_companies order by sort_order;          -- 5 行
   select type_code, name_zh from project_type_rules;             -- C R E I
   select jobname, schedule from cron.job where jobname like 'project%' or jobname like 'xero%';
   -- project-register-status-daily 30 19 * * * ; project-code-notify-10min */10 * * * * ; xero-project-check-daily 0 20 * * *
   select email, modules from user_profiles;                       -- 全部有 'projects'
   select tgname, tgrelid::regclass from pg_trigger where tgname = 'trg_enforce_project_code';  -- 4 個表
   ```
3. `get_advisors`（security）睇有冇新嘅 RLS 警告。

## 4. 部署 edge functions（⚠ production）

```bash
supabase functions deploy project-code-notify
supabase functions deploy xero-project-check
supabase functions deploy xero-oauth --no-verify-jwt
supabase functions deploy netsuite-sync-projects
```
（或者 Supabase MCP `deploy_edge_function`；`xero-oauth` 嘅 `verify_jwt` 要 false，因為 Xero callback 冇 Supabase JWT。）

## 5. Email 設定（用戶做，Claude Code 協助）

揀一個：

**A. Google Apps Script（建議，用 accounts@pbhk.info 寄）**
1. 用 accounts@pbhk.info 開 https://script.google.com → New project → 貼 `docs/project-register/apps-script-mailer.gs`
2. Project Settings → Script Properties → `SECRET` = 一串長亂碼
3. Deploy → Web app → Execute as: Me；Who has access: Anyone → 複製 `/exec` URL
4. `supabase secrets set APPS_SCRIPT_MAIL_URL=<URL> APPS_SCRIPT_MAIL_SECRET=<SECRET>`

**B. Resend**：`supabase secrets set RESEND_API_KEY=... MAIL_FROM="CardRecon <noreply@pbhk.info>"`（pbhk.info 要喺 Resend verify DNS）

測試：喺頁面開一個測試 code → `select status, error from project_notifications order by id desc limit 5;` 要見到 `sent`，accounts@pbhk.info 收到 email。測試完喺頁面將測試 code Cancel。

## 6. 前端上線（⚠ production）

PR merge 入 default branch（`claude/cardrecon-system-rebuild-juc4eh`）。Hourly routine 會比較 `deployed-sha.txt` 自動 redeploy；
驗證：`curl https://cardrecon-pbhk.vercel.app/deployed-sha.txt` = merge commit SHA。

## 7. Xero 連線（可遲啲做）

1. https://developer.xero.com/app/manage → New app → Web app
   - Redirect URI：`https://nyooltqhmrdnippfikes.supabase.co/functions/v1/xero-oauth`
   - 2026-03-02 之後開嘅 app 只可以用 granular scopes；function 用：
     `openid profile email offline_access accounting.invoices.read accounting.contacts.read accounting.settings.read`
2. `supabase secrets set XERO_CLIENT_ID=... XERO_CLIENT_SECRET=... XERO_REDIRECT_URI=https://nyooltqhmrdnippfikes.supabase.co/functions/v1/xero-oauth APP_URL=https://cardrecon-pbhk.vercel.app`
3. 頁面 → Project Codes → 設定 → 連接 Xero。Starter tier 冇 Bulk Connections：每次授權一間公司，做 5 次。
4. 每個 organisation 揀返對應公司。
5. 違規 tab → 「重查最近 120 日」做第一次檢查。
6. API 限額：Starter tier 每間公司每日 1,000 次；每晚增量檢查一般 1–3 次。要確認自己公司嘅 org 係咪計 connection（Starter 上限 5 個）。

### Xero 檢查規則

| rule | 條件 |
| --- | --- |
| missing | Sales invoice 冇 code（CLS 預設唔檢查，POS 零售單）；bill 預設唔強制 |
| unknown | code 唔存在 |
| closed | code 已 Closed / Cancelled，而單據日期過咗收尾期 |
| outside_period | Retainer invoice 日期遲過合約完結日（續約冇開新 code） |
| wrong_company | Sales invoice 用咗第二間公司嘅 code，而客戶唔係集團公司 |
| multiple | 一張 sales invoice 有多過一個 code |

Xero 冇 API 可以喺入數時 block，所以 Xero 部分係「每晚抽出 + email」；喺 Xero 改正後下一輪自動 resolved。

## 8. 驗收清單

- [ ] BU user（例如 fornia.lung@sshk.ltd）只可以揀自己公司，開 C code 成功，收到 email
- [ ] Retainer 冇月費 / 超過 12 個月 → 被拒，訊息清楚
- [ ] 重複 quote 號 → 被拒
- [ ] 非 admin 開 I（集團內部）→ 被拒
- [ ] 新 code 即時喺 Claims / 付款申請 / Recon 嘅 project picker 出現
- [ ] 會計 Close 一個 code → picker 唔再出；claim line 揀返呢個 code → 儲存時被拒
- [ ] Retainer 按 Renew → 出 `-YY` 新 code，原 code 唔可以再續
- [ ] `select project_register_refresh_statuses();` 回傳正常
- [ ] `netsuite-sync-projects` 行一次後，新 code 仍然 `is_active = true`
- [ ] （Xero 連好後）違規 tab 出到資料，email 收到摘要

## 9. Rollback

```sql
-- 前端：revert merge commit 即可（hourly routine 會 redeploy）
select cron.unschedule('project-register-status-daily');
select cron.unschedule('project-code-notify-10min');
select cron.unschedule('xero-project-check-daily');
drop trigger if exists trg_enforce_project_code on public.claim_lines;
drop trigger if exists trg_enforce_project_code on public.meta_invoices;
drop trigger if exists trg_enforce_project_code on public.meta_invoice_splits;
drop trigger if exists trg_enforce_project_code on public.accounting_lines;
-- 新開嘅 code 喺 ns_project_codes（internal_id is null）會保留，唔影響舊紀錄。
-- 如要完全移除表：drop table project_code_violations, project_notifications, project_events,
--   project_register, project_code_sequences, project_type_rules, project_register_settings,
--   xero_oauth_states, xero_connections, project_companies cascade;
```

## 10. 未決定（問用戶）

- 新 code 格式由邊日起用（建議 2026-11-01，NetSuite 到期之後）
- 開 code 使唔使主管批（而家係 sales 自助即出，事後會計可以 Cancel）
- 哪些公司的 bill 要強制有 code（預設全部唔強制）
- 用 Apps Script 定 Resend 寄 email
