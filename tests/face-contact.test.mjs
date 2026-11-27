import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedPairs, faceContact, pairKey } from '../components/flatforge/face-contact.ts';

// The target is the +X side of a panel occupying x 0..100; the other panel comes from the right.
const side = (x, y = 0, z = 0) => [[x, y, z], [x, y + 50, z], [x, y + 50, z + 20], [x, y, z + 20]];
const target = { points: side(100), normal: [1, 0, 0] };
const state = (gap, { y = 0, normal = [-1, 0, 0] } = {}) => faceContact({ points: side(100 + gap, y), normal }, target,
  { moving: { min: [100 + gap, y, 0], max: [200 + gap, y + 50, 20] }, target: { min: [0, 0, 0], max: [100, 50, 20] } });

test('faces still apart are being joined', () => {
  for (const gap of [250, 10, 1, .2]) assert.equal(state(gap), 'joining', String(gap));
});

test('faces on one plane and over each other are matched, within 0.1 mm', () => {
  for (const gap of [0, .00001, .1, -.1]) assert.equal(state(gap), 'matched', String(gap));
  assert.equal(state(0, { y: 45 }), 'matched', 'partly overlapping faces still touch');
});

test('a panel pushed past the face is inside', () => {
  for (const gap of [-.2, -1, -40]) assert.equal(state(gap), 'inside', String(gap));
});

test('sliding clear, passing right through, or turning away is not a match', () => {
  assert.equal(state(0, { y: 60 }), 'joining', 'on the plane but beside the face');
  assert.equal(state(-5, { y: 60 }), 'joining', 'behind the plane but beside the panel');
  assert.equal(state(-250), 'joining', 'out of the far side, no shared space left');
  assert.equal(state(0, { normal: [0, 1, 0] }), 'joining', 'faces not parallel');
});

test('faces facing the same way (flush) are matched on one plane too', () => {
  assert.equal(state(0, { normal: [1, 0, 0] }), 'matched');
});

test('pairs come from face mates and from older single connections', () => {
  const face = n => ({ faceId: `face-${n}`, sourceSha: 'a', point: [0, 0, 0] });
  const entries = [
    { id: 'a', targetId: null },
    { id: 'b', targetId: 'a', planeMates: [{ targetId: 'a', moving: face(1), reference: face(2) }] },
    { id: 'c', targetId: 'b', connection: { moving: face(3), reference: face(4) } },
    { id: 'd', targetId: 'a' },
  ];
  assert.deepEqual(connectedPairs(entries).map(pairKey), ['b:face-1>a:face-2', 'c:face-3>b:face-4']);
});
