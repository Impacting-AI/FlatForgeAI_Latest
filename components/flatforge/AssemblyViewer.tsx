'use client';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Camera, LoaderCircle, Maximize2, Box } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AssemblyEntry, Face, Panel, fileUrl } from './types';

// ── Geometry helpers ──────────────────────────────────────────────────────────
const NORMALS: Record<Face, THREE.Vector3> = {
 '+X':new THREE.Vector3(1,0,0),'-X':new THREE.Vector3(-1,0,0),
 '+Y':new THREE.Vector3(0,1,0),'-Y':new THREE.Vector3(0,-1,0),
 '+Z':new THREE.Vector3(0,0,1),'-Z':new THREE.Vector3(0,0,-1),
};
function faceOff(face:Face,hs:THREE.Vector3):THREE.Vector3{
 switch(face){
  case'+X':return new THREE.Vector3(hs.x,0,0);
  case'-X':return new THREE.Vector3(-hs.x,0,0);
  case'+Y':return new THREE.Vector3(0,hs.y,0);
  case'-Y':return new THREE.Vector3(0,-hs.y,0);
  case'+Z':return new THREE.Vector3(0,0,hs.z);
  case'-Z':return new THREE.Vector3(0,0,-hs.z);
 }
}

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
};

// ── Component ─────────────────────────────────────────────────────────────────
const AssemblyViewer = forwardRef<AssemblyViewerHandle, Props>(
 function AssemblyViewer({entries,panels,paint,wire},ref){
  const host = useRef<HTMLDivElement>(null);
  const viewApi = useRef<{fit:()=>void;screenshot:()=>void}|null>(null);
  const applyRef = useRef<((p:boolean,w:boolean)=>void)|null>(null);
  const runClashRef = useRef<()=>ClashResult[]>(()=>[]);
  const clearClashRef = useRef<()=>void>(()=>{});
  // Track latest paint/wire for use inside async closures
  const paintLatest = useRef(paint);
  const wireLatest = useRef(wire);
  const [msg,setMsg] = useState('');
  const [err,setErr] = useState(false);

  // Keep latest-value refs up to date without triggering re-mount
  useEffect(()=>{ paintLatest.current=paint; wireLatest.current=wire; },[paint,wire]);

  // Expose imperative handle
  useImperativeHandle(ref,()=>({
   runClash: ()=>runClashRef.current(),
   clearClash: ()=>clearClashRef.current(),
  }),[]);

  // Re-mount Three.js scene only when panel set / connections change
  const key = entries.map(e=>`${e.id}:${e.panelId}:${e.myFace}:${e.targetId}:${e.targetFace}:${e.gap}`).join('|');

  useEffect(()=>{
   if(!entries.length){
    setMsg('');
    applyRef.current=null;
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
   type Item={group:THREE.Group;localCenter:THREE.Vector3;halfSize:THREE.Vector3};
   const items=new Map<string,Item>();
   const clashOverlays:THREE.Object3D[]=[];

   Promise.all(entries.map(async entry=>{
    const panel=panelMap.get(entry.panelId);
    if(!panel) throw new Error('Panel not found');
    const gltf=await loader.loadAsync(fileUrl(panel,'panel.glb'));
    if(!alive) return;
    const group=gltf.scene;
    group.scale.setScalar(.001);
    group.updateMatrixWorld(true);
    const bounds=new THREE.Box3().setFromObject(group);
    const localCenter=bounds.getCenter(new THREE.Vector3());
    const halfSize=bounds.getSize(new THREE.Vector3()).multiplyScalar(.5);
    scene.add(group);
    items.set(entry.id,{group,localCenter,halfSize});
   })).then(()=>{
    if(!alive) return;

    // ── Position panels from connection tree ──────────────────────────────
    const worldCenter=new Map<string,THREE.Vector3>();
    for(const entry of entries){
     const item=items.get(entry.id);
     if(!item) continue;
     if(entry.targetId===null){
      worldCenter.set(entry.id,new THREE.Vector3(0,0,item.halfSize.z));
     } else {
      const tItem=items.get(entry.targetId);
      const tWC=worldCenter.get(entry.targetId);
      if(!tItem||!tWC||!entry.targetFace) continue;
      const tFacePos=tWC.clone().add(faceOff(entry.targetFace,tItem.halfSize));
      const normal=NORMALS[entry.targetFace].clone();
      const myOff=faceOff(entry.myFace,item.halfSize);
      const wc=tFacePos.clone().addScaledVector(normal,entry.gap/1000).sub(myOff);
      if(entry.targetFace!=='+Z'&&entry.targetFace!=='-Z'&&entry.myFace!=='+Z'&&entry.myFace!=='-Z'){
       wc.z=item.halfSize.z; // keep panels resting on ground for lateral connections
      }
      worldCenter.set(entry.id,wc);
     }
    }
    for(const[id,wc]of worldCenter){
     const item=items.get(id);
     if(item) item.group.position.copy(wc.clone().sub(item.localCenter));
    }

    // ── Paint / wireframe ─────────────────────────────────────────────────
    function doApply(p:boolean,w:boolean){
     for(const item of items.values()){
      item.group.traverse(o=>{
       if(o instanceof THREE.Mesh){
        for(const mat of Array.isArray(o.material)?o.material:[o.material]){
         if('wireframe' in mat)(mat as THREE.MeshStandardMaterial).wireframe=w;
         if(mat instanceof THREE.MeshStandardMaterial&&o.name.includes('_paint'))
          mat.color.set(p?0x39a88e:0xb7c5c7);
        }
       }
      });
     }
    }
    applyRef.current=doApply;
    doApply(paint,wire);

    // ── Clash detection ───────────────────────────────────────────────────
    function runClash():ClashResult[]{
     const results:ClashResult[]=[];
     const ray=new THREE.Raycaster();
     const entryList=entries.filter(e=>items.has(e.id));
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
     screenshot:()=>{renderer.render(scene,camera);const a=document.createElement('a');a.href=renderer.domElement.toDataURL('image/png');a.download='FlatForge_Assembly.png';a.click();}
    };
    fit(); setMsg('');
   }).catch(()=>{if(alive){setMsg('Could not load one or more panels.');setErr(true);}});

   const resize=new ResizeObserver(()=>{const w=root.clientWidth,h=root.clientHeight;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();});
   resize.observe(root);
   function loop(){frame=requestAnimationFrame(loop);controls.update();renderer.render(scene,camera);}
   loop();

   return()=>{
    alive=false; cancelAnimationFrame(frame); resize.disconnect(); controls.dispose();
    applyRef.current=null;
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
   <div className="viewer-stage">
    <div ref={host} className="webgl-host"/>
    {msg&&<div className="viewer-loading">{err?<Box/>:<LoaderCircle className="spin"/>}<span>{msg}</span></div>}
    {!entries.length&&!msg&&<div className="viewer-empty"><Box size={42}/><h3>Assembly is empty</h3><p>Add panels on the left and define how their faces connect.</p></div>}
    <div className="viewport-actions">
     <Button variant="outline" size="icon" aria-label="Fit to view" onClick={()=>viewApi.current?.fit()}><Maximize2/></Button>
     <Button variant="outline" size="icon" aria-label="Screenshot" onClick={()=>viewApi.current?.screenshot()}><Camera/></Button>
    </div>
    <div className="axis-key"><span className="x">X</span><span className="y">Y</span><span className="z">Z</span><small>mm</small></div>
    <div className="viewport-help">Drag to orbit · Right-drag to pan · Scroll to zoom</div>
   </div>
  );
 }
);

export default AssemblyViewer;
