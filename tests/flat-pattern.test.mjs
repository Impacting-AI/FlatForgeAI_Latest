import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewedBend, hingeAnchor, flatProjection, matchesHinge, calloutLayout, editableHinge } from '../components/flatforge/flat-pattern.ts';
import { updateBendParameters, bendInputValue, bendValueError, bendDraftText } from '../components/flatforge/bend-review.ts';

const settings = { thickness: 2, radius: 2, deduction: 4, input_type: 'flat_pattern' };
const bend = { id: 0, key: 'axis:F0:F2', bend_ids: ['C07'], parent: 0, child: 2, angle: -60, source: [] };
const review = { bend_parameters: {}, parameter_overrides: {} };

test('live edits use per-hinge overrides ahead of panel settings and keep signed angles', () => {
  assert.equal(reviewedBend(bend, settings, review).angle, -60);
  const edit = { ...review, bend_parameters: { [bend.key]: { angle: 120, radius: 3, deduction: 5 } } };
  const result = reviewedBend(bend, { ...settings, radius: 8, deduction: 7 }, edit);
  assert.equal(result.angle, 120);
  assert.equal(result.radius, 3);
  assert.equal(result.deduction, 5);
  assert.equal(reviewedBend(bend, { ...settings, radius: 8 }, review).radius, 8);
});

test('missing, cleared, and removed saved angles never fall back to 90 or stale manual values', () => {
  assert.equal(reviewedBend({ ...bend, angle: null }, { ...settings, default_angle: 90 }, review).angle, null);
  assert.equal(reviewedBend(bend, settings, { ...review, bend_parameters: { [bend.key]: { angle: null } } }).angle, null);
  assert.equal(reviewedBend({ ...bend, confirmed: true, source: [{ profile: 'USER CONFIRMED', angle: 120 }] }, settings, review).angle, null);
  const manual = { ...review, bend_parameters: { [bend.key]: { angle: 120 } } };
  assert.equal(reviewedBend({ ...bend, confirmed: true }, settings, manual).angle, 120);
});

test('90-degree calibration is distinguished from actual oblique deduction', () => {
  const result = reviewedBend(bend, settings, review);
  assert.equal(result.deduction, 4);
  assert.ok(Math.abs(result.atAngle - (8 * Math.tan(Math.PI / 6) - 8 / 3)) < 1e-10);
  assert.equal(reviewedBend({ ...bend, angle: 90 }, settings, review).atAngle.toFixed(6), '4.000000');
  assert.equal(reviewedBend(bend, { ...settings, bend_model: 'fixed_deduction' }, review).atAngle, 4);
});

test('identical DXF IDs do not merge separate hinge/face relationships', () => {
  assert.ok(matchesHinge({ ...bend, segments: [] }, bend));
  assert.ok(!matchesHinge({ ...bend, key: 'axis:F0:F3', child: 3, segments: [] }, bend));
  assert.ok(!matchesHinge({ ...bend, child: 3, segments: [] }, bend));
});

test('anchors stay on an actual segment rather than in a gap; projection handles any origin', () => {
  const hinge = { ...bend, segments: [[[10, 20], [20, 30]], [[90, 100], [110, 120]]] };
  assert.deepEqual(hingeAnchor(hinge), [100, 110]);
  const project = flatProjection([-100, -40, 100, 160], 820, 500);
  assert.deepEqual(project([0, 60]), [410, 250]);
  const p = project([10, 70]), q = project([0, 60]);
  assert.equal(p[0] - q[0], q[1] - p[1]);
});

test('complex fixture keeps every hinge mapped and callouts separate at different zoom layouts', () => {
  const data = JSON.parse(readFileSync(new URL('../public/samples/1648/extraction.json', import.meta.url)));
  const report = JSON.parse(readFileSync(new URL('../public/samples/1648/report.json', import.meta.url)));
  assert.equal(data.bends.length, report.bends.length);
  for (const hinge of data.bends) assert.equal(report.bends.filter(b => matchesHinge(hinge, b)).length, 1);
  for (const cardHeight of [40, 126]) for (const width of [820, 1400]) {
    const height = Math.max(500, Math.ceil(data.bends.length / 2) * (cardHeight + 12) + 32);
    const project = flatProjection(data.bounds, width, height);
    const cards = calloutLayout(data.bends, project, width, height, cardHeight);
    assert.equal(cards.length, data.bends.length);
    for (const side of [true, false]) {
      const group = cards.filter(c => c.left === side).sort((a, b) => a.y - b.y);
      group.forEach((card, i) => {
        assert.ok(card.y >= 0 && card.y + cardHeight <= height);
        assert.deepEqual(card.anchor, project(hingeAnchor(card.hinge)));
        if (i) assert.ok(card.y >= group[i - 1].y + cardHeight + 11.999);
      });
    }
  }
});

