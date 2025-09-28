// netlify/functions/list.js
// 列出 Cloudinary 報價單（raw/image/video × upload/authenticated/private）
// 以 public_id 前綴 (folder + QUOTE_PREFIX) 為主要搜尋條件；
// 若 Search API 無法命中則 fallback 到 Admin API prefix 列表。
// 支援 ?noprefix=1 停用前綴過濾排查。

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
    const fullPrefix = `${FOLDER}/${disablePrefix ? "" : PREFIX}`; // e.g. quotes/q-

    let items = [];
    let next_map = {};
    let usedFallback = false;

    for (const r of RTYPES){
      for (const d of DTYPES){
        // ---- 1) Search API by public_id prefix ----
        const expr = `public_id="${escapeExpr(fullPrefix)}*" AND resource_type=${r} AND type=${d}`;
        let resources = [];
        let nextCur = "";
        const sres = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/resources/search`, {
          method: "POST",
          headers: { "Authorization": auth, "Content-Type": "application/json", "Cache-Control": "no-store" },
          body: JSON.stringify({
            expression: expr,
            max_results: per,
            next_cursor: cursor[`${r}:${d}`] || undefined,
            sort_by: [{ public_id: "desc" }]
          })
        });
        if (sres.ok) {
          const data = await sres.json().catch(()=>({}));
          resources = data.resources || [];
          nextCur = data.next_cursor || "";
        } else {
          usedFallback = true;
        }

        // ---- 2) Fallback: Admin API prefix listing ----
        if (!resources.length) {
          usedFallback = true;
          const url = new URL(`https://api.cloudinary.com/v1_1/${cloud}/resources/${r}/${d}`);
          url.searchParams.set("prefix", fullPrefix); // 直接用 quotes/q- 做前綴
          url.searchParams.set("max_results", String(per));
          if (cursor[`${r}:${d}`]) url.searchParams.set("next_cursor", cursor[`${r}:${d}`]);
          const ares = await fetch(url.toString(), {
            headers: { "Authorization": auth, "Cache-Control": "no-store" }
          });
          if (ares.ok) {
            const data = await ares.json().catch(()=>({}));
            resources = data.resources || [];
            nextCur = data.next_cursor || "";
          } else {
            const detail = await safeText(ares);
            return json(ares.status, { error: "Cloudinary list (prefix) failed", detail, rtype:r, dtype:d });
          }
        }

        // （保險）伺服端再檢查 basename 是否符合 PREFIX（當 disablePrefix=false 時）
        const filtered = resources.filter(rsc => {
          if (disablePrefix) return true;
          const pid = String(rsc.public_id || "");
          const base = pid.slice(pid.lastIndexOf("/") + 1);
          return base.startsWith(PREFIX);
        });

        next_map[`${r}:${d}`] = nextCur || "";
        for (const rsc of filtered){
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
    return json(200, { items, next, _fallback_used: usedFallback });
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
function escapeExpr(s){ return String(s||"").replace(/"/g,'\\"'); }
function escapeRe(s){ return String(s||"").replace(/[.*+?^${}()|[\\]\\/g, '\\$&'); }
function getBaseUrl(event){
  try{
    const proto = (event.headers["x-forwarded-proto"] || "https");
    const host = (event.headers["x-forwarded-host"] || event.headers["host"] || "").split(",")[0].trim();
    const path = event.path && event.path.endsWith("/") ? event.path : "/";
    return host ? `${proto}://${host}${path}`.replace(/\/+$/,"/") : "";
  }catch{ return ""; }
}
