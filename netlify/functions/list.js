// netlify/functions/list.js
// 列出 Cloudinary 中的報價單資源，支援 raw/image/video × upload/authenticated/private，並合併回傳
const RTYPES = ["raw","image","video"];
const DTYPES = ["upload","authenticated","private"];

export async function handler(event) {
  try {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    const FOLDER = process.env.CLOUDINARY_FOLDER || "quotes";
    const SITE_BASE_URL = process.env.SITE_BASE_URL || getBaseUrl(event) || "";
    if (!cloud || !apiKey || !apiSecret) return json(500, { error: "Missing Cloudinary config" });

    const per = Math.min(parseInt(event.queryStringParameters?.per || "50", 10) || 50, 100);
    const cursor = parseCursor(event.queryStringParameters?.next || "");
    const PREFIX = (process.env.QUOTE_PREFIX || "q-");

    // 針對每一組 (rtype, dtype) 查詢一頁，合併結果
    let items = [];
    let next_map = {};

    for (const r of RTYPES){
      for (const d of DTYPES){
        const { resources, next } = await searchOnce({ cloud, apiKey, apiSecret, folder:FOLDER, rtype:r, dtype:d, max:per, next: cursor[`${r}:${d}`] || "" });
        next_map[`${r}:${d}`] = next || "";
        for (const rsc of (resources || [])){
          const pid = (rsc.public_id || "").replace(/^\/*/, "");
          const id  = pid.replace(new RegExp(`^${escapeRe(FOLDER)}/?`), "") || pid;
          const link = SITE_BASE_URL ? (SITE_BASE_URL.replace(/\/+$/,"/") + `?cid=${encodeURIComponent(id)}`) : `/?cid=${encodeURIComponent(id)}`;
          items.push({
            id,
            public_id: rsc.public_id,
            created_at: rsc.created_at,
            bytes: rsc.bytes,
            format: rsc.format,
            filename: rsc.filename,
            resource_type: r,
            type: d,
            link
          });
        }
      }
    }

    // 依建立時間排序（預設最新優先）
    items.sort((a,b)=> new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    // 將 next_map 序列化為游標字串
    const next = serializeCursor(next_map);

    return json(200, { items, next });
  } catch (e) {
    return json(500, { error: String(e?.message || e) });
  }
}

async function searchOnce({ cloud, apiKey, apiSecret, folder, rtype, dtype, max, next }){
  const auth = "Basic " + Buffer.from(apiKey + ":" + apiSecret).toString("base64");
  const expression = `folder="${escapeExpr(folder)}" AND resource_type=${rtype} AND type=${dtype} AND (filename="${escapeExpr(prefix)}*" OR public_id="${escapeExpr(folder)}/${escapeExpr(prefix)}*")`;
  const body = { expression, max_results: max, next_cursor: next || undefined, sort_by: [{ public_id: "desc" }] };
  const r = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/resources/search`, {
    method: "POST",
    headers: { "Authorization": auth, "Content-Type": "application/json", "Cache-Control":"no-store" },
    body: JSON.stringify(body)
  });
  if (!r.ok) return { resources: [], next: "" };
  const data = await r.json();
  return { resources: data.resources || [], next: data.next_cursor || "" };
}

function parseCursor(s){
  try { return JSON.parse(Buffer.from(String(s||""), "base64").toString("utf8")) || {}; } catch { return {}; }
}
function serializeCursor(obj){
  try { return Buffer.from(JSON.stringify(obj||{}), "utf8").toString("base64"); } catch { return ""; }
}

function json(status, obj){ return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) }; }
function escapeExpr(s){ return String(s||"").replace(/"/g,'\\\"'); }
function escapeRe(s){ return String(s||"").replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function getBaseUrl(event){
  try{
    const proto = (event.headers["x-forwarded-proto"] || "https");
    const host = (event.headers["x-forwarded-host"] || event.headers["host"] || "").split(",")[0].trim();
    const path = event.path && event.path.endsWith("/") ? event.path : "/";
    return host ? `${proto}://${host}${path}`.replace(/\/+$/,"/") : "";
  }catch{ return ""; }
}
