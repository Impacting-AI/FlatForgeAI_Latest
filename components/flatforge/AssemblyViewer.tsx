'use client';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Camera, LoaderCircle, Box, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AssemblyEntry, Panel, fileUrl } from './types';
import { assemblyModel, assemblyPlacements, assemblyMatrix, assemblyRotation } from './assembly-geometry';
import { placeAssembly, cadEntries, checkAssembly, downloadAssemblyStep, type CadCheck, type CadEntry, type CadFaceCatalog, type CadPlacement } from './assembly-cad';

import { createAssemblyFacePicker } from './assembly-face-picker';
import type { FaceRole, FaceSelection } from './face-connection-state';
import type { CadFaceReference,AssemblySide } from './types';
import { createAssemblyGizmo } from './assembly-gizmo';
import { createAssemblyLabels } from './assembly-labels';
import { positionValues, type PositionValues } from './assembly-workspace-state';
import { prepareInspectionModel, applyInspectionAppearance, configureInspectionRenderer, prepareInspectionGrid, inspectionLighting } from './inspection-presentation';

// ── Public types ──────────────────────────────────────────────────────────────
export type AssemblyViewerHandle = {fit:(view?:string)=>void};

type Props = {
 sideSelectionMode?:boolean;sideTargets?:{id:string;side:AssemblySide;role:'from'|'to'}[];
 insertId?:string;insertBranchId?:string;onSideSelected?:(id:string,side:AssemblySide)=>void;
 projectId: string;
 live: boolean;
 entries: AssemblyEntry[];
 panels: Panel[];
 paint: boolean;
 wire: boolean;
 onReadyChange: (ready:boolean) => void;
 children?:ReactNode;activeId?:string|null;hiddenIds?:string[];moving?:boolean;moveGroup?:boolean;
 onSelect?:(id:string|null)=>void;onMove?:(values:PositionValues)=>void;onDrag?:(active:boolean)=>void;
 onCatalog?:(catalog:CadFaceCatalog)=>void;onPlaced?:(placement:CadPlacement)=>void;
 selection?:FaceSelection|null;
 previewOnly?:boolean;
 onFacePicked?:(role:FaceRole,face:CadFaceReference)=>void;
 onFaceMessage?:(message:string)=>void;
 onValidation?:(result:{key:string;valid:boolean;token:string|null})=>void;
};

