/** Route, CRUD and drawing-isolation regression. Real UI, mocked API transport. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.env.FLATFORGE_QA_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'flatforge-navigation-'));
fs.mkdirSync(output, { recursive: true });
const url = process.env.FLATFORGE_TEST_URL || 'http://127.0.0.1:5178';
const server = process.env.FLATFORGE_TEST_URL ? null : spawn(process.execPath,
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5178', '--strictPort'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', browser, page;
server?.stdout.on('data', data => { logs += data; }); server?.stderr.on('data', data => { logs += data; });
try {
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(url)).ok) break; } catch {}
    if (i === 179) throw new Error('Server failed: ' + logs.slice(-3000));
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ executablePath: process.env.FLATFORGE_CHROMIUM || undefined,
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  const errors = [], writes = [], confirmations = [];
  page.on('pageerror', error => errors.push(error.message));
  let acceptLeave = false;
  page.on('dialog', async dialog => { confirmations.push(dialog.message()); await (acceptLeave ? dialog.accept() : dialog.dismiss()); });
  const sample = JSON.parse(fs.readFileSync(path.join(root, 'lib/sample-data.json')));
  sample.mode = 'live'; sample.capabilities.connected = true; sample.capabilities.worker_online = true;
  const project = sample.projects[0], [a, b, c] = sample.panels;
  const originalA = structuredClone(a), originalC = structuredClone(c);
  const other = { ...project, id: 'foreign-project', name: 'Other project' };
  sample.projects.push(other);
  sample.panels.push({ ...structuredClone(a), id: 'foreign-drawing', project_id: other.id });
  const projectPath = `/projects/${project.id}/drawings`;
  const drawingURL = (panel, step) => `${url}/projects/${panel.project_id}/drawings/${panel.id}/step/${step}`;
  const heading = name => page.getByRole('heading', { name, exact: true }).first();
  const backToDrawings = () => page.getByRole('button', { name: 'Project Drawings', exact: true }).click();
  const openDrawing = panel => page.getByRole('button', { name: 'Open drawing ' + panel.filename, exact: true }).click();
  const step = number => page.getByRole('tab', { name: new RegExp(['Source', 'Conversion', 'Extract & review', 'Calculate', '3D studio'][number - 1]) }).click();
  let heldLog, holdLog = false, bootstrapCount = 0, holdReview = false, releaseReview, reviewStarted;
  await page.route('**/api/bootstrap', route => { bootstrapCount++; return route.fulfill({ json: sample }); });
  await page.route('**/api/engine/**', async route => {
    const request = route.request(), parts = new URL(request.url()).pathname.split('/').slice(3);
    const method = request.method(), panel = sample.panels.find(p => p.id === parts[1]);
    if (parts[0] === 'panels') {
      assert.ok(panel, request.url());
      if (method !== 'GET') {
        assert.equal(request.headers()['x-flatforge-project-id'], panel.project_id);
        writes.push({ panelId: panel.id, action: parts[2] || method, body: request.headers()['content-type']?.includes('json') ? request.postDataJSON() : request.postData() });
      }
      if (parts[2] === 'measurement') { Object.assign(panel, { manual_value: request.postDataJSON().value, manual_axis: request.postDataJSON().axis }); return route.fulfill({ json: panel }); }
      if (parts[2] === 'review') {
        const body = request.postDataJSON(); assert.equal(body.expected_revision, panel.revision);
        if (holdReview) await new Promise(resolve => { releaseReview = resolve; reviewStarted(); });
        panel.overrides = { ...body }; panel.revision++;
        return route.fulfill({ status: 202, json: panel });
      }
      if (parts[2] === 'log') {
        if (holdLog && panel.id === b.id) { heldLog = route; return; }
        return route.fulfill({ json: { jobs: [{ revision: panel.revision, status: panel.status, log: 'LOG FOR ' + panel.filename }] } });
      }
      if (parts[2] === 'source' && method === 'POST') {
        panel.filename = 'replaced.dxf'; panel.status = 'QUEUED'; panel.revision++; panel.report = {}; panel.artifacts = []; panel.overrides = {};
        return route.fulfill({ status: 202, json: panel });
      }
      if (parts[2] === 'files') {
        const file = path.join(root, 'public', panel.asset_base, parts[3]);
        return route.fulfill({ path: file, contentType: parts[3].endsWith('.svg') ? 'image/svg+xml' : undefined });
      }
      if (method === 'PUT') { panel.filename = request.postDataJSON().filename; return route.fulfill({ json: panel }); }
      if (method === 'DELETE') { sample.panels = sample.panels.filter(p => p.id !== panel.id); return route.fulfill({ json: { ok: true } }); }
    }
    if (parts[0] === 'projects' && parts[2] === 'assembly' && method === 'GET') return route.fulfill({json:{id:parts[1],projectId:parts[1],revision:0,units:'mm',entries:[],updated:null}});
    if (parts[0] === 'projects' && parts[2] === 'upload') {
      const created = { ...structuredClone(a), id: 'uploaded-drawing', project_id: parts[1], filename: 'uploaded.dxf', status: 'QUEUED', artifacts: [], report: {}, overrides: {}, revision: 1 };
      sample.panels.push(created); return route.fulfill({ status: 202, json: { panels: [created] } });
    }
    if (parts[0] === 'projects' && method === 'POST') { const created = { id: 'created-project', ...request.postDataJSON(), created: Date.now() }; sample.projects.push(created); return route.fulfill({ json: created }); }
    if (parts[0] === 'projects' && method === 'PUT') { const target = sample.projects.find(p => p.id === parts[1]); Object.assign(target, request.postDataJSON()); return route.fulfill({ json: target }); }
    if (parts[0] === 'projects' && method === 'DELETE') { sample.projects = sample.projects.filter(p => p.id !== parts[1]); return route.fulfill({ json: { ok: true } }); }
    throw new Error('Unmocked request ' + method + ' ' + request.url());
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Open ' + project.name, exact: true }).click();
  await page.waitForURL(url + projectPath);
  assert.equal(await page.locator('.panel-card').count(), 3);
  assert.equal(await page.getByRole('tab').count(), 0, 'management is outside processing steps');
  await page.screenshot({ path: path.join(output, 'project-drawings.png'), fullPage: true });
  await openDrawing(b); await page.waitForURL(drawingURL(b, 1));
  assert.equal(await page.locator('.panel-card').count(), 0); await heading(b.filename).waitFor();
  assert.ok((await page.locator('.drawing-source-card').textContent()).includes(b.filename));
  assert.equal(await page.getByRole('button', { name: 'Upload drawings', exact: true }).count(), 0);
  await step(2); assert.equal(await page.locator('.conversion-card').count(), 1);
  assert.ok((await page.locator('.conversion-card').textContent()).includes(b.filename));
  await step(4); await page.waitForURL(drawingURL(b, 4));
  assert.equal(await page.locator('.calculation-table tbody tr').count(), 1);
  assert.equal(await page.getByLabel('Manual measurement for ' + a.filename, { exact: true }).count(), 0);
  await page.getByLabel('Manual measurement for ' + b.filename, { exact: true }).fill('123.45');
  await page.getByRole('button', { name: 'Save measurement', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-unsaved-measurement="true"]'));
  assert.equal(writes.at(-1).panelId, b.id); assert.equal(b.manual_value, 123.45);
  assert.deepEqual(a, originalA); assert.deepEqual(c, originalC);
  await page.screenshot({ path: path.join(output, 'selected-calculation.png'), fullPage: true });
  await page.reload({ waitUntil: 'networkidle' }); await heading(b.filename).waitFor();
  assert.equal(page.url(), drawingURL(b, 4)); assert.equal(await page.locator('.calculation-table tbody tr').count(), 1);
  await page.goBack(); await page.waitForURL(drawingURL(b, 2));
  await page.goForward(); await page.waitForURL(drawingURL(b, 4));
  // Fresh history segment: management -> source -> review. Dirty drafts survive steps.
  await backToDrawings(); await openDrawing(b); await step(3);
  await page.getByLabel('Inside bend radius', { exact: true }).fill('3.25');
  await page.getByText('Unsaved drawing changes · Save & rebuild to store them.', { exact: true }).waitFor();
  const changedURL = page.url(); await backToDrawings(); assert.equal(page.url(), changedURL);
  assert.equal(confirmations.length, 1);
  await page.goBack(); await page.waitForURL(drawingURL(b, 1)); // Same drawing: no discard.
  await page.goBack(); await page.waitForURL(drawingURL(b, 1)); // Cancel leaving drawing.
  assert.equal(confirmations.length, 2);
  await page.goForward(); await page.waitForURL(drawingURL(b, 3));
  assert.equal(await page.getByLabel('Inside bend radius', { exact: true }).inputValue(), '3.25');
  const unloadBlocked = await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
  assert.equal(unloadBlocked, true);
  await page.getByRole('button', { name: 'Save & rebuild panel', exact: true }).click();
  await page.waitForURL(drawingURL(b, 2));
  assert.equal(writes.at(-1).panelId, b.id); assert.equal(writes.at(-1).body.parameter_overrides.radius, 3.25, JSON.stringify(writes.at(-1)));
  assert.deepEqual(a, originalA); assert.deepEqual(c, originalC);
  await step(3); await page.getByLabel('Inside bend radius', { exact: true }).fill('4');
  // Changes made during a pending save must not be falsely marked as saved.
  holdReview = true;
  const submitted = new Promise(resolve => { reviewStarted = resolve; });
  await page.getByRole('button', { name: 'Save & rebuild panel', exact: true }).click();
  await submitted;
  await page.getByLabel('Inside bend radius', { exact: true }).fill('4.5');
  releaseReview(); holdReview = false;
  await page.waitForURL(drawingURL(b, 2)); await step(3);
  assert.equal(writes.at(-1).body.parameter_overrides.radius, 4);
  assert.equal(await page.getByLabel('Inside bend radius', { exact: true }).inputValue(), '4.5');
  await page.locator('.review-conflict').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save & rebuild panel', exact: true }).isDisabled(), true);
  acceptLeave = true; await backToDrawings(); acceptLeave = false;
  await openDrawing(a); await step(3); assert.equal(await page.getByLabel('Inside bend radius', { exact: true }).inputValue(), String(a.settings.radius));
  // A pending inline bend draft is also guarded even before Apply.
  await page.locator('svg[aria-label="Flat pattern with geometry-linked bend values"] g[role="button"]').first().click();
  const editor = page.getByRole('dialog', { name: /^Bend / });
  await editor.getByRole('spinbutton').nth(0).fill('63');
  const beforePrompt = confirmations.length; await step(4);
  assert.equal(confirmations.length, beforePrompt + 1); assert.equal(page.url(), drawingURL(a, 3));
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await step(5); assert.equal(await page.locator('.studio-panel').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Compare', exact: true }).count(), 0);
  await backToDrawings(); await page.getByRole('button', { name: 'Compare panels', exact: true }).click();
  assert.equal(page.url(), url + `/projects/${project.id}/compare`);
  assert.equal(await page.locator('.assembly-bar label').count(), 4); // Three panels + gap.
  await backToDrawings(); await page.getByRole('button', { name: '06 Assembly drawings', exact: true }).click();
  assert.equal(page.url(), url + `/projects/${project.id}/assembly`);
  await page.getByRole('button', { name: 'Select First Panel', exact: true }).click();
  assert.equal(await page.locator('.asm-available-panels button').count(), 3);
  await page.getByRole('button',{name:'Close panel picker',exact:true}).click();
  // Direct requests are served by the real dynamic route, not only client selection.
  await page.goto(drawingURL(c, 4), { waitUntil: 'networkidle' }); await heading(c.filename).waitFor();
  assert.equal(await page.locator('.calculation-table tbody tr').count(), 1);
  assert.ok((await page.locator('.calculation-table').textContent()).includes(c.filename.replace(/\.dxf$/i, '')));
  await page.goto(`${url}/projects/${other.id}/drawings/${b.id}/step/4`, { waitUntil: 'networkidle' });
  await heading('Drawing or project unavailable').waitFor(); assert.equal(await page.locator('.calculation-table').count(), 0);
  await page.goto(drawingURL({ ...b, id: 'missing' }, 4), { waitUntil: 'networkidle' }); await heading('Drawing or project unavailable').waitFor();
  // CRUD targets on the management page must not silently select a workflow drawing.
  await page.goto(url + projectPath, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Manage ' + b.filename, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit / replace drawing', exact: true }).click();
  await page.getByLabel('Drawing filename', { exact: true }).fill('renamed.dxf');
  await page.getByRole('button', { name: 'Save drawing', exact: true }).click();
  await page.getByRole('button', { name: 'Open drawing renamed.dxf', exact: true }).waitFor();
  assert.equal(page.url(), url + projectPath); assert.equal(writes.at(-1).panelId, b.id);
  await page.getByRole('button', { name: 'Upload drawings', exact: true }).click();
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'uploaded.dxf', mimeType: 'application/dxf', buffer: Buffer.from('0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n') });
  await page.getByRole('button', { name: 'Upload 1 drawing', exact: true }).click();
  await page.getByRole('button', { name: 'Open drawing uploaded.dxf', exact: true }).waitFor();
  assert.equal(page.url(), url + projectPath); assert.equal(await page.locator('.panel-card').count(), 4);
  const uploaded = sample.panels.find(p => p.id === 'uploaded-drawing');
  await openDrawing(uploaded);
  await page.getByRole('button', { name: 'Edit / replace drawing', exact: true }).click();
  await page.getByLabel('Replace source (optional)', { exact: true }).setInputFiles({ name: 'replaced.dxf', mimeType: 'application/dxf', buffer: Buffer.from('0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n') });
  await page.getByRole('button', { name: 'Save drawing', exact: true }).click();
  await page.waitForURL(drawingURL(uploaded, 2)); assert.equal(writes.at(-1).panelId, uploaded.id);
  await page.getByRole('button', { name: 'Manage ' + uploaded.filename, exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Delete drawing', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForURL(url + projectPath); assert.equal(await page.locator('.panel-card').count(), 3);
  // Late log responses are discarded instead of replacing another drawing's logs.
  a.sample = false; b.sample = false; holdLog = true;
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Conversion log for ' + b.filename, exact: true }).click();
  await page.waitForTimeout(200); await page.getByRole('dialog').press('Escape');
  await page.getByRole('button', { name: 'Conversion log for ' + a.filename, exact: true }).click();
  await page.getByText('LOG FOR ' + a.filename, { exact: true }).waitFor();
  assert.ok(heldLog); await heldLog.fulfill({ json: { jobs: [{ revision: b.revision, status: b.status, log: 'STALE OTHER DRAWING' }] } });
  await page.waitForTimeout(100); assert.equal(await page.getByText('STALE OTHER DRAWING', { exact: true }).count(), 0);
  await page.getByRole('dialog').press('Escape'); holdLog = false;
  // Polling cannot erase dirty review edits when a different revision arrives.
  await openDrawing(a); await step(3); await page.getByLabel('Inside bend radius', { exact: true }).fill('3.5');
  const oldBootstrapCount = bootstrapCount; a.revision++;
  await page.waitForFunction(() => !!document.querySelector('.review-conflict'), undefined, { timeout: 20000 });
  assert.ok(bootstrapCount > oldBootstrapCount); assert.equal(await page.getByLabel('Inside bend radius', { exact: true }).inputValue(), '3.5');
  assert.equal(await page.getByRole('button', { name: 'Save & rebuild panel', exact: true }).isDisabled(), true);
  acceptLeave = true; await backToDrawings(); acceptLeave = false;
  await page.setViewportSize({ width: 390, height: 844 }); await openDrawing(c); await step(4);
  assert.equal(await page.locator('.calculation-table tbody tr').count(), 1);
  await page.screenshot({ path: path.join(output, 'drawing-mobile.png'), fullPage: true });
  // Project CRUD still works from the project index.
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'New project', exact: true }).first().click();
  await page.getByLabel('Project name', { exact: true }).fill('Created project');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.waitForURL(url + '/projects/created-project/drawings');
  assert.equal(await page.locator('.panel-card').count(), 0);
  await page.getByRole('button', { name: 'Manage project', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('Renamed project');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByRole('button', { name: 'Manage project', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete project', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForURL(url + '/');
  assert.deepEqual(errors, []);
  console.log('PASS: project/drawing routes, single-drawing Steps 1–5, scoped review/measurement/CRUD requests, refresh/direct URLs/back/forward, unsaved guards, stale logs/revisions, multi-panel project views, desktop/mobile and project CRUD.');
  console.log('Artifacts: ' + output);
} catch (error) {
  console.error(error); console.error(logs.slice(-2500));
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.html'), await page.content().catch(() => '')); }
  throw error;
} finally { await browser?.close(); server?.kill('SIGTERM'); }
