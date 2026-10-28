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
  await addInstance(sample.panels[0],true);await addInstance(sample.panels[0]);await connect();
  let layout=placements.at(-1);const a=layout.entries[0].id,b=layout.entries[1].id;
  await addInstance(sample.panels[1]);await connect(b);const c=placements.at(-1).entries.find(e=>e.id!==a&&e.id!==b).id;
  await move('C',50);const prior=structuredClone(placements.at(-1));
  await addInstance(sample.panels[2]);await connect(b);
  layout=placements.at(-1);const d=layout.entries.find(e=>![a,b,c].includes(e.id)).id;
  assert.equal(layout.entries.find(e=>e.id===c).targetId,d);assert.equal(layout.entries.find(e=>e.id===d).targetId,b);
  assert.deepEqual(layout.entries.find(e=>e.id===a).matrix,prior.entries.find(e=>e.id===a).matrix);
  assert.deepEqual(layout.entries.find(e=>e.id===b).matrix,prior.entries.find(e=>e.id===b).matrix);
  assert.deepEqual(layout.entries.find(e=>e.id===c).pose.offset,prior.entries.find(e=>e.id===c).pose.offset);
  const names=await page.locator('.asm-model-label:not(.asm-side-label)').allTextContents();assert.deepEqual([...names].sort(),['Panel A','Panel B','Panel C','Panel D']);
  // Four geometry-derived sides exist per fixture instance; occluded labels hide.
  await page.waitForFunction(()=>document.querySelectorAll('.asm-side-label').length===16);
  // Header dragging must not change authoritative matrices or orbit the camera.
  await select('B');await page.getByRole('button',{name:'Move',exact:true}).click();await loaded();
  await position.getByRole('button',{name:'Reset popup position',exact:true}).waitFor();await position.locator('header strong').scrollIntoViewIfNeeded();await page.waitForTimeout(300);
  const start=await position.boundingBox(),header=await position.locator('header strong').boundingBox(),matrices=JSON.stringify(placements.at(-1).entries);
  await page.mouse.move(header.x+15,header.y+8);assert.ok(await position.locator('header').evaluate((e,p)=>e.contains(document.elementFromPoint(p.x,p.y)),{x:header.x+15,y:header.y+8}),'Header drag starts on header');await page.mouse.down();await page.mouse.move(header.x-180,header.y+130,{steps:12});await page.mouse.up();
  const dragged=await position.boundingBox(),relative=await position.evaluate(e=>({x:e.offsetLeft,y:e.offsetTop}));assert.ok(dragged.x<start.x-60&&dragged.y>start.y+50);assert.equal(JSON.stringify(placements.at(-1).entries),matrices);
  await position.getByRole('button',{name:'Cancel',exact:true}).click();await loaded();await page.getByRole('button',{name:'Move',exact:true}).click();await loaded();
  const reopened=await position.evaluate(e=>({x:e.offsetLeft,y:e.offsetTop}));near(reopened.x,relative.x,2);near(reopened.y,relative.y,2);
  await position.getByRole('button',{name:'Reset popup position',exact:true}).click();assert.ok(Math.abs((await position.boundingBox()).x-start.x)<2);
  await position.getByRole('button',{name:'Cancel',exact:true}).click();await loaded();
  await select('C');await page.getByRole('button',{name:'Rotate',exact:true}).click();await position.getByRole('spinbutton',{name:'Rotation',exact:true}).fill('17');await loaded();await position.getByRole('button',{name:'Apply position',exact:true}).click();await loaded();
  await page.getByRole('button',{name:'Save Assembly',exact:true}).click();await page.getByText('Assembly saved to this project.',{exact:true}).waitFor();
  const exported=await exportAssembly('inserted.glb');await exportSTEP('inserted.step',exported.metadata.cadTransformsMm);
  const saved=structuredClone(placements.at(-1));await page.reload({waitUntil:'networkidle'});await loaded();assert.deepEqual(placements.at(-1).entries,saved.entries);
  // Surface anchors must project to the exact label centre, not clamped box corners.
  for(const view of ['iso','top','front']){
   await page.getByRole('combobox',{name:'Assembly camera view',exact:true}).selectOption(view);await page.waitForTimeout(350);
   const canvas=await page.locator('.assembly-workspace canvas').boundingBox(),box=new THREE.Box3();exported.bounds.forEach(b=>box.union(b));
   const camera=new THREE.PerspectiveCamera(32,canvas.width/canvas.height,.001,1000);camera.up.set(0,view==='top'?1:0,view==='top'?0:1);
   const vf=THREE.MathUtils.degToRad(32),hf=2*Math.atan(Math.tan(vf/2)*camera.aspect),distance=box.getSize(new THREE.Vector3()).length()/2/Math.sin(Math.min(vf,hf)/2)*1.15+.1;
   camera.position.copy(box.getCenter(new THREE.Vector3())).addScaledVector(view==='top'?new THREE.Vector3(0,0,1):view==='front'?new THREE.Vector3(0,-1,0):new THREE.Vector3(1,-1.25,1.15).normalize(),distance);camera.lookAt(box.getCenter(new THREE.Vector3()));camera.updateMatrixWorld();
   const nodes=await page.locator('.asm-model-label:not([hidden])').evaluateAll(nodes=>nodes.map(n=>({id:n.dataset.panelId,anchor:n.dataset.anchor.split(',').map(Number),rect:{x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y,w:n.getBoundingClientRect().width,h:n.getBoundingClientRect().height}})));
   assert.ok(nodes.length>=3);
   for(const node of nodes){const matrix=new THREE.Matrix4().fromArray(saved.entries.find(e=>e.id===node.id).matrix);for(const i of [12,13,14])matrix.elements[i]/=1000;const point=new THREE.Vector3(...node.anchor).applyMatrix4(matrix).project(camera);near(node.rect.x+node.rect.w/2,canvas.x+(point.x+1)*canvas.width/2,3);near(node.rect.y+node.rect.h/2,canvas.y+(1-point.y)*canvas.height/2,3);}
   for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){const a=nodes[i].rect,b=nodes[j].rect;assert.ok(a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y,'labels must not overlap');}
   await page.locator('.assembly-workspace').screenshot({path:path.join(output,'anchored-'+view+'.png')});
  }
  await move('B',-37);assert.deepEqual(placements.at(-1).entries.find(e=>e.id===c).matrix,saved.entries.find(e=>e.id===c).matrix,'insertion must not lock subsequent movement');
  await page.getByRole('button',{name:'Move',exact:true}).click();await loaded();await position.locator('header strong').scrollIntoViewIfNeeded();await page.waitForTimeout(200);
  const grip=await position.locator('header strong').boundingBox();await page.mouse.move(grip.x+8,grip.y+8);await page.mouse.down();await page.mouse.move(2,2,{steps:10});await page.mouse.up();
  assert.ok(await position.evaluate(e=>e.offsetLeft>=6&&e.offsetTop>=6));
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
  assert.ok(await position.evaluate(e=>e.offsetLeft>=6&&e.offsetTop>=6&&e.offsetLeft+e.offsetWidth<=e.parentElement.clientWidth-5));
  await page.locator('.assembly-workspace').screenshot({path:path.join(output,'popup-mobile.png')});
  await position.getByRole('button',{name:'Cancel',exact:true}).click();
  // Reconnect an existing panel: D Top -> A Left is occupied by B.
  await loaded();await select('D');await page.getByRole('button',{name:'Reconnect',exact:true}).click();
  await editor.getByRole('combobox',{name:'Reference panel',exact:true}).selectOption(a);
  for(const [group,side] of [['Reference connection side','Left'],['Moving connection side','Top']])await editor.getByRole('group',{name:group,exact:true}).getByRole('button',{name:side,exact:true}).click();
  await loaded();await editor.getByRole('button',{name:'Connect',exact:true}).click();await editor.waitFor({state:'detached'});await loaded();
  const reconnected=structuredClone(placements.at(-1));assert.equal(reconnected.entries.find(e=>e.id===b).targetId,d);
  assert.deepEqual(reconnected.entries.find(e=>e.id===a).matrix,saved.entries.find(e=>e.id===a).matrix);
  assert.ok(await page.locator('.asm-side-label').evaluateAll(nodes=>nodes.every(n=>['L','R','T','B'].includes(n.textContent))));
  await page.getByRole('button',{name:'Save Assembly',exact:true}).click();await page.getByText('Assembly saved to this project.',{exact:true}).waitFor();
  const reconnectExport=await exportAssembly('reconnected.glb');await exportSTEP('reconnected.step',reconnectExport.metadata.cadTransformsMm);
  await page.reload({waitUntil:'networkidle'});await loaded();assert.deepEqual(placements.at(-1).entries,reconnected.entries);
  assert.deepEqual(errors,[]);console.log('PASS: existing D Top → A Left reconnection with occupied-side displacement, save/reload and STEP export; real folded-panel insertion B→D→C; preserved manual offsets and unaffected panels; stable labels and source sides; bounded popup dragging and reopening; save/reload and exact STEP/GLB export; projected anchors in three camera views; independent movement after insertion.');
} catch(error){console.error(logs.slice(-2500));try{const pages=browser?.contexts()[0]?.pages();if(pages?.length)await pages[0].screenshot({path:path.join(output,'failure.png'),fullPage:true});}catch{}throw error;}
finally{await browser?.close();server?.kill('SIGTERM');apiServer.kill('SIGTERM');}
