const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
async function saveSignup(db,email,source){if(!db)throw new Error('Missing storage');await db.prepare('INSERT INTO early_access (email, created_at, source) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING').bind(email,new Date().toISOString(),source).run();}
export default {async fetch(request,env){const url=new URL(request.url);if(url.pathname==='/api/early-access'){
 if(request.method!=='POST')return json({error:'Method not allowed'},405);
 if(request.headers.get('origin')!==url.origin)return json({error:'Request not allowed'},403);
 if(!request.headers.get('content-type')?.startsWith('application/json'))return json({error:'Expected JSON'},415);
 if(Number(request.headers.get('content-length'))>2048)return json({error:'Request too large'},413);
 let data;try{const body=await request.text();if(body.length>2048)return json({error:'Request too large'},413);data=JSON.parse(body);}catch{return json({error:'Invalid request'},400)}
 if(!data||typeof data!=='object')return json({error:'Invalid request'},400);
 if(data.website)return json({ok:true});
 const email=typeof data.email==='string'?data.email.trim().toLowerCase():'';
 if(email.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json({error:'Enter a valid email address.'},400);
 if(!['hero','overview','open-source'].includes(data.source))return json({error:'Invalid form'},400);
 try{await saveSignup(env.DB,email,data.source);return json({ok:true})}catch{console.error('Early access storage unavailable');return json({error:'We couldn’t save your request. Please try again.'},503)}
 }
 if(request.method!=='GET'&&request.method!=='HEAD')return new Response('Method not allowed',{status:405});
 let path=url.pathname;try{path=decodeURIComponent(path)}catch{return new Response('Not found',{status:404})}if(path.endsWith('/'))path+='index.html';
 const asset=ASSETS[path];if(!asset)return new Response('Not found',{status:404});
 return new Response(request.method==='HEAD'?null:Uint8Array.from(atob(asset.body),c=>c.charCodeAt(0)),{headers:{'Content-Type':asset.type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-cache'}});
}};