// ── Component ─────────────────────────────────────────────────────────────────
const AssemblyViewer = forwardRef<AssemblyViewerHandle, Props>(
 function AssemblyViewer({projectId,live,entries,panels,paint,wire,onReadyChange,selection=null,previewOnly=false,onFacePicked,onFaceMessage,onValidation,children,activeId=null,hiddenIds=[],moving=false,moveGroup=false,onSelect,onMove,onDrag,onCatalog,onPlaced,insertId,insertBranchId,onSideSelected,sideTargets=[],sideSelectionMode=false},ref){
  const host = useRef<HTMLDivElement>(null);
  const viewApi = useRef<{fit:(view?:string)=>void;screenshot:()=>void;exportGLB:()=>Promise<void>}|null>(null);
  const applyRef = useRef<((p:boolean,w:boolean)=>void)|null>(null);
  // Track latest paint/wire for use inside async closures
  const paintLatest = useRef(paint);
  const wireLatest = useRef(wire);
  const [msg,setMsg] = useState('');
  const [err,setErr] = useState(false);
  const [ready,setReady] = useState(false);
  const [exporting,setExporting] = useState(false);
  const [cad,setCad] = useState<{key:string;checking:boolean;result:CadCheck|null;error:string}>({key:'',checking:false,result:null,error:''});
  const cadLatest = useRef<CadCheck|null>(null);
  const [stepError,setStepError] = useState('');
  const entriesLatest = useRef(entries);
  const layoutRef = useRef<(()=>void)|null>(null);
  const entriesKey=JSON.stringify({entries,insertId,insertBranchId});
  const insertion=useRef({insertId,insertBranchId});
  const interaction=useRef({selection,previewOnly,onFacePicked,onFaceMessage,onValidation,activeId,hiddenIds,moving,moveGroup,onSelect,onMove,onDrag,onCatalog,onPlaced,onSideSelected,sideTargets,sideSelectionMode});
  const displayRef=useRef<(()=>void)|null>(null);
  const gizmoRef=useRef<ReturnType<typeof createAssemblyGizmo>|null>(null);
  const pickerRef=useRef<ReturnType<typeof createAssemblyFacePicker>|null>(null);
  useEffect(()=>{interaction.current={selection,previewOnly,onFacePicked,onFaceMessage,onValidation,activeId,hiddenIds,moving,moveGroup,onSelect,onMove,onDrag,onCatalog,onPlaced,onSideSelected,sideTargets,sideSelectionMode};void pickerRef.current?.update(selection);displayRef.current?.();},[selection,previewOnly,onFacePicked,onFaceMessage,onValidation,activeId,hiddenIds,moving,moveGroup,onSelect,onMove,onDrag,onCatalog,onPlaced,onSideSelected,sideTargets,sideSelectionMode]);
  // Parent selection/highlight updates must not restart CAD placement.
  useEffect(()=>{entriesLatest.current=JSON.parse(entriesKey).entries;insertion.current={insertId,insertBranchId};layoutRef.current?.();},[entriesKey,insertId,insertBranchId]);
  useEffect(()=>{onValidation?.({key:cad.key,valid:ready&&!cad.checking&&!!cad.result?.valid,token:cad.result?.token??null});},[cad,ready,onValidation]);
  useEffect(()=>{onReadyChange(ready);},[ready,onReadyChange]);

  // Keep latest-value refs up to date without triggering re-mount
  useEffect(()=>{ paintLatest.current=paint; wireLatest.current=wire; },[paint,wire]);

  // Expose imperative handle
  useImperativeHandle(ref,()=>({
   fit:(view)=>viewApi.current?.fit(view),
  }),[]);

  // Reload models only when panel artifacts change. Spacing/connections preserve the camera.
  const key = entries.map(e=>{const panel=panels.find(p=>p.id===e.panelId);return `${e.id}:${e.panelId}:${panel?.revision}:${panel?fileUrl(panel,'panel.glb'):''}:${JSON.stringify(e.rotation??[0,0,0,1])}`;}).join('|');

  useEffect(()=>{
   setReady(false);cadLatest.current=null;
   setCad({key:JSON.stringify(entries),checking:live&&entries.length>0,result:null,error:''});setStepError('');
   if(!entries.length){
    setMsg('');
    applyRef.current=null;
    layoutRef.current=null;
    return;
   }
   let alive=true; let frame=0; let layoutVersion=0; let validationTimer:ReturnType<typeof setTimeout>|undefined;
   let placementController:AbortController|undefined; let validationController:AbortController|undefined;
   let submitted:CadEntry[]=[]; let pending:Promise<CadCheck>|null=null;
   const root=host.current!;
   setMsg('Loading assembly…'); setErr(false);

   let renderer:THREE.WebGLRenderer;
   try{renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});}
   catch{setMsg('WebGL not available');setErr(true);return;}
   renderer.setPixelRatio(Math.min(devicePixelRatio,2));
   configureInspectionRenderer(renderer);
   root.appendChild(renderer.domElement);

   const scene=new THREE.Scene();
   const camera=new THREE.PerspectiveCamera(32,1,.001,1000);
   camera.up.set(0,0,1);
   const controls=new OrbitControls(camera,renderer.domElement);
   controls.enableDamping=true; controls.dampingFactor=.1;
   inspectionLighting(scene);
   const grid=new THREE.GridHelper(20,100,0xc1d1d1,0xd8e2e2);
   prepareInspectionGrid(grid);grid.rotation.x=Math.PI/2; grid.position.z=-.012; scene.add(grid);

   const panelMap=new Map(panels.map(p=>[p.id,p]));
   const loader=new GLTFLoader();
   type Item={group:THREE.Group;bounds:THREE.Box3;localBounds:THREE.Box3};
   const items=new Map<string,Item>();
   let hoveredId:string|null=null;
   let labels:ReturnType<typeof createAssemblyLabels>|null=null,placed:CadPlacement|null=null;let placedKey='';
   function syncDisplay(){
    for(const [id,item] of items)item.group.visible=!interaction.current.hiddenIds.includes(id);
    applyRef.current?.(paintLatest.current,wireLatest.current);
    const id=interaction.current.activeId,entry=entriesLatest.current.find(e=>e.id===id),frame=id?placed?.frames?.[id]:null;
    gizmoRef.current?.set(placedKey===JSON.stringify({entries:entriesLatest.current,...insertion.current})&&interaction.current.moving&&id&&entry&&frame&&!interaction.current.hiddenIds.includes(id)?{id,frame,values:positionValues(entry),gap:entry.gap,group:interaction.current.moveGroup}:null);
   }
   displayRef.current=syncDisplay;

   // Include missing/stale source failures in the recoverable loading error path.
   Promise.resolve().then(()=>{cadEntries(entries,panels);return Promise.all(entries.map(async entry=>{
    const panel=panelMap.get(entry.panelId);
    if(!panel) throw new Error('Panel not found');
    const gltf=await loader.loadAsync(fileUrl(panel,'panel.glb'));
    if(!alive) return;
    const source=assemblyModel(gltf.scene),item={...source,localBounds:source.bounds.clone()};
    prepareInspectionModel(item.group);
    item.group.quaternion.copy(assemblyRotation(entry));item.group.updateMatrixWorld(true);
    item.bounds=new THREE.Box3().setFromObject(item.group,true);
    item.group.name=`Assembly ${entry.id}`;
    item.group.userData={entryId:entry.id,panelId:entry.panelId};
    scene.add(item.group);
    items.set(entry.id,item);
   }));}).then(async()=>{
    if(!alive) return;
    gizmoRef.current=createAssemblyGizmo({scene,camera,canvas:renderer.domElement,orbit:controls,groups:items,entries:()=>entriesLatest.current,
     onStart:()=>{layoutVersion++;validationController?.abort();placementController?.abort();clearTimeout(validationTimer);pending=null;cadLatest.current=null;setReady(false);setCad({key:'',checking:true,result:null,error:''});interaction.current.onDrag?.(true);},
     onChange:values=>{interaction.current.onMove?.(values);pickerRef.current?.refresh();},
     onEnd:()=>{interaction.current.onDrag?.(false);requestAnimationFrame(()=>{if(alive)layoutRef.current?.();});}});
    labels=createAssemblyLabels({host:root,camera,groups:items,entries:()=>entriesLatest.current,active:()=>interaction.current.activeId,targets:()=>interaction.current.sideTargets,selecting:()=>interaction.current.sideSelectionMode,onSelect:id=>interaction.current.onSelect?.(id),onSide:(id,side)=>interaction.current.onSideSelected?.(id,side),onSideHover:(id,side)=>pickerRef.current?.highlightSide(id,side)});
    if(live){
     pickerRef.current=createAssemblyFacePicker({projectId,scene,camera,canvas:renderer.domElement,groups:items,
      entries:()=>cadEntries(entriesLatest.current,panels),
      onPick:(role,face)=>interaction.current.onFacePicked?.(role,face),onMessage:message=>interaction.current.onFaceMessage?.(message),
      onSelect:id=>interaction.current.onSelect?.(id),onCatalog:catalog=>{labels?.setCatalog(catalog);interaction.current.onCatalog?.(catalog);},
      blocked:()=>!!gizmoRef.current?.intercepting,
      onPanelHover:id=>{if(hoveredId!==id){hoveredId=id;applyRef.current?.(paintLatest.current,wireLatest.current);}}});
     void pickerRef.current.loadAll();void pickerRef.current.update(interaction.current.selection);
    }
    let submittedKey='';
    async function validateLayout():Promise<CadCheck>{
     if(pending)return pending;
     clearTimeout(validationTimer);const version=layoutVersion;
     validationController=new AbortController();const controller=validationController;
     pending=checkAssembly(projectId,submitted,controller.signal).then(result=>{
      if(!alive||version!==layoutVersion)throw new Error('Assembly changed while validating.');
      pending=null;cadLatest.current=result;setCad({key:submittedKey,checking:false,result,error:''});
      return result;
     }).catch(error=>{if(alive&&version===layoutVersion&&!controller.signal.aborted){cadLatest.current=null;setCad({key:submittedKey,checking:false,result:null,error:(error as Error).message});pending=null;}throw error;});
     return pending;
    }

    // ── Position panels from connection tree ──────────────────────────────
    async function layout(){
     if(gizmoRef.current?.dragging)return;
     const version=++layoutVersion,snapshot=entriesLatest.current,requestKey=JSON.stringify({entries:snapshot,...insertion.current});
     gizmoRef.current?.set(null);
     placementController?.abort();validationController?.abort();clearTimeout(validationTimer);pending=null;cadLatest.current=null;
     placementController=new AbortController();const controller=placementController;
     setStepError('');setCad({key:requestKey,checking:live,result:null,error:''});setReady(false);
     try {
      if(live){
       const result=await placeAssembly(projectId,cadEntries(snapshot,panels),controller.signal,insertion.current.insertId,insertion.current.insertBranchId);
       if(!alive||version!==layoutVersion)return;
       if(result.units!=='mm'||result.entries.length!==snapshot.length)throw new Error('Incomplete CAD assembly placement.');
       for(const entry of snapshot){
        const row=result.entries.find(row=>row.id===entry.id);if(!row?.matrix||!result.bounds[entry.id])throw new Error('Missing CAD panel placement.');
        const matrix=new THREE.Matrix4().fromArray(row.matrix);matrix.elements[12]/=1000;matrix.elements[13]/=1000;matrix.elements[14]/=1000;
        const group=items.get(entry.id)!.group;matrix.decompose(group.position,group.quaternion,group.scale);group.updateMatrixWorld(true);
       }
       submitted=result.entries;placed=result;placedKey=requestKey;interaction.current.onPlaced?.(result);
       grid.position.z=Math.min(...Object.values(result.bounds).map(box=>box.min[2]))/1000-.012;
      }else{
       if(snapshot.some(entry=>entry.connection))throw new Error('Connect the CAD service to preview saved CAD-face connections.');
       const placements=assemblyPlacements(snapshot,new Map([...items].map(([id,item])=>[id,item.bounds])));
       for(const [id,placement] of placements){const group=items.get(id)!.group;group.position.copy(placement.translation);group.updateMatrixWorld(true);}
       grid.position.z=Math.min(...[...placements.values()].map(placement=>placement.bounds.min.z))-.012;
       submitted=cadEntries(snapshot,panels).map(entry=>({...entry,matrix:assemblyMatrix(entry,placements.get(entry.id)!.translation)}));
      }
      submittedKey=requestKey;pickerRef.current?.refresh();syncDisplay();
      if(live)validationTimer=setTimeout(()=>{void validateLayout().catch(()=>{});},250);
      setMsg('');setErr(false);setReady(true);
     }catch(error){if(alive&&version===layoutVersion&&!controller.signal.aborted){setMsg((error as Error).message);setErr(true);setReady(false);setCad({key:requestKey,checking:false,result:null,error:(error as Error).message});}}
    }
    layoutRef.current=layout;

    // ── Paint / wireframe ─────────────────────────────────────────────────
    function doApply(p:boolean,w:boolean){
     for(const [id,item] of items){
      applyInspectionAppearance(item.group,p,w);
      item.group.traverse(o=>{if(o instanceof THREE.Mesh)for(const material of Array.isArray(o.material)?o.material:[o.material]){
       if(material instanceof THREE.MeshStandardMaterial)material.emissive.set(id===interaction.current.activeId?0x124e65:id===hoveredId?0x163745:0x000000);
      }});
     }
    }
    applyRef.current=doApply;doApply(paintLatest.current,wireLatest.current);

    // ── Fit camera ────────────────────────────────────────────────────────
    function fit(view="iso"){
     if(!items.size) return;
     const box=new THREE.Box3();
     for(const item of items.values()){if(!item.group.visible)continue;item.group.updateMatrixWorld(true);box.union(new THREE.Box3().setFromObject(item.group));}
     if(box.isEmpty())return;
     const size=box.getSize(new THREE.Vector3()),c=box.getCenter(new THREE.Vector3());
     const vFov=THREE.MathUtils.degToRad(camera.fov),hFov=2*Math.atan(Math.tan(vFov/2)*camera.aspect);
     const dist=size.length()/2/Math.sin(Math.min(vFov,hFov)/2)*1.15+.1;
     camera.up.set(0,0,1);if(view==='top')camera.up.set(0,1,0);
     const direction=view==='top'?new THREE.Vector3(0,0,1):view==='front'?new THREE.Vector3(0,-1,0):view==='side'?new THREE.Vector3(1,0,0):new THREE.Vector3(1,-1.25,1.15);
     camera.position.copy(c).addScaledVector(direction.normalize(),dist);
     controls.target.copy(c);
     camera.near=.001; camera.far=Math.max(100,dist*20);
     camera.updateProjectionMatrix(); controls.update();
    }
    viewApi.current={
     fit,
     screenshot:()=>{renderer.render(scene,camera);const a=document.createElement('a');a.href=renderer.domElement.toDataURL('image/png');a.download='FlatForge_Assembly.png';a.click();},
     exportGLB:async()=>{
      if(interaction.current.previewOnly)throw new Error('Apply or cancel the connection preview before exporting.');
      if(live&&!cadLatest.current?.valid)throw new Error('Wait for the current panel positions before exporting.');
      const snapshot=new THREE.Scene();
      snapshot.userData={units:'metres',source_units:'mm',assemblyEntries:entriesLatest.current,cadTransformsMm:submitted};
      for(const entry of entriesLatest.current){const copy=items.get(entry.id)!.group.clone(true);copy.visible=true;const overlays:THREE.Object3D[]=[];copy.traverse(o=>{if(o.userData.inspectionEdges)overlays.push(o);});for(const o of overlays)o.removeFromParent();snapshot.add(copy);}
      snapshot.updateMatrixWorld(true);
      const result=await new GLTFExporter().parseAsync(snapshot,{binary:true});
      if(!(result instanceof ArrayBuffer)) throw new Error('Assembly export failed.');
      const url=URL.createObjectURL(new Blob([result],{type:'model/gltf-binary'}));
      const a=document.createElement('a');a.href=url;a.download='FlatForge_Assembly.glb';a.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
     }
    };
    await layout(); if(alive)fit();
   }).catch(error=>{if(alive){setMsg(`Could not load assembly: ${(error as Error).message}`);setErr(true);setReady(false);setCad({key:JSON.stringify(entries),checking:false,result:null,error:'Assembly source unavailable. Restore its approved panel result or remove the affected entry.'});}});

   const resize=new ResizeObserver(()=>{const w=root.clientWidth,h=root.clientHeight;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();});
   resize.observe(root);
   function loop(){frame=requestAnimationFrame(loop);controls.update();renderer.render(scene,camera);labels?.update();

   }
   loop();

   return()=>{
    alive=false;placementController?.abort();validationController?.abort();pickerRef.current?.dispose();pickerRef.current=null;gizmoRef.current?.dispose();gizmoRef.current=null;labels?.dispose();displayRef.current=null;clearTimeout(validationTimer); cancelAnimationFrame(frame); resize.disconnect(); controls.dispose();
    applyRef.current=null;
    layoutRef.current=null;
    scene.traverse(o=>{if(o instanceof THREE.Mesh||o instanceof THREE.LineSegments){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();}});
    renderer.dispose(); renderer.domElement.remove(); viewApi.current=null;
   };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key,projectId,live]);

  // Apply visual settings without reloading
  useEffect(()=>{applyRef.current?.(paint,wire);},[paint,wire]);

  return(
   <div className="viewer-stage" data-assembly-ready={ready}>
   <div className="asm-cad-controls" data-cad-valid={cad.key===entriesKey&&live&&ready&&entries.length>0&&!!cad.result?.valid&&!cad.checking}>
    <Button variant="outline" disabled={previewOnly||cad.key!==entriesKey||!live||!entries.length||!ready||cad.checking||!cad.result?.valid||exporting} onClick={async()=>{const token=cadLatest.current?.token;if(!token)return;setExporting(true);setStepError('');try{await downloadAssemblyStep(projectId,token);}catch(error){setStepError((error as Error).message);}finally{setExporting(false);}}}><Download size={15}/>{exporting?'Exporting…':'Export assembly as STEP (.step)'}</Button>
    {!live?<p>Sample preview uses mesh bounds. Connect the CAD service for assembly saving and STEP export.</p>:entries.length>0&&<p role="status">{cad.checking?'Checking panel positions…':cad.error||cad.result?.issues.join(' ')||(cad.result?.valid?'Positions ready · millimeters':'Waiting for panel positions.')}</p>}
    {stepError&&<p role="alert">{stepError}</p>}
   </div>
    <div ref={host} className="webgl-host"/>
    {msg&&<div className="viewer-loading">{err?<Box/>:<LoaderCircle className="spin"/>}<span>{msg}</span></div>}
    {!entries.length&&!msg&&<div className="viewer-empty"><Box size={42}/><h3>Assembly is empty</h3><p>Select the first panel to start assembling.</p></div>}
    <div className="viewport-actions">
     <Button variant="outline" size="icon" aria-label="Export assembly GLB" title="Export assembly GLB (metres)" disabled={previewOnly||cad.key!==entriesKey||!ready||exporting||(live&&(cad.checking||!cad.result?.valid))} onClick={async()=>{setExporting(true);try{await viewApi.current?.exportGLB();}catch(error){setMsg((error as Error).message);setErr(true);}finally{setExporting(false);}}}>{exporting?<LoaderCircle className="spin"/>:<Download/>}</Button>
     <Button variant="outline" size="icon" aria-label="Screenshot" onClick={()=>viewApi.current?.screenshot()}><Camera/></Button>
    </div>
    {children}
    <div className="axis-key"><span className="x">X</span><span className="y">Y</span><span className="z">Z</span><small>mm</small></div>
    <div className="viewport-help">Drag to orbit · Right-drag to pan · Scroll to zoom</div>
   </div>
  );
 }
);

export default AssemblyViewer;
