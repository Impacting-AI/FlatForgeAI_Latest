import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { inspectionEdges, prepareInspectionModel, applyInspectionAppearance, INSPECTION } from '../components/flatforge/inspection-presentation.ts';

globalThis.ProgressEvent ??= class ProgressEvent extends Event {
  constructor(type, values = {}) { super(type); Object.assign(this, values); }
};
const digest = array => crypto.createHash('sha256').update(Buffer.from(array.buffer, array.byteOffset, array.byteLength)).digest('hex');
function snapshot(root) {
  const rows = [];
  root.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    rows.push({ id:o.uuid, geometry:o.geometry.uuid, index:o.geometry.index && digest(o.geometry.index.array),
      attributes:Object.fromEntries(Object.entries(o.geometry.attributes).map(([name,a])=>[name,digest(a.array)])),
      position:o.position.toArray(), rotation:o.quaternion.toArray(), scale:o.scale.toArray(), matrix:o.matrix.toArray() });
  });
  return rows;
}
function segments(line) {
  const position=line.geometry.attributes.position, result=[];
  for(let i=0;i<position.count;i+=2) result.push([new THREE.Vector3().fromBufferAttribute(position,i),new THREE.Vector3().fromBufferAttribute(position,i+1)]);
  return result;
}

test('coplanar triangles across separate material meshes produce only their perimeter',()=>{
  const root=new THREE.Group();
  for(const coordinates of [[0,0,0,1,0,0,1,1,0],[0,0,0,1,1,0,0,1,0]]) {
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(coordinates,3));
    root.add(new THREE.Mesh(geometry,new THREE.MeshStandardMaterial()));
  }
  const edges=inspectionEdges(root);
  assert.equal(segments(edges).length,4);
  for(const [a,b] of segments(edges))assert.ok(a.x===b.x||a.y===b.y,'No triangulation diagonal');
});

test('thin geometry keeps thickness edges and original transforms, including nested rotation',()=>{
  const root=new THREE.Group(),child=new THREE.Group();child.rotation.z=.37;child.position.set(.07,.2,-.01);
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(.4,.2,.00005),new THREE.MeshStandardMaterial());
  child.add(mesh);root.add(child);root.updateMatrixWorld(true);
  const original=snapshot(root);const before=new THREE.Box3().setFromObject(root,true);
  const edges=inspectionEdges(root);
  assert.equal(segments(edges).length,12,'Even 0.05 mm thickness is not lost by metre-coordinate rounding');
  assert.deepEqual(snapshot(root),original);
  edges.geometry.computeBoundingBox();const after=edges.geometry.boundingBox;
  assert.ok(before.min.distanceTo(after.min)<1e-7&&before.max.distanceTo(after.max)<1e-7);
});

test('a smooth cylinder has rim edges but no tessellation spokes or facet stripes',()=>{
  const mesh=new THREE.Mesh(new THREE.CylinderGeometry(.01,.01,.002,96),new THREE.MeshStandardMaterial());
  const edges=inspectionEdges(mesh),lines=segments(edges);
  assert.equal(lines.length,192);
  for(const [a,b] of lines)assert.ok(Math.abs(a.y-b.y)<1e-8,'No longitudinal cylinder facet edge');
});

test('a hole and an open corner notch retain real rim edges without coplanar diagonals',()=>{
  const shape=new THREE.Shape([[0,0],[.1,0],[.1,.08],[.07,.08],[.07,.1],[0,.1]].map(([x,y])=>new THREE.Vector2(x,y)));
  const hole=new THREE.Path();hole.absarc(.03,.04,.006,0,Math.PI*2,true);shape.holes.push(hole);
  const mesh=new THREE.Mesh(new THREE.ExtrudeGeometry(shape,{depth:.002,bevelEnabled:false,curveSegments:48}),new THREE.MeshStandardMaterial());
  const lines=segments(inspectionEdges(mesh));
  assert.ok(lines.some(([a,b])=>Math.abs(a.x-.07)<1e-7&&Math.abs(b.x-.07)<1e-7),'Notch boundary');
  const onHole=p=>Math.abs(Math.hypot(p.x-.03,p.y-.04)-.006)<1e-7;
  const rims=lines.filter(([a,b])=>onHole(a)&&onHole(b));
  assert.ok(rims.length>=96,'Hole rims remain visible');
  assert.ok(rims.every(([a,b])=>Math.abs(a.z-b.z)<1e-7),'No vertical hole tessellation stripes');
});

