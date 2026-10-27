import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { decodeAssemblies, encodeAssemblies } from '../components/flatforge/assembly-storage.ts';
// Compile this browser module with the project's TypeScript compiler. Resolve
// its one runtime dependency to the original source for Node's type stripper.
const source=fs.readFileSync(new URL('../components/flatforge/assembly-workspace-state.ts',import.meta.url),'utf8');
const compiled=ts.transpile(source,{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}).replace("'./face-connection-state'",JSON.stringify(new URL('../components/flatforge/face-connection-state.ts',import.meta.url).href));
const {alphabeticLabel,namedEntries,nextLabel,faceSide,faceReference,descendants,stagedPanel,positionValues,withPosition,recordAction}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const root={id:'a',panelId:'one',targetId:null,targetFace:null,myFace:'-X',gap:10};
const ref={faceId:'face-3',sourceSha:'a'.repeat(64),point:[0,0,0]};
const child={...root,id:'b',panelId:'two',targetId:'a',targetFace:'+X',connection:{type:'planar',reference:ref,moving:ref,offsetU:0,offsetV:0,normalOffset:0,twist:17}};
test('stable alphabetic labels survive branches, deletion, and >26 panels without mutating saved data',()=>{
 assert.deepEqual([0,25,26,51,52,99].map(alphabeticLabel),['A','Z','AA','AZ','BA','CV']);
 const old=[root,{...child,label:'D'}];assert.deepEqual(namedEntries(old).map(e=>e.label),['A','D']);assert.equal(root.label,undefined);
 assert.equal(nextLabel(namedEntries(old)),'B');assert.equal(nextLabel([{...child,label:'C'},{...root,label:'A'}]),'B');
});
test('source-local face names and actual triangle anchors distinguish angled surfaces and holes',()=>{
 const face={id:'face-7',type:'PLANE',supported:true,normal:[Math.SQRT1_2,0,Math.SQRT1_2],positions:[10,10,3,20,10,3,10,20,3],indices:[0,1,2]};
 assert.match(faceSide(face),/^Angled toward Right — Face 7$/);
 assert.equal(faceSide({...face,normal:[0,0,-1]}),'Bottom — Face 7');
 const r=faceReference({sourceSha:ref.sourceSha},face);assert.deepEqual(r.point,[40/3,40/3,3]);
 assert.throws(()=>faceReference({}, {...face,positions:[0,0,0,0,0,0,0,0,0]}),/reliable/);
});
test('staged panels use complete actual assembly bounds, retaining a separate requested gap',()=>{
 const rows=namedEntries([root,child]);const draft=stagedPanel(rows,'three','c',{bounds:{a:{min:[-40,-20,0],max:[60,20,3]},b:{min:[90,0,0],max:[500,30,6]}}},23.5);
 assert.equal(draft.preview.gap,463.5);assert.equal(draft.fields.gap,'23.5');assert.equal(draft.preview.label,'C');assert.equal(rows.length,2);
});
test('local movement changes only the selected engineering values; root axes map to world mm',()=>{
 const moved=withPosition(child,{u:-13.125,v:50,normal:2});assert.deepEqual(positionValues(moved),{u:-13.125,v:50,normal:2});assert.equal(moved.gap,10);assert.equal(moved.connection.twist,17);assert.equal(child.connection.offsetV,0);
 const origin=withPosition(root,{u:1,v:50,normal:-25});assert.deepEqual(origin.rootOffset,[1,25,50]);assert.deepEqual(positionValues(origin),{u:1,v:50,normal:-25});
 assert.throws(()=>withPosition(child,{u:0,v:0,normal:-11}),/negative/);assert.throws(()=>withPosition(root,{u:NaN,v:0,normal:0}),/finite/);
 const rows=[root,child,{...child,id:'c',targetId:'b'},{...child,id:'d',targetId:'a'}];assert.deepEqual([...descendants(rows,'b')],['b','c']);
});
test('undo snapshots and persistence retain identities, original gaps, root offsets and face anchors',()=>{
 const rows=namedEntries([withPosition(root,{u:1,v:2,normal:3}),child]);const state={project:rows};assert.deepEqual(decodeAssemblies(encodeAssemblies(state)),state);
 const h=recordAction({past:[],future:[[]]},rows);rows[1].gap=25;assert.equal(h.past[0][1].gap,10);assert.deepEqual(h.future,[]);
 for(const bad of [{...root,rootOffset:[1,2]},{...child,rootOffset:[0,0,0]},{...root,label:'1'},{...root,label:'A',id:'z',targetId:'a'}])assert.throws(()=>decodeAssemblies(encodeAssemblies({p:[{...root,label:'A'},bad]})));
});
