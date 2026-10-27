import * as THREE from 'three';
import { assemblyFaces, type CadEntry, type CadFaceCatalog } from './assembly-cad';
import type { CadFaceReference } from './types';
import type { FaceRole, FaceSelection } from './face-connection-state';
import { faceSide } from './assembly-workspace-state';

/** CAD-face proxies and highlights live outside panel groups, so exports never
 * contain selection geometry. Ray hits identify exact hash-pinned BREP faces. */
export function createAssemblyFacePicker(options:{
  projectId:string;scene:THREE.Scene;camera:THREE.Camera;canvas:HTMLCanvasElement;
  entries:()=>CadEntry[];groups:Map<string,{group:THREE.Group}>;
  onPick:(role:FaceRole,reference:CadFaceReference)=>void;onMessage:(message:string)=>void;
  onSelect:(id:string|null)=>void;onPanelHover:(id:string|null)=>void;
  onCatalog:(catalog:CadFaceCatalog)=>void;blocked:()=>boolean;
}) {
  let selection:FaceSelection|null=null,alive=true,sequence=0;
  const catalogs=new Map<string,{data:CadFaceCatalog;root:THREE.Group;meshes:THREE.Mesh[]}>();
  const pending=new Map<string,Promise<void>>(),abort=new AbortController();
  const visuals=new THREE.Group();options.scene.add(visuals);
  const ray=new THREE.Raycaster(),mouse=new THREE.Vector2();
  let down:{x:number;y:number}|null=null;
  const tooltip=document.createElement('div');tooltip.className='asm-face-tooltip';tooltip.hidden=true;options.canvas.parentElement!.appendChild(tooltip);
  let hover:THREE.Mesh|null=null,hoverKey='';
  function clearHover(){if(hover){options.scene.remove(hover);(hover.material as THREE.Material).dispose();hover=null;}hoverKey='';tooltip.hidden=true;}
  function setRay(event:PointerEvent){const rect=options.canvas.getBoundingClientRect();mouse.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);ray.setFromCamera(mouse,options.camera);}
  function panelHit(){
    const objects=[...options.groups.values()].filter(item=>item.group.visible).map(item=>item.group);
    const hit=ray.intersectObjects(objects,true)[0];let object:THREE.Object3D|null=hit?.object??null;
    while(object&&!object.userData.entryId)object=object.parent;
    return object?.userData.entryId as string|undefined;
  }
  function faceHits(id:string){
    const source=catalogs.get(id),group=options.groups.get(id)?.group;if(!source||!group||!group.visible)return [];
    group.updateMatrixWorld(true);source.root.matrix.copy(group.matrixWorld);source.root.updateMatrixWorld(true);
    return ray.intersectObjects(source.meshes,false);
  }
  const pointerMove=(event:PointerEvent)=>{
    if(options.blocked()||event.buttons){clearHover();return;}
    setRay(event);const id=panelHit();options.onPanelHover(id??null);
    const role=selection?.pick,target=role==='reference'?selection?.referenceEntryId:selection?.movingEntryId;
    if(!role||id!==target){clearHover();return;}
    const hit=faceHits(id!)[0],source=catalogs.get(id!);if(!hit||!source){clearHover();return;}
    const face=source.data.faces.find(f=>f.id===hit.object.userData.faceId)!;
    const key=id+':'+face.id;
    if(key!==hoverKey){clearHover();hoverKey=key;hover=new THREE.Mesh((hit.object as THREE.Mesh).geometry,new THREE.MeshBasicMaterial({color:face.supported?0x70bde0:0xe06a51,transparent:true,opacity:.45,side:THREE.DoubleSide,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}));hover.matrixAutoUpdate=false;hover.matrix.copy(options.groups.get(id!)!.group.matrixWorld);hover.raycast=()=>{};options.scene.add(hover);}
    tooltip.hidden=false;tooltip.textContent=faceSide(face)+(face.supported?' · Click to select':' · Choose a planar face');
    const rect=options.canvas.getBoundingClientRect();tooltip.style.left=Math.max(8,Math.min(rect.width-220,event.clientX-rect.left+14))+'px';tooltip.style.top=Math.max(55,event.clientY-rect.top-35)+'px';
  };
  function clearVisuals(){
    for(const object of [...visuals.children]){
      object.traverse(child=>{
        if(child instanceof THREE.Mesh||child instanceof THREE.Line){
          if(!child.userData.sharedFaceGeometry)child.geometry.dispose();
          for(const material of Array.isArray(child.material)?child.material:[child.material])material.dispose();
        }
      });visuals.remove(object);
    }
  }
  function renderSelection(){
    clearVisuals();if(!selection)return;
    for(const role of ['reference','moving'] as const){
      const entryId=role==='reference'?selection.referenceEntryId:selection.movingEntryId;
      const source=catalogs.get(entryId),group=options.groups.get(entryId)?.group,reference=selection[role];
      if(!source||!group||!group.visible||!reference||source.data.sourceSha!==reference.sourceSha)continue;
      group.updateMatrixWorld(true);
      const index=source.data.faces.findIndex(face=>face.id===reference.faceId);if(index<0)continue;
      const face=source.data.faces[index];
      const mesh=new THREE.Mesh(source.meshes[index].geometry,new THREE.MeshBasicMaterial({color:role==='reference'?0x2788ee:0xffa336,opacity:.42,transparent:true,side:THREE.DoubleSide,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1}));
      mesh.userData.sharedFaceGeometry=true;mesh.matrixAutoUpdate=false;mesh.matrix.copy(group.matrixWorld);mesh.renderOrder=2;mesh.raycast=()=>{};visuals.add(mesh);
      if(role==='reference'&&face.normal&&face.u&&face.v){
        const origin=new THREE.Vector3(...reference.point).multiplyScalar(.001).applyMatrix4(group.matrixWorld);
        const size=new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3()).length()*.08;
        for(const [vector,color] of [[face.u,0xed4545],[face.v,0x25a665],[face.normal,0x2377e5]] as const){
          const direction=new THREE.Vector3(...vector).transformDirection(group.matrixWorld);
          const arrow=new THREE.ArrowHelper(direction,origin,Math.max(.008,size),color);
          // ArrowHelper shares global geometries; own copies can be disposed.
          arrow.line.geometry=arrow.line.geometry.clone();arrow.cone.geometry=arrow.cone.geometry.clone();visuals.add(arrow);
        }
      }
    }
  }
  async function load(id:string){
    if(catalogs.has(id))return;
    if(pending.has(id))return pending.get(id);
    const entry=options.entries().find(entry=>entry.id===id);
    if(!entry)throw new Error('The selected assembly entry is unavailable.');
    const promise=assemblyFaces(options.projectId,entry,abort.signal).then(data=>{
      if(!alive)return;
      if(data.units!=='mm'||data.entryId!==id)throw new Error('CAD face catalog does not match this panel.');
      const root=new THREE.Group(),meshes=data.faces.map(face=>{
        const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(face.positions.map(value=>value/1000),3));geometry.setIndex(face.indices);
        const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));mesh.userData.faceId=face.id;root.add(mesh);return mesh;
      });root.matrixAutoUpdate=false;catalogs.set(id,{data,root,meshes});options.onCatalog(data);
    }).finally(()=>pending.delete(id));
    pending.set(id,promise);return promise;
  }
  async function update(next:FaceSelection|null){
    selection=next;clearHover();const version=++sequence;renderSelection();if(!next)return;
    try{
      await Promise.all([load(next.referenceEntryId),load(next.movingEntryId)]);
      if(!alive||version!==sequence)return;
      renderSelection();
    }catch(error){if(alive&&version===sequence&&!abort.signal.aborted)options.onMessage((error as Error).message);}
  }
  const pointerDown=(event:PointerEvent)=>{down=event.button===0&&!options.blocked()?{x:event.clientX,y:event.clientY}:null;};
  const pointerUp=(event:PointerEvent)=>{
    const start=down;down=null;
    if(options.blocked()||!start||Math.hypot(event.clientX-start.x,event.clientY-start.y)>5)return;
    setRay(event);
    if(!selection?.pick){options.onSelect(panelHit()??null);return;}
    const role=selection.pick,id=role==='reference'?selection.referenceEntryId:selection.movingEntryId;
    const source=catalogs.get(id),group=options.groups.get(id)?.group;
    if(!source||!group){options.onMessage('Loading CAD faces. Try the face again in a moment.');return;}
    if(panelHit()!==id){options.onMessage('Click the requested panel, or orbit to expose its connection surface.');return;}
    const hits=faceHits(id),hit=hits[0];
    if(!hit){options.onMessage('No CAD face at this point. Click inside the selected panel surface.');return;}
    if(hits.some(other=>other.object.userData.faceId!==hit.object.userData.faceId&&Math.abs(other.distance-hit.distance)<1e-6)){
      options.onMessage('This point touches more than one CAD face. Click inside a single surface, away from its boundary.');return;
    }
    const face=source.data.faces.find(face=>face.id===hit.object.userData.faceId)!;
    if(!face.supported){options.onMessage(`${face.type} surface: a constant-gap connection needs a planar face. Pick a planar flange or surface.`);return;}
    const point=hit.point.clone().applyMatrix4(group.matrixWorld.clone().invert()).multiplyScalar(1000);
    options.onPick(role,{faceId:face.id,sourceSha:source.data.sourceSha,point:point.toArray()});
  };
  options.canvas.addEventListener('pointermove',pointerMove);options.canvas.addEventListener('pointerleave',clearHover);options.canvas.addEventListener('pointerdown',pointerDown);options.canvas.addEventListener('pointerup',pointerUp);
  return {update,refresh:renderSelection,dispose(){
    alive=false;abort.abort();clearHover();tooltip.remove();clearVisuals();options.scene.remove(visuals);
    options.canvas.removeEventListener('pointermove',pointerMove);options.canvas.removeEventListener('pointerleave',clearHover);options.canvas.removeEventListener('pointerdown',pointerDown);options.canvas.removeEventListener('pointerup',pointerUp);
    for(const source of catalogs.values())for(const mesh of source.meshes){mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();}
    catalogs.clear();
  }};
}
