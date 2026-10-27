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
  const submitted=[],validations=[];
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
    if(pathname.endsWith('/assembly/validate'))validations.push(JSON.parse(result.body.toString()));
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
  await page.goto(url,{waitUntil:'networkidle'});await openProject();
  await add(sample.panels[0],true);await add(sample.panels[1]);
  const initial=await exportAssembly('before-face.glb');
  const savedBefore=(await stored()).projects[project.id];
  const rows=initial.metadata.cadTransformsMm;
  const catalogs=await Promise.all(rows.map(async row=>{
    const response=await fetch(apiURL+`/projects/${project.id}/assembly/faces`,{method:'POST',headers:{'x-flatforge-key':apiKey,'content-type':'application/json'},body:JSON.stringify({id:row.id,panelId:row.panelId,revision:row.revision})});
    assert.equal(response.status,200);return response.json();
  }));
  const topFaces=catalogs.map(c=>c.faces.filter(f=>f.supported&&f.normal[2]>.999).sort((a,b)=>b.area-a.area)[0]);
  const editor=page.getByRole('region',{name:'CAD face connection editor'});
  const apply=()=>editor.getByRole('button',{name:'Apply position',exact:true});
  await entries.nth(1).getByRole('button',{name:'Connect actual CAD faces',exact:true}).click();
  assert.equal(await apply().isDisabled(),true);
  const canvas=page.locator('.asm-viewer-wrap canvas');
  async function clickFace(index){
    await editor.getByRole('button',{name:index===0?'Pick reference face A':'Pick moving face B',exact:true}).click();
    await page.getByRole('button',{name:'Fit to view',exact:true}).click();
    await page.waitForTimeout(500);
    const rect=await canvas.boundingBox();
    const box=initial.bounds.reduce((box,b)=>box.union(b),new THREE.Box3());
    const size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
    const camera=new THREE.PerspectiveCamera(32,rect.width/rect.height,.001,1000);camera.up.set(0,0,1);
    const vFov=THREE.MathUtils.degToRad(32),hFov=2*Math.atan(Math.tan(vFov/2)*camera.aspect);
    const dist=size.length()/2/Math.sin(Math.min(vFov,hFov)/2)*1.15+.1;
    camera.position.copy(center).addScaledVector(new THREE.Vector3(1,-1.25,1.15).normalize(),dist);camera.lookAt(center);camera.updateMatrixWorld();
    const matrix=new THREE.Matrix4().fromArray(rows[index].matrix);matrix.elements[12]/=1000;matrix.elements[13]/=1000;matrix.elements[14]/=1000;
    const target=new THREE.Vector3(...topFaces[index].center).multiplyScalar(.001).applyMatrix4(matrix).project(camera);
    await page.mouse.click(rect.x+(target.x+1)*rect.width/2,rect.y+(1-target.y)*rect.height/2);
    await editor.locator('.asm-face-pair small').nth(index).getByText(topFaces[index].id,{exact:true}).waitFor();
  }
  await clickFace(0);await clickFace(1);await loaded();
  await editor.getByRole('spinbutton',{name:'Connection gap',exact:true}).fill('20');
  await editor.getByRole('spinbutton',{name:'Vertical offset (local V)',exact:true}).fill('50');
  await editor.getByRole('spinbutton',{name:'Horizontal offset (local U)',exact:true}).fill('-12.5');
  await loaded();
  assert.equal(await apply().isDisabled(),false);
  let checked=validations.at(-1);near(checked.clearances[0].actual,20,1e-5);near(checked.clearances[0].surfaceDistance,20,1e-5);near(checked.clearances[0].offsetV,50,1e-5);
  assert.deepEqual(submitted.at(-1)[0].matrix,rows[0].matrix);
  assert.deepEqual((await stored()).projects[project.id],savedBefore,'preview must not persist before Apply');
  assert.equal(await page.getByRole('button',{name:'Export assembly as STEP (.step)',exact:true}).isDisabled(),true);
  // Invalid and incomplete drafts retain saved data and cannot be applied.
  await editor.getByRole('spinbutton',{name:'Connection gap',exact:true}).fill('');assert.equal(await apply().isDisabled(),true);
  await editor.getByRole('alert').waitFor();
  await editor.getByRole('spinbutton',{name:'Connection gap',exact:true}).fill('20');
  await editor.getByRole('spinbutton',{name:'Normal adjustment (local N)',exact:true}).fill('-21');assert.equal(await apply().isDisabled(),true);
  await editor.getByRole('spinbutton',{name:'Normal adjustment (local N)',exact:true}).fill('0');await loaded();
  await editor.getByRole('spinbutton',{name:'Vertical offset (local V)',exact:true}).fill('10000');
  await page.getByText(/selected faces no longer overlap in projection/).waitFor();assert.equal(await apply().isDisabled(),true);
  await editor.getByRole('spinbutton',{name:'Vertical offset (local V)',exact:true}).fill('50');await loaded();
  const canvasHandle=await canvas.elementHandle();
  // Orbit while picking must not accidentally change the anchor.
  const anchor=JSON.stringify(submitted.at(-1)[1].connection.reference);
  await editor.getByRole('button',{name:'Pick reference face A',exact:true}).click();
  const rect=await canvas.boundingBox();await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await page.mouse.down();await page.mouse.move(rect.x+rect.width/2+80,rect.y+rect.height/2+40,{steps:8});await page.mouse.up();
  assert.equal(JSON.stringify(submitted.at(-1)[1].connection.reference),anchor);
  // Toggle pick off through Cancel, then confirm the draft was discarded.
  await editor.getByRole('button',{name:'Cancel',exact:true}).click();await loaded();
  assert.deepEqual((await stored()).projects[project.id],savedBefore);
  await entries.nth(1).getByRole('button',{name:'Connect actual CAD faces',exact:true}).click();
  await clickFace(0);await clickFace(1);
  await editor.getByRole('spinbutton',{name:'Connection gap',exact:true}).fill('20');
  await editor.getByRole('spinbutton',{name:'Vertical offset (local V)',exact:true}).fill('50');await loaded();
  // Navigating away with a draft invokes the existing unsaved-work guard.
  let guarded=false;page.once('dialog',async dialog=>{guarded=true;await dialog.dismiss();});
  await page.getByRole('button',{name:'All projects',exact:true}).click();assert.ok(guarded);await editor.waitFor();
  await apply().click();await editor.waitFor({state:'detached'});await loaded();
  assert.equal(await canvasHandle.evaluate(element=>element.isConnected),true,'face editing preserves the viewer/camera');
  const saved=(await stored()).projects[project.id];assert.equal(saved[1].connection.offsetV,50);assert.equal(saved[1].gap,20);
  const assembled=await exportAssembly('face-connected.glb');
  assert.equal(assembled.bounds.length,2,'selection helpers must not be exported');
  await exportSTEP('face-connected.step',assembled.metadata.cadTransformsMm);
  await page.reload({waitUntil:'networkidle'});await loaded();
  assert.deepEqual((await stored()).projects[project.id],saved);
  await entries.nth(1).getByRole('button',{name:'Edit face connection',exact:true}).click();
  assert.equal(await editor.getByRole('spinbutton',{name:'Vertical offset (local V)',exact:true}).inputValue(),'50');
  await editor.getByRole('spinbutton',{name:'Normal adjustment (local N)',exact:true}).fill('5');
  await editor.getByRole('spinbutton',{name:'In-plane rotation',exact:true}).fill('12');await loaded();
  checked=validations.at(-1);near(checked.clearances[0].surfaceDistance,25,1e-5);
  await page.locator('.asm-studio').screenshot({path:path.join(output,'face-editor-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  await page.locator('.asm-studio').screenshot({path:path.join(output,'face-editor-mobile.png')});
  await editor.getByRole('button',{name:'Cancel',exact:true}).click();await loaded();
  assert.deepEqual((await stored()).projects[project.id],saved);
  // Stale identities cannot silently move to another face. Recovery stays usable.
  await page.evaluate(projectId=>{
    const data=JSON.parse(localStorage.getItem('flatforge.assemblies.v1'));
    data.projects[projectId][1].connection.reference.sourceSha='0'.repeat(64);
    localStorage.setItem('flatforge.assemblies.v1',JSON.stringify(data));
  },project.id);
  await page.setViewportSize({width:1600,height:1100});
  await page.reload({waitUntil:'networkidle'});
  await page.locator('.asm-cad-controls').getByText(/older panel result/).waitFor();
  await entries.nth(1).getByRole('button',{name:'Edit face connection',exact:true}).click();
  assert.equal(await apply().isDisabled(),true);
  await editor.getByRole('button',{name:'Reselect both faces',exact:true}).click();await loaded();
  assert.equal(await apply().isDisabled(),true,'old validation cannot approve incomplete reselection');
  await clickFace(0);await clickFace(1);await loaded();
  await apply().click();await loaded();
  assert.equal((await stored()).projects[project.id][1].connection.reference.sourceSha,catalogs[0].sourceSha);
  assert.deepEqual(errors,[]);
  console.log('PASS: actual CAD face clicks and highlights; local gap/offset preview; fixed reference; Apply/Cancel; incomplete/negative input and lost-overlap rejection; no draft export; navigation guard; persisted face references; matching GLB/STEP solid transforms; reload; rotation/normal adjustment; orbit during selection; desktop/mobile.');
  console.log('Artifacts: '+output);
} catch(error){console.error(logs.slice(-2000));throw error;}
finally{await browser?.close();server?.kill('SIGTERM');apiServer.kill('SIGTERM');}
