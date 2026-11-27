import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { withMate } from '../components/flatforge/plane-mates.ts';
// Compile this browser module with the project's TypeScript compiler. Resolve
// its one runtime dependency to the original source for Node's type stripper.
const source = fs.readFileSync(new URL('../components/flatforge/assembly-actions.ts', import.meta.url), 'utf8');
const compiled = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext })
  .replace("'./plane-mates'", JSON.stringify(new URL('../components/flatforge/plane-mates.ts', import.meta.url).href));
const { canMove, connectionStatus, movePanel, planConnection, removePanel } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const at = x => [...identity.slice(0, 12), x, 0, 0, 1];
const sha = 'a'.repeat(64);
const face = (n = 1) => ({ faceId: `face-${n}`, sourceSha: sha, point: [0, 0, 0] });
const root = { id: 'a', label: 'A', panelId: 'pa', targetId: null, targetFace: null, myFace: '-X', gap: 10 };
const parked = id => ({ id, label: id.toUpperCase(), panelId: 'p' + id, targetId: 'a', targetFace: '+X', myFace: '-X', gap: 250 });
const entries = [root, parked('b'), parked('c')];
const placed = rows => ({ entries: rows.map((e, i) => ({ ...e, matrix: at(i * 300) })), sourceHashes: Object.fromEntries(rows.map(e => [e.id, sha])),
  bounds: Object.fromEntries(rows.map((e, i) => [e.id, { min: [i * 300, 0, 0], max: [i * 300 + 100, 50, 20] }])) });
const placement = placed(entries);
// face-1 points +X, face-2 points -X, face-3 points +Z on every panel.
const catalogs = Object.fromEntries(entries.map(e => [e.id, { entryId: e.id, faces: [[1,0,0],[-1,0,0],[0,0,1]].map((normal, i) => ({ id: `face-${i + 1}`, normal })) }]));
const pick = (entryId, n) => ({ entryId, face: face(n) });
const connect = (rows, first, second, preferred) => planConnection(rows, first, second, catalogs, placed(rows), 'new', preferred);
const mate = (id, targetId = 'a') => ({ id, targetId, type: 'coincident', offset: 0, aligned: false, lineUp: true, reference: face(1), moving: face(2) });

test('two picks make one centred face-to-face mate, with the base staying put in either pick order', () => {
  for (const picks of [[pick('b', 2), pick('a', 1)], [pick('a', 1), pick('b', 2)]]) {
    const plan = connect(entries, ...picks);
    assert.equal(plan.movingId, 'b');
    assert.equal(plan.targetId, 'a');
    assert.equal(plan.attempts.length, 1);
    const [made] = plan.attempts[0][1].planeMates;
    assert.deepEqual([made.type, made.offset, made.aligned, made.lineUp, made.moving.faceId, made.reference.faceId], ['coincident', 0, false, true, 'face-2', 'face-1']);
    assert.equal(plan.attempts[0][0], entries[0]);
  }
});

test('a first connection turns faces towards each other even if they currently point the same way', () => {
  assert.equal(connect(entries, pick('b', 1), pick('a', 1)).attempts[0][1].planeMates[0].aligned, false);
});

test('the newly added panel is the one that moves', () => {
  assert.equal(connect(entries, pick('b', 2), pick('c', 1), 'c').movingId, 'c');
});

test('a further connection adds to the earlier one, then falls back to replacing it', () => {
  const connected = connect(entries, pick('b', 2), pick('a', 1)).attempts[0];
  const plan = planConnection(connected, pick('b', 3), pick('a', 3), catalogs, placed(connected), 'second');
  assert.equal(plan.attempts.length, 2);
  assert.deepEqual(plan.attempts[0][1].planeMates.map(m => m.id), ['new', 'second']);
  const added = plan.attempts[0][1].planeMates[1];
  assert.deepEqual([added.aligned, added.lineUp], [true, false], 'faces pointing the same way are made flush');
  assert.deepEqual(plan.attempts[1][1].planeMates.map(m => [m.id, m.aligned, m.lineUp]), [['second', false, true]]);
});

