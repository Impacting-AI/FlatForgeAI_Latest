/** Browser regression with mocked API transport; real CAD is tested by pytest.
 * Requires Playwright and Chromium. See docs/flat-pattern-review.md.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.env.FLATFORGE_QA_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'flatforge-step3-'));
fs.mkdirSync(output, { recursive: true });
const url = process.env.FLATFORGE_TEST_URL || 'http://127.0.0.1:5176';
const server = process.env.FLATFORGE_TEST_URL ? null : spawn(process.execPath,
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5176', '--strictPort'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
server?.stdout.on('data', data => { logs += data; });
server?.stderr.on('data', data => { logs += data; });
let browser;
try {
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(url)).ok) break; } catch {}
    if (i === 179) throw new Error('Server did not start: ' + logs.slice(-5000));
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ executablePath: process.env.FLATFORGE_CHROMIUM || undefined,
    headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('dialog', dialog => dialog.accept()); // Explicitly discard drafts when this regression switches drawings.
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const sample = JSON.parse(fs.readFileSync(path.join(root, 'lib/sample-data.json')));
  sample.mode = 'live'; sample.capabilities.connected = true; sample.capabilities.worker_online = true;
  const target = sample.panels.find(panel => panel.id === 'reference-1648');
  const [first, second] = target.report.bends;
  const originalSource = structuredClone(first.source);
  const hiddenReliefs = { 'test-corner': 3.25 };
  const reviewNote = 'Approved corner radius from saved project review.';
  target.settings.use_material_defaults = true;
  target.configured_settings = { ...target.settings };
  target.overrides = { ...target.overrides, relief_radii: hiddenReliefs, review_note: reviewNote, accept_corner_reliefs: true };
  target.report.relief_circles = [{ handle: 'test-corner', center_dxf_mm: [10, 10], original_radius_mm: 1.5, used_radius_mm: 3.25, max_radius_mm: 5 }];
  let saved;
  await page.route('**/api/bootstrap', route => route.fulfill({ json: sample }));
  await page.route('**/api/engine/panels/*/review', async route => {
    saved = route.request().postDataJSON();
    target.overrides = { ...saved }; target.revision++;
    await route.fulfill({ status: 202, json: {} });
  });
  const drawing = page.locator('svg[aria-label="Flat pattern with geometry-linked bend values"]');
  const editor = page.getByRole('dialog', { name: /^Bend / });
  const input = field => editor.getByRole('spinbutton').nth(field);
  const card = bend => drawing.locator('g[role="button"]')
    .filter({ hasText: `F${bend.parent} → F${bend.child}` }).filter({ hasText: 'Bend ' + bend.bend_ids.join(' / ') });
  const materialRule = page.getByRole('checkbox', { name: 'Use material defaults when the drawing does not establish a value' });
  async function select(panel, expectedBends = panel.report.bends.length) {
    if (await page.getByRole('button', { name: 'Project Drawings', exact: true }).count()) await page.getByRole('button', { name: 'Project Drawings', exact: true }).click();
    await page.getByRole('button', { name: 'Open drawing ' + panel.filename, exact: true }).click();
    await page.getByRole('tab', { name: /Extract/ }).click();
    await drawing.waitFor();
    await page.waitForFunction(count => document.querySelectorAll('svg[aria-label="Flat pattern with geometry-linked bend values"] g[role="button"]').length === count, expectedBends);
  }
  async function reviewPage(expectedBends = target.report.bends.length) {
    const openProject = page.getByRole('button', { name: 'Open ' + sample.projects[0].name, exact: true });
    if (new URL(page.url()).pathname === '/') await openProject.click();
    await select(target, expectedBends);
  }
  async function open(bend) {
    await card(bend).click(); await editor.waitFor();
    assert.ok((await editor.locator('h4').textContent()).includes(`F${bend.parent} → F${bend.child}`));
    assert.equal(await editor.getByRole('spinbutton').count(), 3);
  }
  async function cancel() { await editor.getByRole('button', { name: 'Cancel', exact: true }).click(); }
  async function apply() { await editor.getByRole('button', { name: 'Apply', exact: true }).click(); }
  async function save() {
    await page.getByRole('button', { name: 'Save & rebuild panel', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-state="active"][role="tab"]')?.textContent.includes('Conversion'));
  }
  await page.goto(url, { waitUntil: 'networkidle' }); await reviewPage();
  for (const panel of sample.panels) {
    await select(panel);
    for (const bend of panel.report.bends) {
      const label = await card(bend).getAttribute('aria-label');
      for (const source of bend.source) assert.ok(label.includes(source.profile === 'USER CONFIRMED'
        ? 'USER CONFIRMED · no extracted vertex' : `${source.profile} / vertex ${source.vertex}`));
    }
  }
  await select(target);
  assert.equal(await page.locator('.bend-evidence-table').count(), 0);
  for (const name of ['Correct individual bends · angle, radius or deduction', 'Adjust corner-relief cuts', 'Advanced · load a saved review']) {
    assert.equal(await page.getByText(name, { exact: true }).count(), 0);
  }
  assert.equal(await page.getByLabel('Review values JSON', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Corner radius test-corner', { exact: true }).count(), 0);
  assert.equal(await materialRule.count(), 0);
  assert.equal(await page.getByRole('checkbox', { name: 'Use reviewed bend values instead of missing or unreliable section drawings' }).count(), 0);
  assert.equal(await page.getByLabel('Source of confirmed values / reason for this decision').count(), 0);
  assert.equal(await page.locator('.review-decisions .parameter-help, .review-controls .review-warning').count(), 0);
  await page.locator('.review-decisions').screenshot({ path: path.join(output, 'step3-clean-parameters.png') });
  // Global defaults retain their existing policy control; only Step 3 lost it.
  await page.getByRole('button', { name: 'Material defaults', exact: true }).click();
  await materialRule.waitFor();
  await page.getByRole('dialog').press('Escape');
  assert.equal(await materialRule.count(), 0);
  await open(first);
  assert.ok((await editor.textContent()).includes(`${originalSource[0].profile} / vertex ${originalSource[0].vertex}`));
  await input(0).fill('61.25'); await cancel();
  assert.ok((await card(first).textContent()).includes('Rotation: ' + first.angle + '°'));
  await open(first); await input(0).fill('62'); await input(0).press('Escape');
  assert.equal(await editor.count(), 0);
  assert.equal(await card(first).evaluate(element => element === document.activeElement), true);
  await open(first); await apply(); await open(first);
  assert.equal(await editor.getByText('Manual correction', { exact: true }).count(), 0); await cancel();
  for (const [field, value] of [[0, ''], [0, '0'], [0, '180'], [1, '0'], [1, '-1'], [1, '101'], [2, '-1'], [2, '101']]) {
    await open(first); await input(field).fill(value); await apply();
    assert.ok(await editor.getByRole('alert').textContent());
    assert.ok((await card(first).textContent()).includes('Rotation: ' + first.angle + '°')); await cancel();
  }
  // Panel changes still refresh automatic values and discard stale editor drafts.
  await open(first); await input(1).fill('9');
  await page.getByLabel('Inside bend radius', { exact: true }).fill('2.5');
  assert.equal(await input(1).inputValue(), '2.5');
  await page.getByLabel('Inside bend radius', { exact: true }).fill('2');
  assert.equal(await input(1).inputValue(), '2'); await cancel();
  await open(first); await input(1).fill('2.123456789'); await apply(); await open(first);
  assert.equal(await input(1).inputValue(), '2.123456789');
  assert.equal(await editor.getByText('Manual correction', { exact: true }).count(), 1);
  await editor.getByRole('button', { name: 'Use automatic', exact: true }).click();
  await open(first); assert.equal(await input(1).inputValue(), '2'); await cancel();
  await open(first); await input(0).fill('60.123456789'); await input(1).fill('3.25'); await input(2).fill('5'); await apply();
  assert.match(await card(first).textContent(), /Rotation: \+60.123°/);
  assert.match(await card(first).textContent(), /Inside radius: 3.25 mm/);
  const repeated = target.report.bends.filter(bend => bend.bend_ids.join('/') === 'C04');
  assert.ok(repeated.length > 1);
  await open(repeated[0]); await input(2).fill('4.1'); await apply();
  await open(repeated[1]); assert.equal(await input(2).inputValue(), '4'); await cancel();
  const line = drawing.locator('g[tabindex="-1"]').filter({ hasText: first.bend_ids.join(' / ') + ' · F' + first.parent + ' → F' + first.child });
  await line.locator('path').last().click({ force: true }); await editor.waitFor();
  await input(0).fill('76'); await page.getByRole('button', { name: 'Zoom in drawing', exact: true }).click();
  const canvas = drawing.locator('..');
  await canvas.evaluate(element => { element.scrollTop += 100; element.scrollLeft += 40; });
  assert.equal(await input(0).inputValue(), '76'); await cancel();
  await save();
  assert.deepEqual(saved.bend_parameters[first.key], { angle: 60.123456789, radius: 3.25, deduction: 5 });
  assert.deepEqual(saved.bend_parameters[repeated[0].key], { deduction: 4.1 });
  assert.equal(saved.bend_parameters[repeated[1].key], undefined);
  assert.equal(saved.bend_parameters[second.key], undefined);
  assert.deepEqual(saved.relief_radii, hiddenReliefs); assert.equal(saved.review_note, reviewNote);
  assert.equal(saved.accept_corner_reliefs, true); assert.equal(saved.settings.use_material_defaults, true);
  await page.reload({ waitUntil: 'networkidle' }); await reviewPage(); await open(first);
  assert.equal(await input(0).inputValue(), '60.123456789'); assert.equal(await input(1).inputValue(), '3.25'); assert.equal(await input(2).inputValue(), '5');
  await page.locator('.drawing-window').screenshot({ path: path.join(output, 'step3-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  await page.locator('.drawing-window').screenshot({ path: path.join(output, 'step3-mobile.png') });
  const eb = await editor.boundingBox(), vb = await canvas.boundingBox();
  assert.ok(eb.x >= vb.x && eb.x + eb.width <= vb.x + vb.width + 1 && eb.y >= vb.y && eb.y + eb.height <= vb.y + vb.height + 1);
  const applyBox = await editor.getByRole('button', { name: 'Apply', exact: true }).boundingBox();
  assert.ok(applyBox.y >= eb.y && applyBox.y + applyBox.height <= eb.y + eb.height);
  await cancel();
  // Missing values stay blank, and absent/ambiguous section references are honest.
  target.settings.use_material_defaults = false; target.configured_settings.use_material_defaults = false;
  target.overrides = { relief_radii: hiddenReliefs, review_note: reviewNote, bend_parameters: { [first.key]: { radius: null, deduction: null } } };
  first.angle = null; first.source = []; target.revision++;
  target.report.issues = [{ code: 'SECTION_EVIDENCE', message: 'Missing section profiles' }];
  target.report.unresolved_bends = [{ key: first.key, bend_ids: first.bend_ids, parent: first.parent, child: first.child, axis: '(1, 0, 0)', reason: 'Test missing section evidence' }];
  await page.reload({ waitUntil: 'networkidle' }); await reviewPage(); await open(first);
  assert.ok((await editor.textContent()).includes('Source section / vertex not established'));
  for (let field = 0; field < 3; field++) assert.equal(await input(field).inputValue(), '');
  await input(0).fill('60'); await input(1).fill('2'); await input(2).fill('4'); await apply();
  await open(first); await input(0).fill('120');
  await page.getByLabel('Signed angle for ' + first.bend_ids.join('/'), { exact: true }).fill('75');
  assert.equal(await input(0).inputValue(), '75'); await cancel();
  await save(); assert.equal(saved.manual_bends, true); assert.equal(saved.settings.use_material_defaults, false);
  assert.deepEqual(saved.relief_radii, hiddenReliefs); assert.equal(saved.review_note, reviewNote);
  // A saved reviewed panel with an empty historical note must rebuild without a hidden field.
  target.overrides.relief_radii = {}; target.overrides.review_note = '';
  target.revision++; await page.reload({ waitUntil: 'networkidle' }); await reviewPage();
  await save(); assert.equal(saved.manual_bends, true); assert.equal(saved.review_note, '');
  // Use automatic clears the selected override and returns to drawing-based processing.
  await page.reload({ waitUntil: 'networkidle' }); await reviewPage(); await open(first);
  await editor.getByRole('button', { name: 'Use automatic', exact: true }).click();
  await save(); assert.equal(saved.manual_bends, false); assert.deepEqual(saved.bend_parameters[first.key], {});
  // Apply can confirm an unchanged detected angle when section correspondence failed.
  first.angle = 60; first.source = originalSource;
  target.overrides = {}; target.revision++;
  await page.reload({ waitUntil: 'networkidle' }); await reviewPage(); await open(first); await apply();
  await save(); assert.equal(saved.manual_bends, true); assert.equal(saved.bend_parameters[first.key].angle, 60);
  assert.equal(saved.review_note, '');
  first.angle = null;
  first.source = [{ profile: 'A_VERY_LONG_SECTION_IDENTIFIER_WITH_MULTIPLE_REFERENCES_01', vertex: 0, angle: 60 }, { profile: 'SECOND_SECTION', vertex: null, angle: 90 }];
  target.revision++; await page.reload({ waitUntil: 'networkidle' }); await reviewPage(); await open(first);
  assert.ok((await editor.textContent()).includes('Unresolved source mapping'));
  assert.ok((await editor.textContent()).includes('SECOND_SECTION / vertex not established'));
  assert.ok((await editor.textContent()).includes('A_VERY_LONG_SECTION_IDENTIFIER_WITH_MULTIPLE_REFERENCES_01 / vertex 0'));
  await cancel();
  // An uncertain geometric relationship must not gain an editable callout.
  await page.route('**/samples/1648/extraction.json?*', async route => {
    const geometry = JSON.parse(fs.readFileSync(path.join(root, 'public/samples/1648/extraction.json')));
    geometry.bends[0].child = 999; await route.fulfill({ json: geometry });
  });
  target.revision++; await page.reload({ waitUntil: 'networkidle' });
  await reviewPage(target.report.bends.length - 1); await drawing.waitFor();
  assert.equal(await card(first).count(), 0); assert.equal(await editor.count(), 0);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('PASS: 53 source mappings; removed circled controls/text; automatic section recovery; empty-note rebuild; automatic restore; global defaults; viewer editing and validation; shared state; hidden relief persistence; true/false fallback settings; save/reload; missing values; repeated IDs; zoom/pan; mobile bounds; uncertain identity.');
} finally {
  await browser?.close(); server?.kill('SIGTERM');
  fs.writeFileSync(path.join(output, 'step3-server.log'), logs);
}
