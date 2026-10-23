/** Real WebGL / GLB browser regression; bootstrap uses bundled panel fixtures. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.env.FLATFORGE_QA_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'flatforge-assembly-'));
fs.mkdirSync(output, { recursive: true });
const url = process.env.FLATFORGE_TEST_URL || 'http://127.0.0.1:5177';
const server = process.env.FLATFORGE_TEST_URL ? null : spawn(process.execPath,
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5177', '--strictPort'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', browser;
server?.stdout.on('data', data => { logs += data; });
server?.stderr.on('data', data => { logs += data; });
const near = (actual, expected, tolerance = .002) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
globalThis.ProgressEvent ??= class ProgressEvent extends Event {
  constructor(type, values = {}) { super(type); Object.assign(this, values); }
};
try {
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(url)).ok) break; } catch {}
    if (i === 179) throw new Error('Server did not start: ' + logs.slice(-5000));
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ executablePath: process.env.FLATFORGE_CHROMIUM || undefined,
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const sample = JSON.parse(fs.readFileSync(path.join(root, 'lib/sample-data.json')));
  const project = sample.projects[0];
  sample.projects.push({ ...project, id: 'other-project', name: 'Assembly isolation test' });
  sample.panels.push({ ...sample.panels[0], id: 'other-panel', project_id: 'other-project' });
  await page.route('**/api/bootstrap', route => route.fulfill({ json: sample }));
  const entries = page.locator('.asm-entry');
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('flatforge.assemblies.v1')));
  async function openProject(name = project.name) {
    await page.getByRole('button', { name: 'Open ' + name, exact: true }).click();
    await page.getByRole('tab', { name: /06.*Assembly/ }).click();
  }
  async function loaded() { await page.locator('[data-assembly-ready="true"]').waitFor({ timeout: 45000 }); }
  async function add(panel, first = false) {
    await page.getByRole('button', { name: first ? 'Add first panel' : 'Add next panel', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('select').first().selectOption(panel.id);
    await dialog.getByRole('button', { name: 'Add to assembly', exact: true }).click();
    await loaded();
  }
  const field = (index, name) => entries.nth(index).getByRole('spinbutton', { name, exact: true });
  const horizontal = 'Horizontal (X) gap', vertical = 'Vertical (Z) offset', depth = 'Front / back (Y) offset';
  async function exportAssembly(filename) {
    const waiting = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export assembly GLB', exact: true }).click();
    await (await waiting).saveAs(path.join(output, filename));
    const bytes = fs.readFileSync(path.join(output, filename));
    const length = bytes.readUInt32LE(12);
    const gltf = JSON.parse(bytes.subarray(20, 20 + length).toString());
    gltf.buffers[0].uri = 'data:application/octet-stream;base64,' + bytes.subarray(28 + length).toString('base64');
    delete gltf.images; delete gltf.textures; delete gltf.materials;
    gltf.meshes.forEach(mesh => mesh.primitives.forEach(primitive => delete primitive.material));
    const result = await new GLTFLoader().parseAsync(JSON.stringify(gltf), '');
    return { bounds: result.scene.children.map(child => new THREE.Box3().setFromObject(child, true)), metadata: result.scene.userData };
  }
  await page.goto(url, { waitUntil: 'networkidle' }); await openProject();
  await add(sample.panels[0], true); await add(sample.panels[1]);
  const canvas = await page.locator('.asm-viewer-wrap canvas').elementHandle();
  for (const gap of [1, 5, 10, 25, 50, 100]) {
    await field(1, horizontal).fill(String(gap));
    const exported = await exportAssembly(`gap-${gap}.glb`);
    near((exported.bounds[1].min.x - exported.bounds[0].max.x) * 1000, gap);
    assert.equal(exported.metadata.source_units, 'mm');
    assert.equal(exported.metadata.assemblyEntries[1].gap, gap);
  }
  await field(1, horizontal).fill('10');
  await field(1, vertical).fill('50'); await field(1, depth).fill('-25');
  assert.equal(await canvas.evaluate(element => element.isConnected), true, 'spacing must not replace canvas/camera');
  const before = (await stored()).projects[project.id];
  assert.deepEqual(before[1].offsets, { x: 0, y: -25, z: 50 });
  await field(1, horizontal).fill('-1'); assert.equal(await entries.nth(1).getByRole('alert').count(), 1);
  assert.equal((await stored()).projects[project.id][1].gap, 10);
  await field(1, horizontal).fill(''); assert.equal((await stored()).projects[project.id][1].gap, 10);
  await field(1, horizontal).fill('10');
  await add(sample.panels[2]);
  await field(2, horizontal).fill('5');
  const result = await exportAssembly('three-panels.glb');
  assert.equal(result.bounds.length, 3);
  result.bounds.forEach((bounds, index) => bounds.getSize(new THREE.Vector3()).toArray().forEach((size, axis) => near(size * 1000, sample.panels[index].report.bbox[axis])));
  near(result.bounds[1].min.z * 1000, 50); near(result.bounds[2].min.z * 1000, 50);
  near((result.bounds[2].min.x - result.bounds[1].max.x) * 1000, 5);
  near((result.bounds[1].getCenter(new THREE.Vector3()).y - result.bounds[0].getCenter(new THREE.Vector3()).y) * 1000, -25);
  await page.getByRole('button', { name: 'Run clash check', exact: true }).click();
  await page.getByText('No clashes — all clear', { exact: true }).waitFor();
  const box = await page.locator('.asm-viewer-wrap canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -100);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30); await page.mouse.up();
  await page.mouse.down({ button: 'right' }); await page.mouse.move(box.x + box.width / 2 + 75, box.y + box.height / 2 + 10); await page.mouse.up({ button: 'right' });
  await page.getByRole('button', { name: 'Fit to view', exact: true }).click();
  await page.locator('.asm-studio').screenshot({ path: path.join(output, 'assembly-desktop.png') });
  const saved = (await stored()).projects[project.id];
  await page.reload({ waitUntil: 'networkidle' }); await openProject(); await loaded();
  assert.equal(await entries.count(), 3);
  assert.equal(await field(1, vertical).inputValue(), '50');
  assert.deepEqual((await stored()).projects[project.id], saved);
  // Switch projects via home; assembly entries must never leak between projects.
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await openProject('Assembly isolation test'); assert.equal(await entries.count(), 0);
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await openProject(); await loaded(); assert.equal(await entries.count(), 3);
  // Selected faces decide which axis is a gap; remaining axes stay signed offsets.
  await entries.nth(1).locator('select').nth(0).selectOption('-Z');
  await entries.nth(1).locator('select').nth(1).selectOption('+Z');
  await field(1, 'Vertical (Z) gap').fill('25');
  let stacked = await exportAssembly('vertical.glb');
  near((stacked.bounds[1].min.z - stacked.bounds[0].max.z) * 1000, 25);
  await entries.nth(1).locator('select').nth(0).selectOption('+Y');
  await entries.nth(1).locator('select').nth(1).selectOption('-Y');
  await field(1, 'Front / back (Y) gap').fill('50');
  stacked = await exportAssembly('depth.glb');
  near((stacked.bounds[0].min.y - stacked.bounds[1].max.y) * 1000, 50);
  await entries.nth(1).getByRole('button', { name: 'Reset', exact: true }).click();
  assert.equal(await field(1, 'Front / back (Y) gap').inputValue(), '10');
  assert.equal(await field(1, 'Vertical (Z) offset').inputValue(), '0');
  await page.setViewportSize({ width: 390, height: 844 });
  await field(1, 'Vertical (Z) offset').fill('-10.5');
  assert.equal((await stored()).projects[project.id][1].offsets.z, -10.5);
  await page.locator('.asm-studio').screenshot({ path: path.join(output, 'assembly-mobile.png') });
  await entries.nth(1).getByRole('button', { name: 'Remove', exact: true }).click();
  assert.equal(await entries.count(), 1, 'removing a connection removes its descendants');
  assert.deepEqual(errors, []);
  console.log('PASS: WebGL preview, six exported gap measurements, 3-panel mixed dimensions, signed offsets, vertical/depth connections, invalid input, reset, persistence, project isolation, clash check, orbit/pan/zoom, mobile and branch removal.');
  console.log('Artifacts: ' + output);
} catch (error) {
  console.error(logs.slice(-2000)); throw error;
} finally { await browser?.close(); server?.kill('SIGTERM'); }
