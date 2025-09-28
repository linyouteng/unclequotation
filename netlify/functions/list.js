// netlify/functions/list.js
// 列出 Cloudinary 報價單：固定用 Admin API prefix (quotes/q-)，不再用 Search API
// 支援 raw/image/video × upload/authenticated/private
// 支援 ?noprefix=1 停用前綴過濾（列出整個 quotes/ 資料夾）

const RTYPES = ["raw","image","video"];
const DTYPES = ["upload","authenticated","private"];

export async function handler(event) {
  try {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    const FOLDER = process.env.CLOUDINARY_FOLDER || "quotes";
    const PREFIX = process.env.QUOTE_PREFIX || "q-";
    if (!cloud || !apiKey || !apiSecret) return json(500, { error: "Missing Cloudinary config" });

    const qp = event.queryStringParameters || {};
    const per = Math.min(parseInt(qp.per || "50", 10) || 50, 100);
    const cursor = parseCursor(qp.next || "");
    const disablePrefix = qp.noprefix === "1";

    const auth = "Basic " + Buffer.from(apiKey + ":" + apiSecret).toString("base64");
    const fullPrefix = disablePrefix ? `${FOLDER}/` : `${FOLDER}/${PREFIX}`; // e.g. quotes/q-

    let items = [];
    let next_map = {};

    for (const r of RTYPES) {
      for (const d of DTYPES) {
        const url = new URL(`https://api.cloudinary.com/v1_1/${cloud}/resources/${r}/${d}`);
        url.searchParams.set("prefix", fullPrefix);
        url.searchParams.set("max_results", String(per));
        if (cursor[`${r}:${d}`]) url.searchParams.set("next_cursor", cursor[`${r}:${d}`]);

        const res = await fetch(url.toString(), {
          headers: { "Authorization": auth, "Cache-Control": "no-store" }
        });

        if (!res.ok) {
          const detail = await safeText(res);
          return json(res.status, { error: "Cloudinary Admin API failed", detail, rtype:r, dtype:d });
        }

        const data = await res.json().catch(()=>({}));
        const resources = data.resources || [];
        next_map[`${r}:${d}`] = data.next_cursor || "";

        for (const rsc of resources) {
          const pid = String(rsc.public_id || "").replace(/^\/+/, "");
          const id  = pid.replace(new RegExp(`^${escapeRe(FOLDER)}/?`), "") || pid;
          const link = buildSiteLink(event, id);
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

    // 最新在前
    items.sort((a,b)=> new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const next = serializeCursor(next_map);
    return json(200, { items, next });
  } catch (e) {
    return json(500, { error: String(e?.message || e) });
  }
}

function buildSiteLink(event, id){
  const base = getBaseUrl(event) || (process.env.SITE_BASE_URL || "");
  const u = (base || "/").replace(/\/+$/,"/");
  return u + `?cid=${encodeURIComponent(id)}`;
}

function json(status, obj){ return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) }; }
async function safeText(res){ try{ return await res.text(); }catch{ return "(no body)"; } }
function parseCursor(s){ try { return JSON.parse(Buffer.from(String(s||""), "base64").toString("utf8")) || {}; } catch { return {}; } }
function serializeCursor(obj){ try { return Buffer.from(JSON.stringify(obj||{}), "utf8").toString("base64"); } catch { return ""; } }
function escapeRe(s){ return String(s||"").replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'); }
function getBaseUrl(event){
  try{
    const proto = (event.headers["x-forwarded-proto"] || "https");
    const host = (event.headers["x-forwarded-host"] || event.headers["host"] || "").split(",")[0].trim();
    const path = event.path && event.path.endsWith("/") ? event.path : "/";
    return host ? `${proto}://${host}${path}`.replace(/\/+$/,"/") : "";
  }catch{ return ""; }
}
