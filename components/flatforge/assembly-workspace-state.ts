import type { AssemblyEntry, CadFaceReference } from './types';
import type { CadFace, CadFaceCatalog, CadPlacement } from './assembly-cad';
import { beginFaceDraft, type FaceDraft } from './face-connection-state';

export function alphabeticLabel(index:number):string {
  let label='';for(let n=index+1;n>0;n=Math.floor((n-1)/26))label=String.fromCharCode(65+(n-1)%26)+label;
  return label;
}
export function namedEntries(entries:AssemblyEntry[]) {
  const used=new Set(entries.flatMap(e=>e.label?[e.label]:[]));
  return entries.map(e=>{if(e.label)return e;let i=0;while(used.has(alphabeticLabel(i)))i++;const label=alphabeticLabel(i);used.add(label);return {...e,label};});
}
export function nextLabel(entries:AssemblyEntry[]) {
  const used=new Set(namedEntries(entries).map(e=>e.label));let i=0;while(used.has(alphabeticLabel(i)))i++;return alphabeticLabel(i);
}
/** Labels follow source-local normals, then rotate with the panel. No screen/world guess. */
export function faceSide(face:CadFace) {
  if(!face.supported||!face.normal)return `Curved (${face.type}) — Face ${face.id.slice(5)}`;
  const n=face.normal,index=n.reduce((best,v,i)=>Math.abs(v)>Math.abs(n[best])?i:best,0);
  const side=([['Left','Right'],['Front','Back'],['Bottom','Top']])[index][n[index]>0?1:0];
  return `${Math.abs(n[index])<.966?'Angled toward ':''}${side} — Face ${face.id.slice(5)}`;
}
/** A real triangle interior, never a face centroid that might lie inside a hole. */
export function faceReference(catalog:CadFaceCatalog,face:CadFace):CadFaceReference {
  let best=-1,point:[number,number,number]=[0,0,0];
  for(let i=0;i<face.indices.length;i+=3){
    const v=face.indices.slice(i,i+3).map(index=>face.positions.slice(index*3,index*3+3));
    const a=v[1].map((x,j)=>x-v[0][j]),b=v[2].map((x,j)=>x-v[0][j]);
    const area=Math.hypot(a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]);
    if(area>best){best=area;point=[0,1,2].map(j=>(v[0][j]+v[1][j]+v[2][j])/3) as typeof point;}
  }
  if(best<=0)throw new Error('This face has no reliable picking surface.');
  return {faceId:face.id,sourceSha:catalog.sourceSha,point};
}
export function descendants(entries:AssemblyEntry[],id:string) {
  const ids=new Set([id]);for(const e of entries)if(e.targetId&&ids.has(e.targetId))ids.add(e.id);return ids;
}
/** Unconnected staging preview lies beyond the actual assembly bounds. It is
 * discarded on cancel and replaced by the selected CAD-face mate on Connect. */
export function stagedPanel(entries:AssemblyEntry[],panelId:string,id:string,placement:CadPlacement,gap:number):FaceDraft {
  const root=entries[0],box=placement.bounds[root.id];
  const parking=Math.max(...Object.values(placement.bounds).map(b=>b.max[0]))-box.max[0]+gap;
  const entry:AssemblyEntry={id,label:nextLabel(entries),panelId,myFace:'-X',targetId:root.id,targetFace:'+X',gap:parking};
  return {...beginFaceDraft(entry),fields:{gap:String(gap),u:'0',v:'0',normal:'0',twist:'0'},preview:entry,pick:'reference'};
}
export type PositionValues={u:number;v:number;normal:number};
export function positionValues(entry:AssemblyEntry):PositionValues {
  if(entry.targetId===null){const p=entry.rootOffset??[0,0,0];return {u:p[0],v:p[2],normal:-p[1]};}
  const c=entry.connection;return {u:c?.offsetU??0,v:c?.offsetV??0,normal:c?.normalOffset??0};
}
export function withPosition(entry:AssemblyEntry,p:PositionValues):AssemblyEntry {
  if(!Object.values(p).every(Number.isFinite))throw new Error('Enter finite offsets in mm.');
  if(entry.targetId===null)return {...entry,rootOffset:[p.u,-p.normal,p.v]};
  if(!entry.connection)throw new Error('Select connection faces before moving with the controller.');
  if(entry.gap+p.normal<0)throw new Error('The effective gap cannot be negative.');
  return {...entry,connection:{...entry.connection,offsetU:p.u,offsetV:p.v,normalOffset:p.normal}};
}
export type AssemblyHistory={past:AssemblyEntry[][];future:AssemblyEntry[][]};
export function recordAction(history:AssemblyHistory,current:AssemblyEntry[]):AssemblyHistory {
  return {past:[...history.past,structuredClone(current)].slice(-40),future:[]};
}
