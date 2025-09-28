// netlify/functions/list.js
// 列出 Cloudinary 報價單，支援 raw/image/video × upload/authenticated/private
// 並能依 QUOTE_PREFIX 過濾（預設 "q-"）

const RTYPES = ["raw","image","video"];
const DTYPES = ["upload","authenticated","private"];

export async function handler(event) {
  try {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    const FOLDER = process.env.CLOUDINARY_FOLDER || "quotes";
    const PREFIX = process.env.QUOTE_PREFIX || "q-";

    if (!cloud || !apiKey || !apiSecret) {
      return json(500, { error: "Missing Cloudinary config" });
    }

    const qp = event.queryStringParameters || {};
    const per = Math.min(parseInt(qp.per || "50", 10) || 50, 100);
    const cursor = parseCursor(qp.next || "");
    const disablePrefix = qp.noprefix === "1"; // 可用 ?noprefix=1 停用前綴過濾

    let items = [];
    let next_map = {};

    for (const r of RTYPES) {
      for (const d of DTYPES) {
        const { resources, next } = await searchOnce({
          cloud, apiKey, apiSecret, folder: FOLDER,
          rtype: r, dtype: d, max: per,
          next: cursor[`${r}:${d}`] || "",
          prefix: disablePrefix ? "" : PREFIX
        });
        next_map[`${r}:${d}`] = next || "";
        for (const rsc of (resources || [])) {
          const pid = String(rsc.public_id || "").replace(/^\/+/, "");
          const id = pid.replace(new RegExp(`^${escapeRe(FOLDER)}/?`), "") || pid;
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

    items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const next = serializeCursor(next_map);

    return json(200, { items, next });
  } catch (e) {
    return json(500, { error: String(e?.message || e) });
  }
}

async function searchOnce({ cloud, apiKey, apiSecret, folder, rtype, dtype, max, next, prefix }) {
  const auth = "Basic " + Buffer.from(apiKey + ":" + apiSecret).toString("base64");
  const prefixExpr = prefix
    ? ` AND (filename="${escapeExpr(prefix)}*" OR public_id="${escapeExpr(folder)}/${escapeExpr(prefix)}*")`
    : "";
  const expr = `folder="${escapeExpr(folder)}" AND resource_type=${rtype} AND type=${dtype}${prefixExpr}`;

  const r = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/resources/search`, {
    method: "POST",
    headers: { "Authorization": auth, "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({ expression: expr, max_results: max, next_cursor: next || undefined, sort_by: [{ public_id: "desc" }] })
  });

  const bodyText = await safeText(r);
  if (!r.ok) return { resources: [], next: "", expr, status: r.status, bodyText };

  const data = JSON.parse(bodyText || "{}");
  return { resources: data.resources || [], next: data.next_cursor || "" };
}

function buildSiteLink(event, id) {
  const base = getBaseUrl(event) || (process.env.SITE_BASE_URL || "");
  const u = (base || "/").replace(/\/+$/, "/");
  return u + `?cid=${encodeURIComponent(id)}`;
}

function json(status, obj) { return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) }; }
async function safeText(res) { try { return await res.text(); } catch { return "(no body)"; } }
function parseCursor(s) { try { return JSON.parse(Buffer.from(String(s || ""), "base64").toString("utf8")) || {}; } catch { return {}; } }
function serializeCursor(obj) { try { return Buffer.from(JSON.stringify(obj || {}), "utf8").toString("base64"); } catch { return ""; } }
function escapeExpr(s) { return String(s || "").replace(/"/g, '\\"'); }
function escapeRe(s) { return String(s || "").replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'); }
function getBaseUrl(event) {
  try {
    const proto = (event.headers["x-forwarded-proto"] || "https");
    const host = (event.headers["x-forwarded-host"] || event.headers["host"] || "").split(",")[0].trim();
    const path = event.path && event.path.endsWith("/") ? event.path : "/";
    return host ? `${proto}://${host}${path}`.replace(/\/+$/, "/") : "";
  } catch { return ""; }
}
