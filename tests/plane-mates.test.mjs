import test from 'node:test';
import assert from 'node:assert/strict';
import { baseId, chooseMoving, convertedMate, dependsOn, mateTitle, measureFaces, motionText, newSession, panelStatus, sessionMate, withMate, withoutMate, withoutTargets } from '../components/flatforge/plane-mates.ts';

const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const at = (x, y = 0, z = 0) => [...identity.slice(0, 12), x, y, z, 1];
const sha = 'a'.repeat(64);
const ref = n => ({ faceId: `face-${n}`, sourceSha: sha, point: [0, 0, 0] });
const root = { id: 'a', panelId: 'pa', targetId: null, targetFace: null, myFace: '-X', gap: 10 };
const parked = id => ({ id, panelId: 'p' + id, targetId: 'a', targetFace: '+X', myFace: '-X', gap: 10,
  pose: { matrix: at(500), sourceSha: sha, pivot: [0, 0, 0], axis: [0, 0, 1], offset: [0, 0, 0], turn: 0 } });
const mate = (id, targetId = 'a', offset = 0) => ({ id, targetId, type: offset ? 'distance' : 'coincident', offset, aligned: false, reference: ref(1), moving: ref(2) });
const entries = [root, parked('b'), parked('c')];
const placement = { entries: entries.map((e, i) => ({ ...e, matrix: at(i * 200) })), sourceHashes: { a: sha, b: sha, c: sha },
  bounds: Object.fromEntries(entries.map((e, i) => [e.id, { min: [i * 200, 0, 0], max: [i * 200 + 100, 50, 20] }])) };

test('the base never moves, whichever face is picked first', () => {
  assert.equal(baseId(entries), 'a');
  assert.deepEqual(chooseMoving(entries, 'a', 'b'), { movingId: 'b', targetId: 'a', swapped: true });
  assert.deepEqual(chooseMoving(entries, 'b', 'a'), { movingId: 'b', targetId: 'a', swapped: false });
  assert.match(chooseMoving(entries, 'b', 'b').error, /different panel/);
});

test('the panel being worked on moves, and finished panels stay put', () => {
  assert.equal(chooseMoving(entries, 'b', 'c').movingId, 'b');
  assert.equal(chooseMoving(entries, 'b', 'c', 'c').movingId, 'c');
  assert.equal(chooseMoving(entries, 'b', 'c', undefined, ['b']).movingId, 'c');
});

test('a panel is never moved onto its own follower', () => {
  const chained = withMate(entries, 'c', mate('m', 'b'), placement);
  assert.equal(dependsOn(chained, 'c', 'b'), true);
  assert.deepEqual(chooseMoving(chained, 'b', 'c'), { movingId: 'c', targetId: 'b', swapped: true });
});

test('measured faces propose the current facing and signed gap', () => {
  const target = { matrix: identity, normal: [1, 0, 0], point: [100, 0, 0] };
  assert.deepEqual(measureFaces({ matrix: at(125), normal: [-1, 0, 0], point: [0, 0, 0] }, target), { aligned: false, offset: 25 });
  assert.deepEqual(measureFaces({ matrix: at(70), normal: [1, 0, 0], point: [0, 0, 0] }, target), { aligned: true, offset: -30 });
});

test('a session only becomes a mate once both faces and a finite value exist', () => {
  const session = { ...newSession(), pick: null, mateId: 'm1', moving: { entryId: 'b', face: ref(2) }, target: { entryId: 'a', face: ref(1) } };
  assert.equal(sessionMate({ ...session, target: undefined }), null);
  assert.equal(sessionMate(session).offset, 0);
  assert.equal(sessionMate({ ...session, lineUp: true }).lineUp, true);
  assert.equal(sessionMate({ ...session, type: 'distance', distance: '' }), null);
  assert.equal(sessionMate({ ...session, type: 'distance', distance: '20', reverse: true }).offset, -20);
});

test('mates accumulate, are replaced by id, and seed the solve from the current position', () => {
  const one = withMate(entries, 'b', mate('m1'), placement);
  const two = withMate(one, 'b', mate('m2'), placement);
  const edited = withMate(two, 'b', mate('m1', 'a', 20), placement);
  assert.deepEqual(edited[1].planeMates.map(m => [m.id, m.offset]), [['m1', 20], ['m2', 0]]);
  assert.deepEqual(edited[1].pose.matrix, at(200));
  assert.equal(edited[1].connection, undefined);
  assert.equal(edited[0], root);
  assert.equal(edited[2], entries[2]);
  assert.deepEqual(entries[1].planeMates, undefined, 'inputs are not mutated');
  assert.equal(withoutMate(withoutMate(edited, 'b', 'm1', placement), 'b', 'm2', placement)[1].planeMates, undefined);
});

test('an applied snap connection is kept as the first mate', () => {
  const snapped = { ...parked('b'), pose: undefined, mateState: 'active', gap: 15,
    connection: { type: 'planar', reference: ref(3), moving: ref(4), offsetU: 0, offsetV: 0, normalOffset: 5, twist: 0 } };
  assert.deepEqual(convertedMate(snapped), { id: 'snap-b', targetId: 'a', type: 'distance', offset: 20, aligned: false, reference: ref(3), moving: ref(4) });
  const added = withMate([root, snapped, parked('c')], 'b', mate('m2'), placement);
  assert.deepEqual(added[1].planeMates.map(m => m.id), ['snap-b', 'm2']);
  assert.equal(convertedMate({ ...snapped, mateState: 'suspended' }), null);
});

test('removing a panel drops only the mates that pointed at it', () => {
  const chained = withMate(withMate(entries, 'b', mate('keep'), placement), 'b', mate('gone', 'c'), placement);
  const after = withoutTargets(chained.filter(e => e.id !== 'c'), ['c'], placement);
  assert.deepEqual(after[1].planeMates.map(m => m.id), ['keep']);
  assert.throws(() => withoutTargets(chained, ['c'], null), /Wait for the current panel positions/);
});

test('status is only fully defined when the solver says so', () => {
  const mated = withMate(entries, 'b', mate('m1'), placement)[1];
  const report = { status: 'under', dof: 3, translationDof: 2, rotationDof: 1, freeAxes: ['Y', 'Z'], rotationAxis: [-1, 0, 0], mates: [] };
  assert.equal(panelStatus(root).label, 'Base · fixed');
  assert.equal(panelStatus(entries[1]).label, 'Not mated');
  assert.equal(panelStatus(mated).label, 'Checking…');
  assert.equal(panelStatus(mated, report).label, 'Under defined · 3 free');
  assert.equal(panelStatus(mated, { ...report, status: 'defined', dof: 0 }).label, 'Fully defined');
  assert.equal(panelStatus(mated, { ...report, status: 'conflict' }).tone, 'conflict');
  assert.equal(motionText(report), 'Can still slide along Y and Z and turn about X');
  assert.equal(motionText({ ...report, freeAxes: [], translationDof: 1, rotationDof: 0 }), 'Can still slide in 1 direction');
  assert.equal(mateTitle(mate('m', 'a', -20), 'B', 'A'), 'Distance 20 mm · B → A');
});
