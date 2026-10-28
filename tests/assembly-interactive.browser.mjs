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



  const editor=page.getByRole('region',{name:'Connection controls'}),position=page.getByRole('region',{name:'Panel position controls'});
  async function addInstance(panel,first=false){await page.getByRole('button',{name:first?'Select First Panel':'Add Panel',exact:true}).click();if(!first)await page.getByRole('checkbox',{name:'Include drawings already added',exact:true}).check();await page.getByRole('region',{name:'Choose a panel'}).getByRole('button',{name:panel.filename+' Ready · folded CAD solid',exact:true}).click();await loaded();}
  async function connect(parent){if(parent)await editor.getByRole('combobox',{name:'Reference panel',exact:true}).selectOption(parent);for(const [group,side] of [['Reference connection side','Left'],['Moving connection side','Right']])await editor.getByRole('group',{name:group,exact:true}).getByRole('button',{name:side,exact:true}).click();await editor.getByRole('spinbutton',{name:'Connection gap',exact:true}).fill('20');await loaded();await editor.getByRole('button',{name:'Connect',exact:true}).click();await editor.waitFor({state:'detached'});await loaded();}
  async function select(label){await page.getByRole('button',{name:'Fit Assembly',exact:true}).click();await page.waitForTimeout(200);const button=page.getByRole('button',{name:'Select Panel '+label,exact:true});if(await button.isVisible())await button.click();else{await page.getByRole('button',{name:'Panels',exact:true}).click();await page.getByRole('complementary',{name:'Assembly panels'}).locator('div').filter({has:page.locator('b',{hasText:new RegExp('^'+label+'$')})}).locator('button').first().click();await page.getByRole('button',{name:'Close panel list',exact:true}).click();}}
  async function move(label,value){await select(label);await page.getByRole('button',{name:'Move',exact:true}).click();await position.getByRole('spinbutton',{name:'Y offset — up',exact:true}).fill(String(value));await loaded();await position.getByRole('button',{name:'Apply position',exact:true}).click();await loaded();}
  await page.goto(url,{waitUntil:'networkidle'});await openProject();
  await addInstance(sample.panels[0],true);await addInstance(sample.panels[1]);await connect();
  const original=structuredClone(placements.at(-1)),a=original.entries[0].id;
  const interactive=page.getByRole('region',{name:'Interactive connection',exact:true});
  async function sideClick(panel,side){
   const target=page.getByRole('button',{name:`Panel ${panel} ${side} side`,exact:true});
   const body=page.getByRole('button',{name:`Select Panel ${panel}`,exact:true});if(await body.isVisible())await body.click();
   for(const view of ['top','iso','front','side']){
    await page.getByRole('combobox',{name:'Assembly camera view',exact:true}).selectOption(view);await page.waitForTimeout(150);
    if(await target.isVisible()){try{await target.click({timeout:1500});return;}catch{}}
   }
   const canvas=await page.locator('.assembly-workspace canvas').boundingBox();
   for(let i=0;i<12;i++){
    await page.mouse.move(canvas.x+canvas.width*.45,canvas.y+canvas.height*.55);await page.mouse.down();await page.mouse.move(canvas.x+canvas.width*.55,canvas.y+canvas.height*.65,{steps:5});await page.mouse.up();await page.waitForTimeout(150);
    if(await target.isVisible()){try{await target.click({timeout:1500});return;}catch{}}
   }
   for(let i=0;i<5;i++){await page.mouse.move(canvas.x+canvas.width/2,canvas.y+canvas.height/2);await page.mouse.wheel(0,-160);await page.waitForTimeout(150);if(await target.isVisible()){await target.click();return;}}
   throw new Error(`No accessible ${panel} ${side} label`);
  }
  await page.getByRole('button',{name:'Connect panels in viewer',exact:true}).click();await sideClick('A','Right');await sideClick('A','Left');await page.getByText('Choose two different panels.',{exact:true}).waitFor();
  await interactive.getByRole('button',{name:'Cancel',exact:true}).click();assert.deepEqual(placements.at(-1).entries,original.entries);
  await select('B');await page.getByRole('button',{name:'Move',exact:true}).click();await position.getByRole('button',{name:'Cancel',exact:true}).click();
  for(const [from,to] of [['Right','Left'],['Left','Right'],['Top','Bottom'],['Bottom','Top']]){
   // Establish the dropdown result as the baseline, then perform the same mate
   // exclusively through actual visible 3D side-label clicks.
   await loaded();await select('B');await page.getByRole('button',{name:'Reconnect',exact:true}).click();
   for(const [group,side] of [['Reference connection side',from],['Moving connection side',to]])await editor.getByRole('group',{name:group,exact:true}).getByRole('button',{name:side,exact:true}).click();
   await loaded();await editor.getByRole('button',{name:'Connect',exact:true}).click();await editor.waitFor({state:'detached'});await loaded();
   const expected=placements.at(-1).entries.find(e=>e.id!==a).matrix;
   await page.getByRole('button',{name:'Connect panels in viewer',exact:true}).click();await sideClick('A',from);await sideClick('B',to);await loaded();
   if(from==='Right'){
    await interactive.getByRole('button',{name:/^From:/}).click();await sideClick('A',from);
    await interactive.getByRole('button',{name:/^To:/}).click();await sideClick('B',to);await loaded();
   }
   assert.equal(await page.locator('.asm-side-label[data-connection-role=from]').count(),1);assert.equal(await page.locator('.asm-side-label[data-connection-role=to]').count(),1);
   await interactive.getByRole('button',{name:'Join Panels',exact:true}).click();await interactive.waitFor({state:'detached'});await loaded();
   placements.at(-1).entries.find(e=>e.id!==a).matrix.forEach((v,i)=>near(v,expected[i],1e-7));
  }
  const b=placements.at(-1).entries.find(e=>e.id!==a).id;
  await addInstance(sample.panels[2]);await connect(b);const c=placements.at(-1).entries.find(e=>e.id!==a&&e.id!==b).id;
  await page.getByRole('button',{name:'Connect panels in viewer',exact:true}).click();await sideClick('A','Bottom');await sideClick('C','Top');await loaded();
  await interactive.getByRole('button',{name:'Join Panels',exact:true}).click();await interactive.waitFor({state:'detached'});await loaded();
  assert.equal(placements.at(-1).entries.find(e=>e.id===b).targetId,c,'interactive reconnect inserts into the occupied side');
  await move('B',50);await page.getByRole('button',{name:'Save Assembly',exact:true}).click();await page.getByText('Assembly saved to this project.',{exact:true}).waitFor();
  const saved=structuredClone(placements.at(-1));const exported=await exportAssembly('interactive.glb');await exportSTEP('interactive.step',exported.metadata.cadTransformsMm);
  await page.reload({waitUntil:'networkidle'});await loaded();assert.deepEqual(placements.at(-1).entries,saved.entries);
  await page.locator('.assembly-workspace').screenshot({path:path.join(output,'interactive.png')});
  assert.deepEqual(errors,[]);console.log('PASS: four interactive side pairs match dropdown matrices; cancel and Move mode; both endpoint highlights; manual offset, save/reload and original-solid STEP export.');
} catch(error){console.error(logs.slice(-2500));try{const pages=browser?.contexts()[0]?.pages();if(pages?.length)await pages[0].screenshot({path:path.join(output,'failure.png'),fullPage:true});}catch{}throw error;}
finally{await browser?.close();server?.kill('SIGTERM');apiServer.kill('SIGTERM');}
