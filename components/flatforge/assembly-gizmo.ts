import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * Translation handles on the selected panel, along the assembly's own axes:
 * X left/right, Y forward/back, Z up/down. Drags snap to 1 mm, or 0.1 mm with Shift.
 * A drag only previews the move; on release the CAD service places and checks the panel.
 */
export function createAssemblyGizmo(options:{scene:THREE.Scene;camera:THREE.Camera;canvas:HTMLCanvasElement;orbit:OrbitControls;
  groups:Map<string,{group:THREE.Group;localBounds:THREE.Box3}>;
  onStart:()=>void;onDrag:(delta:number[])=>void;onEnd:(id:string,delta:number[])=>void}) {
  const control=new TransformControls(options.camera,options.canvas),anchor=new THREE.Object3D();
  options.scene.add(anchor);const helper=control.getHelper();options.scene.add(helper);
  control.setMode('translate');control.setSpace('world');control.setSize(.9);
  let id:string|null=null,active:string|null=null,fine=false;
  const from=new THREE.Vector3(),origin=new THREE.Vector3(),delta=new THREE.Vector3();
  /** Keeps the handles on the middle of the selected panel. */
  function refresh(){
    const item=id?options.groups.get(id):undefined;if(!item||control.dragging)return;
    item.group.updateMatrixWorld(true);
    item.localBounds.clone().applyMatrix4(item.group.matrixWorld).getCenter(anchor.position);anchor.updateMatrixWorld(true);
  }
  function set(next:string|null){
    if(control.dragging)return;
    id=next&&options.groups.has(next)?next:null;
    if(!id){control.detach();return;}
    refresh();control.attach(anchor);
  }
  // Capture phase: the snap step is known before the controller handles the same movement.
  const pointer=(e:PointerEvent)=>{fine=e.shiftKey;};options.canvas.addEventListener('pointermove',pointer,true);
  control.addEventListener('mouseDown',()=>{
    const item=id?options.groups.get(id):undefined;if(!item)return;
    active=id;from.copy(anchor.position);origin.copy(item.group.position);delta.set(0,0,0);
    options.orbit.enabled=false;options.onStart();
  });
  control.addEventListener('objectChange',()=>{
    const item=active&&control.dragging?options.groups.get(active):undefined;if(!item)return;
    const step=fine?.1:1,snap=(metres:number)=>Math.round(metres*1000/step)*step;
    delta.set(snap(anchor.position.x-from.x),snap(anchor.position.y-from.y),snap(anchor.position.z-from.z));
    anchor.position.copy(from).addScaledVector(delta,.001);
    item.group.position.copy(origin).addScaledVector(delta,.001);item.group.updateMatrixWorld(true);
    options.onDrag(delta.toArray().map(v=>Math.round(v*10)/10));
  });
  control.addEventListener('mouseUp',()=>{
    if(!active)return;const moved=active;active=null;options.orbit.enabled=true;
    options.onEnd(moved,delta.toArray().map(v=>Math.round(v*10)/10));
  });
  return {set,refresh,get dragging(){return control.dragging;},get intercepting(){return control.enabled&&!!control.object&&!!control.axis;},
    dispose(){options.orbit.enabled=true;control.detach();control.dispose();options.scene.remove(helper,anchor);options.canvas.removeEventListener('pointermove',pointer,true);}};
}
