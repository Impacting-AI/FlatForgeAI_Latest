import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {hingeTransforms,bendSegments,createBendOverlay,bendLabel} from '../components/flatforge/BendOverlay.ts';
const fixture=(angle=59.661)=>({thickness:2,radius:2,allowance:4,k_factor:(4/(Math.PI/2)-2)/2,
 faces:[{id:0,polygons:[]},{id:1,polygons:[]},{id:2,polygons:[]}],bends:[
 {id:1,name:'C1',parent:0,child:1,axis:[0,1,0],d:[1,0,0],hinge:[30,0,0],coordinate:30,dim:1,low:0,high:80,angle,allowance:angle===null?0:4*Math.abs(angle)/90,source:[{profile:'HAT',vertex:1}]},
 {id:2,name:'C2',parent:1,child:2,axis:[0,1,0],d:[1,0,0],hinge:[60,0,0],coordinate:60,dim:1,low:0,high:80,angle:-30,allowance:4/3,source:[{profile:'HAT',vertex:2}]}]});
for(const angle of [30,60,59.661,90,120.339])test(`folded hinge and return at ${angle} degrees`,()=>{
 const data=fixture(angle),frames=hingeTransforms(data,1),normal=new THREE.Vector3(0,0,1).transformDirection(frames.get(1));
 assert.ok(Math.abs(normal.z-Math.cos(angle*Math.PI/180))<1e-9);
 const returnNormal=new THREE.Vector3(0,0,1).transformDirection(frames.get(2));
 assert.ok(Math.abs(returnNormal.z-Math.cos((angle-30)*Math.PI/180))<1e-9);
 for(const e of data.bends){const segments=bendSegments(data,e,1,frames);assert.equal(segments.length,4);for(const [a,b] of segments)assert.ok(Math.abs(a.distanceTo(b)-80)<1e-9);}
 const overlay=createBendOverlay(data,'panel');assert.equal(overlay.group.children.length,2);assert.ok(overlay.group.visible);
 overlay.update(.5);overlay.update(1);
 for(const line of overlay.group.children){assert.ok(line.material instanceof THREE.LineDashedMaterial);assert.equal(line.geometry.attributes.position.count,8);assert.ok(line.geometry.attributes.lineDistance);assert.ok(line.userData.hinge);}
 overlay.group.visible=false;assert.equal(overlay.group.visible,false);overlay.dispose();
});
test('unknown rotation stays flat and is labelled for review',()=>{
 const data=fixture(null),e=data.bends[0],overlay=createBendOverlay(data,'panel');
 assert.match(bendLabel(e),/UNKNOWN.*needs review/);assert.equal(overlay.group.children[0].material.color.getHex(),0xe38a18);
 assert.deepEqual(hingeTransforms(data,1).get(1).elements,new THREE.Matrix4().elements);
 assert.equal(bendSegments(data,e,1).length,2);overlay.dispose();
});
test('final overlay uses exact backend coordinates and never inserts a mesh',()=>{
 const data=fixture();data.bends[0].folded_lines=[{face:0,surface:1,points:[[1,2,3],[1,82,3]]}];
 assert.deepEqual(bendSegments(data,data.bends[0],1).map(s=>s.map(p=>p.toArray())),[[[1,2,3],[1,82,3]]]);
 const overlay=createBendOverlay(data,'panel');assert.ok(overlay.group.children.every(o=>o instanceof THREE.LineSegments));assert.equal(overlay.group.scale.x,.001);overlay.dispose();
});
