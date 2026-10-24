/** Real WebGL + Python CAD API: shared transforms, STEP and GLB regression. */
import { spawn, spawnSync } from 'node:child_process';
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
const apiPort = 5181, apiURL = 'http://127.0.0.1:' + apiPort;
const apiKey = 'test-assembly-browser-key-never-use-in-production';
const apiData = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-assembly-browser-'));
const apiEnv = {...process.env, PYTHONPATH:path.join(root,'backend'), OPENBLAS_NUM_THREADS:'1',
  FLATFORGE_ASSEMBLY_TEST:'1', FLATFORGE_DATA:apiData, FLATFORGE_API_KEY:apiKey, FLATFORGE_TEST_API_PORT:String(apiPort)};
const apiServer=spawn(process.env.FLATFORGE_PYTHON||'python',['backend/tests/serve_assembly.py'],{cwd:root,env:apiEnv,stdio:['ignore','pipe','pipe']});
let logs = '', browser;
apiServer.stdout.on('data',data=>{logs+=data;});apiServer.stderr.on('data',data=>{logs+=data;});
server?.stdout.on('data', data => { logs += data; });
server?.stderr.on('data', data => { logs += data; });
const near = (actual, expected, tolerance = .002) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
globalThis.ProgressEvent ??= class ProgressEvent extends Event {
  constructor(type, values = {}) { super(type); Object.assign(this, values); }
};
try {
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(url)).ok && (await fetch(apiURL+'/health')).ok) break; } catch {}
    if (i === 179) throw new Error('Server did not start: ' + logs.slice(-5000));
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ executablePath: process.env.FLATFORGE_CHROMIUM || undefined,
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'lib/sample-data.json')));
  const sample=await (await fetch(apiURL+'/bootstrap',{headers:{'x-flatforge-key':apiKey}})).json();
  const project=sample.projects.find(p=>p.id===fixture.projects[0].id);
  sample.panels=sample.panels.filter(p=>p.project_id===project.id);
  const submitted=[];
  let holdNextValidation=false,heldValidation=null,failNextStep=false;
  await page.route('**/api/bootstrap',async route=>{
    const response=await fetch(apiURL+'/bootstrap',{headers:{'x-flatforge-key':apiKey}});
    await route.fulfill({status:response.status,body:Buffer.from(await response.arrayBuffer()),contentType:'application/json'});
  });
  await page.route('**/api/engine/**',async route=>{
    const request=route.request(),pathname=new URL(request.url()).pathname.replace('/api/engine','');
    if(pathname.endsWith('/assembly/step')&&failNextStep){failNextStep=false;await route.fulfill({status:503,json:{detail:'Test CAD connection interrupted; please retry.'}});return;}
    if(pathname.endsWith('/assembly/validate'))submitted.push(request.postDataJSON().entries);
    const response=await fetch(apiURL+pathname,{method:request.method(),headers:{'x-flatforge-key':apiKey,'content-type':request.headers()['content-type']||'application/json'},body:request.postDataBuffer()||undefined});
    const result={status:response.status,body:Buffer.from(await response.arrayBuffer()),headers:{'content-type':response.headers.get('content-type')||'application/octet-stream',...(response.headers.get('content-disposition')?{'content-disposition':response.headers.get('content-disposition')}:{})}};
    if(pathname.endsWith('/assembly/validate')&&holdNextValidation){holdNextValidation=false;heldValidation={route,result};return;}
    await route.fulfill(result);
  });
  const entries = page.locator('.asm-entry');
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('flatforge.assemblies.v1')));
  async function openProject(name = project.name) {
    await page.getByRole('button', { name: 'Open ' + name, exact: true }).click();
    await page.getByRole('button', { name: '06 Assembly drawings', exact: true }).click();
  }
  async function loaded() { await page.locator('[data-assembly-ready="true"]').waitFor({ timeout: 45000 }); await page.locator('[data-cad-valid="true"]').waitFor({timeout:45000}); }
  async function add(panel, first = false) {
    await page.getByRole('button', { name: first ? 'Add first panel' : 'Add next panel', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('select').first().selectOption(panel.id);
    await dialog.getByRole('button', { name: 'Add to assembly', exact: true }).click();
    await loaded();
  }
  const field = (index, name) => entries.nth(index).getByRole('spinbutton', { name, exact: true });
  const horizontal = 'Horizontal (X) gap', vertical = 'Vertical (Z) gap', depth = 'Front / back (Y) gap';
  const direction=(index,name,side)=>entries.nth(index).getByRole('combobox',{name:name+' direction',exact:true}).selectOption(String(side));
  async function exportAssembly(filename) {
    await loaded();
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
    for(const child of result.scene.children){
      const row=result.scene.userData.cadTransformsMm.find(entry=>entry.id===child.userData.entryId);
      assert.ok(row);child.updateMatrix();
      child.matrix.toArray().forEach((value,index)=>near(value*(index>=12&&index<=14?1000:1),row.matrix[index],1e-5));
    }
    return { bounds: result.scene.children.map(child => new THREE.Box3().setFromObject(child, true)), metadata: result.scene.userData };
  }
  async function exportSTEP(filename,manifest){
    await loaded();
    const waiting=page.waitForEvent('download');
    await page.getByRole('button',{name:'Export assembly as STEP (.step)',exact:true}).click();
    const downloaded=await waiting; await downloaded.saveAs(path.join(output,filename));
    fs.writeFileSync(path.join(output,filename+'.json'),JSON.stringify(manifest));
    const verified=spawnSync(process.env.FLATFORGE_PYTHON||'python',['backend/tests/verify_assembly_export.py',path.join(output,filename),path.join(output,filename+'.json')],{cwd:root,env:apiEnv,encoding:'utf8'});
    assert.equal(verified.status,0,verified.stdout+'\n'+verified.stderr);console.log(verified.stdout.trim());
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
    if(gap===10)await exportSTEP('two-panels.step',exported.metadata.cadTransformsMm);
  }
  await field(1, horizontal).fill('10');
  await direction(1,'Vertical (Z)',1);await field(1,vertical).fill('50');
  await direction(1,'Front / back (Y)',-1);await field(1,depth).fill('25');
  assert.equal(await canvas.evaluate(element => element.isConnected), true, 'spacing must not replace canvas/camera');
  const before = (await stored()).projects[project.id];
  assert.deepEqual(before[1].spacing, {x:{side:1,gap:10},y:{side:-1,gap:25},z:{side:1,gap:50}});
  await field(1, horizontal).fill('-1'); assert.equal(await entries.nth(1).getByRole('alert').count(), 1);
  assert.equal((await stored()).projects[project.id][1].gap, 10);
  await field(1, horizontal).fill(''); assert.equal((await stored()).projects[project.id][1].gap, 10);
  await field(1, horizontal).fill('10');
  await add(sample.panels[2]);
  await field(2, horizontal).fill('5');
  const result = await exportAssembly('three-panels.glb');
  assert.equal(result.bounds.length, 3);
  result.bounds.forEach((bounds, index) => bounds.getSize(new THREE.Vector3()).toArray().forEach((size, axis) => near(size * 1000, sample.panels[index].report.bbox[axis])));
  near((result.bounds[1].min.z-result.bounds[0].max.z)*1000,50);near(result.bounds[2].min.z,result.bounds[1].min.z);
  near((result.bounds[2].min.x - result.bounds[1].max.x) * 1000, 5);
  near((result.bounds[0].min.y-result.bounds[1].max.y)*1000,25);
  await exportSTEP('three-panels.step',result.metadata.cadTransformsMm);
  await page.getByRole('button', { name: 'Run clash check', exact: true }).click();
  await page.getByText('No clashes — all clear', { exact: true }).waitFor();
  const box = await page.locator('.asm-viewer-wrap canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -100);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30); await page.mouse.up();
  await page.mouse.down({ button: 'right' }); await page.mouse.move(box.x + box.width / 2 + 75, box.y + box.height / 2 + 10); await page.mouse.up({ button: 'right' });
  await page.getByRole('button', { name: 'Fit to view', exact: true }).click();
  await page.locator('.asm-studio').screenshot({ path: path.join(output, 'assembly-desktop.png') });
  const saved = (await stored()).projects[project.id];
  await page.reload({ waitUntil: 'networkidle' }); await loaded();
  assert.equal(new URL(page.url()).pathname, `/projects/${project.id}/assembly`);
  assert.equal(await entries.count(), 3);
  assert.equal(await field(1, vertical).inputValue(), '50');
  assert.deepEqual((await stored()).projects[project.id], saved);
  // Switch projects via home; assembly entries must never leak between projects.
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await openProject('Assembly isolation test'); assert.equal(await entries.count(), 0);
  await page.getByRole('button', { name: 'All projects', exact: true }).click();
  await openProject(); await loaded(); assert.equal(await entries.count(), 3);
  // Selected faces decide the primary gap; other axes keep explicit constraints.
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
  assert.equal(await field(1, vertical).inputValue(), '0');
  await page.setViewportSize({ width: 390, height: 844 });
  await direction(1,'Vertical (Z)',-1);await field(1,vertical).fill('10.5');await loaded();
  assert.deepEqual((await stored()).projects[project.id][1].spacing.z,{side:-1,gap:10.5});
  await page.locator('.asm-studio').screenshot({ path: path.join(output, 'assembly-mobile.png') });
  await entries.nth(1).getByRole('button', { name: 'Remove', exact: true }).click();
  assert.equal(await entries.count(), 1, 'removing a connection removes its descendants');
  // Two siblings can satisfy their parent gaps yet overlap each other.
  await page.setViewportSize({width:1600,height:1100});
  await add(sample.panels[1]);await add(sample.panels[1]);
  const rootEntry=(await stored()).projects[project.id][0].id;
  await entries.nth(2).locator('.target-sel').selectOption(rootEntry);
  await page.getByText(/Placement conflict:/).waitFor();
  assert.equal(await page.getByRole('button',{name:'Export assembly as STEP (.step)',exact:true}).isDisabled(),true);
  await field(2,horizontal).fill('5000');await loaded();
  const separated=await exportAssembly('branches.glb');
  await exportSTEP('branches.step',separated.metadata.cadTransformsMm);
  // Preserve arbitrary saved rotations and use rotated BREP extents in preview.
  await page.evaluate(() => {
    const data=JSON.parse(localStorage.getItem('flatforge.assemblies.v1'));
    const rows=Object.values(data.projects).find(rows=>rows.length===3);
    const angle=23*Math.PI/360;
    rows[0].rotation=[Math.sin(angle),0,0,Math.cos(angle)];
    rows[1].rotation=[0,0,Math.sin(angle),Math.cos(angle)];
    localStorage.setItem('flatforge.assemblies.v1',JSON.stringify(data));
  });
  await page.reload({waitUntil:'networkidle'});await loaded();
  const rotated=await exportAssembly('rotated.glb');
  await exportSTEP('rotated.step',rotated.metadata.cadTransformsMm);
  // Opening a legacy layout must not silently move its saved offsets.
  await page.evaluate(() => {
    const data=JSON.parse(localStorage.getItem('flatforge.assemblies.v1'));
    const id=Object.keys(data.projects).find(id=>data.projects[id].length===3);
    data.projects[id]=data.projects[id].slice(0,2);
    delete data.projects[id][1].spacing;
    data.projects[id][1].offsets={x:0,y:-20,z:50};
    localStorage.setItem('flatforge.assemblies.v1',JSON.stringify(data));
  });
  await page.reload({waitUntil:'networkidle'});await loaded();
  const legacy=await exportAssembly('legacy.glb');
  await entries.nth(1).getByRole('button',{name:'Use directional gaps',exact:true}).click();
  const converted=await exportAssembly('legacy-converted.glb');
  legacy.metadata.cadTransformsMm.forEach((entry,index)=>entry.matrix.forEach((value,axis)=>near(value,converted.metadata.cadTransformsMm[index].matrix[axis],1e-8)));
  // A delayed approval for an old layout must never authorize the new export.
  holdNextValidation=true;await field(1,horizontal).fill('17');
  for(let i=0;i<250&&!heldValidation;i++)await page.waitForTimeout(20);
  assert.ok(heldValidation,'expected an in-flight CAD validation');
  assert.equal(await page.getByRole('button',{name:'Export assembly as STEP (.step)',exact:true}).isDisabled(),true);
  await field(1,horizontal).fill('27');await loaded();
  await heldValidation.route.fulfill(heldValidation.result).catch(()=>{});
  await page.waitForTimeout(100);
  const latest=await exportAssembly('latest-only.glb');
  assert.equal(latest.metadata.assemblyEntries[1].gap,27);
  failNextStep=true;
  await page.getByRole('button',{name:'Export assembly as STEP (.step)',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Test CAD connection interrupted'}).waitFor();
  await exportSTEP('latest-only.step',latest.metadata.cadTransformsMm);
  // A saved source can return to review. Preserve its entry and show an error,
  // rather than throwing from the render effect or exporting a partial assembly.
  const retained=(await stored()).projects[project.id];
  const setSourceStatus=status=>{
    const changed=spawnSync(process.env.FLATFORGE_PYTHON||'python',['-c',
      'import sys\nfrom flatforge.db import Session, Panel\nwith Session.begin() as session:\n session.get(Panel,sys.argv[1]).status=sys.argv[2]',
      sample.panels[1].id,status],{cwd:root,env:apiEnv,encoding:'utf8'});
    assert.equal(changed.status,0,changed.stderr);
  };
  setSourceStatus('NEEDS_REVIEW');
  await page.reload({waitUntil:'networkidle'});
  await page.getByText('Could not load assembly: An assembly drawing is unavailable.',{exact:true}).waitFor();
  assert.ok((await entries.nth(1).textContent()).includes(sample.panels[1].filename.replace(/\.(dxf|dwg)$/i,'')));
  assert.equal(await page.getByRole('button',{name:'Export assembly as STEP (.step)',exact:true}).isDisabled(),true);
  assert.deepEqual((await stored()).projects[project.id],retained);
  setSourceStatus('PASS');
  await page.reload({waitUntil:'networkidle'});await loaded();
  assert.deepEqual((await stored()).projects[project.id],retained);
  assert.ok(submitted.length>10,'real CAD validation must run after spacing edits');
  assert.deepEqual(errors, []);
  console.log('PASS: real CAD API + WebGL; six measured gaps; shared STEP/GLB transforms; combined directional gaps; 3-panel mixed dimensions; exact sibling collision rejection; vertical/depth connections; invalid input; reset; persistence; project isolation; clash check; orbit/pan/zoom; mobile; branch removal; unavailable source recovery.');
  console.log('Artifacts: ' + output);
} catch (error) {
  console.error(logs.slice(-2000)); throw error;
} finally { await browser?.close(); server?.kill('SIGTERM'); apiServer.kill('SIGTERM'); }
