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
  const submitted=[],validations=[],placements=[],catalogResponses=[];
  let holdNextValidation=false,heldValidation=null,holdNextPlacement=false,heldPlacement=null,failNextStep=false;
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
    if(pathname.endsWith('/assembly/place')&&holdNextPlacement){holdNextPlacement=false;heldPlacement={route,result};return;}
    if(pathname.endsWith('/assembly/validate')&&holdNextValidation){holdNextValidation=false;heldValidation={route,result};return;}
    if(pathname.endsWith('/assembly/place')&&response.ok)placements.push(JSON.parse(result.body.toString()));
    if(pathname.endsWith('/assembly/faces')&&response.ok)catalogResponses.push(JSON.parse(result.body.toString()));
    if(pathname.endsWith('/assembly/validate'))validations.push(JSON.parse(result.body.toString()));
    await route.fulfill(result);
  });
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('flatforge.assemblies.v1')));
  async function openProject() {
    await page.getByRole('button', { name: 'Open ' + project.name, exact: true }).click();
    await page.getByRole('button', { name: '06 Assembly drawings', exact: true }).click();
  }
  async function loaded() { await page.locator('[data-assembly-ready="true"]').waitFor({ timeout: 45000 }); await page.locator('[data-cad-valid="true"]').waitFor({timeout:45000}); }
  async function add(panel, first = false) {
    await page.getByRole('button', { name: first ? 'Select First Panel' : 'Add Panel', exact: true }).click();
    await page.getByRole('region',{name:'Choose a panel'}).getByRole('button',{name:panel.filename+' Ready · folded CAD solid',exact:true}).click();
    await loaded();
  }
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
  await add(sample.panels[0],true);
  assert.equal((await stored()).projects[project.id][0].label,'A');
  await page.getByRole('button',{name:'Select Panel A',exact:true}).waitFor();
  await add(sample.panels[1]);
  const savedBefore=(await stored()).projects[project.id];assert.equal(savedBefore.length,1);
  const rows=placements.at(-1).entries;
  const catalogs=await Promise.all(rows.map(async row=>{
    const response=await fetch(apiURL+`/projects/${project.id}/assembly/faces`,{method:'POST',headers:{'x-flatforge-key':apiKey,'content-type':'application/json'},body:JSON.stringify({id:row.id,panelId:row.panelId,revision:row.revision})});
    assert.equal(response.status,200);return response.json();
  }));
  const topFaces=catalogs.map(c=>c.faces.filter(f=>f.supported&&f.normal[2]>.999).sort((a,b)=>b.area-a.area)[0]);
  const editor=page.getByRole('region',{name:'Connection controls'});
  const apply=()=>editor.getByRole('button',{name:'Apply position',exact:true});
  const field=name=>editor.getByRole('spinbutton',{name,exact:true});
  const canvas=page.locator('.assembly-workspace canvas');
  async function cameraFor(layout){
    await canvas.scrollIntoViewIfNeeded();await page.getByRole('button',{name:'Fit Assembly',exact:true}).click();await page.waitForTimeout(400);
    const rect=await canvas.boundingBox(),box=new THREE.Box3();
    for(const b of Object.values(layout.bounds))box.union(new THREE.Box3(new THREE.Vector3(...b.min).multiplyScalar(.001),new THREE.Vector3(...b.max).multiplyScalar(.001)));
    const size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
    const camera=new THREE.PerspectiveCamera(32,rect.width/rect.height,.001,1000);camera.up.set(0,0,1);
    const vFov=THREE.MathUtils.degToRad(32),hFov=2*Math.atan(Math.tan(vFov/2)*camera.aspect);
    const dist=size.length()/2/Math.sin(Math.min(vFov,hFov)/2)*1.15+.1;
    camera.position.copy(center).addScaledVector(new THREE.Vector3(1,-1.25,1.15).normalize(),dist);camera.lookAt(center);camera.updateMatrixWorld();
    return {camera,rect,project:point=>{const p=point.clone().project(camera);return {x:rect.x+(p.x+1)*rect.width/2,y:rect.y+(1-p.y)*rect.height/2};}};
  }
  async function clickFace(index){
    await editor.getByRole('button',{name:index===0?'1. Reference side · Panel A':'2. New side · Panel B',exact:true}).click();
    const layout=placements.at(-1),{project}=await cameraFor(layout);
    const matrix=new THREE.Matrix4().fromArray(layout.entries[index].matrix);matrix.elements[12]/=1000;matrix.elements[13]/=1000;matrix.elements[14]/=1000;
    const target=project(new THREE.Vector3(...topFaces[index].center).multiplyScalar(.001).applyMatrix4(matrix));
    await page.mouse.move(target.x,target.y);await page.locator('.asm-face-tooltip').getByText(new RegExp('Top — Face '+topFaces[index].id.slice(5))).waitFor();
    await page.mouse.click(target.x,target.y);
    await editor.locator('.asm-side-step small').nth(index).getByText('Top — Face '+topFaces[index].id.slice(5),{exact:true}).waitFor();
  }
  await clickFace(0);await clickFace(1);await loaded();
  await field('Connection gap').fill('20');await field('Y offset — along face').fill('50');await field('X offset — along face').fill('-12.5');await loaded();
  let checked=validations.at(-1);near(checked.clearances[0].actual,20,1e-5);near(checked.clearances[0].surfaceDistance,20,1e-5);near(checked.clearances[0].offsetV,50,1e-5);
  assert.deepEqual(submitted.at(-1)[0].matrix,rows[0].matrix);
  assert.deepEqual((await stored()).projects[project.id],savedBefore);
  assert.equal(await page.getByRole('button',{name:'Export assembly as STEP (.step)',exact:true}).isDisabled(),true);
  const connect=editor.getByRole('button',{name:'Connect Panels',exact:true});
  await field('Connection gap').fill('');assert.equal(await connect.isDisabled(),true);
  await field('Connection gap').fill('20');await field('Z offset — normal').fill('-21');assert.equal(await connect.isDisabled(),true);
  await field('Z offset — normal').fill('0');await loaded();
  await field('Y offset — along face').fill('10000');await page.getByText(/selected faces no longer overlap in projection/).waitFor();assert.equal(await connect.isDisabled(),true);
  await field('Y offset — along face').fill('50');await loaded();
  let guarded=false;page.once('dialog',async dialog=>{guarded=true;await dialog.dismiss();});await page.getByRole('button',{name:'All projects',exact:true}).click();assert.ok(guarded);
  await connect.click();await editor.waitFor({state:'detached'});await loaded();
  const saved=(await stored()).projects[project.id];assert.equal(saved[1].label,'B');assert.equal(saved[1].connection.offsetV,50);
  await page.getByRole('button',{name:'Move',exact:true}).click();await editor.waitFor();
  const canvasHandle=await canvas.elementHandle();
  holdNextPlacement=true;await field('Y offset — along face').fill('60');
  for(let i=0;i<100&&!heldPlacement;i++)await page.waitForTimeout(25);assert.ok(heldPlacement);
  assert.equal(await apply().isDisabled(),true);
  const oldLayout=placements.at(-1);
  const pendingCamera=await cameraFor(oldLayout),pendingFrame=oldLayout.frames[saved[1].id];
  const pendingOrigin=new THREE.Vector3(...pendingFrame.origin).multiplyScalar(.001);
  const pendingScale=pendingOrigin.distanceTo(pendingCamera.camera.position)*Math.min(1.9*Math.tan(Math.PI*32/360),7)*.8/4;
  const oldHandle=pendingCamera.project(pendingOrigin.clone().addScaledVector(new THREE.Vector3(...pendingFrame.v),pendingScale*.45));
  await page.mouse.move(oldHandle.x,oldHandle.y);await page.mouse.down();await page.mouse.move(oldHandle.x+15,oldHandle.y-10,{steps:3});
  assert.equal(await field('Y offset — along face').inputValue(),'60','pending placement must not expose a stale drag frame');
  await page.mouse.up();await heldPlacement.route.fulfill(heldPlacement.result);await loaded();
  await field('Y offset — along face').fill('50');await loaded();
  // Exercise an actual pointer drag on the Three.js local Y handle.
  const layout=placements.at(-1),frame=layout.frames[saved[1].id],{camera,project:projectPoint}=await cameraFor(layout);
  const origin=new THREE.Vector3(...frame.origin).multiplyScalar(.001);
  // Same documented perspective scale as TransformControlsGizmo.updateMatrixWorld.
  const factor=origin.distanceTo(camera.position)*Math.min(1.9*Math.tan(Math.PI*camera.fov/360)/camera.zoom,7)*.8/4;
  const direction=new THREE.Vector3(...frame.v);
  const from=projectPoint(origin.clone().addScaledVector(direction,factor*.45));
  const to=projectPoint(origin.clone().addScaledVector(direction,factor*.45+.05));
  await page.locator(".assembly-workspace").screenshot({path:path.join(output,"before-drag.png")});await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:10});
  await page.locator('.asm-mode-indicator').filter({hasText:'Moving · release'}).waitFor({timeout:5000});
  assert.equal(await apply().isDisabled(),true);
  const liveY=Number(await field('Y offset — along face').inputValue());assert.ok(liveY>50,'drag must update the mm field');
  await page.mouse.up();await loaded();
  near(validations.at(-1).clearances[0].surfaceDistance,20,1e-5);
  assert.deepEqual((await stored()).projects[project.id],saved);
  await page.locator('.assembly-workspace').screenshot({path:path.join(output,'workspace-drag.png')});
  await editor.getByRole('button',{name:'Reset position',exact:true}).click();await loaded();assert.equal(await field('Y offset — along face').inputValue(),'50');
  await field('Y offset — along face').fill('-30.125');await loaded();await apply().click();await editor.waitFor({state:'detached'});await loaded();
  assert.equal((await stored()).projects[project.id][1].connection.offsetV,-30.125);
  assert.equal(await canvasHandle.evaluate(e=>e.isConnected),true);
  await page.getByRole('button',{name:'Undo',exact:true}).click();await loaded();assert.equal((await stored()).projects[project.id][1].connection.offsetV,50);
  await page.getByRole('button',{name:'Redo',exact:true}).click();await loaded();assert.equal((await stored()).projects[project.id][1].connection.offsetV,-30.125);
  await page.getByRole('button',{name:'Rotate',exact:true}).click();await field('In-plane rotation').fill('12');await field('Z offset — normal').fill('5');await loaded();near(validations.at(-1).clearances[0].surfaceDistance,25,1e-5);await apply().click();await loaded();
  // Add C using either existing reference, then mate it to B's outward back face.
  await add(sample.panels[2]);
  const referenceSelect=editor.getByRole('combobox',{name:'Reference panel',exact:true});
  assert.equal(await referenceSelect.locator('option').count(),2);
  await referenceSelect.selectOption(saved[0].id);await referenceSelect.selectOption(saved[1].id);
  for(const detail of await editor.locator('details').all())await detail.locator('summary').click();
  const cRow=placements.at(-1).entries.at(-1);
  for(let i=0;i<100&&!catalogResponses.some(c=>c.entryId===cRow.id);i++)await page.waitForTimeout(50);
  const catalogC=catalogResponses.find(c=>c.entryId===cRow.id);
  assert.ok(catalogC,'new CAD face catalog should load for the unified picker');
  const backB=catalogs[1].faces.filter(f=>f.supported&&f.normal[2]<-.999).sort((a,b)=>b.area-a.area)[0];
  const topC=catalogC.faces.filter(f=>f.supported&&f.normal[2]>.999).sort((a,b)=>b.area-a.area)[0];
  await editor.getByRole('combobox',{name:'Reference connection side',exact:true}).selectOption(backB.id);
  await editor.getByRole('combobox',{name:'Moving connection side',exact:true}).selectOption(topC.id);
  await field('Connection gap').fill('40');await page.getByText(/Placement conflict:/).waitFor();
  assert.equal(await editor.getByRole('button',{name:'Connect Panels',exact:true}).isDisabled(),true);
  const branchGap=Math.ceil(sample.panels[1].report.bbox[2]+sample.panels[2].report.bbox[2])+50;
  await field('Connection gap').fill(String(branchGap));await loaded();
  await editor.getByRole('button',{name:'Connect Panels',exact:true}).click();await loaded();
  const beforeBranch=placements.at(-1);
  await page.getByRole('button',{name:'Select Panel B',exact:true}).click();await page.getByRole('button',{name:'Move',exact:true}).click();
  await field('Y offset — along face').fill('25');await loaded();
  const afterBranch=placements.at(-1);
  assert.deepEqual(beforeBranch.entries[0].matrix,afterBranch.entries[0].matrix);
  for(let j=12;j<=14;j++)near(afterBranch.entries[1].matrix[j]-beforeBranch.entries[1].matrix[j],afterBranch.entries[2].matrix[j]-beforeBranch.entries[2].matrix[j],1e-5);
  near(validations.at(-1).clearances[0].surfaceDistance,25,1e-5);near(validations.at(-1).clearances[1].surfaceDistance,branchGap,1e-5);
  await apply().click();await loaded();
  // Root translation must move both CAD solids together, without changing the mate.
  const beforeRoot=placements.at(-1);await page.getByRole('button',{name:'Select Panel A',exact:true}).click();await page.getByRole('button',{name:'Move',exact:true}).click();
  const rootEditor=page.getByRole('region',{name:'Root position controls'});
  await rootEditor.getByRole('spinbutton',{name:'Y offset — up',exact:true}).fill('75');await loaded();
  for(let i=0;i<3;i++)near(placements.at(-1).entries[i].matrix[14]-beforeRoot.entries[i].matrix[14],75,1e-5);
  await rootEditor.getByRole('button',{name:'Apply position',exact:true}).click();await loaded();
  const assembled=await exportAssembly('workspace-connected.glb');assert.equal(assembled.bounds.length,3,'no gizmo or labels in export');
  await exportSTEP('workspace-connected.step',assembled.metadata.cadTransformsMm);
  const savedFinal=(await stored()).projects[project.id];await page.reload({waitUntil:'networkidle'});await loaded();assert.deepEqual((await stored()).projects[project.id],savedFinal);
  await page.getByRole('button',{name:'Panels',exact:true}).click();await page.getByRole('button',{name:'Hide Panel B',exact:true}).click();await page.getByRole('button',{name:'Select Panel B',exact:true}).waitFor({state:'hidden'});
  const hiddenExport=await exportAssembly('workspace-hidden.glb');assert.equal(hiddenExport.bounds.length,3);
  await page.getByRole('button',{name:'Show all panels',exact:true}).click();await page.getByRole('button',{name:'Close panel list',exact:true}).click();
  await page.getByRole('button',{name:'Select Panel B',exact:true}).click();await page.getByRole('button',{name:'Move',exact:true}).click();
  await page.locator('.assembly-workspace').screenshot({path:path.join(output,'workspace-desktop.png')});
  await page.setViewportSize({width:390,height:844});await editor.getByRole('button',{name:'Collapse position controls',exact:true}).click();await page.locator('.assembly-workspace').screenshot({path:path.join(output,'workspace-mobile.png')});await editor.getByRole('button',{name:'Expand position controls',exact:true}).click();
  await editor.getByRole('button',{name:'Cancel',exact:true}).click();await loaded();
  // Saved face IDs cannot silently bind to a rebuilt source. Reselecting uses
  // current actual faces and repairs only the explicit, validated draft.
  await page.setViewportSize({width:1600,height:1100});
  await page.evaluate(id=>{const data=JSON.parse(localStorage.getItem('flatforge.assemblies.v1'));data.projects[id][1].connection.reference.sourceSha='0'.repeat(64);localStorage.setItem('flatforge.assemblies.v1',JSON.stringify(data));},project.id);
  await page.reload({waitUntil:'networkidle'});await page.locator('.asm-cad-controls').getByText(/older panel result/).waitFor();
  await page.getByRole('button',{name:'Panels',exact:true}).click();await page.locator('.asm-panel-list>div').nth(1).locator('button').first().click();await page.getByRole('button',{name:'Close panel list',exact:true}).click();
  await page.getByRole('button',{name:'Connection',exact:true}).click();assert.equal(await apply().isDisabled(),true);
  await editor.getByRole('button',{name:'Reselect sides',exact:true}).click();
  for(const detail of await editor.locator('details').all())await detail.locator('summary').click();
  await editor.getByRole('combobox',{name:'Reference connection side',exact:true}).selectOption(topFaces[0].id);
  await editor.getByRole('combobox',{name:'Moving connection side',exact:true}).selectOption(topFaces[1].id);await loaded();
  await apply().click();await loaded();assert.equal((await stored()).projects[project.id][1].connection.reference.sourceSha,catalogs[0].sourceSha);
  assert.deepEqual(errors,[]);
  console.log('PASS: actual face picking; panel labels; guided Add/Connect; gap and signed offset accuracy; pointer gizmo drag; precision entry; invalid/rejected drafts; reset, Apply/Cancel, undo/redo; root group movement; persistence; visibility; exact STEP/GLB transforms; no exported helpers; desktop/mobile.');
  console.log('Artifacts: '+output);
} catch(error){console.error(logs.slice(-2000));try{const pages=browser?.contexts()[0]?.pages();if(pages?.length)await pages[0].screenshot({path:path.join(output,'failure.png'),fullPage:true});}catch{}throw error;}
finally{await browser?.close();server?.kill('SIGTERM');apiServer.kill('SIGTERM');}
