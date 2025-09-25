// netlify/functions/lock.js
// 將指定 Cloudinary public_id 的 context.locked 設為 1
// 自動偵測 resource_type (raw/image/video) 與 type (upload/authenticated/private)

const RTYPES = ["raw", "image", "video"];
const DTYPES = ["upload", "authenticated", "private"];

export async function handler(event){
  try{
    if (event.httpMethod !== "POST") return resp(405, "Method Not Allowed");
    const body = JSON.parse(event.body || "{}");
    let id = (body.id || "").trim();
    if (!id) return resp(400, "Missing id");

    const cloud = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    const FOLDER = process.env.CLOUDINARY_FOLDER || "quotes";
    if (!cloud || !apiKey || !apiSecret) return resp(500, "Missing Cloudinary config");

    const auth = "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
    id = normalizeId(id);
    const candidates = uniq([ id, !id.includes("/") ? `${FOLDER}/${id}` : null ].filter(Boolean));

    // 先找出正確 rtype / dtype
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
    if (!meta) return resp(404, "Not found");

    // 更新 context
    const url = `https://api.cloudinary.com/v1_1/${cloud}/resources/${rtype}/${dtype}/${encodeURIComponent(publicId)}`;
    const form = new URLSearchParams();
    form.append("context", "locked=1");
    const r = await fetch(url, { method:"POST", headers:{ Authorization: auth, "Content-Type":"application/x-www-form-urlencoded" }, body: form });
    if (!r.ok) return resp(r.status, await r.text());

    return json(200, { ok:true, public_id: publicId, resource_type: rtype, type: dtype });

  }catch(e){
    return json(500, { error: String(e?.message || e) });
  }
}

function normalizeId(id){ try{ id = decodeURIComponent(id); }catch{} return id.replace(/^#?cid=/i,"").replace(/^\/+|\/+$/g,"").replace(/\.(json|txt|bin|pdf|xml|csv|yaml|yml)$/i,""); }
async function getAdminMeta(cloud, auth, rtype, dtype, publicId){
  const url = `https://api.cloudinary.com/v1_1/${cloud}/resources/${rtype}/${dtype}/${encodeURIComponent(publicId)}`;
  const r = await fetch(url, { headers: { Authorization: auth } });
  if (r.status === 404) return null;
  if (!r.ok) return null;
  return await r.json();
}
function resp(status, text){ return { statusCode: status, body: text }; }
function json(status, obj){ return { statusCode: status, headers:{ "Content-Type":"application/json" }, body: JSON.stringify(obj) }; }
function uniq(a){ return Array.from(new Set(a)); }
