/**
 * CardRecon email relay — 用公司 Google Workspace 帳戶寄 project code 通知。
 *
 * 設定（一次）：
 * 1. 用 accounts@pbhk.info 登入 → https://script.google.com → New project，貼入呢個檔。
 * 2. Project Settings → Script Properties → 加 SECRET = 一串長亂碼（同 Supabase secret APPS_SCRIPT_MAIL_SECRET 一樣）。
 * 3. Deploy → New deployment → Type: Web app
 *      Execute as: Me (accounts@pbhk.info)
 *      Who has access: Anyone
 *    → Authorize → 複製 Web app URL（.../exec）。
 * 4. Supabase secrets：
 *      supabase secrets set APPS_SCRIPT_MAIL_URL=<web app URL> APPS_SCRIPT_MAIL_SECRET=<同上>
 * Google Workspace 每日可寄約 1,500 封，夠用。
 */
function doPost(e) {
  var out = function (obj) {
    return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  };
  try {
    var body = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
    if (!secret || body.secret !== secret) return out({ ok: false, error: 'bad secret' });
    if (!body.to || !body.subject) return out({ ok: false, error: 'missing to/subject' });
    MailApp.sendEmail({
      to: body.to,
      subject: body.subject,
      htmlBody: body.html || '',
      name: 'CardRecon Project Codes',
    });
    return out({ ok: true });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}
