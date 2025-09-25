// netlify/functions/cancel.js (v5 - raw 用 tags, image/video 用 context)
import crypto from "crypto";

const RTYPES = ["raw","image","video"];
const DTYPES = ["upload","authenticated","private"];

export async function handler(event){
  try{
    if(event.httpMethod!=="POST") return json(405,{error:"Method Not Allowed"});
    const body = JSON.parse(event.body||"{}");
    let id = (body.id||"").trim();
    const reason = String(body.reason||"").slice(0,500);
    if(!id) return json(400,{error:"Missing id"});

    const cloud = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    if(!cloud || !apiKey || !apiSecret){
      return json(500,{error:"Missing Cloudinary env"});
    }

    id = normalizeId(id);
    const meta = await findResourceMeta(cloud, apiKey, apiSecret, id);
    if(!meta) return json(404,{error:"Resource not found", id});

    const nowISO = new Date().toISOString();

    // === RAW 檔案 → 用 tags ===
    if(meta.resource_type==="raw"){
      const auth = "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
      const url = `https://api.cloudinary.com/v1_1/${cloud}/resources/raw/upload/${encodeURIComponent(meta.public_id)}`;
      const tags = [
        "locked",
        "cancelled",
        `cancel_time_${nowISO}`,
      ];
      if(reason) tags.push(`cancel_reason_${sanitize(reason)}`);

      const r = await fetch(url, {
        method:"POST",
        headers:{ Authorization: auth, "Content-Type":"application/json" },
        body: JSON.stringify({ tags: tags.join(",") })
      });
      const txt = await r.text();
      if(!r.ok) return json(502,{error:"Failed to update tags (raw)", status:r.status, response:txt});
      let parsed=null; try{parsed=JSON.parse(txt);}catch{}
      return json(200,{ok:true, id:meta.public_id, resource_type:"raw", tags, raw:parsed||txt});
    }

    // === IMAGE / VIDEO → 用 Upload API context ===
    const contextData = {
      locked:"1",
      status:"cancelled",
      cancel_reason: reason,
      cancel_time: nowISO
    };
    const contextKV = Object.entries(contextData)
      .map(([k,v])=>`${k}=${String(v).replace(/\|/g,"/")}`).join("|");
    const timestamp = Math.floor(Date.now()/1000);
    const paramsToSign = {
      command:"add", context:contextKV, "public_ids[]": meta.public_id, timestamp:String(timestamp)
    };
    const signature = signParams(paramsToSign, apiSecret);
    const form = new URLSearchParams();
    form.append("command","add");
    form.append("context",contextKV);
    form.append("public_ids[]",meta.public_id);
    form.append("timestamp",String(timestamp));
    form.append("api_key",apiKey);
    form.append("signature",signature);

    const url = `https://api.cloudinary.com/v1_1/${cloud}/${meta.resource_type}/context`;
    const r = await fetch(url,{method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" }, body:form.toString()});
    const txt = await r.text();
    if(!r.ok) return json(502,{error:"Failed to update context (Upload API)", status:r.status, response:txt});
    let parsed=null; try{parsed=JSON.parse(txt);}catch{}
    return json(200,{ok:true, id:meta.public_id, resource_type:meta.resource_type, context:contextData, raw:parsed||txt});

  }catch(e){
    return json(500,{error:String(e?.message||e)});
  }
}

function signParams(params, apiSecret){
  const entries = Object.entries(params)
    .filter(([k,v])=>v!==undefined && v!==null && v!=="")
    .sort((a,b)=>a[0].localeCompare(b[0]))
    .map(([k,v])=>`${k}=${v}`)
    .join("&");
  const toSign = entries+apiSecret;
  return crypto.createHash("sha1").update(toSign).digest("hex");
}

function sanitize(s){
  return s.replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,50);
}

function normalizeId(id){
  try{id=decodeURIComponent(id);}catch{}
  return id.replace(/^#+/,"").replace(/[?#].*$/,"").replace(/\.(json|txt|bin|pdf|xml|csv|yaml|yml)$/i,"");
}

async function findResourceMeta(cloud, apiKey, apiSecret, id){
  const auth = "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
  for(const rtype of RTYPES){
    for(const dtype of DTYPES){
      const url = `https://api.cloudinary.com/v1_1/${cloud}/resources/${rtype}/${dtype}/${encodeURIComponent(id)}`;
      const r = await fetch(url,{headers:{Authorization:auth}});
      if(r.status===404) continue;
      if(!r.ok) continue;
      const j=await r.json();
      if(j&&j.public_id) return {resource_type:j.resource_type, public_id:j.public_id};
    }
  }
  // fallback search
  const s=await fetch(`https://api.cloudinary.com/v1_1/${cloud}/resources/search`,{
    method:"POST", headers:{Authorization:auth,"Content-Type":"application/json"},
    body:JSON.stringify({expression:`public_id="${id}" OR public_id="quotes/${id}"`,max_results:1})
  });
  if(!s.ok) return null;
  const js=await s.json();
  const hit=(js.resources||[])[0];
  return hit?{resource_type:hit.resource_type, public_id:hit.public_id}:null;
}

function json(status,obj){return{statusCode:status,headers:{"Content-Type":"application/json"},body:JSON.stringify(obj)};}