test('an untagged single-mesh GLB style keeps neutral surfaces without inventing painted faces',()=>{
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(.2,.1,.002),new THREE.MeshStandardMaterial({color:0x00ff00,vertexColors:true}));
  const root=new THREE.Group();root.add(mesh);prepareInspectionModel(root);
  applyInspectionAppearance(root,true,false);
  assert.equal(mesh.material.color.getHex(),INSPECTION.aluminium);
  assert.equal(mesh.material.userData.inspectionPainted,false);
  assert.equal(mesh.material.vertexColors,false);
});

test('a dense 180,000-triangle surface generates only its perimeter, once',()=>{
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,1,300,300),new THREE.MeshStandardMaterial());
  const before=digest(mesh.geometry.attributes.position.array);
  const started=performance.now(),edges=inspectionEdges(mesh),elapsed=performance.now()-started;
  assert.equal(segments(edges).length,1200);
  assert.equal(digest(mesh.geometry.attributes.position.array),before);
  const buffer=edges.geometry.attributes.position.array;
  for(let i=0;i<100;i++)applyInspectionAppearance(mesh,i%2===0,false);
  assert.equal(edges.geometry.attributes.position.array,buffer);
  console.log(`Dense surface: 180000 triangles, 1200 boundary segments, ${elapsed.toFixed(1)} ms one-time setup; one extra line draw`);
});

test('real folded panels retain every geometry buffer and transform; appearance and edges stay cached',async()=>{
  for(const directory of fs.readdirSync(new URL('../public/samples/',import.meta.url))) {
    const file=new URL(`../public/samples/${directory}/panel.glb`,import.meta.url);
    if(!fs.existsSync(file))continue;
    const bytes=fs.readFileSync(file),hash=digest(bytes);
    const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
    const root=gltf.scene;root.updateMatrixWorld(true);const original=snapshot(root);
    const started=performance.now();const edges=prepareInspectionModel(root);const elapsed=performance.now()-started;
    const buffer=edges.geometry.attributes.position.array;
    for(let i=0;i<20;i++)applyInspectionAppearance(root,i%2===0,i%3===0);
    applyInspectionAppearance(root,true,false);
    assert.deepEqual(snapshot(root),original);
    assert.equal(edges.geometry.attributes.position.array,buffer,'No per-frame/per-toggle edge regeneration');
    assert.equal(digest(fs.readFileSync(file)),hash);
    assert.equal(edges.material.depthTest,true);assert.equal(edges.material.depthWrite,false);
    const hits=[];edges.raycast(new THREE.Raycaster(),hits);assert.deepEqual(hits,[],'Overlay cannot steal hover');
    const triangles=original.reduce((sum,row)=>sum+root.getObjectByProperty('uuid',row.id).geometry.index.count/3,0);
    assert.ok(buffer.length/6<triangles,'Feature lines are substantially fewer than mesh triangle edges');
    root.traverse(o=>{if(o instanceof THREE.Mesh){assert.equal(o.material.vertexColors,false);assert.ok([INSPECTION.aluminium,INSPECTION.paintedFace].includes(o.material.color.getHex()));}});
    console.log(`${directory}: ${triangles} triangles, ${buffer.length/6} feature segments, ${elapsed.toFixed(1)} ms one-time setup`);
  }
});
