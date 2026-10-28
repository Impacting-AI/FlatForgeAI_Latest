import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
const compile=source=>'data:text/javascript;base64,'+Buffer.from(ts.transpile(source,{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext})).toString('base64');
const helper=compile(fs.readFileSync(new URL('../components/flatforge/assembly-workspace-state.ts',import.meta.url),'utf8').replace("'./face-connection-state'",JSON.stringify(new URL('../components/flatforge/face-connection-state.ts',import.meta.url).href)));
const source=fs.readFileSync(new URL('../components/flatforge/assembly-labels.ts',import.meta.url),'utf8').replace("'./assembly-workspace-state'",JSON.stringify(helper)).replace("'three'",JSON.stringify(import.meta.resolve('three')));
const {surfaceLabelAnchors}=await import(compile(source));

test('surface anchors avoid a central opening instead of using the bounding-box centre',()=>{
 const shape=new THREE.Shape();shape.moveTo(-2,-2);shape.lineTo(2,-2);shape.lineTo(2,2);shape.lineTo(-2,2);shape.closePath();
 const hole=new THREE.Path();hole.moveTo(-1,-1);hole.lineTo(-1,1);hole.lineTo(1,1);hole.lineTo(1,-1);hole.closePath();shape.holes.push(hole);
 const geometry=new THREE.ExtrudeGeometry(shape,{depth:.03,bevelEnabled:false}),original=Array.from(geometry.attributes.position.array),group=new THREE.Group();
 group.add(new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide})));
 const anchors=surfaceLabelAnchors(group);assert.ok(anchors.length>4);
 for(const p of anchors)assert.ok(Math.abs(p.x)>=1-1e-7||Math.abs(p.y)>=1-1e-7,'never anchor inside the cutout');
 assert.deepEqual(Array.from(geometry.attributes.position.array),original);
});
test('nested mesh transforms produce local anchors that follow arbitrary panel rigid transforms',()=>{
 const group=new THREE.Group(),nested=new THREE.Group(),mesh=new THREE.Mesh(new THREE.BoxGeometry(.17,.31,.003));nested.position.set(.2,-.1,.05);nested.rotation.z=.37;nested.add(mesh);group.add(nested);
 const before=surfaceLabelAnchors(group);assert.equal(before.length,12);
 group.position.set(5,-3,1);group.rotation.set(.3,-.6,1.2);group.updateMatrixWorld(true);
 const ray=new THREE.Raycaster();mesh.material.side=THREE.DoubleSide;
 for(const local of before){const world=local.clone().applyMatrix4(group.matrixWorld);let onSurface=false;
  for(const axis of [new THREE.Vector3(1,0,0),new THREE.Vector3(0,1,0),new THREE.Vector3(0,0,1)]){ray.set(world.clone().addScaledVector(axis,.0001),axis.clone().negate());const hit=ray.intersectObject(group,true)[0];if(hit&&hit.point.distanceTo(world)<1e-6)onSurface=true;}
  assert.ok(onSurface,'anchor remains on the transformed body');
 }
});
test('empty or degenerate geometry does not invent a surface anchor',()=>{
 const group=new THREE.Group();assert.deepEqual(surfaceLabelAnchors(group),[]);
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,0,0,0,0,0,0],3));group.add(new THREE.Mesh(geometry));assert.deepEqual(surfaceLabelAnchors(group),[]);
});
