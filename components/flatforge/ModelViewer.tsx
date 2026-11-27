'use client';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Maximize2, Camera, LoaderCircle, Box, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Panel, fileUrl, type Bend, type BendValues, type Settings } from './types';
import type { ReviewValues } from './review-state';
import { bendFields, bendInputValue } from './bend-review';
import BendEditor from './BendEditor';
import { createBendLabels } from './bend-overlay';
import { createOrbitNavigation, NAVIGATION, type CameraPose } from './orbit-navigation';
import { SoftwareRenderer } from './SoftwareRenderer';
import { createStudioLabels, type FaceInfo } from './studio-labels';
import { configureInspectionRenderer, prepareInspectionGrid, INSPECTION, inspectionMaterial, inspectionEdges, inspectionLighting, prepareInspectionModel, applyInspectionAppearance } from './inspection-presentation';
type Face={id:number;polygons:{outer:number[][];holes:number[][][]}[]};
type Hinge={id:number;name:string;parent:number;child:number;axis:number[];d:number[];hinge?:number[];allowance?:number;radius?:number;k_factor?:number;coordinate:number;dim:number;low:number;high:number;angle:number;source:{profile:string;vertex:number}[]};
type Drawing={thickness:number;radius:number;allowance:number;k_factor:number;faces:Face[];bends:Hinge[]};
export type ViewerBendReview={settings:Settings;review:ReviewValues;resolution:Panel['report']['parameter_resolution'];sectionReviewRequired:boolean;onApply:(key:string,patch:BendValues|null)=>void};
type Props={inspection?:boolean;panels:Panel[];fraction:number;gap:number;alignment:string;paint:boolean;wire:boolean;view:string;onHover:(value:string|null)=>void;reportBends?:Bend[];bendReview?:ViewerBendReview;pendingAngles?:Record<number,number>;showBends?:boolean;fullscreen?:boolean;onFullscreen?:(open:boolean)=>void};
const v=(p:number[])=>new THREE.Vector3(p[0],p[1],p[2]);
const hingePoint=(e:Hinge)=>e.hinge?v(e.hinge):new THREE.Vector3().setComponent(1-e.dim,e.coordinate);
// A selected bend only changes colour; its line keeps the same width as every other edge.
function markBendLine(line:THREE.LineSegments,active:boolean){const material=line.material as THREE.LineBasicMaterial;material.color.set(active?0xff7a00:INSPECTION.edge);material.opacity=active?1:.72;line.renderOrder=active?10:1;}
function animatedModel(data:Drawing,panelId:string,inspection=false){
 const group=new THREE.Group();group.scale.setScalar(.001);const plates=new Map<number,THREE.Group>();const bends=new Map<number,THREE.Mesh>();
 const finish=inspection?inspectionMaterial(true):new THREE.MeshStandardMaterial({color:0x39a88e,metalness:.18,roughness:.62,side:THREE.DoubleSide});const metal=inspection?inspectionMaterial():new THREE.MeshStandardMaterial({color:0xb5c1c4,metalness:.55,roughness:.55});
 for(const face of data.faces){const body=new THREE.Group();body.matrixAutoUpdate=false;for(const poly of face.polygons){const shape=new THREE.Shape(poly.outer.map(q=>new THREE.Vector2(q[0],q[1])));for(const h of poly.holes)shape.holes.push(new THREE.Path(h.map(q=>new THREE.Vector2(q[0],q[1]))));const geom=new THREE.ExtrudeGeometry(shape,{depth:data.thickness,bevelEnabled:false});geom.translate(0,0,-data.thickness/2);const plate=new THREE.Mesh(geom,[finish,metal]);plate.userData={faceName:`F${face.id}`,panelId};body.add(plate);}if(inspection)inspectionEdges(body,1);plates.set(face.id,body);group.add(body)}
 for(const e of data.bends){const mesh=new THREE.Mesh(new THREE.BufferGeometry(),finish);mesh.userData={hinge:e,panelId};bends.set(e.id,mesh);group.add(mesh)}
 // Bend lines for the flat sheet and the fold preview; the exported solid is outlined separately.
 const overlay=new THREE.Group();overlay.scale.setScalar(.001);
 const lines=new Map(data.bends.map(e=>{const line=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:INSPECTION.edge,transparent:true,opacity:.72,depthWrite:false,toneMapped:false}));line.matrixAutoUpdate=false;overlay.add(line);return [e.id,{line,middle:new THREE.Vector3()}] as const;}));
 function drawBend(e:Hinge,fraction:number,parent:THREE.Matrix4){
  const entry=lines.get(e.id)!,axis=v(e.axis),d=v(e.d),h=hingePoint(e),allowance=e.allowance??data.allowance,lift=data.thickness*.15+.3;const offsets:THREE.Vector3[]=[];
  if(fraction<.00001){for(const side of [1,-1])offsets.push(h.clone().add(new THREE.Vector3(0,0,side*(data.thickness/2+lift))));}
  else{const angle=THREE.MathUtils.degToRad(e.angle)*fraction,inner=allowance/Math.abs(angle)-(e.k_factor??data.k_factor)*data.thickness,w=new THREE.Vector3().crossVectors(axis,d).multiplyScalar(Math.sign(angle)),center=h.clone().addScaledVector(d,-allowance/2).addScaledVector(w,inner+data.thickness/2),out=w.clone().applyAxisAngle(axis,angle/2);for(const radius of [inner+data.thickness+lift,inner-lift])offsets.push(center.clone().addScaledVector(out,-radius));}
  const ends=offsets.flatMap(p=>[p.clone().addScaledVector(axis,e.low),p.clone().addScaledVector(axis,e.high)]);
  entry.line.geometry.dispose();entry.line.geometry=new THREE.BufferGeometry().setFromPoints(ends);entry.line.matrix.copy(parent);
  entry.middle.copy(ends[0]).add(ends[1]).multiplyScalar(.5).applyMatrix4(parent);
 }
 function update(fraction:number){
  const transforms=new Map<number,THREE.Matrix4>([[0,new THREE.Matrix4()]]);const byChild=new Map(data.bends.map(e=>[e.child,e]));
  function world(id:number):THREE.Matrix4{if(transforms.has(id))return transforms.get(id)!;const e=byChild.get(id);if(!e)throw new Error('Invalid fold tree');const parent=world(e.parent);if(fraction<.00001){transforms.set(id,parent.clone());return transforms.get(id)!}const angle=THREE.MathUtils.degToRad(e.angle)*fraction,axis=v(e.axis),d=v(e.d),h=hingePoint(e),allowance=e.allowance??data.allowance;const R=new THREE.Matrix4().makeRotationAxis(axis,angle);const rm=allowance/Math.abs(angle)+(0.5-(e.k_factor??data.k_factor))*data.thickness;const w=new THREE.Vector3().crossVectors(axis,d).multiplyScalar(Math.sign(angle));const tangent=h.clone().addScaledVector(d,-allowance/2);const center=tangent.clone().addScaledVector(w,rm);const end=center.clone().addScaledVector(w.clone().applyMatrix4(R),-rm);const shifted=h.clone().addScaledVector(d,allowance/2).applyMatrix4(R);R.setPosition(end.sub(shifted));const result=parent.clone().multiply(R);transforms.set(id,result);return result}
  for(const [id,plate]of plates)plate.matrix.copy(world(id));
  for(const e of data.bends){const mesh=bends.get(e.id)!;const axis=v(e.axis),d=v(e.d),h=hingePoint(e),allowance=e.allowance??data.allowance;const angle=THREE.MathUtils.degToRad(e.angle)*fraction;let geom:THREE.BufferGeometry;
   if(fraction<.00001){geom=new THREE.BoxGeometry(e.high-e.low,allowance,data.thickness);geom.rotateZ(Math.atan2(axis.y,axis.x));const c=h.clone().addScaledVector(axis,(e.low+e.high)/2);geom.translate(c.x,c.y,c.z)}
   else{const segments=24;const inner=allowance/Math.abs(angle)-(e.k_factor??data.k_factor)*data.thickness;const rm=inner+data.thickness/2;const w=new THREE.Vector3().crossVectors(axis,d).multiplyScalar(Math.sign(angle));const center=h.clone().addScaledVector(d,-allowance/2).addScaledVector(w,rm);const positions:number[]=[];const index:number[]=[];
    for(const length of [e.low,e.high])for(const radius of [inner,inner+data.thickness])for(let k=0;k<=segments;k++){const p=center.clone().addScaledVector(axis,length).addScaledVector(w.clone().applyAxisAngle(axis,angle*k/segments),-radius);positions.push(p.x,p.y,p.z)}
    const n=segments+1;const quad=(a:number,b:number,c:number,d:number)=>index.push(a,b,c,a,c,d);
    for(let k=0;k<segments;k++){quad(k,k+1,2*n+k+1,2*n+k);quad(n+k,3*n+k,3*n+k+1,n+k+1);quad(k,n+k,n+k+1,k+1);quad(2*n+k,2*n+k+1,3*n+k+1,3*n+k)}quad(0,2*n,3*n,n);quad(segments,n+segments,3*n+segments,2*n+segments);
    geom=new THREE.BufferGeometry();geom.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geom.setIndex(index);geom.computeVertexNormals();
   }mesh.geometry.dispose();mesh.geometry=geom;mesh.matrixAutoUpdate=false;mesh.matrix.copy(world(e.parent));drawBend(e,fraction,world(e.parent));
  }
 }
 update(0);return {group,update,overlay,lines};
}
// Saving a bend edit rebuilds the panel and remounts this viewer; the camera is carried over.
const savedCameras=new Map<string,{revisions:string;view:string;pose:CameraPose}>();
export default function ModelViewer(props:Props){
 const host=useRef<HTMLDivElement>(null);const ref=useRef<{fit:()=>void;screenshot:()=>void;apply:(p:Props)=>void}|null>(null);const latest=useRef(props);const [state,setState]=useState('Loading solid geometry…');const [error,setError]=useState(false);const [software,setSoftware]=useState(false);
 // The chosen bend stays highlighted across Flat and Folded; the editor can be closed separately.
 const [selected,setSelected]=useState<number|null>(null);const [editing,setEditing]=useState(false);const chosen=useRef<number|null>(null);
 const [faceInfo,setFaceInfo]=useState<FaceInfo|null>(null);
 function selectBend(id:number|null){chosen.current=id;setSelected(id);setEditing(id!=null&&!!latest.current.bendReview);}
 useEffect(()=>{latest.current=props;},[props]);
 const ids=props.panels.map(p=>p.id+':'+p.revision).join('|');
 useEffect(()=>{let alive=true;let frame=0;const root=host.current!;setState('Loading solid geometry…');setError(false);let renderer:THREE.WebGLRenderer|SoftwareRenderer;
  try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,preserveDrawingBuffer:true})}catch{renderer=new SoftwareRenderer();setSoftware(true)}
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor(props.inspection?INSPECTION.background:0xeef3f3);renderer.outputColorSpace=THREE.SRGBColorSpace;root.appendChild(renderer.domElement);
  if(props.inspection&&renderer instanceof THREE.WebGLRenderer){configureInspectionRenderer(renderer);}
  const scene=new THREE.Scene();const camera=new THREE.PerspectiveCamera(32,1,.001,1000);const centreRay=new THREE.Raycaster();
  const navigation=createOrbitNavigation(camera,renderer.domElement,{pickCentre:()=>{centreRay.setFromCamera(new THREE.Vector2(),camera);return centreRay.intersectObjects(shownModels(),true).find(h=>h.object instanceof THREE.Mesh)?.point??null}});const controls=navigation.controls;
  if(props.inspection)inspectionLighting(scene);else{scene.add(new THREE.HemisphereLight(0xffffff,0x82999d,2.1));const sun=new THREE.DirectionalLight(0xffffff,3);sun.position.set(3,-3,5);scene.add(sun);const fill=new THREE.DirectionalLight(0xc5e5e7,1.3);fill.position.set(-2,2,-4);scene.add(fill);}
  const grid=new THREE.GridHelper(20,100,0xc1d1d1,0xd8e2e2);grid.rotation.x=Math.PI/2;if(props.inspection){prepareInspectionGrid(grid);}scene.add(grid);
  const panelKey=props.panels.map(p=>p.id).join('|');
  const items:{root:THREE.Group;final:THREE.Group;animated:ReturnType<typeof animatedModel>;data:Drawing;panel:Panel;bounds:THREE.Box3;angles:Map<number,number>;bendLines:{id:number;line:THREE.LineSegments}[]}[]=[];
  function layout(){let x=0;const p=latest.current;for(const item of items){const box=item.bounds;const size=box.getSize(new THREE.Vector3());item.root.position.set(x-box.min.x,p.alignment==='near'?-box.min.y:p.alignment==='far'?-box.max.y:-(box.min.y+box.max.y)/2,-box.min.z);x+=size.x+p.gap/1000}grid.position.z=-.012;}
  function shownModels(){return items.map(i=>i.final.visible?i.final:i.animated.group)}
  function modelBox(){const box=new THREE.Box3();for(const item of items){item.root.updateMatrixWorld(true);box.union(new THREE.Box3().setFromObject(item.final.visible?item.final:item.animated.group))}return box}
  let framed=false;
  function fit(){if(!items.length)return;framed=true;const box=modelBox(),size=box.getSize(new THREE.Vector3());const vertical=THREE.MathUtils.degToRad(camera.fov),horizontal=2*Math.atan(Math.tan(vertical/2)*camera.aspect);const dist=(size.length()/2)/Math.sin(Math.min(vertical,horizontal)/2)*1.12+.1;const type=latest.current.view;const direction=type==='top'?new THREE.Vector3(0,0,1):type==='front'?new THREE.Vector3(0,-1,.001):type==='side'?new THREE.Vector3(1,0,.001):new THREE.Vector3(1,-1.25,1.15).normalize();const minDist=Math.max(.01,size.length()*.015);const maxDist=dist*7;controls.minDistance=minDist;controls.maxDistance=maxDist;camera.near=Math.max(.0005,minDist*.015);camera.far=Math.max(100,maxDist*3);camera.updateProjectionMatrix();navigation.setView(box,direction,dist)}
  function apply(p:Props){for(const item of items){
   // Unsaved angles can only be shown by the fold preview; the exported solid is still the old one.
   let preview=false;for(const hinge of item.data.bends){const built=item.angles.get(hinge.id)!;hinge.angle=p.pendingAngles?.[hinge.id]??built;if(hinge.angle!==built)preview=true;}
   item.final.visible=!preview&&p.fraction>=.99999;item.animated.group.visible=!item.final.visible;item.animated.update(p.fraction);item.animated.overlay.visible=!!p.inspection&&p.showBends!==false;if(p.inspection){applyInspectionAppearance(item.final,p.paint,p.wire);applyInspectionAppearance(item.animated.group,p.paint,p.wire);for(const {line} of item.bendLines)line.visible=!p.wire&&p.showBends!==false;continue;}item.final.traverse(o=>{if(o instanceof THREE.Mesh){const mats=Array.isArray(o.material)?o.material:[o.material];for(const mat of mats){if('wireframe'in mat)mat.wireframe=p.wire;if(mat instanceof THREE.MeshStandardMaterial&&o.name.includes('_paint'))mat.color.set(p.paint?0x39a58e:0xb7c5c7)}}});item.animated.group.traverse(o=>{if(o instanceof THREE.Mesh){for(const mat of Array.isArray(o.material)?o.material:[o.material]){if('wireframe'in mat)mat.wireframe=p.wire;if(mat instanceof THREE.MeshStandardMaterial)mat.color.set(p.paint?0x39a58e:0xb7c5c7)}}})}layout();if(framed)navigation.follow(modelBox())}
  ref.current={fit,apply,screenshot:()=>{renderer.render(scene,camera);const a=document.createElement('a');a.href=renderer.domElement.toDataURL('image/png');a.download='FlatForge_3D_view.png';a.click()}};
  let studio:Awaited<ReturnType<typeof createStudioLabels>>=null;const labelAbort=new AbortController();
  const loader=new GLTFLoader();Promise.all(props.panels.map(async panel=>{const [gltf,response]=await Promise.all([loader.loadAsync(fileUrl(panel,'panel.glb')),fetch(fileUrl(panel,'viewer.json'))]);if(!response.ok)throw new Error('Viewer metadata unavailable');const data=await response.json() as Drawing;if(!alive)return;const object=new THREE.Group();const final=gltf.scene;const bounds=new THREE.Box3().setFromObject(final);const animated=animatedModel(data,panel.id,props.inspection);if(props.inspection)prepareInspectionModel(final);
   // A bend meets its faces smoothly, below the crease angle, so each solid bend is outlined on its own.
   const bendMeshes:THREE.Mesh[]=[];if(props.inspection)final.traverse(o=>{if(o instanceof THREE.Mesh&&/^bend_\d+/.test(o.name))bendMeshes.push(o)});const bendLines=bendMeshes.map(mesh=>({id:Number(mesh.name.match(/^bend_(\d+)/)![1]),line:inspectionEdges(mesh)}));
   final.traverse(o=>{o.userData.panelId=panel.id});object.add(final,animated.group);scene.add(object);object.add(animated.overlay);items.push({root:object,final,animated,data,panel,bounds,angles:new Map(data.bends.map(e=>[e.id,e.angle])),bendLines})})).then(()=>{if(!alive)return;items.sort((a,b)=>props.panels.findIndex(p=>p.id===a.panel.id)-props.panels.findIndex(p=>p.id===b.panel.id));apply(latest.current);fit();const saved=savedCameras.get(panelKey);if(saved&&saved.revisions!==ids&&saved.view===latest.current.view)navigation.setPose(saved.pose);setState('');const single=items.length===1?items[0]:null;if(single&&props.inspection&&!single.panel.sample)createStudioLabels({panel:single.panel,scene,camera,host:root,model:single.final,signal:labelAbort.signal,onPick:info=>{clearPlate();selectBend(null);setFaceInfo(info);}}).then(result=>{if(!alive){result?.dispose();return;}studio=result;}).catch(()=>{if(alive)latest.current.onHover('Face labels are unavailable for this panel.');});}).catch(()=>{if(alive){setState('Unable to load the 3D result. Retry or download the STEP file.');setError(true)}});
  const ray=new THREE.Raycaster(),mouse=new THREE.Vector2();const move=(event:PointerEvent)=>{if(event.buttons){latest.current.onHover(null);return;}const rect=renderer.domElement.getBoundingClientRect();mouse.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);ray.setFromCamera(mouse,camera);const hits=ray.intersectObjects(shownModels(),true);let message:string|null=null;if(hits.length){const object=hits[0].object;const match=object.name.match(/bend_(\d+)/);const item=items.find(i=>i.panel.id===object.userData.panelId);const hinge=object.userData.hinge as Hinge|undefined;const e=hinge??(match&&item?item.data.bends.find(b=>b.id===Number(match[1])):undefined);if(e)message=`${e.name} · ${e.angle>0?'+':''}${e.angle}° · ${e.source.map(s=>s.profile+(s.vertex?' / vertex '+s.vertex:'')).join(', ')}`;}latest.current.onHover(message)};
  renderer.domElement.addEventListener('pointermove',move);renderer.domElement.addEventListener('pointerleave',()=>latest.current.onHover(null));
  let _hMat=new THREE.MeshStandardMaterial({color:0xff7a00,emissive:0xaa4400,emissiveIntensity:0.35,side:THREE.DoubleSide}),_painted:{mesh:THREE.Mesh;material:THREE.Material|THREE.Material[]}[]=[];
  function clearPlate(){for(const entry of _painted)entry.mesh.material=entry.material;_painted=[];}
  function paintPlate(meshes:THREE.Mesh[]){for(const mesh of meshes){_painted.push({mesh,material:mesh.material});mesh.material=_hMat;}}
  let _px=0,_py=0;const _pd=(e:PointerEvent)=>{_px=e.clientX;_py=e.clientY;};
  const _pu=(e:PointerEvent)=>{if(!latest.current.inspection||e.button!==0||navigation.moved)return;const dx=e.clientX-_px,dy=e.clientY-_py;if(dx*dx+dy*dy>NAVIGATION.clickTolerance**2)return;const rect=renderer.domElement.getBoundingClientRect();mouse.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);ray.setFromCamera(mouse,camera);const hit=ray.intersectObjects(shownModels(),true).find(h=>h.object instanceof THREE.Mesh);const obj=hit?.object as THREE.Mesh|undefined;clearPlate();
   const hinge=obj?.userData.hinge as Hinge|undefined,named=obj?.name.match(/bend_(\d+)/),bendId=hinge?.id??(named?Number(named[1]):undefined);
   if(bendId!==undefined&&latest.current.reportBends?.some(b=>b.id===bendId)){studio?.clear();setFaceInfo(null);selectBend(bendId);return;}
   selectBend(null);
   const faceName=obj?.userData.faceName as string|undefined;
   if(obj&&faceName){studio?.clear();paintPlate(obj.parent!.children.filter((c):c is THREE.Mesh=>c instanceof THREE.Mesh));setFaceInfo({title:`Face ${faceName}`,detail:'Flat pattern face'});return;}
   if(studio&&items[0]?.final.visible)studio.pick(ray);else{studio?.clear();setFaceInfo(null);}};
  const bendLabels=props.inspection?createBendLabels(root,id=>{clearPlate();studio?.clear();setFaceInfo(null);selectBend(id);}):null;
  function updateBends(){
   const p=latest.current,item=items[0];if(!bendLabels||!item)return;const shown=p.showBends!==false;
   // The exported solid has its own bend outlines; overlay lines serve the flat sheet and the fold preview.
   // A selected bend stays marked in every view, even when the other lines are switched off.
   const flat=p.fraction<.00001;
   item.animated.overlay.visible=shown||chosen.current!=null;
   for(const [id,{line}]of item.animated.lines){const active=chosen.current===id;markBendLine(line,active);line.visible=flat?shown||active:active&&!item.final.visible;}
   for(const {id,line}of item.bendLines){const active=chosen.current===id;markBendLine(line,active);line.visible=!p.wire&&(shown||active);}
   item.animated.overlay.updateWorldMatrix(true,false);
   bendLabels.update(item.data.bends.filter(e=>flat&&(shown||chosen.current===e.id)&&p.reportBends?.some(b=>b.id===e.id)).map(e=>({id:e.id,text:`${e.name} · ${e.angle>0?'+':''}${Number(e.angle.toFixed(3))}°`,title:`Edit bend ${e.name} · F${e.parent} → F${e.child}`,anchor:item.animated.lines.get(e.id)!.middle.clone().applyMatrix4(item.animated.overlay.matrixWorld),selected:chosen.current===e.id,changed:p.pendingAngles?.[e.id]!==undefined})),camera);
  }
  renderer.domElement.addEventListener('pointerdown',_pd);renderer.domElement.addEventListener('pointerup',_pu);
  const resize=new ResizeObserver(()=>{const w=root.clientWidth,h=root.clientHeight;if(!w||!h)return;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix()});resize.observe(root);
  // Seen from underneath, the floor grid would cross in front of the panel.
  function loop(){frame=requestAnimationFrame(loop);navigation.update();grid.visible=camera.position.z>grid.position.z;updateBends();renderer.render(scene,camera);studio?.update()}loop();
  return()=>{alive=false;if(framed)savedCameras.set(panelKey,{revisions:ids,view:latest.current.view,pose:navigation.getPose()});cancelAnimationFrame(frame);resize.disconnect();navigation.dispose();renderer.domElement.removeEventListener('pointerdown',_pd);renderer.domElement.removeEventListener('pointerup',_pu);clearPlate();_hMat.dispose();labelAbort.abort();studio?.dispose();studio=null;bendLabels?.dispose();setFaceInfo(null);selectBend(null);scene.traverse(o=>{if(o instanceof THREE.Mesh||o instanceof THREE.LineSegments){o.geometry.dispose();for(const mat of Array.isArray(o.material)?o.material:[o.material])mat.dispose()}});renderer.dispose();renderer.domElement.remove();ref.current=null};
 // Geometry changes require a fresh scene, presentation changes do not.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[ids,props.inspection]);
 const pendingKey=JSON.stringify(props.pendingAngles??{});
 useEffect(()=>{ref.current?.apply(latest.current)},[props.fraction,props.paint,props.wire,props.gap,props.alignment,props.inspection,props.showBends,pendingKey]);
 useEffect(()=>{ref.current?.fit()},[props.view,props.gap,props.alignment]);
 const bend=props.bendReview&&selected!=null?props.reportBends?.find(b=>b.id===selected):undefined;
 return <div className="viewer-stage"><div ref={host} className="webgl-host"/>{state&&<div className="viewer-loading">{error?<Box/>:<LoaderCircle className="spin"/>}<span>{state}</span></div>}<div className="viewport-actions">{props.fullscreen&&<Button variant="outline" size="icon" className="viewer-close" aria-label="Close full screen" title="Close full screen (Esc)" onClick={()=>props.onFullscreen?.(false)}><X/></Button>}{props.onFullscreen&&!props.fullscreen&&<Button variant="outline" size="icon" aria-label="Open full screen" title="Open full screen" onClick={()=>props.onFullscreen?.(true)}><Maximize2/></Button>}<Button variant="outline" size="icon" aria-label="Fit model to view" title="Reset view" onClick={()=>ref.current?.fit()}><RotateCcw/></Button><Button variant="outline" size="icon" aria-label="Download viewport PNG" title="Download image" onClick={()=>ref.current?.screenshot()}><Camera/></Button></div><div className="axis-key"><span className="x">X</span><span className="y">Y</span><span className="z">Z</span><small>mm</small></div><div className="viewport-help">{software&&<div className="vh-row"><span className="vh-key">⚠</span><span>Software renderer</span></div>}<div className="vh-row"><span className="vh-key">Left drag</span><span>Orbit / rotate</span></div><div className="vh-row"><span className="vh-key">Right drag</span><span>Pan</span></div><div className="vh-row"><span className="vh-key">Scroll</span><span>Zoom</span></div>{props.bendReview&&<div className="vh-row"><span className="vh-key">Click bend</span><span>Edit angle</span></div>}<div className="vh-row"><span className="vh-key">↺</span><span>Reset view</span></div>{props.onFullscreen&&<div className="vh-row"><span className="vh-key">⤢</span><span>Full screen</span></div>}</div>{faceInfo&&selected==null&&props.inspection&&<div className="face-chip" role="status"><div><strong>{faceInfo.title}</strong><small>{faceInfo.detail}</small></div><button aria-label="Close face label" onClick={()=>setFaceInfo(null)}>✕</button></div>}{bend&&editing&&props.bendReview&&<BendEditor
   key={bend.key+JSON.stringify([bendFields.map(field=>bendInputValue(bend,props.bendReview!.settings,props.bendReview!.review,field)),props.bendReview.review.bend_parameters[bend.key],props.bendReview.settings.bend_model])}
   bend={bend} names={`F${bend.parent} → F${bend.child}`} settings={props.bendReview.settings} review={props.bendReview.review} resolution={props.bendReview.resolution} sectionReviewRequired={props.bendReview.sectionReviewRequired}
   style={{left:12,top:12,maxHeight:'calc(100% - 24px)'}} onCancel={()=>setEditing(false)}
   onApply={patch=>{if(Object.keys(patch).length)props.bendReview!.onApply(bend.key,patch);setEditing(false);}}
   onAutomatic={()=>{props.bendReview!.onApply(bend.key,null);setEditing(false);}}/>}</div>
}
