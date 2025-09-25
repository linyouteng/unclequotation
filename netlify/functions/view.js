// netlify/functions/view.js
// 找出 Cloudinary 檔案（raw/image/video × upload/authenticated/private），回傳 data + locked + tags/context

const RTYPES = ["raw", "image", "video"];
const DTYPES = ["upload", "authenticated", "private"];

export async function handler(event) {
  try {
    let id = (event.queryStringParameters?.id || "").trim();
    if (!id) return resp(400, { error: "Missing id" });

    const cloud = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    const FOLDER = process.env.CLOUDINARY_FOLDER || "quotes";
    if (!cloud || !apiKey || !apiSecret) return resp(500, { error: "Missing Cloudinary config" });

    const auth = "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
    id = normalizeId(id);

    const candidates = uniq([ id, !id.includes("/") ? `${FOLDER}/${id}` : null ].filter(Boolean));

    let meta = null, rtype = null, dtype = null, publicId = null;

    outer:
    for (const rt of RTYPES) {
      for (const dt of DTYPES) {
        for (const pid of candidates) {
          const m = await getAdminMeta(cloud, auth, rt, dt, pid);
          if (m) { meta = m; rtype = rt; dtype = dt; publicId = pid; break outer; }
        }
      }
    }

    if (!meta) {
      const found = await searchAny(cloud, auth, id, FOLDER);
      if (found) {
        rtype = found.resource_type;
        dtype = found.type || "upload";
        publicId = found.public_id;
        meta = await getAdminMeta(cloud, auth, rtype, dtype, publicId, true);
      }
    }

    if (!meta) return resp(404, { error: "Not found", tried: { id, candidates } });

    const locked = meta?.context?.custom?.locked === "1";
    const fileUrl = meta?.secure_url;
    if (!fileUrl) return resp(500, { error: "Missing secure_url on resource", rtype, dtype, publicId });

    const r2 = await fetch(fileUrl, { headers: { "Cache-Control": "no-store", "Pragma": "no-cache" } });
    if (!r2.ok) return resp(500, { error: "Fetch resource error", status: r2.status, detail: await safeText(r2) });

    const raw = await r2.text();
    let data; try { data = JSON.parse(raw); } catch { data = raw; }

    return resp(200, { 
      locked, 
      data, 
      public_id: publicId, 
      resource_type: rtype, 
      type: dtype,
      tags: meta.tags || [],
      context: meta.context || {}
    }, true);

  } catch (e) {
    console.error("[view.js] error:", e);
    return resp(500, { error: String(e?.message || e) });
  }
}

/* helpers */
function normalizeId(id){ try{ id = decodeURIComponent(id); }catch{} return id.replace(/^#?cid=/i,"").replace(/^\/+|\/+$/g,"").replace(/\.(json|txt|bin|pdf|xml|csv|yaml|yml)$/i,""); }
async function getAdminMeta(cloud, auth, rtype, dtype, publicId, throwOnError=false){
  const url = `https://api.cloudinary.com/v1_1/${cloud}/resources/${rtype}/${dtype}/${encodeURIComponent(publicId)}`;
  const r = await fetch(url, { headers: { Authorization: auth, "Cache-Control":"no-store", "Pragma":"no-cache" } });
  if (r.status === 404) return null;
  if (!r.ok){ const t = await safeText(r); if (throwOnError) throw new Error(`Admin API error (${rtype}/${dtype}/${publicId}): ${t}`); return null; }
  return await r.json();
}
async function searchAny(cloud, auth, id, folder){
  const expr = [
    `public_id="${escapeExpr(id)}"`,
    `public_id="${escapeExpr(`${folder}/${id}`)}"`,
    `filename="${escapeExpr(basename(id))}"`
  ].join(" OR ");
  const r = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/resources/search`, {
    method:"POST",
    headers:{ Authorization: auth, "Content-Type":"application/json", "Cache-Control":"no-store", "Pragma":"no-cache" },
    body: JSON.stringify({ expression: expr, max_results: 1 })
  });
  if (!r.ok) return null;
  const json = await r.json();
  return (json?.resources || [])[0] || null;
}
function basename(s){ const i=s.lastIndexOf("/"); return i>=0?s.slice(i+1):s; }
function escapeExpr(s){ return s.replace(/(["\\])/g,"\\$1"); }
function uniq(a){ return Array.from(new Set(a)); }
function resp(statusCode,json,noStore=false){ const h={"Content-Type":"application/json"}; if(noStore){ h["Cache-Control"]="no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"; h["Pragma"]="no-cache"; h["Expires"]="0"; } return { statusCode, headers:h, body:JSON.stringify(json) }; }
async function safeText(res){ try{ return await res.text(); }catch{ return "(no body)"; } }
