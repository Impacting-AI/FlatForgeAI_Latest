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
    return { bounds: result.scene.children.map(child => new THREE.Box3().setFromObject(child)), metadata: result.scene.userData };
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



  const mate=page.getByRole('region',{name:'Planar mate controls'});
  const position=page.getByRole('region',{name:'Panel position controls'});
  async function choose(label){
    await page.getByRole('button',{name:'Panels',exact:true}).click();
    await page.getByRole('complementary',{name:'Assembly panels'}).locator('div').filter({has:page.locator('b',{hasText:new RegExp('^'+label+'$')})}).locator('button').first().click();
    await page.getByRole('button',{name:'Close panel list',exact:true}).click();
  }
  async function pickFace(label){
    await page.getByRole('combobox',{name:'Assembly camera view',exact:true}).selectOption('top');
    await page.waitForTimeout(300);
    const button=page.getByRole('button',{name:'Select Panel '+label,exact:true});
    const box=await button.boundingBox();assert.ok(box,`Panel ${label} surface anchor visible`);
    // Real pointer ray, just outside the on-surface label; no injected face IDs.
    for(const [dx,dy] of [[0,35],[40,0],[0,-35],[-40,0]]){
      const x=box.x+box.width/2+dx,y=box.y+box.height/2+dy;
      await page.mouse.move(x,y);await page.waitForTimeout(650);await page.mouse.move(x+1,y);await page.waitForTimeout(100);
      if(await page.locator('.asm-face-tooltip:visible').filter({hasText:'Click to select'}).count()){
        await page.mouse.click(x+1,y);return;
      }
    }
    throw new Error('No CAD picking surface beside '+label);
  }
  await page.goto(url,{waitUntil:'networkidle'});await openProject();
  await add(sample.panels[0],true);await add(sample.panels[1]);
  const initial=structuredClone(placements.at(-1));
  await page.getByRole('button',{name:'Connect / Mate',exact:true}).click();
  if(process.env.FLATFORGE_TEST_EDGE){
    await mate.getByLabel('Mate geometry').selectOption('edge');
    await page.getByRole('combobox',{name:'Assembly camera view'}).selectOption('top');
    const pickEdge=async label=>{
      await page.waitForTimeout(350);
      const box=await page.getByRole('button',{name:'Select Panel '+label,exact:true}).boundingBox();
      assert.ok(box);
      for(const [dx,dy] of [[0,-1],[0,1],[1,0],[-1,0]]){
        for(let d=18;d<270;d+=4){
          const x=box.x+box.width/2+d*dx,y=box.y+box.height/2+d*dy;
          await page.mouse.move(x,y);
          if(await page.locator('.asm-face-tooltip:visible').filter({hasText:'/ edge-'}).count()){
            await page.mouse.click(x,y);return;
          }
        }
      }
      throw Error('No visible straight CAD edge on '+label);
    };
    await pickEdge('A');await mate.getByRole('button',{name:/^Reference: Panel A .*edge-/}).waitFor();
    await pickEdge('B');await mate.getByRole('button',{name:/^Moving: Panel B .*edge-/}).waitFor();
    await mate.getByLabel('Plane gap',{exact:true}).fill('20');await loaded();
    await mate.getByRole('button',{name:'Apply Mate'}).click();await loaded();
    await page.getByRole('button',{name:'Save Assembly',exact:true}).click();
    await page.getByText('Assembly saved to this project.',{exact:true}).waitFor();
    const before=structuredClone(placements.at(-1).entries);
    await page.reload({waitUntil:'networkidle'});await loaded();assert.deepEqual(placements.at(-1).entries,before);
    const exported=await exportAssembly('edges.glb');await exportSTEP('edges.step',exported.metadata.cadTransformsMm);
    assert.deepEqual(errors,[]);console.log('PASS: CAD edge clicks, Apply, persistence, STEP/GLB parity.');
  } else {
  await pickFace('A');await mate.getByRole('button',{name:/^Reference: Panel A/}).waitFor();
  await pickFace('A');await page.getByText('Select faces on two different panels.',{exact:true}).waitFor();
  await pickFace('B');
  // The chosen broad skins have folded returns: even a parallel 20 mm
  // offset can penetrate their webs. Verify the warning before clearing them.
  await mate.getByRole('spinbutton',{name:'Plane gap',exact:true}).fill('20');
  await page.getByRole('status').filter({hasText:'intersect by'}).waitFor();
  assert.equal(await mate.getByRole('button',{name:'Apply Mate'}).isEnabled(),false);
  const skinGap=1+Object.values(initial.bounds).reduce((sum,b)=>sum+b.max[2]-b.min[2],0);
  await mate.getByRole('spinbutton',{name:'Plane gap',exact:true}).fill(String(skinGap));
  await loaded();
  // Both exposed broad skins point up in this assembly. Preserve the observed
  // pose at selection, including roll, until an explicit twist is entered.
  for(const row of placements.at(-1).entries){
    const prior=initial.entries.find(e=>e.id===row.id);
    row.matrix.slice(0,12).forEach((value,i)=>near(value,prior.matrix[i],1e-7));
  }
  await mate.getByRole('spinbutton',{name:'Local V offset',exact:true}).fill('50');
  await mate.getByRole('spinbutton',{name:'In-plane rotation',exact:true}).fill('13');await loaded();
  const restoredPreview=page.waitForResponse(response=>response.url().endsWith('/assembly/place')&&response.ok());
  await mate.getByRole('button',{name:/^Moving: Panel B/}).click();await restoredPreview;await loaded();
  await pickFace('B');await mate.getByRole('button',{name:/^Moving: Panel B/}).waitFor();await loaded();
  assert.equal(await mate.getByRole('spinbutton',{name:'Local V offset',exact:true}).inputValue(),'50');
  assert.equal(await mate.getByRole('spinbutton',{name:'In-plane rotation',exact:true}).inputValue(),'13');
  near(placements.at(-1).mates[0].actual,skinGap,1e-5);
  const b=placements.at(-1).entries.find(e=>e.mateState==='active').id;
  assert.equal(placements.at(-1).entries.find(e=>e.id===b).connection.offsetV,50);
  await mate.getByRole('spinbutton',{name:'Plane gap',exact:true}).fill('-1');assert.equal(await mate.getByRole('button',{name:'Apply Mate'}).isEnabled(),false);
  await mate.getByRole('spinbutton',{name:'Plane gap',exact:true}).fill(String(skinGap));await loaded();
  await page.locator('.assembly-workspace').screenshot({path:path.join(output,'mate-preview.png')});
  await mate.getByRole('button',{name:'Apply Mate',exact:true}).click();await mate.waitFor({state:'detached'});await loaded();
  assert.equal(placements.at(-1).entries.find(e=>e.id===b).pose,null);
  await add(sample.panels[2]);
  await page.getByRole('button',{name:'Connect / Mate',exact:true}).click();
  await pickFace('B');await pickFace('C');
  // This subsequent mate no longer implicitly rolls C into A.
  await mate.getByRole('spinbutton',{name:'Plane gap',exact:true}).fill('9');
  await mate.getByRole('spinbutton',{name:'Local U offset',exact:true}).fill('3200');await loaded();
  await mate.getByRole('button',{name:'Apply Mate',exact:true}).click();await loaded();
  const c=placements.at(-1).entries.find(e=>e.targetId===b).id;
  const chainBefore=structuredClone(placements.at(-1));
  await page.getByRole('button',{name:'Save Assembly',exact:true}).click();await page.getByText('Assembly saved to this project.',{exact:true}).waitFor();
  await page.reload({waitUntil:'networkidle'});await loaded();assert.deepEqual(placements.at(-1).entries,chainBefore.entries);
  await choose('B');await page.getByRole('button',{name:'Edit mate',exact:true}).click();
  await mate.getByRole('spinbutton',{name:'Local U offset',exact:true}).fill('-35.125');await loaded();
  assert.notDeepEqual(placements.at(-1).entries.find(e=>e.id===c).matrix,chainBefore.entries.find(e=>e.id===c).matrix);
  near(placements.at(-1).mates.find(m=>m.entryId===c).actual,9,1e-5);
  await mate.getByRole('button',{name:'Apply Mate',exact:true}).click();await loaded();
  near(placements.at(-1).mates[0].actual,skinGap,1e-5);
  const beforeFree=structuredClone(placements.at(-1));
  await choose('B');await page.getByRole('button',{name:'Move',exact:true}).click();await loaded();
  await position.getByRole('spinbutton',{name:'Y offset — up',exact:true}).fill('50');await loaded();
  await position.getByRole('button',{name:'Apply position',exact:true}).click();await loaded();
  const final=structuredClone(placements.at(-1));
  assert.equal(final.entries.find(e=>e.id===b).mateState,'suspended');
  assert.deepEqual(final.entries[0].matrix,initial.entries[0].matrix);
  assert.equal(final.mates[0].satisfied,false);
  assert.deepEqual(final.entries.find(e=>e.id===c).matrix,beforeFree.entries.find(e=>e.id===c).matrix);
  assert.equal(final.entries.find(e=>e.id===c).mateState,'suspended');
  await page.getByRole('button',{name:'Save Assembly',exact:true}).click();await page.getByText('Assembly saved to this project.',{exact:true}).waitFor();
  const exported=await exportAssembly('mates.glb');await exportSTEP('mates.step',exported.metadata.cadTransformsMm);
  await page.reload({waitUntil:'networkidle'});await loaded();assert.deepEqual(placements.at(-1).entries,final.entries);
  await choose('B');await page.getByRole('button',{name:'Edit mate',exact:true}).click();await loaded();
  await mate.getByRole('button',{name:'Apply Mate',exact:true}).click();await loaded();
  assert.equal(placements.at(-1).entries.find(e=>e.id===b).mateState,'active');
  await page.getByRole('button',{name:'Connect / Mate',exact:true}).click();await mate.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.locator('.assembly-workspace').screenshot({path:path.join(output,'mate-final.png')});
  await choose('B');await page.getByRole('button',{name:'Edit mate',exact:true}).click();await loaded();
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
  const mobile=await mate.boundingBox();assert.ok(mobile.x>=0&&mobile.x+mobile.width<=390);
  await mate.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.deepEqual(errors,[]);console.log('PASS: actual CAD face clicks, same-panel rejection, gap/local offsets/twist, invalid inputs, apply/edit/resume, independent Free Move suspension, save/reload and original-solid STEP/GLB parity.');
  }
} catch(error){console.error(logs.slice(-2500));try{const pages=browser?.contexts()[0]?.pages();if(pages?.length)await pages[0].screenshot({path:path.join(output,'failure.png'),fullPage:true});}catch{}throw error;}
finally{await browser?.close();server?.kill('SIGTERM');apiServer.kill('SIGTERM');}