test('shared updates preserve every other bend, other review decisions and numeric precision', () => {
  const original = { ...review, review_note: 'Keep this', relief_radii: { corner: 2 },
    bend_parameters: { [bend.key]: { angle: -60, deduction: 4 }, other: { angle: 120, radius: 3 } } };
  const updated = updateBendParameters(original, bend.key, { radius: 2.123456789 });
  assert.deepEqual(updated.bend_parameters[bend.key], { angle: -60, deduction: 4, radius: 2.123456789 });
  assert.equal(updated.bend_parameters.other, original.bend_parameters.other);
  assert.equal(updated.relief_radii, original.relief_radii);
  assert.equal(updated.review_note, 'Keep this');
  assert.equal(original.bend_parameters[bend.key].radius, undefined);
  assert.deepEqual(updateBendParameters(updated, bend.key, null).bend_parameters, { [bend.key]: {}, other: original.bend_parameters.other });
});

test('editor and table share empty-value and manual/default precedence, without turning zero into missing', () => {
  const cleared = updateBendParameters(review, bend.key, { angle: null, radius: null, deduction: 0 });
  assert.equal(bendInputValue(bend, settings, cleared, 'angle'), '');
  assert.equal(bendInputValue(bend, settings, cleared, 'radius'), '');
  assert.equal(bendInputValue(bend, settings, cleared, 'deduction'), 0);
  assert.equal(bendInputValue(bend, settings, review, 'angle'), -60);
  assert.equal(bendInputValue(bend, settings, review, 'radius'), 2);
  assert.equal(bendInputValue({ ...bend, angle: null }, settings, review, 'angle'), '');
});

test('required editor fields and existing engineering ranges reject invalid numbers', () => {
  const valid = { angle: 60.123456789, radius: 2.123456789, deduction: 0 };
  assert.equal(bendValueError(valid, true), null);
  for (const patch of [{ angle: null }, { radius: null }, { deduction: null }, { angle: 0 }, { angle: 180 },
    { angle: -180 }, { angle: NaN }, { radius: 0 }, { radius: -1 }, { radius: 101 }, { radius: Infinity },
    { deduction: -1 }, { deduction: 101 }, { deduction: NaN }]) assert.ok(bendValueError({ ...valid, ...patch }, true));
  // Automatic reset and incomplete table drafts retain their existing semantics.
  assert.equal(bendValueError({}), null);
});

test('a shared field change wins over a stale popover draft while other fields stay staged', () => {
  const draft = { angle: { base: '-60', text: '120' }, radius: { base: '2', text: '3' } };
  assert.equal(bendDraftText(draft, 'angle', '-60'), '120');
  assert.equal(bendDraftText(draft, 'angle', '75'), '75');
  assert.equal(bendDraftText(draft, 'radius', '2'), '3');
});

test('only unique verified hinge identities with actual geometry are editable', () => {
  const data = JSON.parse(readFileSync(new URL('../public/samples/1648/extraction.json', import.meta.url)));
  const report = JSON.parse(readFileSync(new URL('../public/samples/1648/report.json', import.meta.url)));
  for (const hinge of data.bends) assert.ok(editableHinge(data, report.bends, hinge.key));
  const hinge = data.bends[0];
  assert.equal(editableHinge(data, [...report.bends, report.bends[0]], hinge.key), false);
  assert.equal(editableHinge({ ...data, bends: [...data.bends, hinge] }, report.bends, hinge.key), false);
  for (const bad of [{ ...hinge, child: 999 }, { ...hinge, segments: [] }, { ...hinge, segments: [[[NaN, 0], [1, 2]]] }]) {
    assert.equal(editableHinge({ ...data, bends: [bad, ...data.bends.slice(1)] }, report.bends, hinge.key), false);
  }
});
