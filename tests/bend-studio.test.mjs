import test from 'node:test';
import assert from 'node:assert/strict';
import { bendsChanged, completeBendReview, fillMissingAngles } from '../components/flatforge/bend-review.ts';
import { missingAngleBends, pendingAngles } from '../components/flatforge/flat-pattern.ts';
import { spreadLabels } from '../components/flatforge/bend-overlay.ts';

const settings = { thickness: 2, radius: 2, deduction: 4, input_type: 'flat_pattern' };
const review = (bend_parameters = {}) => ({ parameter_overrides: {}, relief_radii: {}, bend_parameters, section_choices: {}, manual_bends: false, review_note: '', accept_corner_reliefs: false });
const bend = (id, angle, extra = {}) => ({ id, key: 'k' + id, bend_ids: ['C0' + id], parent: 0, child: id, angle, source: [], ...extra });
const bends = [bend(1, 90), bend(2, null), bend(3, -45)];

test('the bulk angle fills only the bends without one', () => {
  const before = review({ k3: { angle: -30 } });
  const keys = missingAngleBends(bends, settings, before).map(b => b.key);
  assert.deepEqual(keys, ['k2']);
  const after = fillMissingAngles(before, keys, 90);
  assert.deepEqual(after.bend_parameters, { k3: { angle: -30 }, k2: { angle: 90 } });
  assert.equal(missingAngleBends(bends, settings, after).length, 0);
  assert.deepEqual(before.bend_parameters, { k3: { angle: -30 } }, 'inputs are not mutated');
});

test('a cleared angle counts as missing again', () => {
  assert.deepEqual(missingAngleBends(bends, settings, review({ k1: { angle: null } })).map(b => b.key), ['k1', 'k2']);
});

test('a rebuild after one edit carries every other angle unchanged', () => {
  const full = completeBendReview(review({ k1: { angle: 60 }, k3: { radius: 3 } }), bends);
  assert.equal(full.manual_bends, true);
  assert.deepEqual(full.bend_parameters, { k1: { angle: 60 }, k3: { radius: 3, angle: -45 } });
});

test('cleared angles stay missing and Use automatic returns the drawing angle', () => {
  const confirmed = bend(4, 12, { confirmed: true, source: [{ profile: 'A', angle: 90 }, { profile: 'USER CONFIRMED', angle: 12 }] });
  assert.deepEqual(completeBendReview(review({ k1: { angle: null }, k4: {} }), [bends[0], confirmed]).bend_parameters,
    { k1: { angle: null }, k4: { angle: 90 } });
});

test('only real bend differences count as edits', () => {
  assert.equal(bendsChanged({ a: { angle: 90, radius: 2 }, b: { angle: 1 } }, { b: { angle: 1 }, a: { radius: 2, angle: 90 } }), false);
  assert.equal(bendsChanged({}, { a: { angle: 90 } }), true);
  assert.equal(bendsChanged({ a: {} }, { a: { angle: 90 } }), true);
});

test('the 3D preview receives only the angles that differ from the built model', () => {
  assert.deepEqual(pendingAngles(bends, settings, review()), {});
  assert.deepEqual(pendingAngles(bends, settings, review({ k1: { angle: 60 }, k3: { angle: -45 }, k2: { angle: 200 } })), { 1: 60 });
});

test('bend labels are moved apart and stay inside the viewer', () => {
  const boxes = Array.from({ length: 8 }, (_, i) => ({ x: 100 + i, y: 50, width: 60, height: 20 }));
  const spread = spreadLabels(boxes, 400);
  for (const [i, a] of spread.entries()) {
    assert.ok(a.y >= 0 && a.y <= 380);
    assert.equal(a.x, boxes[i].x);
    for (const b of spread.slice(i + 1)) assert.ok(Math.abs(a.y - b.y) >= 20, 'labels overlap');
  }
});
