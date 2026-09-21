import { env } from 'cloudflare:workers';
import sample from '@/lib/sample-data.json';
export async function GET(){
 const e=env as unknown as Record<string,string>;const base=e.FLATFORGE_API_URL||process.env.FLATFORGE_API_URL;const key=e.FLATFORGE_API_KEY||process.env.FLATFORGE_API_KEY;
 if(!base||!key)return Response.json({...sample,service_message:'Sample workspace · conversion service not connected'},{headers:{'Cache-Control':'private, no-store'}});
 try{const r=await fetch(base.replace(/\/$/,'')+'/bootstrap',{headers:{'x-flatforge-key':key!},signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error('Unavailable');return Response.json(await r.json(),{headers:{'Cache-Control':'private, no-store'}})}catch{return Response.json({...sample,service_message:'Conversion service unreachable · showing sample workspace'},{headers:{'Cache-Control':'private, no-store'}})}
}