test('unloaded faces and two faces of one panel are refused with a reason', () => {
  assert.match(planConnection(entries, pick('b', 2), pick('a', 1), {}, placement, 'x').error, /not loaded/);
  assert.match(connect(entries, pick('b', 1), pick('b', 2)).error, /different panel/);
});

test('moving a connected panel releases its mate and translates only that panel', () => {
  const connected = withMate(entries, 'b', mate('m'), placement);
  const moved = movePanel(connected, 'b', [5, -2.5, 10], placed(connected));
  assert.equal(moved[1].planeMates, undefined);
  assert.deepEqual(moved[1].pose.matrix, at(300), 'starts from where it is shown');
  assert.deepEqual(moved[1].pose.offset, [5, -2.5, 10]);
  assert.equal(moved[0], connected[0]);
  assert.equal(moved[2], connected[2]);
  assert.equal(connectionStatus(moved[1], moved).label, 'Not connected');
});

test('further steps accumulate exactly and need no new CAD positions', () => {
  let rows = movePanel(entries, 'b', [0.1, 0, 0], placement);
  assert.equal(canMove(rows, 'b', false), true);
  for (let i = 0; i < 2; i++) rows = movePanel(rows, 'b', [0.1, 0, 0], null);
  assert.deepEqual(rows[1].pose.offset, [0.3, 0, 0]);
  assert.equal(canMove(entries, 'b', false), false);
  assert.throws(() => movePanel(entries, 'b', [1, 0, 0], null), /current panel positions/);
});

test('moving the base leaves every panel connected to it where it is', () => {
  const one = withMate(entries, 'b', mate('m'), placement);
  const rows = withMate(one, 'c', mate('n', 'b'), placement);
  const moved = movePanel(rows, 'a', [100, 0, 0], placed(rows));
  assert.deepEqual(moved[0].pose.offset, [100, 0, 0]);
  assert.equal(moved[0].targetId, null);
  assert.equal(moved[1].planeMates, undefined);
  assert.deepEqual([moved[1].pose.matrix, moved[1].pose.offset], [at(300), [0, 0, 0]]);
  assert.equal(moved[2], rows[2], 'a mate to a panel that did not move is kept');
});

test('removing a panel removes only that panel', () => {
  const one = withMate(entries, 'b', mate('m'), placement);
  const rows = withMate(one, 'c', mate('n', 'b'), placement);
  const without = removePanel(rows, 'b', placed(rows));
  assert.deepEqual(without.map(e => e.id), ['a', 'c']);
  assert.equal(without[1].planeMates, undefined);
  assert.deepEqual(without[1].pose.matrix, at(600));
});

test('removing the base makes the next panel the fixed base, in place', () => {
  const rows = withMate(withMate(entries, 'b', mate('m'), placement), 'c', mate('n', 'b'), placement);
  const without = removePanel(rows, 'a', placed(rows));
  assert.deepEqual(without.map(e => [e.id, e.targetId]), [['b', null], ['c', 'b']]);
  assert.equal(without[0].planeMates, undefined);
  assert.deepEqual(without[0].pose.matrix, at(300));
  assert.equal(without[1].planeMates[0].targetId, 'b');
  assert.deepEqual(removePanel([root], 'a', null), []);
});

test('the list says what each panel is connected to', () => {
  const rows = withMate(entries, 'b', mate('m'), placement);
  assert.equal(connectionStatus(rows[0], rows).label, 'Base · fixed');
  assert.equal(connectionStatus(rows[1], rows).label, 'Connected to A');
  assert.equal(connectionStatus(rows[1], rows, { status: 'conflict' }).label, 'Mate conflict');
  assert.equal(connectionStatus(rows[2], rows).label, 'Not connected');
});
