/** Assembly workspace with real WebGL and the real Python CAD API: add, connect, move, full screen, save. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as THREE from 'three';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.env.FLATFORGE_QA_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'ff-assembly-simple-'));
fs.mkdirSync(output, { recursive: true });
const url = 'http://127.0.0.1:5183', apiURL = 'http://127.0.0.1:5186';
const apiKey = 'test-assembly-browser-key-never-use-in-production';
const apiData = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-assembly-api-'));
const venv = path.join(root, 'backend/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5183', '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
const apiServer = spawn(process.env.FLATFORGE_PYTHON || (fs.existsSync(venv) ? venv : 'python'), ['backend/tests/serve_assembly.py'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONPATH: path.join(root, 'backend'), OPENBLAS_NUM_THREADS: '1',
    FLATFORGE_ASSEMBLY_TEST: '1', FLATFORGE_DATA: apiData, FLATFORGE_API_KEY: apiKey, FLATFORGE_TEST_API_PORT: '5186' } });
let logs = '', browser;
for (const child of [server, apiServer]) for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs += data; });
const results = [], pass = message => { results.push(message); console.log('PASS ' + message); };
const near = (a, b, tolerance = .01, message = '') => assert.ok(Math.abs(a - b) <= tolerance, `${message} ${a} != ${b}`);

try {
  for (let i = 0; i < 400; i++) {
    try { if ((await fetch(url)).ok && (await fetch(apiURL + '/health')).ok) break; } catch {}
    if (i === 399) throw new Error('Server did not start');
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  // Full Chromium on the machine's graphics hardware; see orbit-viewer.browser.mjs.
  browser = await chromium.launch({ executablePath: process.env.FLATFORGE_CHROMIUM || undefined, channel: 'chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push('Unexpected popup: ' + dialog.message()); void dialog.dismiss(); });
  await page.addInitScript(() => {
    localStorage.setItem('flatforge_admin_token', 'x'.repeat(40));
    // Three.js announces its objects to developer tools; record what is drawn and from where.
    const tools = window.__THREE_DEVTOOLS__ = new EventTarget();
    tools.addEventListener('observe', ({ detail: renderer }) => {
      if (!renderer.isWebGLRenderer) return; const render = renderer.render;
      renderer.render = function (scene, camera) { render.call(this, scene, camera); window.__scene = scene; window.__camera = camera; };
    });
  });
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'lib/sample-data.json')));
  const data = await (await fetch(apiURL + '/bootstrap', { headers: { 'x-flatforge-key': apiKey } })).json();
  const project = data.projects.find(p => p.id === fixture.projects[0].id);
  const drawings = data.panels.filter(p => p.project_id === project.id);
  const placements = [], saves = [], catalogs = {};
  let failValidation = false;
  await page.route('**/api/bootstrap', route => route.fulfill({ json: data }));
  await page.route('**/api/engine/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname.replace('/api/engine', '');
    if (failValidation && pathname.endsWith('/assembly/validate') && request.postDataJSON().mateCheckId) { return route.fulfill({ status: 503, json: { detail: 'Test CAD interruption.' } }); }
    if (pathname.endsWith('/assembly') && request.method() === 'PUT') saves.push(request.postDataJSON());
    const response = await fetch(apiURL + pathname, { method: request.method(), headers: { 'x-flatforge-key': apiKey, 'content-type': request.headers()['content-type'] || 'application/json' }, body: request.postDataBuffer() || undefined });
    const body = Buffer.from(await response.arrayBuffer());
    if (response.ok && pathname.endsWith('/assembly/place')) placements.push(JSON.parse(body));
    if (response.ok && pathname.endsWith('/assembly/faces')) { const catalog = JSON.parse(body); catalogs[catalog.entryId] = catalog; }
    await route.fulfill({ status: response.status, body, headers: { 'content-type': response.headers.get('content-type') || 'application/octet-stream' } });
  });

  const stage = page.locator('.viewer-stage'), canvas = page.locator('.viewer-stage canvas'), status = page.locator('.asm-status');
  const button = name => page.getByRole('button', { name, exact: true });
  const frames = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  async function loaded() {
    await page.locator('[data-assembly-ready="true"]').waitFor({ timeout: 90000 });
    await page.locator('[data-cad-valid="true"]').waitFor({ state: 'attached', timeout: 90000 }); await frames();
  }
  const layout = () => placements.at(-1);
  const matrixOf = id => new THREE.Matrix4().fromArray(layout().entries.find(e => e.id === id).matrix);
  const position = id => new THREE.Vector3().setFromMatrixPosition(matrixOf(id)).toArray();
  const visibleButtons = () => page.locator('.assembly-workspace button:visible').evaluateAll(nodes => nodes.map(node => (node.getAttribute('aria-label') || node.textContent).trim()));
  /** Screen pixels of a point in viewer metres. */
  const screen = point => page.evaluate(p => {
    const c = window.__camera, box = document.querySelector('.viewer-stage canvas').getBoundingClientRect();
    const multiply = (m, v) => [0, 1, 2, 3].map(r => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
    const q = multiply(c.projectionMatrix.elements, multiply(c.matrixWorldInverse.elements, [...p, 1]));
    return { x: box.x + (q[0] / q[3] + 1) / 2 * box.width, y: box.y + (1 - q[1] / q[3]) / 2 * box.height };
  }, point);

  /** Clicks where a wanted face should be visible. A surface in front of it would be picked instead. */
  async function clickFace(id, wanted = () => true) {
    await loaded();
    const before = await status.innerText();
    // The first pointer movement over a panel loads its CAD faces.
    const centre = new THREE.Box3(new THREE.Vector3(...layout().bounds[id].min), new THREE.Vector3(...layout().bounds[id].max)).getCenter(new THREE.Vector3()).multiplyScalar(.001);
    for (let i = 0; i < 100 && !catalogs[id]?.faces.length; i++) { const at = await screen(centre.toArray()); await page.mouse.move(at.x + i % 7 * 3, at.y + i % 5 * 3); await page.waitForTimeout(150); }
    assert.ok(catalogs[id]?.faces.length, 'face catalog loaded for ' + id);
    const camera = await page.evaluate(() => window.__camera.position.toArray()), matrix = matrixOf(id), turn = new THREE.Matrix3().setFromMatrix4(matrix);
    const candidates = catalogs[id].faces.filter(f => f.supported && wanted(f, new THREE.Vector3(...f.normal).applyMatrix3(turn))).sort((a, b) => b.area - a.area);
    for (const face of candidates) {
      const triangles = [];
      for (let i = 0; i < face.indices.length; i += 3) {
        const [a, b, c] = face.indices.slice(i, i + 3).map(n => new THREE.Vector3(...face.positions.slice(n * 3, n * 3 + 3)).applyMatrix4(matrix).multiplyScalar(.001));
        triangles.push({ at: a.clone().add(b).add(c).divideScalar(3), area: b.clone().sub(a).cross(c.clone().sub(a)).length() });
      }
      for (const { at } of triangles.sort((a, b) => b.area - a.area).slice(0, 6)) {
        const facing = new THREE.Vector3(...face.normal).applyMatrix3(turn).dot(new THREE.Vector3(...camera).sub(at).normalize());
        if (facing < .12) continue;
        const point = await screen(at.toArray());
        const topmost = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, point);
        if (topmost !== 'CANVAS') continue;
        await page.mouse.move(point.x, point.y); await frames();
        await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(250);
        const now = await status.innerText();
        // A curved surface in the way only raises a message; try the next spot.
        if (now !== before && /Now click|Connecting| connected to /.test(now)) return face.id;
      }
    }
    throw new Error(`No clickable face found on ${id}`);
  }

  /** The saved mate must hold exactly: faces opposed or flush, planes touching, and (first mate) centred. */
  function checkMate(entry, mate, { centred = true } = {}) {
    const face = (panel, ref) => {
      const f = catalogs[panel].faces.find(x => x.id === ref.faceId), m = matrixOf(panel);
      return { normal: new THREE.Vector3(...f.normal).applyMatrix3(new THREE.Matrix3().setFromMatrix4(m)), point: new THREE.Vector3(...ref.point).applyMatrix4(m), centre: new THREE.Vector3(...f.center).applyMatrix4(m) };
    };
    const moving = face(entry.id, mate.moving), target = face(mate.targetId, mate.reference);
    near(moving.normal.dot(target.normal), mate.aligned ? 1 : -1, 1e-6, 'face directions');
    near(moving.point.clone().sub(target.point).dot(target.normal), 0, .002, 'planes touch');
    if (centred) near(moving.centre.distanceTo(target.centre), 0, .01, 'face centres meet');
  }

  await page.goto(`${url}/projects/${project.id}/assembly`, { waitUntil: 'networkidle' });
  await button('Add Panel').waitFor();
  await page.waitForFunction(() => !document.querySelector('.asm-status')?.textContent.includes('Loading saved assembly'));
  assert.deepEqual((await visibleButtons()).sort(), ['Add Panel', 'Export assembly GLB', 'Export assembly as STEP (.step)', 'Full Screen', 'Mate', 'Redo', 'Save Assembly', 'Screenshot', 'Undo']);
  pass('empty workspace shows only Mate, Add Panel, Save, Undo, Redo, Full Screen and the export controls');

  async function add(drawing) {
    await button('Add Panel').click();
    await page.getByRole('region', { name: 'Choose a panel' }).getByRole('button', { name: drawing.filename, exact: true }).click();
    await loaded();
  }
  await add(drawings[0]);
  assert.equal(await page.locator('.asm-tree>li').count(), 1);
  await add(drawings[0]);
  await status.getByText('Click a face on Panel B.').waitFor({ timeout: 30000 });
  await page.screenshot({ path: path.join(output, '01-pick-faces.png') });
  const [a, b] = layout().entries.map(e => e.id);
  for (const gone of ['.asm-selection-toolbar', '.asm-mate-card', '.asm-more', '.asm-popup-reset', '.asm-panel-list details', 'select[aria-label="Assembly camera view"]'])
    assert.equal(await page.locator('.assembly-workspace ' + gone).count(), 0, gone + ' is removed');
  assert.equal(await page.locator('.assembly-workspace .asm-side-label').count(), 0);
  pass('adding the second panel goes straight to face picking; crossed-out controls are gone');

  // face-115 is the outer +X side web of sample panel 1648. Joining it on both
  // panels turns the new panel round and puts it side by side with the base.
  const side = face => face.id === 'face-115';
  const start = position(b);
  await clickFace(b, side);
  await status.getByText('Now click the face it should join, on another panel.').waitFor();
  await clickFace(a, side);
  await status.getByText(/Panel B connected to Panel A\./).waitFor({ timeout: 60000 }); await loaded();
  const boxA = layout().bounds[a], boxB = layout().bounds[b];
  assert.ok(boxB.min[0] > boxA.max[0] - 40 && boxB.max[0] > boxA.max[0] + 900, `side by side ${JSON.stringify([boxA, boxB])}`);
  near(boxB.min[2], boxA.min[2], .01, 'same height'); near(boxB.max[2], boxA.max[2], .01, 'same height');
  let moved = position(b);
  assert.ok(new THREE.Vector3(...moved).distanceTo(new THREE.Vector3(...start)) > 1, 'panel B moved');
  assert.equal(await page.getByRole('button', { name: 'Apply', exact: true }).count(), 0);
  await page.locator('.asm-tree>li[data-entry=B]').getByText('Connected to A').waitFor();
  await page.screenshot({ path: path.join(output, '02-connected.png') });
  await button('Save Assembly').click(); await status.getByText('Assembly saved to this project.').waitFor({ timeout: 60000 });
  let saved = saves.at(-1).entries;
  assert.equal(saved[1].planeMates.length, 1); checkMate(saved[1], saved[1].planeMates[0]);
  assert.deepEqual([saved[1].planeMates[0].moving.faceId, saved[1].planeMates[0].reference.faceId], ['face-115', 'face-115']);
  near(new THREE.Vector3(...position(a)).length(), new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(saved[0].matrix)).length());
  pass('two face clicks connect and align the panels with no further step; saved mate verified on the CAD faces');

  await button('Undo').click(); await loaded();
  near(new THREE.Vector3(...position(b)).distanceTo(new THREE.Vector3(...start)), 0, .01);
  await button('Redo').click(); await loaded();
  near(new THREE.Vector3(...position(b)).distanceTo(new THREE.Vector3(...moved)), 0, .01);
  pass('Undo and Redo revert and restore the connection');

  // Gizmo: select from the list, then drag each axis.
  await page.locator('.asm-tree>li[data-entry=B] .asm-tree-name').click(); await loaded();
  const gizmo = () => page.evaluate(() => {
    let found = null;
    window.__scene.traverse(o => { if (o.isTransformControlsRoot) { const c = o.controls; found = { attached: !!c.object, axis: c.axis, at: c.object?.position.toArray() }; } });
    return found;
  });
  const values = page.getByRole('complementary', { name: 'Movement values' });
  const number = async selector => Number((await values.locator(selector).innerText()).replace(/[^0-9.+-]/g, ''));
  const moveValues = async () => [await number('[data-axis=X] dd'), await number('[data-axis=Y] dd'), await number('[data-axis=Z] dd')];
  /** "Position from Panel A" must equal the distance between the two CAD bounding-box centres. */
  async function positionMatches() {
    const centre = id => layout().bounds[id].min.map((v, i) => (v + layout().bounds[id].max[i]) / 2);
    for (const [i, axis] of ['X', 'Y', 'Z'].entries()) near(await number(`[data-position=${axis}] dd`), centre(b)[i] - centre(a)[i], .06, 'position ' + axis);
  }
  async function dragAxis(axis, pixels, { shift = false } = {}) {
    await loaded();
    const handle = await gizmo(); assert.ok(handle.attached, 'gizmo on the selected panel');
    const index = 'XYZ'.indexOf(axis), unit = [0, 0, 0]; unit[index] = 1;
    const origin = await screen(handle.at), tip = await screen(handle.at.map((v, i) => v + unit[i] * .2));
    const length = Math.hypot(tip.x - origin.x, tip.y - origin.y), way = { x: (tip.x - origin.x) / length, y: (tip.y - origin.y) / length };
    let grab = null;
    for (const side of [1, -1]) for (let r = 30; r < 200 && !grab; r += 4) {
      const at = { x: origin.x + way.x * r * side, y: origin.y + way.y * r * side };
      await page.mouse.move(at.x, at.y); await frames();
      if ((await gizmo()).axis === axis) grab = { ...at, side };
    }
    assert.ok(grab, `${axis} handle found`);
    const before = position(b), others = position(a);
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.down();
    const jumps = []; let last = null;
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(grab.x + way.x * pixels * i / 12, grab.y + way.y * pixels * i / 12); await frames();
      const at = (await gizmo()).at[index]; if (last !== null) jumps.push(at - last); last = at;
    }
    await status.getByText(new RegExp('Panel B · X')).waitFor();
    assert.equal(await values.locator('h4').first().innerText(), 'MOVING NOW');
    const live = await moveValues();
    await page.mouse.up(); if (shift) await page.keyboard.up('Shift');
    await loaded();
    const delta = position(b).map((v, i) => v - before[i]);
    assert.equal(await values.locator('h4').first().innerText(), 'LAST MOVE');
    const shown = await moveValues();
    assert.deepEqual(shown, live, 'the values stay after release');
    shown.forEach((value, i) => near(value, delta[i], .051, 'sidebar value'));
    near(await number('[data-value=distance] dd'), Math.hypot(...delta), .051, 'distance');
    await positionMatches();
    assert.ok(Math.sign(delta[index]) === Math.sign(pixels) && Math.abs(delta[index]) > (shift ? .05 : 1), `${axis} moved ${delta}`);
    for (let i = 0; i < 3; i++) if (i !== index) near(delta[i], 0, .002, 'single axis');
    near(delta[index] * (shift ? 10 : 1), Math.round(delta[index] * (shift ? 10 : 1)), .002, 'snap step');
    assert.ok(jumps.every(step => Math.sign(step) !== -Math.sign(pixels)), 'no backwards jumps during the drag');
    assert.deepEqual(position(a), others, 'the other panel stays');
    near((await gizmo()).at[index] - handle.at[index], delta[index] / 1000, .0005, 'gizmo follows the panel');
    return delta;
  }
  for (const axis of ['X', 'Y', 'Z']) { await dragAxis(axis, 90); await dragAxis(axis, -50); }
  await dragAxis('X', 40, { shift: true });
  await page.locator('.asm-tree>li[data-entry=B]').getByText('Not connected').waitFor();
  await page.screenshot({ path: path.join(output, '03-gizmo.png') });
  pass('gizmo drags move the panel along X, Y and Z, snap to 1 mm (0.1 mm with Shift), smoothly and alone');
  await page.screenshot({ path: path.join(output, '08-values.png') });
  await button('Minimize movement values').click();
  assert.equal(await values.count(), 0);
  await page.screenshot({ path: path.join(output, '09-values-minimized.png') });
  await dragAxis_minimized();
  await button('Show movement values').click(); await values.waitFor();
  pass('movement sidebar shows live and final values matching the CAD positions; it minimizes and restores');
  async function dragAxis_minimized() {
    // The sidebar stays out of the way while minimized, including after a keyboard move.
    const count = placements.length; await page.keyboard.press('PageUp');
    for (let i = 0; i < 200 && placements.length === count; i++) await page.waitForTimeout(50);
    await loaded(); assert.equal(await values.count(), 0);
  }

  // The dragged position is what gets saved, and a reload returns it.
  await button('Save Assembly').click(); await status.getByText('Assembly saved to this project.').waitFor({ timeout: 60000 });
  const stored = position(b);
  await page.reload({ waitUntil: 'networkidle' }); await loaded();
  near(new THREE.Vector3(...position(b)).distanceTo(new THREE.Vector3(...stored)), 0, .001);
  assert.equal(await page.locator('[data-unsaved-assembly]').count(), 0);
  pass('moved position saves and survives a reload');

  assert.equal(await values.count(), 0, 'nothing selected, no sidebar');
  // Click a panel in the 3D view to select it, then precise keyboard steps.
  const label = page.locator('.asm-model-label', { hasText: 'Panel B' });
  await label.click(); await loaded();
  await page.locator('.asm-tree>li[data-entry=B].selected').waitFor();
  const step = async (key, options = {}) => {
    const before = position(b), count = placements.length;
    if (options.shift) await page.keyboard.down('Shift');
    for (let i = 0; i < (options.times ?? 1); i++) await page.keyboard.down(key);
    await page.keyboard.up(key); if (options.shift) await page.keyboard.up('Shift');
    for (let i = 0; i < 200 && placements.length === count; i++) await page.waitForTimeout(50);
    await loaded();
    return position(b).map((v, i) => Math.round((v - before[i]) * 1000) / 1000);
  };
  const right = await step('ArrowRight'), left = await step('ArrowLeft'), forward = await step('ArrowUp'), back = await step('ArrowDown');
  assert.equal(right.reduce((s, v) => s + Math.abs(v), 0), 1); assert.deepEqual(left.map((v, i) => v + right[i]), [0, 0, 0]);
  assert.equal(forward.reduce((s, v) => s + Math.abs(v), 0), 1); assert.deepEqual(back.map((v, i) => v + forward[i]), [0, 0, 0]);
  assert.equal(forward[2] + right[2], 0); assert.ok(right[0] > 0 && forward[1] > 0, 'directions follow the view');
  assert.deepEqual(await step('PageUp'), [0, 0, 1]);
  assert.deepEqual(await moveValues(), [0, 0, 1]); await positionMatches();
  assert.equal(await values.locator('[data-value=tilt] dd').innerText(), '90°');
  assert.equal(await values.locator('[data-value=heading] dd').innerText(), '—'); assert.deepEqual(await step('PageDown', { shift: true }), [0, 0, -.1]);
  const held = position(b);
  assert.deepEqual(await step('PageUp', { times: 15 }), [0, 0, 15]);
  await button('Undo').click(); await loaded();
  near(new THREE.Vector3(...position(b)).distanceTo(new THREE.Vector3(...held)), 0, .001, 'a held key is one undo step');
  pass('arrow and Page keys move left/right, forward/back and up/down by 1 mm (0.1 mm with Shift)');

  // A second connection through the Mate button, with the base clicked first.
  await button('Mate').click(); assert.equal(await button('Mate').getAttribute('aria-pressed'), 'true');
  await clickFace(a, (face, normal) => normal.x > .99);
  await clickFace(b, (face, normal) => normal.x > .99);
  await status.getByText(/Panel B connected to Panel A\./).waitFor({ timeout: 60000 }); await loaded();
  near(new THREE.Vector3(...position(a)).distanceTo(new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(saves.at(-1).entries[0].matrix))), 0, .001, 'base stays');
  pass('Mate button reconnects; the base stays even when clicked first');

  // A failed CAD check leaves the assembly unchanged.
  const kept = position(b);
  await button('Mate').click();
  await clickFace(b, (face, normal) => normal.z > .99);
  failValidation = true;
  await clickFace(a, (face, normal) => normal.z > .99);
  await status.getByText(/could not be connected/).waitFor({ timeout: 60000 });
  failValidation = false;
  await page.keyboard.press('Escape'); await loaded();
  near(new THREE.Vector3(...position(b)).distanceTo(new THREE.Vector3(...kept)), 0, .001);
  assert.equal(await button('Mate').getAttribute('aria-pressed'), 'false');
  pass('a rejected connection is reported and changes nothing; Escape leaves Mate mode');

  // Full screen: only Add Panel, Save Assembly and the exit control.
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  const before = await canvas.boundingBox();
  await button('Full Screen').click(); await page.waitForTimeout(700);
  assert.deepEqual((await visibleButtons()).filter(name => !name.startsWith('Select Panel')), ['Add Panel', 'Save Assembly', 'Exit full screen']);
  assert.equal(await page.locator('.asm-panel-list, .asm-cad-controls:visible, .viewport-actions:visible').count(), 0);
  const full = await canvas.boundingBox(), viewport = await page.evaluate(() => [innerWidth, innerHeight]);
  assert.ok(full.width >= viewport[0] - 2 && full.height >= viewport[1] - 2 && full.height > before.height, `fills the screen ${JSON.stringify(full)}`);
  await page.screenshot({ path: path.join(output, '04-fullscreen.png') });
  // Add, connect, move and save without leaving full screen.
  await add(drawings[0]);
  await status.getByText('Click a face on Panel C.').waitFor({ timeout: 30000 });
  const c = layout().entries.at(-1).id;
  await clickFace(c, (face, normal) => normal.x > .99);
  await clickFace(b, (face, normal) => normal.x > .99);
  await status.getByText(/Panel C connected to Panel B\./).waitFor({ timeout: 60000 }); await loaded();
  await page.screenshot({ path: path.join(output, '05-fullscreen-connected.png') });
  const z = position(c)[2], count = placements.length;
  await page.keyboard.press('PageUp');
  for (let i = 0; i < 200 && placements.length === count; i++) await page.waitForTimeout(50);
  await loaded(); near(position(c)[2], z + 1, .001);
  await button('Save Assembly').click(); await status.getByText('Assembly saved to this project.').waitFor({ timeout: 60000 });
  assert.equal(saves.at(-1).entries.length, 3);
  await button('Exit full screen').click(); await page.waitForTimeout(700);
  assert.equal(await page.locator('.assembly-workspace.is-fullscreen').count(), 0);
  assert.equal(await page.locator('.asm-tree>li').count(), 3);
  await button('Full Screen').click(); await page.waitForTimeout(500); await page.keyboard.press('Escape'); await button('Full Screen').waitFor();
  pass('full screen shows only Add Panel, Save and exit; add, connect, move and save work; button and Esc exit');

  // Remove: one panel only, no popup, undoable.
  await loaded(); await button('Remove Panel B').click(); await loaded();
  assert.deepEqual(await page.locator('.asm-tree>li').evaluateAll(nodes => nodes.map(n => n.dataset.entry)), ['A', 'C']);
  await page.keyboard.press('Control+z'); await loaded();
  assert.equal(await page.locator('.asm-tree>li').count(), 3);
  await page.locator('.asm-tree>li[data-entry=A] .asm-tree-name').click(); await page.keyboard.press('Delete'); await loaded();
  assert.equal(await page.locator('.asm-tree>li').count(), 2);
  await page.locator('.asm-tree>li[data-entry=B]').getByText('Base · fixed').waitFor();
  await button('Undo').click(); await loaded();
  pass('removing a panel (including the base) removes only that panel, without a popup, and undoes');

  // The same unlimited orbit as 3D Studio.
  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  /** Camera axes and position once its movement has finished. */
  async function view() {
    let last, still = 0;
    for (let i = 0; i < 300; i++) {
      await frames();
      const m = await page.evaluate(() => window.__camera.matrixWorld.elements.slice());
      still = last && m.every((v, k) => Math.abs(v - last[k]) < 1e-7) ? still + 1 : 0;
      if (still >= 3) return { right: m.slice(0, 3), up: m.slice(4, 7), back: m.slice(8, 11), position: m.slice(12, 15) };
      last = m;
    }
    throw new Error('The camera never came to rest');
  }
  const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, (dot(a.right, b.right) + dot(a.up, b.up) + dot(a.back, b.back) - 1) / 2)));
  const apart = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
  /** The orbit centre shared by two views taken before and after a rotation. */
  function pivot(a, b) {
    const d = apart(a.position, b.position) / apart(a.back, b.back);
    const first = a.position.map((v, i) => v - a.back[i] * d), second = b.position.map((v, i) => v - b.back[i] * d);
    return { point: first, error: apart(first, second) / d };
  }
  const turnPixels = async () => (await canvas.boundingBox()).height / .6;
  async function orbit(dx, dy, button = 'left') {
    // Starts to the right, clear of the toolbar, panel list and status line.
    const box = await canvas.boundingBox(), x = box.x + box.width * .78 - dx / 2, y = box.y + box.height * .5 - dy / 2;
    await page.mouse.move(x, y); await page.mouse.down({ button }); await page.mouse.move(x + dx, y + dy, { steps: 8 }); await page.mouse.up({ button });
    return view();
  }
  const home = async () => { await page.keyboard.press('f'); return view(); };
  const gridShown = () => page.evaluate(() => { let shown; window.__scene.traverse(o => { if (o.type === 'GridHelper') shown = o.visible; }); return shown; });
  async function allAngles(mode) {
    const turn = await turnPixels();
    for (const sign of [1, -1]) {
      let previous = await home(), centre = null; const heights = [], inverted = [];
      for (let i = 0; i < 12; i++) {
        const now = await orbit(0, sign * turn / 12), moved = angle(previous, now), at = pivot(previous, now);
        assert.ok(moved > .35 && moved < .56, `${mode}: vertical step ${i} turned ${moved}`);
        assert.ok(at.error < .002, `${mode}: orbit centre ${at.error}`);
        if (centre) assert.ok(apart(centre, at.point) < .01, 'one stable orbit centre');
        centre = at.point; near(now.right[2], 0, 1e-4, 'level horizon');
        heights.push(now.back[2]); inverted.push(now.up[2] < 0); previous = now;
      }
      assert.ok(Math.max(...heights) > .9 && Math.min(...heights) < -.9 && inverted.some(Boolean), `${mode}: over the top and underneath ${heights}`);
    }
    const start = await home(), turned = []; let previous = start;
    for (let i = 0; i < 16; i++) {
      const now = await orbit(turn / 12, 0);
      assert.ok(angle(previous, now) > .2, `${mode}: horizontal never stops`); near(now.back[2], start.back[2], 1e-4, 'constant elevation');
      turned.push(Math.atan2(now.back[1], now.back[0])); previous = now;
    }
    for (const side of [-Math.PI / 2, 0, Math.PI / 2, Math.PI]) assert.ok(turned.some(a => Math.abs(Math.atan2(Math.sin(a - side), Math.cos(a - side))) < .45), `${mode}: side ${side}`);
    const rest = await home(), panned = await orbit(120, 60, 'right');
    assert.ok(angle(rest, panned) < 1e-3 && apart(rest.position, panned.position) > .02, 'right drag pans');
    const box = await canvas.boundingBox(); await page.mouse.move(box.x + box.width * .6, box.y + box.height * .5); await page.mouse.wheel(0, -500);
    const zoomed = await view(); assert.ok(angle(panned, zoomed) < 1e-3 && apart(panned.position, zoomed.position) > .02, 'wheel zooms');
    const back = await home(); assert.ok(angle(rest, back) < 1e-3 && apart(rest.position, back.position) < .002, 'F restores the view');
  }
  await loaded(); await page.keyboard.press('Escape');
  const layouts = placements.length;
  await allAngles('normal');
  assert.equal(await page.locator('.asm-tree>li.selected').count(), 0, 'orbiting selects nothing');
  assert.equal(placements.length, layouts, 'orbiting moves no panel');
  pass('360° orbit: over both poles in both directions, full horizontal turns, stable centre; pan, zoom and F');

  await home(); await orbit(0, -(await turnPixels()) * .27); const below = await view();
  assert.ok(below.back[2] < -.5, 'seen from underneath'); assert.equal(await gridShown(), false);
  await page.screenshot({ path: path.join(output, '07-underneath.png') });
  // A drag that starts on a panel and returns to its start must not pick a face.
  await button('Mate').click();
  const prompt = await status.innerText(), middle = await screen([0, 1, 2].map(i => (layout().bounds[a].min[i] + layout().bounds[a].max[i]) / 2000));
  await page.mouse.move(middle.x, middle.y); await page.waitForTimeout(1500);
  await page.mouse.down(); await page.mouse.move(middle.x + 90, middle.y + 40, { steps: 5 }); await page.mouse.move(middle.x, middle.y, { steps: 5 }); await page.mouse.up();
  await view(); await page.waitForTimeout(300);
  assert.equal(await status.innerText(), prompt, 'a drag is not a face pick');
  await clickFace(c, (face, normal) => normal.z < -.99);
  await status.getByText('Now click the face it should join, on another panel.').waitFor();
  await page.keyboard.press('Escape');
  pass('from underneath: grid hidden, faces can be picked, and dragging never picks');

  await home(); await orbit(0, -(await turnPixels()) * .27);
  await page.locator('.asm-tree>li[data-entry=B] .asm-tree-name').click(); await loaded();
  const still = await view();
  await dragAxis('X', 70);
  assert.ok(angle(still, await view()) < 1e-6 && apart(still.position, (await view()).position) < 1e-6, 'dragging the gizmo does not orbit');
  const from = position(b), solved = placements.length;
  await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 200 && placements.length === solved; i++) await page.waitForTimeout(50);
  await loaded(); assert.ok(dot(position(b).map((v, i) => v - from[i]), still.right) > .5, 'right is still screen right');
  assert.ok(angle(still, await orbit(0, 100)) > .3, 'orbit works again after the gizmo');
  pass('from underneath: the gizmo and arrow keys move the panel without turning the view');

  await page.keyboard.press('Escape'); await button('Full Screen').click(); await page.waitForTimeout(700);
  await allAngles('full screen');
  const angled = await orbit(-140, (await turnPixels()) * .4);
  await button('Exit full screen').click(); await page.waitForTimeout(700);
  assert.ok(angle(angled, await view()) < 1e-3, 'leaving full screen keeps the angle');
  pass('360° orbit works in full screen and the angle is kept on exit');

  // STEP export and re-opening both still work.
  const download = page.waitForEvent('download'); await button('Export assembly as STEP (.step)').click();
  await (await download).saveAs(path.join(output, 'assembly.step'));
  assert.ok(fs.readFileSync(path.join(output, 'assembly.step'), 'utf8').startsWith('ISO-10303-21'));
  await page.setViewportSize({ width: 800, height: 900 }); await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(output, '06-narrow.png') });
  pass('STEP export works');

  assert.deepEqual(errors, []); pass('no page errors and no browser popups');
  console.log(`\n${results.length} checks passed. Screenshots: ${output}`);
} catch (error) {
  console.error(logs.slice(-2000)); console.error('Screenshots: ' + output);
  try { await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: path.join(output, 'failure.png') }); } catch {}
  throw error;
} finally { await browser?.close(); server.kill('SIGTERM'); apiServer.kill('SIGTERM'); }
