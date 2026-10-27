import test from 'node:test';
import assert from 'node:assert/strict';
import { beginFaceDraft, updateFaceDraft, previewFaceDraft, faceDraftError, reselectFaceDraft } from '../components/flatforge/face-connection-state.ts';
import { decodeAssemblies, encodeAssemblies } from '../components/flatforge/assembly-storage.ts';

const root={id:'a',panelId:'p',targetId:null,targetFace:null,myFace:'-X',gap:10};
const original={...root,id:'b',targetId:'a',targetFace:'+X'};
const reference={faceId:'face-1',sourceSha:'a'.repeat(64),point:[1,2,3]};
const moving={...reference,faceId:'face-7',point:[4,5,6]};
const complete=()=>updateFaceDraft(beginFaceDraft(original),{reference,moving});

test('face edits are drafts, preserve identity, and round-trip with local mm offsets',()=>{
  const draft=complete();draft.fields={gap:'20',u:'-3.5',v:'50',normal:'2.25',twist:'-18'};
  const saved=previewFaceDraft(draft);
  assert.equal(original.connection,undefined);assert.equal(saved.id,original.id);
  assert.deepEqual(saved.connection,{type:'planar',reference,moving,offsetU:-3.5,offsetV:50,normalOffset:2.25,twist:-18});
  const state={project:[root,saved]};assert.deepEqual(decodeAssemblies(encodeAssemblies(state)),state);
  assert.deepEqual(beginFaceDraft(saved).fields,draft.fields);
});

test('incomplete, invalid, or negative effective gaps never replace a valid preview',()=>{
  const draft=complete();
  for(const [key,value] of [['gap',''],['v','Infinity'],['u','not-a-number'],['gap','-1'],['normal','-11']]){
    const next=updateFaceDraft(draft,{fields:{...draft.fields,[key]:value}});
    assert.ok(faceDraftError(next));assert.equal(previewFaceDraft(next),undefined);
    assert.deepEqual(next.preview,draft.preview);
  }
  assert.equal(previewFaceDraft(beginFaceDraft(original)),undefined);
  assert.equal(previewFaceDraft(updateFaceDraft(draft,{reference:undefined})),undefined);
});

test('saved face references reject malformed IDs, anchors, numbers and cyclic parents',()=>{
  for(const mutate of [e=>{e.connection.reference.sourceSha='bad';},e=>{e.connection.moving.point=[1,2];},e=>{e.connection.offsetV=null;},e=>{e.targetId='b';},e=>{e.connection.normalOffset=-11;}]){
    const saved=structuredClone(previewFaceDraft(complete()));mutate(saved);
    assert.throws(()=>decodeAssemblies(encodeAssemblies({p:[root,saved]})));
  }
});

test('reselecting stale faces repairs obsolete envelope metadata only in the draft',()=>{
  const saved={...previewFaceDraft(complete()),gap:37,spacing:{x:{side:1,gap:10},y:{side:0,gap:0},z:{side:0,gap:0}}};
  const draft=reselectFaceDraft(beginFaceDraft(saved));
  assert.equal(draft.preview.spacing.x.gap,37);assert.equal(draft.preview.gap,37);
  assert.equal(draft.preview.connection,undefined);assert.equal(previewFaceDraft(draft),undefined);
  assert.equal(saved.spacing.x.gap,10);assert.ok(saved.connection);
});
