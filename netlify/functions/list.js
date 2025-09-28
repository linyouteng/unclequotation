//
// netlify/functions/list.js
// Hybrid：先用 Cloudinary Search API（public_id 前綴），若無結果/失敗再用 Admin API prefix 當備援。
// 保留分頁 "__END__" 標記避免「載入更多」重複；支援 ?noprefix=1 排查。

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
    const cursor = parseCursor(qp.next || {});
    const disablePrefix = qp.noprefix === "1";

    const auth = "Basic " + Buffer.from(apiKey + ":" + apiSecret).toString("base64");
    const fullPrefix = disablePrefix ? `${FOLDER}/` : `${FOLDER}/${PREFIX}`; // e.g. quotes/ or quotes/q-

    let items = [];
    let next_map = {};

    for (const r of RTYPES){
      for (const d of DTYPES){
        const key = `${r}:${d}`;
        if (cursor[key] === "__END__") { next_map[key] = "__END__"; continue; }

        // 1) Search API first
        let resources = [];
        let nextCur = "";
        let searchTried = false;
        let searchOk = false;

        try{
          searchTried = true;
          // expression：若停用前綴 -> 用 folder 過濾；否則以 public_id 前綴
          const expr = disablePrefix
            ? `folder="${escapeExpr(FOLDER)}" AND resource_type=${r} AND type=${d}`
            : `public_id="${escapeExpr(fullPrefix)}*" AND resource_type=${r} AND type=${d}`;

          const sres = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/resources/search`, {
            method: "POST",
            headers: { "Authorization": auth, "Content-Type": "application/json", "Cache-Control": "no-store" },
            body: JSON.stringify({
              expression: expr,
              max_results: per,
              next_cursor: cursor[key] || undefined,
              sort_by: [{ public_id: "desc" }]
            })
          });
          if (sres.ok){
            const data = await sres.json().catch(()=>({}));
            resources = data.resources || [];
            nextCur = data.next_cursor || "";
            searchOk = true;
          }
        }catch(_){ /* ignore search errors, fall back */ }

        // 2) Fallback: Admin API by prefix （更穩）
        if (!searchOk || resources.length === 0){
          const url = new URL(`https://api.cloudinary.com/v1_1/${cloud}/resources/${r}/${d}`);
          url.searchParams.set("prefix", fullPrefix);
          url.searchParams.set("max_results", String(per));
          if (cursor[key] && cursor[key] !== "__END__") url.searchParams.set("next_cursor", cursor[key]);
          const ares = await fetch(url.toString(), { headers: { "Authorization": auth, "Cache-Control":"no-store" } });
          if (!ares.ok){
            const detail = await safeText(ares);
            return json(ares.status, { error: "Cloudinary Admin API failed", detail, rtype:r, dtype:d });
          }
          const data = await ares.json().catch(()=>({}));
          resources = data.resources || [];
          nextCur = data.next_cursor || "";
        }

        // 更新游標：若沒有下一頁就標記為 __END__
        next_map[key] = nextCur ? nextCur : "__END__";

        // push items
        for (const rsc of resources){
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
function escapeExpr(s){ return String(s||"").replace(/"/g,'\\\"'); }
function escapeRe(s){ return String(s||"").replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'); }
function getBaseUrl(event){
  try{
    const proto = (event.headers["x-forwarded-proto"] || "https");
    const host = (event.headers["x-forwarded-host"] || event.headers["host"] || "").split(",")[0].trim();
    const path = event.path && event.path.endsWith("/") ? event.path : "/";
    return host ? `${proto}://${host}${path}`.replace(/\/+$/,"/") : "";
  }catch{ return ""; }
}
