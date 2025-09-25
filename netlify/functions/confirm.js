// netlify/functions/confirm.js
// 功能：
// 1) 產 Markdown → （已停用）不再建立 GitHub Issue
// 2) 寄信：優先 Resend，其次 Brevo
// 3) 回傳郵件送出結果 (mail_ok / mail_provider / mail_response) 方便除錯
//
// 需要的環境變數：
//   CLOUDINARY_*  (與本檔無關，但整站會用到)
//   GITHUB_TOKEN (可選)       GITHUB_REPO="owner/repo" (可選)
//   RESEND_API_KEY (可選)  或  BREVO_API_KEY (可選)
//   EMAIL_FROM 或 FROM_EMAIL         ← 寄件人（建議用已驗證網域的信箱）
//   EMAIL_TO   或 TO_EMAIL           ← 收件人
//   EMAIL_SUBJECT_PREFIX (可選)     ← 主旨前綴（例如「[線上報價]」）
//   EMAIL_SENDER_NAME 或 SENDER_NAME (可選) ← 寄件顯示名稱
//   SITE_BASE_URL (可選)            ← 信件內顯示「開啟網站」連結

export async function handler(event){
  try{
    if (event.httpMethod !== "POST") return resp(405, "Method Not Allowed");
    const data = JSON.parse(event.body || "{}");
    const SITE_BASE_URL = process.env.SITE_BASE_URL || "";

    // 建 Issue（可選）
    const issueUrl = null; // Issues disabled

    // 寄信（會回傳詳細結果）
    const mailResult = await maybeSendEmail(data, issueUrl, SITE_BASE_URL);

    return json(200, {
      ok: true,
      issue_url: issueUrl || null,
      ...mailResult, // mail_ok, mail_provider, mail_response
    });
  }catch(e){
    return json(500, { error: String(e?.message || e) });
  }
}

/* ---------- GitHub Issue（可選） ---------- */
async function maybeCreateIssue(payload){
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO; // "owner/repo"
  if (!token || !repo) return { issueUrl: null };

  const [owner, name] = repo.split("/");
  const url = `https://api.github.com/repos/${owner}/${name}/issues`;

  const md = toMarkdown(payload);
  const title = `[同意報價] ${payload.customer || "未填姓名"}｜合計 ${payload.total || 0} 元`;

  const r = await fetch(url, {
    method:"POST",
    headers:{
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify({ title, body: md, labels: ["quote","confirmed"] })
  });

  if (!r.ok) {
    console.warn("[confirm] GitHub issue failed:", await safeText(r));
    return { issueUrl: null };
  }

  const j = await r.json();
  return { issueUrl: j.html_url };
}

function toMarkdown(p){
  const items = (p.items||[]).map((it,i)=>`| ${i+1} | ${it.service||""} | ${it.option||""} | ${it.qty||""} | ${it.price||""} | ${it.subtotal||""} |`).join("\n");
  return `# 線上報價單確認
**客戶名稱**：${p.customer||""}  
**電話**：${p.phone||""}  
**地址**：${p.address||""}  
**預約時間**：${p.cleanTime||""}  
**技師**：${p.technician||""}（${p.techPhone||""}）  

## 服務項目
| # | 項目名稱 | 補充說明 | 數量 | 單價 | 小計 |
|---|---|---:|---:|---:|---:|
${items}

**其他事項**：  
${p.otherNotes||""}

## 合計
**${p.total||0} 元**

> 承辦 / 報價：${p.quoteInfo||""}
`;
}

/* ---------- Email：Resend（優先）→ Brevo ---------- */
async function maybeSendEmail(payload, issueUrl, siteBase){
  // 相容兩種命名
  const FROM = (process.env.FROM_EMAIL || process.env.EMAIL_FROM || "").trim();
  const TO = (process.env.TO_EMAIL || process.env.EMAIL_TO || "").trim();
  const SENDER_NAME = process.env.SENDER_NAME || process.env.EMAIL_SENDER_NAME || "";
  const SUBJECT_PREFIX = process.env.EMAIL_SUBJECT_PREFIX || "";

  if (!FROM || !TO) {
    return { mail_ok:false, mail_provider:null, mail_response:"FROM_EMAIL/EMAIL_FROM 或 TO_EMAIL/EMAIL_TO 未設定" };
  }

  const subject = `${SUBJECT_PREFIX ? SUBJECT_PREFIX + " " : ""}客戶同意報價｜${payload.customer||"未填"}｜合計 ${payload.total||0} 元`;
  const md = toMarkdown(payload);
  const html = mdToHtml(md, issueUrl, siteBase);
  const text = stripHtml(html);

  // 首選：Resend
  if (process.env.RESEND_API_KEY) {
    try{
      const r = await fetch("https://api.resend.com/emails", {
        method:"POST",
        headers:{ "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type":"application/json" },
        body: JSON.stringify({ from: senderHeader(FROM, SENDER_NAME), to: [TO], subject, html, text })
      });
      const body = await safeText(r);
      if (!r.ok) return { mail_ok:false, mail_provider:"resend", mail_response: body };
      return { mail_ok:true, mail_provider:"resend", mail_response: body };
    }catch(e){
      // 落下去試 Brevo
    }
  }

  // 次選：Brevo
  if (process.env.BREVO_API_KEY) {
    try{
      const sender = { email: FROM };
      if (SENDER_NAME) sender.name = SENDER_NAME;
      const to = [ parseAddr(TO) ];
      const r = await fetch("https://api.brevo.com/v3/smtp/email", {
        method:"POST",
        headers:{ "api-key": process.env.BREVO_API_KEY, "Content-Type":"application/json" },
        body: JSON.stringify({
          sender,
          to,
          subject,
          htmlContent: html,
          textContent: text
        })
      });
      const body = await safeText(r);
      if (!r.ok) return { mail_ok:false, mail_provider:"brevo", mail_response: body };
      return { mail_ok:true, mail_provider:"brevo", mail_response: body };
    }catch(e){
      return { mail_ok:false, mail_provider:"brevo", mail_response: String(e?.message || e) };
    }
  }

  return { mail_ok:false, mail_provider:null, mail_response:"未設定 RESEND_API_KEY 或 BREVO_API_KEY" };
}

/* ---------- 工具 ---------- */
function mdToHtml(md, issueUrl, siteBase){
  const esc = s => (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\n/g,"<br/>");
  const viewLink = siteBase ? `<p><a href="${siteBase}" target="_blank">開啟網站</a></p>` : "";
  const issueLink = issueUrl ? `<p>GitHub Issue：<a href="${issueUrl}">${issueUrl}</a></p>` : "";
  return `<pre style="font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap;">${esc(md)}</pre>${viewLink}${issueLink}`;
}
function stripHtml(h){ return (h||"").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""); }
function senderHeader(email, name){ return name ? `${name} <${email}>` : email; }
function parseAddr(str){
  // 支援 "Name <email@x.com>" 或 "email@x.com"
  const m = String(str).match(/^\s*(?:"?([^"]*)"?\s*)?<([^>]+)>\s*$/);
  if (m) return { name: m[1] || undefined, email: m[2].trim() };
  return { email: String(str).trim() };
}

function resp(status, text){ return { statusCode: status, body: text }; }
function json(status, obj){ return { statusCode: status, headers:{ "Content-Type":"application/json" }, body: JSON.stringify(obj) }; }
async function safeText(res){ try{ return await res.text(); }catch{ return "(no body)"; } }
