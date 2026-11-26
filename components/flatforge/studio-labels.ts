import * as THREE from 'three';
import { assemblyFaces, type CadEntry, type CadFaceCatalog } from './assembly-cad';
import { createAssemblyLabels } from './assembly-labels';
import { type AssemblyEntry, type AssemblySide, type Panel } from './types';

export type FaceInfo={title:string;detail:string};
const SIDES=['left','right','top','bottom'] as const;
const sideName=(side:AssemblySide)=>side[0].toUpperCase()+side.slice(1)+' side';

/** Side and face names for the single-panel 3D Studio. Faces come from the
 * same CAD catalog the assembly uses, so "face-32" means the same face in both. */
export async function createStudioLabels(options:{panel:Panel;scene:THREE.Scene;camera:THREE.Camera;host:HTMLElement;model:THREE.Group;signal:AbortSignal;onPick:(info:FaceInfo|null)=>void}){
 const {panel,model,scene}=options;
 const catalog:CadFaceCatalog=await assemblyFaces(panel.project_id,{id:panel.id,panelId:panel.id,revision:panel.revision} as CadEntry,options.signal);
 if(options.signal.aborted)return null;

 const proxies=catalog.faces.map(face=>{
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(face.positions.map(v=>v*.001),3));
  geometry.setIndex(face.indices);
  const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
  mesh.matrixAutoUpdate=false;mesh.userData.faceId=face.id;return mesh;
 });
 const highlight=new THREE.Group();scene.add(highlight);
 function clear(){for(const child of [...highlight.children]){((child as THREE.Mesh).material as THREE.Material).dispose();highlight.remove(child);}}
 function show(faceIds:string[]){
  clear();model.updateMatrixWorld(true);
  for(const proxy of proxies)if(faceIds.includes(proxy.userData.faceId)){
   const mesh=new THREE.Mesh(proxy.geometry,new THREE.MeshBasicMaterial({color:0x2788ee,transparent:true,opacity:.5,side:THREE.DoubleSide,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}));
   mesh.matrixAutoUpdate=false;mesh.matrix.copy(model.matrixWorld);highlight.add(mesh);
  }
 }
 const sideFaces=(side:AssemblySide)=>catalog.sides?.[side]?.candidates.map(c=>c.faceId)??[];
 let chosen:string[]=[];
 const labels=createAssemblyLabels({host:options.host,camera:options.camera,
  groups:new Map([[panel.id,{group:model,localBounds:new THREE.Box3().setFromObject(model)}]]),
  entries:()=>[{id:panel.id,panelId:panel.id} as AssemblyEntry],active:()=>panel.id,sidesOnly:true,
  onSelect:()=>{},
  onSide:(_,side)=>{chosen=sideFaces(side);show(chosen);options.onPick({title:sideName(side),detail:chosen.join(', ')});},
  onSideHover:(_,side)=>show(side?sideFaces(side):chosen)});
 labels.setCatalog(catalog);

 return {
  /** Names the CAD face under the ray, or clears the selection on a miss. */
  pick(ray:THREE.Raycaster){
   model.updateMatrixWorld(true);
   for(const proxy of proxies){proxy.matrix.copy(model.matrixWorld);proxy.updateMatrixWorld(true);}
   const id=ray.intersectObjects(proxies,false)[0]?.object.userData.faceId as string|undefined;
   chosen=id?[id]:[];show(chosen);
   if(!id){options.onPick(null);return;}
   const side=SIDES.find(s=>sideFaces(s).includes(id));
   options.onPick({title:side?sideName(side):'Face '+id.slice(5),detail:id});
  },
  clear(){chosen=[];clear();},
  update(){highlight.visible=model.visible;labels.update();},
  dispose(){clear();scene.remove(highlight);labels.dispose();for(const proxy of proxies){proxy.geometry.dispose();(proxy.material as THREE.Material).dispose();}},
 };
}
