import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CadFrame } from './assembly-cad';
import { descendants, type PositionValues } from './assembly-workspace-state';
import type { AssemblyEntry } from './types';

export type GizmoConfig={id:string;frame:CadFrame;values:PositionValues;gap:number;group?:boolean};
/** A drag is a temporary rigid translation, never a second CAD mate solver.
 * On release the authoritative placement/solid checks replace the preview.
 * No transforms can be saved or exported until that check finishes. */
export function createAssemblyGizmo(options:{scene:THREE.Scene;camera:THREE.Camera;canvas:HTMLCanvasElement;orbit:OrbitControls;
  groups:Map<string,{group:THREE.Group}>;entries:()=>AssemblyEntry[];
  onStart:()=>void;onChange:(values:PositionValues)=>void;onEnd:()=>void}) {
  const control=new TransformControls(options.camera,options.canvas),anchor=new THREE.Object3D();
  options.scene.add(anchor);const helper=control.getHelper();options.scene.add(helper);
  control.setMode('translate');control.setSpace('local');control.setSize(.8);
  control.showXY=false;control.showYZ=false;control.showXZ=false;
  let config:GizmoConfig|null=null,start:GizmoConfig|null=null,fine=false;
  let basePosition=new THREE.Vector3();const basis=new THREE.Matrix4();
  const originals=new Map<string,THREE.Matrix4>();
  function set(next:GizmoConfig|null){
    if(control.dragging)return;
    config=next;
    if(!next){control.detach();return;}
    basis.makeBasis(new THREE.Vector3(...next.frame.u),new THREE.Vector3(...next.frame.v),new THREE.Vector3(...next.frame.n));
    anchor.position.set(...next.frame.origin).multiplyScalar(.001);anchor.quaternion.setFromRotationMatrix(basis);anchor.updateMatrixWorld(true);control.attach(anchor);
  }
  const pointer=(e:PointerEvent)=>{fine=e.shiftKey;};options.canvas.addEventListener('pointermove',pointer);
  control.addEventListener('mouseDown',()=>{
    if(!config)return;start=structuredClone(config);basePosition=anchor.position.clone();originals.clear();
    for(const id of (config.group?descendants(options.entries(),config.id):new Set([config.id]))){const group=options.groups.get(id)?.group;if(group){group.updateMatrix();originals.set(id,group.matrix.clone());}}
    options.orbit.enabled=false;options.onStart();
  });
  control.addEventListener('objectChange',()=>{
    if(!start||!control.dragging)return;
    const local=anchor.position.clone().sub(basePosition).applyMatrix4(basis.clone().invert()).multiplyScalar(1000);
    const step=fine?.1:1;local.set(Math.round(local.x/step)*step,Math.round(local.y/step)*step,Math.round(local.z/step)*step);
    const delta=local.clone().multiplyScalar(.001).applyMatrix4(basis);
    anchor.position.copy(basePosition).add(delta);
    for(const [id,matrix] of originals){const group=options.groups.get(id)!.group;matrix.decompose(group.position,group.quaternion,group.scale);group.position.add(delta);group.updateMatrixWorld(true);}
    options.onChange({u:start.values.u+local.x,v:start.values.v+local.y,normal:start.values.normal+local.z});
  });
  control.addEventListener('mouseUp',()=>{if(start){start=null;options.orbit.enabled=true;options.onEnd();}});
  return {set,get dragging(){return control.dragging;},get intercepting(){return control.enabled&&!!control.object&&!!control.axis;},anchor,helper,
    dispose(){options.orbit.enabled=true;control.detach();control.dispose();options.scene.remove(helper,anchor);options.canvas.removeEventListener('pointermove',pointer);}};
}
