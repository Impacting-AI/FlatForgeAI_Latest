import * as THREE from 'three';
import type { AssemblyEntry,AssemblySide } from './types';
import type {CadFaceCatalog} from './assembly-cad';
import { alphabeticLabel } from './assembly-workspace-state';

/** Candidate points are actual triangle interiors in panel-local metres. No
 * bounding-box corner, screen clamp, or collision displacement can detach them. */
export function surfaceLabelAnchors(group:THREE.Group){
 group.updateMatrixWorld(true);const inverse=group.matrixWorld.clone().invert();
 const candidates:{point:THREE.Vector3;area:number}[]=[];
 group.traverse(object=>{if(!(object instanceof THREE.Mesh))return;const geometry=object.geometry,positions=geometry.getAttribute('position'),index=geometry.index;if(!positions)return;if(!geometry.boundingBox)geometry.computeBoundingBox();
  const matrix=inverse.clone().multiply(object.matrixWorld),count=index?.count??positions.count;
  for(let i=0;i+2<count;i+=3){const v=[0,1,2].map(j=>new THREE.Vector3().fromBufferAttribute(positions,index?index.getX(i+j):i+j).applyMatrix4(matrix));
   const area=v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0])).length();if(area>1e-14)candidates.push({point:v[0].add(v[1]).add(v[2]).multiplyScalar(1/3),area});
  }
 });
 return candidates.sort((a,b)=>b.area-a.area).slice(0,24).map(c=>c.point);
}

export function createAssemblyLabels(options:{host:HTMLElement;camera:THREE.Camera;groups:Map<string,{group:THREE.Group;localBounds:THREE.Box3}>;
 entries:()=>AssemblyEntry[];active:()=>string|null;onSelect:(id:string)=>void;onSide:(id:string,side:AssemblySide)=>void;onSideHover:(id:string|null,side:AssemblySide|null)=>void}){
 const layer=document.createElement('div');layer.className='asm-model-labels';options.host.appendChild(layer);
 let selectedSide:{id:string;side:AssemblySide}|null=null;
 const restoreHighlight=()=>options.onSideHover(selectedSide?.id??null,selectedSide?.side??null);
 const catalogs=new Map<string,CadFaceCatalog>(),anchors=new Map<string,THREE.Vector3[]>();
 const chosenPoints=new Map<string,THREE.Vector3>();
 const labels=new Map<string,{button:HTMLButtonElement;id:string;side?:AssemblySide}>();
 function button(id:string,side?:AssemblySide){const key=id+':'+(side??'panel');if(labels.has(key))return;
  const node=document.createElement('button');node.type='button';node.className=side?'asm-model-label asm-side-label':'asm-model-label';node.dataset.panelId=id;if(side)node.dataset.side=side;
  node.onclick=()=>{selectedSide=side?{id,side}:null;restoreHighlight();if(side)options.onSide(id,side);else options.onSelect(id);};
  if(side){node.onpointerenter=()=>options.onSideHover(id,side);node.onpointerleave=restoreHighlight;node.onfocus=()=>options.onSideHover(id,side);node.onblur=restoreHighlight;}
  node.hidden=true;layer.appendChild(node);labels.set(key,{button:node,id,side});
 }
 for(const e of options.entries()){button(e.id);const item=options.groups.get(e.id);if(item)anchors.set(e.id,surfaceLabelAnchors(item.group));}
 const ray=new THREE.Raycaster(),cameraPoint=new THREE.Vector3(),world=new THREE.Vector3();
 let last=0;
 function update(){
  const now=performance.now();if(now-last<60)return;last=now;
  const width=options.host.clientWidth,height=options.host.clientHeight,active=options.active(),entries=options.entries();
  if(selectedSide&&selectedSide.id!==active){selectedSide=null;restoreHighlight();}
  options.camera.getWorldPosition(cameraPoint);
  const objects=[...options.groups.values()].filter(i=>i.group.visible).map(i=>i.group);
  const occupied:{x:number;y:number;w:number;h:number}[]=[];
  const ordered=[...labels.values()].sort((a,b)=>Number(!!a.side)-Number(!!b.side)||Number(b.id===active)-Number(a.id===active));
  for(const {button:node,id,side} of ordered){
   const entry=entries.find(e=>e.id===id),item=options.groups.get(id);if(!entry||!item?.group.visible){node.hidden=true;continue;}
   const label=`Panel ${entry.label??alphabeticLabel(entries.indexOf(entry))}`;
   const region=side?catalogs.get(id)?.sides?.[side]:null;
   const text=side?side[0].toUpperCase()+side.slice(1):label;
   if(node.textContent!==text)node.textContent=text;node.setAttribute('aria-label',side?`${label} ${text} side`:`Select ${label}`);node.dataset.activePanel=String(id===active);node.setAttribute('aria-pressed',String(side?selectedSide?.id===id&&selectedSide.side===side:id===active));
   node.title=side&&region&&!region.automatic?`${text}: choose one of ${region.candidates.length} connection regions`:label+(side?' · '+text:'');
   let points=side?(region?.candidates??[]).flatMap(c=>(c.labelPoints?.length?c.labelPoints:[c.point]).map(point=>new THREE.Vector3(...point).multiplyScalar(.001))):anchors.get(id)??[];
   const labelKey=id+':'+(side??'panel'),previous=chosenPoints.get(labelKey);
   if(previous)points=[previous,...points.filter(p=>p.distanceToSquared(previous)>1e-18)];
   let found=false;
   for(const point of points){
    world.copy(point).applyMatrix4(item.group.matrixWorld);const projected=world.clone().project(options.camera);
    if(projected.z< -1||projected.z>1)continue;
    const x=(projected.x+1)*width/2,y=(1-projected.y)*height/2,w=side?48:74,h=side?20:25;
    if(x-w/2<3||x+w/2>width-3||y-h/2<3||y+h/2>height-3||occupied.some(o=>Math.abs(o.x-x)<(o.w+w)/2+3&&Math.abs(o.y-y)<(o.h+h)/2+3))continue;
    ray.setFromCamera(new THREE.Vector2(projected.x,projected.y),options.camera);
    ray.far=ray.ray.origin.distanceTo(world)+.00008;
    const hit=ray.intersectObjects(objects,true)[0];if(!hit||hit.point.distanceTo(world)>.00008)continue;
    node.style.transform=`translate(${x}px,${y}px) translate(-50%,-50%)`;node.dataset.anchor=point.toArray().join(',');node.hidden=false;chosenPoints.set(labelKey,point);occupied.push({x,y,w,h});found=true;break;
   }
   if(!found)node.hidden=true;
  }
 }
 return {update,setCatalog(catalog:CadFaceCatalog){catalogs.set(catalog.entryId,catalog);for(const side of ['left','right','top','bottom'] as const)if(catalog.sides?.[side].candidates.length)button(catalog.entryId,side);last=0;},dispose(){options.onSideHover(null,null);layer.remove();}};
}
