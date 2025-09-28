// netlify/functions/list.js
// 列出 Cloudinary 中的報價單（raw）資源，支援分頁
export async function handler(event) {
  try {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    const FOLDER = process.env.CLOUDINARY_FOLDER || "quotes";
    const SITE_BASE_URL = process.env.SITE_BASE_URL || getBaseUrl(event) || "";
    if (!cloud || !apiKey || !apiSecret) return json(500, { error: "Missing Cloudinary config" });

    const next = event.queryStringParameters?.next || "";
    const per = Math.min(parseInt(event.queryStringParameters?.per || "50", 10) || 50, 100);

    const auth = "Basic " + Buffer.from(apiKey + ":" + apiSecret).toString("base64");
    const expression = `folder="${escapeExpr(FOLDER)}" AND resource_type=raw`;

    const body = { expression, max_results: per, next_cursor: next || undefined, sort_by: [{ public_id: "desc" }] };
    const r = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/resources/search`, {
      method: "POST",
      headers: { "Authorization": auth, "Content-Type": "application/json", "Cache-Control":"no-store" },
      body: JSON.stringify(body)
    });
    if (!r.ok) return json(r.status, { error: `cloudinary search error: ${await safeText(r)}` });

    const data = await r.json();
    const items = (data.resources || []).map(r => {
      const pid = r.public_id?.replace(/^\/*/, "");
      const id = pid?.replace(new RegExp(`^${escapeRe(FOLDER)}/?`), "") || pid;
      const link = SITE_BASE_URL ? (SITE_BASE_URL.replace(/\/+$/,"/") + `?cid=${encodeURIComponent(id)}`) : `/?cid=${encodeURIComponent(id)}`;
      return {
        id,
        public_id: r.public_id,
        created_at: r.created_at,
        bytes: r.bytes,
        format: r.format,
        filename: r.filename,
        link
      };
    });

    return json(200, { items, next: data.next_cursor || "" });
  } catch (e) {
    return json(500, { error: String(e?.message || e) });
  }
}

function json(status, obj){ return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) }; }
async function safeText(res){ try{ return await res.text(); }catch{ return "(no body)"; } }
function escapeExpr(s){ return String(s||"").replace(/"/g,'\\\"'); }
function escapeRe(s){ return String(s||"").replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function getBaseUrl(event){
  try{
    const proto = (event.headers["x-forwarded-proto"] || "https");
    const host = event.headers["x-forwarded-host"] || event.headers["host"];
    const path = event.path && event.path.endsWith("/") ? event.path : "/";
    return host ? `${proto}://${host}${path}`.replace(/\/+$/,"/") : "";
  }catch{ return ""; }
}
