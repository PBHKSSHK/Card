# Project Code Register（CardRecon → Project Codes）

Sales 自助取 project code；按 project 性質自動驗證；狀態自動更新；出 code 即 email；
用錯 code 會被 ban（CardRecon 即時拒絕、Xero 每晚抽出 + email）。

## 功能

| 部分 | 做乜 |
| --- | --- |
| 取 Code | 揀公司（只限自己 entity scope）+ 性質 → 按規則填資料 → 出 code，即時寫入 `ns_project_codes`，claims / 付款申請 / card recon 嘅 project picker 即刻用得 |
| 性質規則 | `project_type_rules`：C Campaign、R Retainer、E Event、I 集團內部（只限 admin）。每個性質設定要唔要 quote、金額、完結日、月費、最長幾個月、提醒日數、關閉日數 |
| Code 格式 | `P` + 年 + 公司碼（PB/SS/PR/JM/CG）+ `-` + 性質 + 4 位流水號；Retainer 尾加合約完結年：`P26SS-R0003-27`，續約 → `-28` |
| 狀態 | Active → Expiring（完結前 N 日，email 提醒 sales + 會計）→ Closed（完結後 N 日自動）；Completed（sales 標記）；Cancelled（會計）|
| Ban（CardRecon）| trigger：`claim_lines`、`meta_invoices`、`meta_invoice_splits`、`accounting_lines` 用 Closed / Cancelled / 唔存在嘅 code → 拒絕儲存（只喺改 code 時檢查，舊紀錄唔受影響）|
| Ban（Xero）| `xero-project-check` 每晚 04:00 HKT：invoice 冇 code、code 唔存在、已關閉、retainer 超出合約期、公司唔啱、一張 invoice 多個 code → 違規清單 + email；Xero 改正後自動消除 |
| Email | 開 code、續約、即將完結、自動關閉、Xero 違規 → `project_register_settings.notify_emails`（預設 accounts@pbhk.info）+ 開 code 嘅 sales |

Xero 冇辦法喺入數嗰刻 block 單據，所以 Xero 部分係「事後即日抽出」。

## 部署步驟

1. **DB**：apply `supabase/migrations/00000000000040_project_register.sql`。
2. **Edge functions**：
   ```bash
   supabase functions deploy project-code-notify
   supabase functions deploy xero-project-check
   supabase functions deploy xero-oauth --no-verify-jwt
   supabase functions deploy netsuite-sync-projects   # 已改：唔會收起 register 開嘅新 code
   ```
3. **Email（揀一個）**
   - Google Apps Script（建議）：跟 `apps-script-mailer.gs` 開頭步驟，然後
     `supabase secrets set APPS_SCRIPT_MAIL_URL=... APPS_SCRIPT_MAIL_SECRET=...`
   - 或 Resend：`supabase secrets set RESEND_API_KEY=... MAIL_FROM="CardRecon <noreply@pbhk.info>"`
4. **Xero（可遲啲做）**
   - https://developer.xero.com/app/manage → New app（Web app）
   - Redirect URI：`https://nyooltqhmrdnippfikes.supabase.co/functions/v1/xero-oauth`
   - `supabase secrets set XERO_CLIENT_ID=... XERO_CLIENT_SECRET=... XERO_REDIRECT_URI=https://nyooltqhmrdnippfikes.supabase.co/functions/v1/xero-oauth APP_URL=https://cardrecon-pbhk.vercel.app`
   - CardRecon → Project Codes → 設定 → 連接 Xero（Starter tier 每次授權一間公司，做五次）→ 每個 organisation 揀返對應公司
   - API 用量：Starter tier 每間公司每日 1,000 次；每晚增量檢查一般每間 1–3 次
5. **前端**：merge 入 default branch，hourly routine 會自動 redeploy Vercel。

## 測試紀錄

本地 Postgres 16 跑過 migration + 行為測試：開 C / R code、重複 quote 被拒、無權公司被拒、
retainer 冇月費被拒、超過 12 個月被拒、非 admin 開內部 code 被拒、完結日已過被拒、續約出 `-28`、
重複續約被拒、ban trigger 拒絕已關閉同唔存在嘅 code、未改 code 嘅更新照過、sales 只可以標記完成、
每日狀態更新（Expiring / Closed）同 email 排隊內容。
