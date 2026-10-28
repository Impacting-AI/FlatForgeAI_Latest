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
  const submitted=[],validations=[],placements=[],catalogResponses=[],saves=[];
  let holdNextValidation=false,heldValidation=null,holdNextPlacement=false,heldPlacement=null,failNextStep=false;
  await page.route('**/api/bootstrap',async route=>{
    const response=await fetch(apiURL+'/bootstrap',{headers:{'x-flatforge-key':apiKey}});
    await route.fulfill({status:response.status,body:Buffer.from(await response.arrayBuffer()),contentType:'application/json'});
  });
  await page.route('**/api/engine/**',async route=>{
    const request=route.request(),pathname=new URL(request.url()).pathname.replace('/api/engine','');
    if(pathname.endsWith('/assembly/step')&&failNextStep){failNextStep=false;await route.fulfill({status:503,json:{detail:'Test CAD connection interrupted; please retry.'}});return;}
    if(pathname.endsWith('/assembly/validate'))submitted.push(request.postDataJSON().entries);
    if(pathname.endsWith('/assembly')&&request.method()==='PUT')saves.push(request.postDataJSON());
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


  const editor=page.getByRole('region',{name:'Connection controls'}),positionEditor=page.getByRole('region',{name:'Panel position controls'});
  const getSaved=async()=>{const response=await fetch(apiURL+`/projects/${project.id}/assembly`,{headers:{'x-flatforge-key':apiKey}});return response.json();};
  async function connect(referenceId){
    if(referenceId)await editor.getByRole('combobox',{name:'Reference panel',exact:true}).selectOption(referenceId);
    await editor.getByRole('group',{name:'Reference connection side',exact:true}).getByRole('button',{name:'Right',exact:true}).click();
    await editor.getByRole('group',{name:'Moving connection side',exact:true}).getByRole('button',{name:'Left',exact:true}).click();
    await editor.getByRole('spinbutton',{name:'Connection gap',exact:true}).fill('20');await loaded();
    assert.equal(await editor.locator('select').count(),1,'only reference panel selector; no CAD-face selector');
    await editor.getByRole('button',{name:'Connect',exact:true}).click();await editor.waitFor({state:'detached'});await loaded();
  }
  async function move(label,group=false){await page.getByRole('button',{name:'Select Panel '+label,exact:true}).click();await page.getByRole('button',{name:group?'Move branch':'Move',exact:true}).click();await positionEditor.waitFor();await loaded();}
  const field=name=>positionEditor.getByRole('spinbutton',{name,exact:true});
  async function apply(){await loaded();await positionEditor.getByRole('button',{name:'Apply position',exact:true}).click();await positionEditor.waitFor({state:'detached'});await loaded();}
  async function save(){await loaded();await page.getByRole('button',{name:'Save Assembly',exact:true}).click();await page.getByText('Assembly saved to this project.',{exact:true}).waitFor();}
  const matrix=id=>placements.at(-1).entries.find(e=>e.id===id).matrix;
  await page.goto(url,{waitUntil:'networkidle'});await openProject();
  await add(sample.panels[0],true);await add(sample.panels[1]);await connect();
  const a=placements.at(-1).entries[0].id,b=placements.at(-1).entries[1].id;
  assert.equal((await getSaved()).revision,0,'Connect must not pretend the project was saved');
  const beforeSave=JSON.stringify(placements.at(-1).entries),placeCount=placements.length;
  await save();const firstSave=await getSaved();assert.equal(firstSave.revision,1);assert.equal(firstSave.entries.length,2);
  await page.waitForTimeout(400);assert.equal(placements.length,placeCount,'Save must not rerun placement');assert.equal(JSON.stringify(placements.at(-1).entries),beforeSave);
  // Side connection is only initial alignment. Every subsequent move is independent.
  const initialA=matrix(a);await move('B');await field('Y offset — up').fill('50');await loaded();
  near(matrix(b)[14]-firstSave.entries[1].matrix[14],50,1e-5);assert.deepEqual(matrix(a),initialA);
  await apply();assert.equal((await getSaved()).entries[1].pose.offset[2],0,'Apply is not Save');
  await move('B');await field('Z offset — forward').fill('-500');await field('X offset — right').fill('-12.125');await loaded();
  // Large signed movement never triggers a mate-gap, lost-overlap or clash gate.
  assert.equal(await positionEditor.getByRole('button',{name:'Apply position',exact:true}).isDisabled(),false);
  await field('Y offset — up').fill('');assert.equal(await positionEditor.getByRole('button',{name:'Apply position',exact:true}).isDisabled(),true);
  await field('Y offset — up').fill('50');await apply();
  await page.getByRole('button',{name:'Undo',exact:true}).click();await loaded();near(matrix(b)[14]-firstSave.entries[1].matrix[14],50,1e-5);
  await page.getByRole('button',{name:'Redo',exact:true}).click();await loaded();
  // Add a third, repeated instance through the same four-side workflow.
  await page.getByRole('button',{name:'Add Panel',exact:true}).click();
  await page.getByRole('checkbox',{name:'Include drawings already added',exact:true}).check();
  await page.getByRole('region',{name:'Choose a panel'}).getByRole('button',{name:sample.panels[0].filename+' Ready · folded CAD solid',exact:true}).click();await loaded();
  assert.equal(await editor.getByRole('combobox',{name:'Reference panel',exact:true}).locator('option').count(),2);
  await connect(b);const c=placements.at(-1).entries[2].id;
  const before=structuredClone(placements.at(-1).entries);
  await move('B');await field('Y offset — up').fill('-75');await apply();
  assert.deepEqual(matrix(a),before[0].matrix);assert.deepEqual(matrix(c),before[2].matrix,'Move B must leave C fixed');
  // Root Move also moves only A; group behavior is a separate explicit action.
  const bBefore=matrix(b),cBefore=matrix(c);await move('A');await field('Y offset — up').fill('25');await apply();assert.deepEqual(matrix(b),bBefore);assert.deepEqual(matrix(c),cBefore);
  const prior=structuredClone(placements.at(-1).entries);await move('B',true);await field('Y offset — up').fill('-25');await apply();
  assert.deepEqual(matrix(a),prior[0].matrix);near(matrix(b)[14]-prior[1].matrix[14],50,1e-5);near(matrix(c)[14]-prior[2].matrix[14],50,1e-5);
  // Actual pointer drag on the selected panel's world-up handle. C stays fixed.
  await move('B');const layout=placements.at(-1),frame=layout.frames[b];
  const canvas=page.locator('.assembly-workspace canvas');await canvas.scrollIntoViewIfNeeded();await page.getByRole('button',{name:'Fit Assembly',exact:true}).click();await page.waitForTimeout(400);
  const rect=await canvas.boundingBox(),box=new THREE.Box3();for(const v of Object.values(layout.bounds))box.union(new THREE.Box3(new THREE.Vector3(...v.min).multiplyScalar(.001),new THREE.Vector3(...v.max).multiplyScalar(.001)));
  const camera=new THREE.PerspectiveCamera(32,rect.width/rect.height,.001,1000);camera.up.set(0,0,1);
  const size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3()),vf=THREE.MathUtils.degToRad(32),hf=2*Math.atan(Math.tan(vf/2)*camera.aspect),distance=size.length()/2/Math.sin(Math.min(vf,hf)/2)*1.15+.1;
  camera.position.copy(center).addScaledVector(new THREE.Vector3(1,-1.25,1.15).normalize(),distance);camera.lookAt(center);camera.updateMatrixWorld();
  const origin=new THREE.Vector3(...frame.origin).multiplyScalar(.001),factor=origin.distanceTo(camera.position)*Math.min(1.9*Math.tan(Math.PI*32/360),7)*.8/4;
  const projectPoint=p=>{p=p.clone().project(camera);return {x:rect.x+(p.x+1)*rect.width/2,y:rect.y+(1-p.y)*rect.height/2};};
  const from=projectPoint(origin.clone().addScaledVector(new THREE.Vector3(...frame.v),factor*.45)),to=projectPoint(origin.clone().addScaledVector(new THREE.Vector3(...frame.v),factor*.45+.05));
  await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:12});
  assert.notEqual(await field('Y offset — up').inputValue(),'-25');assert.equal(await positionEditor.getByRole('button',{name:'Apply position',exact:true}).isDisabled(),true);
  await page.mouse.up();await loaded();assert.deepEqual(matrix(a),layout.entries[0].matrix);assert.deepEqual(matrix(c),layout.entries[2].matrix);
  await apply();await save();
  // Intentionally place C exactly on A using the displayed mm offset controls.
  const aPose=matrix(a),cPose=matrix(c);aPose.slice(0,12).forEach((value,index)=>near(value,cPose[index],1e-7));
  await move('C');const current=placements.at(-1).entries.find(e=>e.id===c).pose.offset;
  const shift=aPose.slice(12,15).map((v,i)=>v-cPose[12+i]+current[i]);
  await field('X offset — right').fill(String(shift[0]));await field('Y offset — up').fill(String(shift[2]));await field('Z offset — forward').fill(String(-shift[1]));await apply();
  matrix(c).forEach((value,index)=>near(value,matrix(a)[index],1e-7));
  assert.equal(await page.getByText(/Placement conflict|intersecting solids|Check clearances/).count(),0);
  await save();const saved=await getSaved();assert.equal(saved.entries.length,3);assert.ok(saved.entries.every(e=>e.pose&&e.label&&e.matrix));
  const exported=await exportAssembly('free-overlap.glb');assert.equal(exported.bounds.length,3);
  await exportSTEP('free-overlap.step',exported.metadata.cadTransformsMm);
  // No localStorage recovery is needed: a fresh client restores backend positions.
  await page.evaluate(()=>localStorage.clear());await page.reload({waitUntil:'networkidle'});await loaded();
  for(const row of saved.entries)matrix(row.id).forEach((value,i)=>near(value,row.matrix[i],1e-7));
  assert.equal(await page.locator('[data-unsaved-assembly="true"]').count(),0);
  await page.getByRole('button',{name:'Panels',exact:true}).click();await page.getByRole('button',{name:'Hide Panel C',exact:true}).click();
  const hidden=await exportAssembly('free-hidden.glb');assert.equal(hidden.bounds.length,3);await page.getByRole('button',{name:'Show all panels',exact:true}).click();await page.getByRole('button',{name:'Close panel list',exact:true}).click();
  await page.locator('.assembly-workspace').screenshot({path:path.join(output,'free-desktop.png')});
  await move('B');await page.setViewportSize({width:390,height:844});await positionEditor.getByRole('button',{name:'Collapse position controls',exact:true}).click();await page.locator('.assembly-workspace').screenshot({path:path.join(output,'free-mobile.png')});await positionEditor.getByRole('button',{name:'Expand position controls',exact:true}).click();await positionEditor.getByRole('button',{name:'Cancel',exact:true}).click();await page.setViewportSize({width:1600,height:1100});await loaded();
  // Another writer saves the same project: stale Save must preserve local edits.
  const external=structuredClone(saves.at(-1));external.revision=saved.revision;external.entries[2].label='D';
  const outside=await fetch(apiURL+`/projects/${project.id}/assembly`,{method:'PUT',headers:{'x-flatforge-key':apiKey,'content-type':'application/json'},body:JSON.stringify(external)});assert.equal(outside.status,200,await outside.text());
  await move('B');await field('Y offset — up').fill('85');await apply();
  let guarded=false;page.once('dialog',async d=>{guarded=true;await d.dismiss();});await page.getByRole('button',{name:'All projects',exact:true}).click();assert.ok(guarded);
  await page.getByRole('button',{name:'Save Assembly',exact:true}).click();await page.getByRole('alert').filter({hasText:'saved elsewhere'}).waitFor();
  assert.equal(placements.at(-1).entries.find(e=>e.id===b).pose.offset[2],85);assert.equal((await getSaved()).entries[2].label,'D');
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Reload saved assembly',exact:true}).click();await loaded();
  assert.deepEqual(errors,[]);console.log('PASS: four-side CAD connections; STEP 5 rendering; individual/root/branch movement; real gizmo drag; repeated edits; signed offsets and intentional coincident solids; explicit project save without placement recalculation; backend restore with empty browser storage; conflict protection; exact overlapping STEP/GLB export; hidden export; desktop/mobile.');
  console.log('Artifacts: '+output);
} catch(error){console.error(logs.slice(-2500));try{const pages=browser?.contexts()[0]?.pages();if(pages?.length)await pages[0].screenshot({path:path.join(output,'failure.png'),fullPage:true});}catch{}throw error;}
finally{await browser?.close();server?.kill('SIGTERM');apiServer.kill('SIGTERM');}
