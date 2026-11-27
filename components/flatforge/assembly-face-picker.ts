import * as THREE from 'three';
import { assemblyFaces, type CadEntry, type CadEdge, type CadFace, type CadFaceCatalog } from './assembly-cad';
import type { CadFaceReference,AssemblySide } from './types';
import type { FaceRole, FaceSelection } from './face-connection-state';
import { CONTACT_COLORS, faceContact, type ContactState, type FacePair } from './face-contact';
import { matchHoles, panelHoles, type Hole } from './hole-match';

/** CAD-face proxies and highlights live outside panel groups, so exports never
 * contain selection geometry. Ray hits identify exact hash-pinned BREP faces. */
/** How the selected panel's holes sit on the nearest other panel. */
export type HoleReport={entryId:string;otherId:string;matched:number;inside:number;move:number[]|null};

export function createAssemblyFacePicker(options:{
  projectId:string;scene:THREE.Scene;camera:THREE.Camera;canvas:HTMLCanvasElement;
  entries:()=>CadEntry[];groups:Map<string,{group:THREE.Group}>;
  onPick:(role:FaceRole,reference:CadFaceReference,entryId:string)=>void;onMessage:(message:string)=>void;
  onSelect:(id:string|null)=>void;onPanelHover:(id:string|null)=>void;
  onCatalog:(catalog:CadFaceCatalog)=>void;blocked:()=>boolean;
  /** True when the latest press turned the view, even if the pointer came back to its start. */
  dragged?:()=>boolean;
  onHoles?:(report:HoleReport|null)=>void;
}) {
  let sideHover:{id:string;side:AssemblySide}|null=null;
  let selection:FaceSelection|null=null,alive=true,sequence=0,pickRevision=0;
  const catalogs=new Map<string,{data:CadFaceCatalog;root:THREE.Group;meshes:THREE.Mesh[]}>();
  const pending=new Map<string,Promise<void>>(),abort=new AbortController();
  const visuals=new THREE.Group();options.scene.add(visuals);
  const ray=new THREE.Raycaster(),mouse=new THREE.Vector2();
  let down:{x:number;y:number}|null=null;
  let pairs:FacePair[]=[];const outlines=new Map<THREE.BufferGeometry,THREE.EdgesGeometry>();
  let focus:string|null=null,reported='null';const holes=new Map<string,Hole[]>();
  function edgeLine(edge:CadEdge,group:THREE.Group,color:number){
    const geometry=new THREE.BufferGeometry().setFromPoints([edge.a,edge.b].map(p=>new THREE.Vector3(...p).multiplyScalar(.001)));
    const line=new THREE.Line(geometry,new THREE.LineBasicMaterial({color,depthTest:false}));
    line.matrixAutoUpdate=false;line.matrix.copy(group.matrixWorld);line.renderOrder=4;line.raycast=()=>{};return line;
  }
  // Pick only trimmed LINE edges on the visible support face. Pixel tolerance
  // stays constant as the camera zooms; the saved point comes from the CAD line.
  function nearestEdge(face:CadFace,group:THREE.Group){
    const rect=options.canvas.getBoundingClientRect();
    const hits=(face.edges??[]).flatMap(edge=>{
      const [a,b]=[edge.a,edge.b].map(p=>new THREE.Vector3(...p).multiplyScalar(.001).applyMatrix4(group.matrixWorld));
      const q=new THREE.Vector3();ray.ray.distanceSqToSegment(a,b,undefined,q);
      const screen=q.clone().project(options.camera);
      if(screen.z< -1||screen.z>1)return [];
      const distance=Math.hypot((screen.x-mouse.x)*rect.width/2,(screen.y-mouse.y)*rect.height/2);
      return distance<=8?[{edge,distance,point:q.applyMatrix4(group.matrixWorld.clone().invert()).multiplyScalar(1000)}]:[];
    }).sort((a,b)=>a.distance-b.distance);
    return hits.length>1&&hits[1].distance-hits[0].distance<.5?undefined:hits[0];
  }
  let hover:THREE.Mesh|THREE.Line|null=null,hoverKey='';
  function clearHover(){if(hover){options.scene.remove(hover);if(hover instanceof THREE.Line)hover.geometry.dispose();(hover.material as THREE.Material).dispose();hover=null;}hoverKey='';}
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
    if(!role||!id||!selection?.anyPanel&&id!==target){clearHover();return;}
    if(!catalogs.get(id)?.data.faces.length){void load(id).catch(error=>options.onMessage((error as Error).message));clearHover();return;}
    const allowed=selection?.allowed?.[role];
    const hit=faceHits(id!)[0],source=catalogs.get(id!);if(!hit||!source||allowed&&!allowed.includes(hit.object.userData.faceId)){clearHover();return;}
    const face=source.data.faces.find(f=>f.id===hit.object.userData.faceId)!;
    const candidate=selection?.geometry==='edge'?nearestEdge(face,options.groups.get(id)!.group):undefined;
    if(selection?.geometry==='edge'&&!candidate){clearHover();return;}
    const key=id+':'+face.id+':'+(candidate?.edge.id??'');
    if(key!==hoverKey){clearHover();hoverKey=key;hover=candidate?edgeLine(candidate.edge,options.groups.get(id)!.group,0x008dd2):new THREE.Mesh((hit.object as THREE.Mesh).geometry,new THREE.MeshBasicMaterial({color:face.supported?0xffd9ae:0xe06a51,transparent:true,opacity:.45,side:THREE.DoubleSide,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}));hover.matrixAutoUpdate=false;hover.matrix.copy(options.groups.get(id!)!.group.matrixWorld);hover.raycast=()=>{};options.scene.add(hover);}
  };
  function clearVisuals(){
    for(const object of [...visuals.children]){
      object.traverse(child=>{
        if(child instanceof THREE.Mesh||child instanceof THREE.Line||child instanceof THREE.Points){
          if(!child.userData.sharedFaceGeometry)child.geometry.dispose();
          for(const material of Array.isArray(child.material)?child.material:[child.material])material.dispose();
        }
      });visuals.remove(object);
    }
  }
  /** A face of a loaded panel at its current position, or nothing if it cannot be shown. */
  function placedFace(end:FacePair['moving']){
    const source=catalogs.get(end.entryId),group=options.groups.get(end.entryId)?.group;
    if(!source||!group?.visible||source.data.sourceSha!==end.face.sourceSha)return null;
    const index=source.data.faces.findIndex(face=>face.id===end.face.faceId),face=source.data.faces[index];
    if(!face?.normal)return null;
    group.updateMatrixWorld(true);
    const point=new THREE.Vector3(),points:number[][]=[];
    for(let i=0;i<face.positions.length;i+=3)points.push(point.fromArray(face.positions,i).multiplyScalar(.001).applyMatrix4(group.matrixWorld).multiplyScalar(1000).toArray());
    const box=new THREE.Box3().setFromObject(group);
    return {geometry:source.meshes[index].geometry,group,points,normal:new THREE.Vector3(...face.normal).transformDirection(group.matrixWorld).toArray(),
      box:{min:box.min.multiplyScalar(1000).toArray(),max:box.max.multiplyScalar(1000).toArray()}};
  }
  /** The panel's holes where it stands now, in world millimetres. */
  function placedHoles(id:string){
    const source=catalogs.get(id),group=options.groups.get(id)?.group;
    if(!source?.data.faces.length||!group?.visible)return null;
    let own=holes.get(id);if(!own){own=panelHoles(source.data.faces);holes.set(id,own);}
    group.updateMatrixWorld(true);
    return own.map(hole=>({half:hole.half,faces:hole.faces,axis:new THREE.Vector3(...hole.axis as [number,number,number]).transformDirection(group.matrixWorld).toArray(),
      centre:new THREE.Vector3(...hole.centre as [number,number,number]).multiplyScalar(.001).applyMatrix4(group.matrixWorld).multiplyScalar(1000).toArray()}));
  }
  /** Colours the faces fastened through lined-up holes, and returns the state for each such panel. */
  function renderHoles(){
    const states=new Map<string,ContactState>();let report:HoleReport|null=null;
    const group=focus?options.groups.get(focus)?.group:undefined;
    if(focus&&group){
      const near=new THREE.Box3().setFromObject(group).expandByScalar(.05);
      for(const [id,item] of options.groups){
        if(id===focus||!near.intersectsBox(new THREE.Box3().setFromObject(item.group)))continue;
        // Face meshes are fetched once, the first time two panels come close.
        const missing=[focus,id].filter(panel=>!catalogs.get(panel)?.data.faces.length);
        if(missing.length){for(const panel of missing)if(!pending.has(panel))void load(panel).then(()=>{if(alive)renderSelection();}).catch(error=>{if(alive&&!abort.signal.aborted)options.onMessage((error as Error).message);});continue;}
        const moving=placedHoles(focus),target=placedHoles(id);if(!moving||!target)continue;
        const found=matchHoles(moving,target);
        if(found.inside.length)states.set(id,'inside');else if(found.matched.length)states.set(id,'matched');
        // The whole face around the holes takes the colour, on both panels.
        for(const state of ['inside','matched'] as const){
          for(const [panel,own,list] of [[focus,moving,found[state]],[id,target,found.onto[state]]] as const){
            const source=catalogs.get(panel)!,owner=options.groups.get(panel)!.group;
            for(const index of new Set(list.flatMap(i=>own[i].faces)))paintFace(source.meshes[index].geometry,owner,state,{holes:state,entryId:panel,faceId:source.data.faces[index].id});
          }
        }
        const seated=found.matched.length+found.inside.length,best=report?report.matched+report.inside:-1;
        if(found.move&&(seated>best||seated===best&&Math.hypot(...found.move)<Math.hypot(...report?.move??[Infinity])))
          report={entryId:focus,otherId:id,matched:found.matched.length,inside:found.inside.length,move:found.move.map(v=>Math.round(v*10)/10||0)};
      }
    }
    const text=JSON.stringify(report);
    if(text!==reported){reported=text;options.onHoles?.(report);}
    return states;
  }
  /** A whole face in a light, see-through colour, drawn on top because joined faces cover each other. */
  function paintFace(geometry:THREE.BufferGeometry,group:THREE.Group,state:ContactState,userData:Record<string,unknown>){
    let outline=outlines.get(geometry);if(!outline){outline=new THREE.EdgesGeometry(geometry,20);outlines.set(geometry,outline);}
    // The stencil paints each pixel once, so faces lying on each other stay equally see-through.
    const fill=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color:CONTACT_COLORS[state],transparent:true,opacity:.6,side:THREE.DoubleSide,depthTest:false,depthWrite:false,toneMapped:false,
      stencilWrite:true,stencilRef:1,stencilFunc:THREE.NotEqualStencilFunc,stencilZPass:THREE.ReplaceStencilOp}));
    const edge=new THREE.LineSegments(outline,new THREE.LineBasicMaterial({color:CONTACT_COLORS[state],transparent:true,depthTest:false,depthWrite:false,toneMapped:false}));
    group.updateMatrixWorld(true);
    for(const object of [fill,edge]){object.userData={sharedFaceGeometry:true,...userData};object.matrixAutoUpdate=false;object.matrix.copy(group.matrixWorld);object.renderOrder=5;object.raycast=()=>{};visuals.add(object);}
  }
  /** Colours both faces of each pair by how they sit now. */
  function renderPairs(holeStates:Map<string,ContactState>){
    for(const pair of pairs){
      const moving=placedFace(pair.moving),target=placedFace(pair.target);if(!moving||!target)continue;
      // Panels fastened through lined-up holes are matched even where the picked faces sit apart.
      const other=pair.moving.entryId===focus?pair.target.entryId:pair.target.entryId===focus?pair.moving.entryId:null;
      const state=pair.force??(other?holeStates.get(other):undefined)??faceContact(moving,target,{moving:moving.box,target:target.box});
      for(const end of [moving,target])paintFace(end.geometry,end.group,state,{contact:state,entryId:end===moving?pair.moving.entryId:pair.target.entryId});
    }
  }
  function renderSelection(){
    clearVisuals();
    renderPairs(renderHoles());
    if(sideHover){const source=catalogs.get(sideHover.id),group=options.groups.get(sideHover.id)?.group;
     if(source&&group?.visible)for(const region of source.data.sides?.[sideHover.side].candidates??[]){const meshSource=source.meshes.find(m=>m.userData.faceId===region.faceId);if(!meshSource)continue;const mesh=new THREE.Mesh(meshSource.geometry,new THREE.MeshBasicMaterial({color:0x2788ee,transparent:true,opacity:.45,side:THREE.DoubleSide,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}));mesh.userData.sharedFaceGeometry=true;mesh.matrixAutoUpdate=false;mesh.matrix.copy(group.matrixWorld);mesh.raycast=()=>{};visuals.add(mesh);}
    }
    if(!selection)return;
    if(selection.pick){
     const role=selection.pick,id=role==='reference'?selection.referenceEntryId:selection.movingEntryId,source=catalogs.get(id),group=options.groups.get(id)?.group;
     if(source&&group?.visible)for(const id of selection.allowed?.[role]??[]){
      const index=source.data.faces.findIndex(f=>f.id===id);if(index<0)continue;
      const mesh=new THREE.Mesh(source.meshes[index].geometry,new THREE.MeshBasicMaterial({color:0x71b5db,opacity:.32,transparent:true,side:THREE.DoubleSide,depthWrite:false}));
      mesh.userData.sharedFaceGeometry=true;mesh.matrixAutoUpdate=false;mesh.matrix.copy(group.matrixWorld);mesh.raycast=()=>{};visuals.add(mesh);
     }
    }
    for(const role of ['reference','moving'] as const){
      const entryId=role==='reference'?selection.referenceEntryId:selection.movingEntryId;
      const source=catalogs.get(entryId),group=options.groups.get(entryId)?.group,reference=selection[role];
      if(!source||!group||!group.visible||!reference||source.data.sourceSha!==reference.sourceSha)continue;
      group.updateMatrixWorld(true);
      const index=source.data.faces.findIndex(face=>face.id===reference.faceId);if(index<0)continue;
      const face=source.data.faces[index];
      if(reference.edgeId){
        const edge=face.edges?.find(e=>e.id===reference.edgeId);
        if(edge)visuals.add(edgeLine(edge,group,role==='reference'?0x0079dd:0xe88700));
        continue;
      }
      const mesh=new THREE.Mesh(source.meshes[index].geometry,new THREE.MeshBasicMaterial({color:CONTACT_COLORS.joining,opacity:.85,toneMapped:false,transparent:true,side:THREE.DoubleSide,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1}));
      mesh.userData.sharedFaceGeometry=true;mesh.matrixAutoUpdate=false;mesh.matrix.copy(group.matrixWorld);mesh.renderOrder=2;mesh.raycast=()=>{};visuals.add(mesh);
      if(role==='reference'&&selection.alignment!=='top'&&face.normal&&face.u&&face.v){
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
  async function load(id:string,meshes=true):Promise<void>{
    if(catalogs.has(id)&&(!meshes||catalogs.get(id)!.data.faces.length))return;
    if(pending.has(id)){await pending.get(id);return load(id,meshes);}
    const entry=options.entries().find(entry=>entry.id===id);
    if(!entry)throw new Error('The selected assembly entry is unavailable.');
    const promise=assemblyFaces(options.projectId,entry,abort.signal,meshes).then(data=>{
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
    if(JSON.stringify(next)!==JSON.stringify(selection))pickRevision++;
    selection=next;clearHover();const version=++sequence;renderSelection();if(!next)return;
    try{
      await Promise.all([next.referenceEntryId,next.movingEntryId].filter(Boolean).map(id=>load(id)));
      if(!alive||version!==sequence)return;
      renderSelection();
    }catch(error){if(alive&&version===sequence&&!abort.signal.aborted)options.onMessage((error as Error).message);}
  }
  const pointerDown=(event:PointerEvent)=>{down=event.button===0&&!options.blocked()?{x:event.clientX,y:event.clientY}:null;};
  const pointerUp=async(event:PointerEvent)=>{
    const start=down;down=null;
    if(options.blocked()||options.dragged?.()||!start||Math.hypot(event.clientX-start.x,event.clientY-start.y)>5)return;
    setRay(event);
    if(!selection?.pick){options.onSelect(panelHit()??null);return;}
    const role=selection.pick,id=selection.anyPanel?panelHit():(role==='reference'?selection.referenceEntryId:selection.movingEntryId);
    if(!id)return;
    const selectionKey=JSON.stringify(selection),revision=pickRevision;
    if(!catalogs.get(id)?.data.faces.length){
      options.onMessage('Loading the selected CAD face…');
      try{await load(id);}catch(error){if(alive)options.onMessage((error as Error).message);return;}
      if(!alive||options.blocked()||revision!==pickRevision||JSON.stringify(selection)!==selectionKey)return;
      setRay(event);
    }
    const source=catalogs.get(id),group=options.groups.get(id)?.group;
    if(!source||!group)return;
    if(panelHit()!==id){options.onMessage('Click the requested panel, or orbit to expose its connection surface.');return;}
    const allowed=selection.allowed?.[role];
    const hits=faceHits(id),hit=hits[0];
    if(!hit||allowed&&!allowed.includes(hit.object.userData.faceId)){options.onMessage('Choose a highlighted region on the selected side.');return;}
    if(hits.some(other=>other.object.userData.faceId!==hit.object.userData.faceId&&Math.abs(other.distance-hit.distance)<1e-6)){
      options.onMessage(selection.geometry==='edge'?'This edge borders two faces. Click just inside the flange that defines the gap direction.':'This point touches more than one CAD face. Click inside a single surface, away from its boundary.');return;
    }
    const face=source.data.faces.find(face=>face.id===hit.object.userData.faceId)!;
    if(!face.supported){options.onMessage(`${face.type} surfaces cannot be connected. Click a flat face.`);return;}
    if(selection?.geometry==='edge'){
      const candidate=nearestEdge(face,group);
      if(!candidate){options.onMessage('Click closer to a straight edge on this planar face, away from a shared corner.');return;}
      options.onPick(role,{faceId:face.id,edgeId:candidate.edge.id,sourceSha:source.data.sourceSha,point:candidate.point.toArray()},id);return;
    }
    const point=hit.point.clone().applyMatrix4(group.matrixWorld.clone().invert()).multiplyScalar(1000);
    options.onPick(role,{faceId:face.id,sourceSha:source.data.sourceSha,point:point.toArray()},id);
  };
  options.canvas.addEventListener('pointermove',pointerMove);options.canvas.addEventListener('pointerleave',clearHover);options.canvas.addEventListener('pointerdown',pointerDown);options.canvas.addEventListener('pointerup',pointerUp);
  function setPairs(next:FacePair[]){
    if(JSON.stringify(next)===JSON.stringify(pairs))return;
    pairs=next;renderSelection();
    for(const id of new Set(next.flatMap(pair=>[pair.moving.entryId,pair.target.entryId])))
      void load(id).then(()=>{if(alive)renderSelection();}).catch(error=>{if(alive&&!abort.signal.aborted)options.onMessage((error as Error).message);});
  }
  /** The selected panel, whose holes are compared with its neighbours'. */
  function setFocus(id:string|null){if(id===focus)return;focus=id;renderSelection();}
  return {update,setPairs,setFocus,async loadAll(){for(const entry of options.entries()){if(!alive)return;try{await load(entry.id,false);}catch(error){if(alive&&!abort.signal.aborted)options.onMessage((error as Error).message);}}},highlightSide(id:string|null,side:AssemblySide|null){sideHover=id&&side?{id,side}:null;renderSelection();if(id)void load(id).then(()=>{if(alive)renderSelection();}).catch(()=>{});},refresh:renderSelection,dispose(){
    alive=false;abort.abort();clearHover();clearVisuals();options.scene.remove(visuals);
    options.canvas.removeEventListener('pointermove',pointerMove);options.canvas.removeEventListener('pointerleave',clearHover);options.canvas.removeEventListener('pointerdown',pointerDown);options.canvas.removeEventListener('pointerup',pointerUp);
    for(const source of catalogs.values())for(const mesh of source.meshes){mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();}
    for(const outline of outlines.values())outline.dispose();
    outlines.clear();
    catalogs.clear();
  }};
}
