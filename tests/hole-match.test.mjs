import test from 'node:test';
import assert from 'node:assert/strict';
import { innerLoops, matchHoles, panelHoles } from '../components/flatforge/hole-match.ts';

/** A flat 100 × 40 plate at height z with 12 × 3 slots, triangulated as a grid without the slot cells. */
function plate(z, slots, normal = [0, 0, 1]) {
  const xs = [...new Set([0, 100, ...slots.flatMap(([x]) => [x - 6, x + 6])])].sort((a, b) => a - b);
  const ys = [...new Set([0, 40, ...slots.flatMap(([, y]) => [y - 1.5, y + 1.5])])].sort((a, b) => a - b);
  const positions = [], indices = [];
  for (let i = 0; i + 1 < xs.length; i++) for (let j = 0; j + 1 < ys.length; j++) {
    const mx = (xs[i] + xs[i + 1]) / 2, my = (ys[j] + ys[j + 1]) / 2;
    if (slots.some(([x, y]) => Math.abs(mx - x) < 6 && Math.abs(my - y) < 1.5)) continue;
    // Every cell repeats its own vertices, as separate tessellation patches would.
    const n = positions.length / 3;
    positions.push(xs[i], ys[j], z, xs[i + 1], ys[j], z, xs[i + 1], ys[j + 1], z, xs[i], ys[j + 1], z);
    indices.push(n, n + 1, n + 2, n, n + 2, n + 3);
  }
  return { supported: true, normal, positions, indices };
}
const SLOTS = [[20, 20], [70, 20]];
const sheet = (z, slots = SLOTS) => panelHoles([plate(z + 2, slots), plate(z, slots, [0, 0, -1])]);
const shifted = (holes, delta) => holes.map(hole => ({ ...hole, centre: hole.centre.map((v, i) => v + delta[i]) }));

test('slot centres are read from a face, and its outline is not a hole', () => {
  const face = plate(0, SLOTS);
  assert.deepEqual(innerLoops(face.positions, face.indices).sort((a, b) => a[0] - b[0]), [[20, 20, 0], [70, 20, 0]]);
  const plain = plate(0, []);
  assert.deepEqual(innerLoops(plain.positions, plain.indices), []);
});

test('both sides of a sheet make one hole as thick as the sheet', () => {
  const holes = sheet(4);
  assert.equal(holes.length, 2);
  for (const hole of holes) assert.deepEqual([hole.centre[2], hole.half], [5, 1]);
});

test('a sheet resting on the other with holes lined up is matched', () => {
  const lower = sheet(4), upper = sheet(6);
  for (const delta of [[0, 0, 0], [.7, -.6, 0], [0, 0, .5], [0, 0, -.5]]) {
    const found = matchHoles(shifted(upper, delta), lower);
    assert.equal(found.matched.length, 2, String(delta));
    assert.equal(found.inside.length, 0);
  }
});

test('holes that are off, or sheets apart, are not matched and report the movement needed', () => {
  const lower = sheet(4), upper = sheet(6);
  const off = matchHoles(shifted(upper, [0, -4, -1]), lower);
  assert.equal(off.matched.length + off.inside.length, 0);
  assert.deepEqual(off.move.map(v => v + 0), [0, 4, 1]);
  const above = matchHoles(shifted(upper, [0, 0, 3]), lower);
  assert.equal(above.matched.length, 0);
  assert.deepEqual(above.move.map(v => v + 0), [0, 0, -3]);
  assert.equal(matchHoles(shifted(upper, [200, 0, 0]), lower).move, null, 'too far to suggest');
});

test('lined-up sheets that share the same space are inside', () => {
  const lower = sheet(4);
  for (const z of [4, 5]) {
    const found = matchHoles(sheet(z), lower);
    assert.equal(found.inside.length, 2, String(z));
    assert.equal(found.matched.length, 0);
  }
});
