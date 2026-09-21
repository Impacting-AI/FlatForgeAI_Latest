import { env } from 'cloudflare:workers';
const runtime=()=>{const e=env as unknown as Record<string,string>;return {url:e.FLATFORGE_API_URL||process.env.FLATFORGE_API_URL,key:e.FLATFORGE_API_KEY||process.env.FLATFORGE_API_KEY}};
async function proxy(request:Request,{params}:{params:Promise<{path:string[]}>}){
 const {url,key}=runtime();
 if(!url||!key)return Response.json({detail:'The Python conversion service is not connected. Deploy the supplied backend and configure its URL and secret.'},{status:503});
 const {path}=await params;
 if(path.some(p=>p==='..'||p.includes('/')||p.includes('\\'))||!['bootstrap','settings','projects','panels'].includes(path[0]))return Response.json({detail:'Invalid API route'},{status:400});
 const destination=new URL(url.replace(/\/$/,'')+'/'+path.map(encodeURIComponent).join('/'));destination.search=new URL(request.url).search;
 const headers=new Headers({'x-flatforge-key':key});const contentType=request.headers.get('content-type');if(contentType)headers.set('content-type',contentType);
 try{
  const upstream=await fetch(destination,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,redirect:'manual',signal:AbortSignal.timeout(120000)});
  const resultHeaders=new Headers(upstream.headers);resultHeaders.set('cache-control','private, no-store');resultHeaders.delete('access-control-allow-origin');
  return new Response(upstream.body,{status:upstream.status,headers:resultHeaders});
 }catch{return Response.json({detail:'The conversion service is unavailable. Your saved projects remain on the backend; try again shortly.'},{status:503})}
}
export {proxy as GET,proxy as POST,proxy as PUT,proxy as DELETE};
