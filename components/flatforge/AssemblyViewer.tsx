'use client';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Camera, LoaderCircle, Maximize2, Box, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AssemblyEntry, Panel, fileUrl } from './types';
import { assemblyModel, assemblyPlacements } from './assembly-geometry';

// ── Public types ──────────────────────────────────────────────────────────────
export type ClashResult = {
 entryIdA: string;
 entryIdB: string;
 /** Minimum AABB overlap dimension in mm — severity indicator */
 depth: number;
 /** Number of sampled vertices found penetrating the other solid */
 pointCount: number;
};

export type AssemblyViewerHandle = {
 /** Run pairwise AABB + vertex-in-solid clash detection; returns results and highlights clashes in red */
 runClash: () => ClashResult[];
 /** Remove clash highlighting and restore panel colours */
 clearClash: () => void;
};

type Props = {
 entries: AssemblyEntry[];
 panels: Panel[];
 paint: boolean;
 wire: boolean;
 onReadyChange: (ready:boolean) => void;
};

// ── Component ─────────────────────────────────────────────────────────────────
const AssemblyViewer = forwardRef<AssemblyViewerHandle, Props>(
 function AssemblyViewer({entries,panels,paint,wire,onReadyChange},ref){
  const host = useRef<HTMLDivElement>(null);
  const viewApi = useRef<{fit:()=>void;screenshot:()=>void;exportGLB:()=>Promise<void>}|null>(null);
  const applyRef = useRef<((p:boolean,w:boolean)=>void)|null>(null);
  const runClashRef = useRef<()=>ClashResult[]>(()=>[]);
  const clearClashRef = useRef<()=>void>(()=>{});
  // Track latest paint/wire for use inside async closures
  const paintLatest = useRef(paint);
  const wireLatest = useRef(wire);
  const [msg,setMsg] = useState('');
  const [err,setErr] = useState(false);
  const [ready,setReady] = useState(false);
  const [exporting,setExporting] = useState(false);
  const entriesLatest = useRef(entries);
  const layoutRef = useRef<(()=>void)|null>(null);
  useEffect(()=>{entriesLatest.current=entries;layoutRef.current?.();},[entries]);
  useEffect(()=>{onReadyChange(ready);},[ready,onReadyChange]);

  // Keep latest-value refs up to date without triggering re-mount
  useEffect(()=>{ paintLatest.current=paint; wireLatest.current=wire; },[paint,wire]);

  // Expose imperative handle
  useImperativeHandle(ref,()=>({
   runClash: ()=>runClashRef.current(),
   clearClash: ()=>clearClashRef.current(),
  }),[]);

  // Reload models only when panel artifacts change. Spacing/connections preserve the camera.
  const key = entries.map(e=>{const panel=panels.find(p=>p.id===e.panelId);return `${e.id}:${e.panelId}:${panel?.revision}:${panel?fileUrl(panel,'panel.glb'):''}`;}).join('|');

  useEffect(()=>{
   setReady(false);
   if(!entries.length){
    setMsg('');
    applyRef.current=null;
    layoutRef.current=null;
    runClashRef.current=()=>[];
    clearClashRef.current=()=>{};
    return;
   }
   let alive=true; let frame=0;
   const root=host.current!;
   setMsg('Loading assembly…'); setErr(false);

   let renderer:THREE.WebGLRenderer;
   try{renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});}
   catch{setMsg('WebGL not available');setErr(true);return;}
   renderer.setPixelRatio(Math.min(devicePixelRatio,2));
   renderer.setClearColor(0xeef3f3);
   renderer.outputColorSpace=THREE.SRGBColorSpace;
   root.appendChild(renderer.domElement);

   const scene=new THREE.Scene();
   const camera=new THREE.PerspectiveCamera(32,1,.001,1000);
   camera.up.set(0,0,1);
   const controls=new OrbitControls(camera,renderer.domElement);
   controls.enableDamping=true; controls.dampingFactor=.1;
   scene.add(new THREE.HemisphereLight(0xffffff,0x82999d,2.1));
   const sun=new THREE.DirectionalLight(0xffffff,3); sun.position.set(3,-3,5); scene.add(sun);
   const fill=new THREE.DirectionalLight(0xc5e5e7,1.3); fill.position.set(-2,2,-4); scene.add(fill);
   const grid=new THREE.GridHelper(20,100,0xc1d1d1,0xd8e2e2);
   grid.rotation.x=Math.PI/2; grid.position.z=-.012; scene.add(grid);

   const panelMap=new Map(panels.map(p=>[p.id,p]));
   const loader=new GLTFLoader();
   type Item={group:THREE.Group;bounds:THREE.Box3};
   const items=new Map<string,Item>();
   const clashOverlays:THREE.Object3D[]=[];
   const originalColours=new Map<THREE.Material,THREE.Color>();

   Promise.all(entries.map(async entry=>{
    const panel=panelMap.get(entry.panelId);
    if(!panel) throw new Error('Panel not found');
    const gltf=await loader.loadAsync(fileUrl(panel,'panel.glb'));
    if(!alive) return;
    const item=assemblyModel(gltf.scene);
    item.group.name=`Assembly ${entry.id}`;
    item.group.userData={entryId:entry.id,panelId:entry.panelId};
    item.group.traverse(o=>{if(o instanceof THREE.Mesh) for(const mat of Array.isArray(o.material)?o.material:[o.material])
     if(mat instanceof THREE.MeshStandardMaterial) originalColours.set(mat,mat.color.clone());});
    scene.add(item.group);
    items.set(entry.id,item);
   })).then(()=>{
    if(!alive) return;

    // ── Position panels from connection tree ──────────────────────────────
    function layout(){
     try {
      clearClash();
      const placements=assemblyPlacements(entriesLatest.current,new Map([...items].map(([id,item])=>[id,item.bounds])));
      for(const [id,placement] of placements){const group=items.get(id)!.group;group.position.copy(placement.translation);group.updateMatrixWorld(true);}
      setMsg('');setErr(false);setReady(true);
     } catch(error) {setMsg((error as Error).message);setErr(true);setReady(false);}
    }
    layoutRef.current=layout;

    // ── Paint / wireframe ─────────────────────────────────────────────────
    function doApply(p:boolean,w:boolean){
     for(const item of items.values()){
      item.group.traverse(o=>{
       if(o instanceof THREE.Mesh){
        for(const mat of Array.isArray(o.material)?o.material:[o.material]){
         if('wireframe' in mat)(mat as THREE.MeshStandardMaterial).wireframe=w;
         if(mat instanceof THREE.MeshStandardMaterial&&originalColours.has(mat)) mat.color.copy(originalColours.get(mat)!);
         if(mat instanceof THREE.MeshStandardMaterial&&o.name.includes('_paint'))
          mat.color.set(p?0x39a88e:0xb7c5c7);
        }
       }
      });
     }
    }
    applyRef.current=doApply;
    doApply(paintLatest.current,wireLatest.current);

    // ── Clash detection ───────────────────────────────────────────────────
    function runClash():ClashResult[]{
     const results:ClashResult[]=[];
     const ray=new THREE.Raycaster();
     const entryList=entriesLatest.current.filter(e=>items.has(e.id));
     // Two orthogonal test directions for inside-solid parity test
     const DIRS=[new THREE.Vector3(1,0,0),new THREE.Vector3(0,1,0)];

     for(let i=0;i<entryList.length;i++){
      for(let j=i+1;j<entryList.length;j++){
       const eA=entryList[i], eB=entryList[j];
       const iA=items.get(eA.id)!, iB=items.get(eB.id)!;
       iA.group.updateMatrixWorld(true); iB.group.updateMatrixWorld(true);

       // ── Broad phase: AABB ─────────────────────────────────────────────
       const boxA=new THREE.Box3().setFromObject(iA.group);
       const boxB=new THREE.Box3().setFromObject(iB.group);
       if(!boxA.intersectsBox(boxB)) continue;

       // Overlap region
       const oMin=boxA.min.clone().max(boxB.min);
       const oMax=boxA.max.clone().min(boxB.max);
       const oSize=oMax.clone().sub(oMin);
       const depth=Math.min(oSize.x,oSize.y,oSize.z)*1000; // mm
       const center=oMin.clone().add(oMax).multiplyScalar(.5);

       // ── Narrow phase: vertex-in-solid (ray parity) ────────────────────
       const mA:THREE.Mesh[]=[],mB:THREE.Mesh[]=[];
       iA.group.traverse(o=>{if(o instanceof THREE.Mesh)mA.push(o);});
       iB.group.traverse(o=>{if(o instanceof THREE.Mesh)mB.push(o);});

       let pointCount=0;

       const checkVerts=(meshes:THREE.Mesh[],targets:THREE.Mesh[],searchBox:THREE.Box3)=>{
        for(const mesh of meshes){
         const pos=mesh.geometry.attributes.position;
         // Sample at most 120 vertices per mesh for performance
         const stride=Math.max(1,Math.floor(pos.count/120));
         for(let vi=0;vi<pos.count;vi+=stride){
          const v=new THREE.Vector3().fromBufferAttribute(pos,vi).applyMatrix4(mesh.matrixWorld);
          if(!searchBox.containsPoint(v)) continue; // fast reject
          // Point-in-solid: ray parity test along 2 orthogonal axes
          let inside=0;
          for(const d of DIRS){
           ray.set(v,d);
           if(ray.intersectObjects(targets,false).length%2===1) inside++;
          }
          if(inside>=2) pointCount++;
         }
        }
       };

       // Check A vertices penetrating B, then B into A if nothing found
       checkVerts(mA,mB,boxB);
       if(pointCount===0) checkVerts(mB,mA,boxA);

       if(pointCount>0){
        results.push({entryIdA:eA.id,entryIdB:eB.id,depth,pointCount});

        // ── Highlight clashing panels red ─────────────────────────────────
        for(const id of[eA.id,eB.id]){
         items.get(id)?.group.traverse(o=>{
          if(o instanceof THREE.Mesh){
           for(const mat of Array.isArray(o.material)?o.material:[o.material]){
            if(mat instanceof THREE.MeshStandardMaterial) mat.color.set(0xdd2020);
           }
          }
         });
        }

        // ── Clash zone: semi-transparent red volume + wireframe ───────────
        const sz=oSize;
        const solid=new THREE.Mesh(
         new THREE.BoxGeometry(sz.x,sz.y,sz.z),
         new THREE.MeshBasicMaterial({color:0xff1111,transparent:true,opacity:.18,depthWrite:false})
        );
        solid.position.copy(center);
        scene.add(solid); clashOverlays.push(solid);

        const outline=new THREE.LineSegments(
         new THREE.EdgesGeometry(new THREE.BoxGeometry(sz.x,sz.y,sz.z)),
         new THREE.LineBasicMaterial({color:0xff0000})
        );
        outline.position.copy(center);
        scene.add(outline); clashOverlays.push(outline);
       }
      }
     }
     return results;
    }

    // ── Clear clash visuals ───────────────────────────────────────────────
    function clearClash(){
     for(const obj of clashOverlays){
      scene.remove(obj);
      if(obj instanceof THREE.Mesh){
       obj.geometry.dispose();
       for(const m of Array.isArray(obj.material)?obj.material:[obj.material]) m.dispose();
      } else if(obj instanceof THREE.LineSegments){
       obj.geometry.dispose();
       (obj.material as THREE.Material).dispose();
      }
     }
     clashOverlays.length=0;
     // Restore original colours using the latest paint/wire values
     doApply(paintLatest.current,wireLatest.current);
    }

    runClashRef.current=runClash;
    clearClashRef.current=clearClash;

    // ── Fit camera ────────────────────────────────────────────────────────
    function fit(){
     if(!items.size) return;
     const box=new THREE.Box3();
     for(const item of items.values()){item.group.updateMatrixWorld(true);box.union(new THREE.Box3().setFromObject(item.group));}
     const size=box.getSize(new THREE.Vector3()),c=box.getCenter(new THREE.Vector3());
     const vFov=THREE.MathUtils.degToRad(camera.fov),hFov=2*Math.atan(Math.tan(vFov/2)*camera.aspect);
     const dist=size.length()/2/Math.sin(Math.min(vFov,hFov)/2)*1.15+.1;
     camera.position.copy(c).addScaledVector(new THREE.Vector3(1,-1.25,1.15).normalize(),dist);
     controls.target.copy(c);
     camera.near=.001; camera.far=Math.max(100,dist*20);
     camera.updateProjectionMatrix(); controls.update();
    }
    viewApi.current={
     fit,
     screenshot:()=>{renderer.render(scene,camera);const a=document.createElement('a');a.href=renderer.domElement.toDataURL('image/png');a.download='FlatForge_Assembly.png';a.click();},
     exportGLB:async()=>{
      const snapshot=new THREE.Scene();
      snapshot.userData={units:'metres',source_units:'mm',assemblyEntries:entriesLatest.current};
      for(const entry of entriesLatest.current) snapshot.add(items.get(entry.id)!.group.clone(true));
      snapshot.updateMatrixWorld(true);
      const result=await new GLTFExporter().parseAsync(snapshot,{binary:true});
      if(!(result instanceof ArrayBuffer)) throw new Error('Assembly export failed.');
      const url=URL.createObjectURL(new Blob([result],{type:'model/gltf-binary'}));
      const a=document.createElement('a');a.href=url;a.download='FlatForge_Assembly.glb';a.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
     }
    };
    layout(); fit();
   }).catch(error=>{if(alive){setMsg(`Could not load assembly: ${(error as Error).message}`);setErr(true);setReady(false);}});

   const resize=new ResizeObserver(()=>{const w=root.clientWidth,h=root.clientHeight;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();});
   resize.observe(root);
   function loop(){frame=requestAnimationFrame(loop);controls.update();renderer.render(scene,camera);}
   loop();

   return()=>{
    alive=false; cancelAnimationFrame(frame); resize.disconnect(); controls.dispose();
    applyRef.current=null;
    layoutRef.current=null;
    runClashRef.current=()=>[];
    clearClashRef.current=()=>{};
    scene.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();}});
    renderer.dispose(); renderer.domElement.remove(); viewApi.current=null;
   };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key]);

  // Apply visual settings without reloading
  useEffect(()=>{applyRef.current?.(paint,wire);},[paint,wire]);

  return(
   <div className="viewer-stage" data-assembly-ready={ready}>
    <div ref={host} className="webgl-host"/>
    {msg&&<div className="viewer-loading">{err?<Box/>:<LoaderCircle className="spin"/>}<span>{msg}</span></div>}
    {!entries.length&&!msg&&<div className="viewer-empty"><Box size={42}/><h3>Assembly is empty</h3><p>Add panels on the left and define how their faces connect.</p></div>}
    <div className="viewport-actions">
     <Button variant="outline" size="icon" aria-label="Fit to view" onClick={()=>viewApi.current?.fit()}><Maximize2/></Button>
     <Button variant="outline" size="icon" aria-label="Export assembly GLB" title="Export assembly GLB (metres)" disabled={!ready||exporting} onClick={async()=>{setExporting(true);try{await viewApi.current?.exportGLB();}catch(error){setMsg((error as Error).message);setErr(true);}finally{setExporting(false);}}}>{exporting?<LoaderCircle className="spin"/>:<Download/>}</Button>
     <Button variant="outline" size="icon" aria-label="Screenshot" onClick={()=>viewApi.current?.screenshot()}><Camera/></Button>
    </div>
    <div className="axis-key"><span className="x">X</span><span className="y">Y</span><span className="z">Z</span><small>mm</small></div>
    <div className="viewport-help">Drag to orbit · Right-drag to pan · Scroll to zoom</div>
   </div>
  );
 }
);

export default AssemblyViewer;
