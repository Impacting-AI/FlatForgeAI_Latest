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
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('flatforge.assemblies.v1')));
  async function openProject(name=project.name){await page.getByRole('button',{name:'Open '+name,exact:true}).click();await page.getByRole('button',{name:'06 Assembly drawings',exact:true}).click();}
  async function loaded(){await page.locator('[data-assembly-ready="true"]').waitFor({timeout:45000});await page.locator('[data-cad-valid="true"]').waitFor({timeout:45000});}
  const editor=page.getByRole('region',{name:'Saved envelope layout'});
  const field= name => editor.getByRole('spinbutton',{name,exact:true});
  const horizontal='Horizontal (X) gap',vertical='Vertical (Z) gap',depth='Front / back (Y) gap';
  const direction=(name,side)=>editor.getByRole('combobox',{name:name+' direction',exact:true}).selectOption(String(side));
  async function edit(label='B'){await page.getByRole('button',{name:'Select Panel '+label,exact:true}).click();await page.getByRole('button',{name:'Move',exact:true}).click();await editor.waitFor();}
  async function apply(){await loaded();await editor.getByRole('button',{name:'Apply position',exact:true}).click();await editor.waitFor({state:'detached'});await loaded();}
  async function replace(rows){await page.evaluate(({id,rows})=>{const data=JSON.parse(localStorage.getItem('flatforge.assemblies.v1'));data.projects[id]=rows;localStorage.setItem('flatforge.assemblies.v1',JSON.stringify(data));},{id:project.id,rows});await page.reload({waitUntil:'networkidle'});}
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

  const initial=sample.panels.slice(0,2).map((p,index)=>({id:'legacy-'+index,panelId:p.id,targetId:index?'legacy-0':null,targetFace:index?'+X':null,myFace:'-X',gap:10,spacing:{x:{side:index?1:0,gap:index?10:0},y:{side:0,gap:0},z:{side:0,gap:0}}}));
  await page.addInitScript(({id,rows})=>{if(!localStorage.getItem('flatforge.assemblies.v1'))localStorage.setItem('flatforge.assemblies.v1',JSON.stringify({version:1,units:'mm',projects:{[id]:rows}}));},{id:project.id,rows:initial});
  await page.goto(url,{waitUntil:'networkidle'});await openProject();await loaded();
  const canvas=await page.locator('.assembly-workspace canvas').elementHandle();
  for(const gap of [1,5,10,25,50,100]){
    await edit();await field(horizontal).fill(String(gap));await apply();
    const exported=await exportAssembly(`gap-${gap}.glb`);near((exported.bounds[1].min.x-exported.bounds[0].max.x)*1000,gap);
    if(gap===10)await exportSTEP('legacy-two.step',exported.metadata.cadTransformsMm);
  }
  await edit();await field(horizontal).fill('10');await direction('Vertical (Z)',1);await field(vertical).fill('50');await direction('Front / back (Y)',-1);await field(depth).fill('25');await loaded();
  await field(horizontal).fill('-1');await editor.getByRole('alert').waitFor();assert.equal(await editor.getByRole('button',{name:'Apply position',exact:true}).isDisabled(),true);
  await field(horizontal).fill('');assert.equal(await editor.getByRole('button',{name:'Apply position',exact:true}).isDisabled(),true);await field(horizontal).fill('10');await apply();
  assert.equal(await canvas.evaluate(e=>e.isConnected),true);
  let rows=(await stored()).projects[project.id];assert.deepEqual(rows[1].spacing,{x:{side:1,gap:10},y:{side:-1,gap:25},z:{side:1,gap:50}});
  const child={...initial[1],id:'legacy-2',label:'C',panelId:sample.panels[2].id,targetId:rows[1].id,gap:5,spacing:{...initial[1].spacing,x:{side:1,gap:5}}};
  await replace([...rows,child]);await loaded();
  let result=await exportAssembly('legacy-three.glb');assert.equal(result.bounds.length,3);
  result.bounds.forEach((box,index)=>box.getSize(new THREE.Vector3()).toArray().forEach((size,axis)=>near(size*1000,sample.panels[index].report.bbox[axis])));
  near((result.bounds[1].min.z-result.bounds[0].max.z)*1000,50);near((result.bounds[2].min.x-result.bounds[1].max.x)*1000,5);
  await exportSTEP('legacy-three.step',result.metadata.cadTransformsMm);
  const saved=(await stored()).projects[project.id];await page.reload({waitUntil:'networkidle'});await loaded();assert.deepEqual((await stored()).projects[project.id],saved);
  await page.getByRole('button',{name:'All projects',exact:true}).click();await openProject('Assembly isolation test');assert.equal(await page.locator('.asm-model-label').count(),0);
  await page.getByRole('button',{name:'All projects',exact:true}).click();await openProject();await loaded();
  await edit();await editor.getByRole('combobox',{name:'Envelope moving side',exact:true}).selectOption('-Z');await editor.getByRole('combobox',{name:'Envelope reference side',exact:true}).selectOption('+Z');await field(vertical).fill('25');await apply();
  result=await exportAssembly('legacy-vertical.glb');near((result.bounds[1].min.z-result.bounds[0].max.z)*1000,25);
  await edit();await editor.getByRole('combobox',{name:'Envelope moving side',exact:true}).selectOption('+Y');await editor.getByRole('combobox',{name:'Envelope reference side',exact:true}).selectOption('-Y');await field(depth).fill('50');await apply();
  result=await exportAssembly('legacy-depth.glb');near((result.bounds[0].min.y-result.bounds[1].max.y)*1000,50);
  // Two siblings at one position collide, despite satisfying their parent gap.
  rows=(await stored()).projects[project.id];rows=rows.slice(0,2);rows[1]={...initial[1],label:'B'};rows.push({...rows[1],id:'duplicate',label:'C'});await replace(rows);
  await page.getByText(/Placement conflict:/).waitFor();assert.equal(await page.getByRole('button',{name:'Export assembly as STEP (.step)',exact:true}).isDisabled(),true);
  await edit('C');await field(horizontal).fill('5000');await apply();
  result=await exportAssembly('legacy-branches.glb');await exportSTEP('legacy-branches.step',result.metadata.cadTransformsMm);
  rows=(await stored()).projects[project.id];const angle=23*Math.PI/360;rows[0].rotation=[Math.sin(angle),0,0,Math.cos(angle)];rows[1].rotation=[0,0,Math.sin(angle),Math.cos(angle)];await replace(rows);await loaded();
  result=await exportAssembly('legacy-rotated.glb');await exportSTEP('legacy-rotated.step',result.metadata.cadTransformsMm);
  // Old offsets remain exactly placed until the explicit existing conversion.
  rows=(await stored()).projects[project.id];rows=rows.slice(0,2);delete rows[1].spacing;rows[1].offsets={x:0,y:-20,z:50};await replace(rows);await loaded();
  const before=await exportAssembly('legacy-offsets.glb');await edit();await editor.getByRole('button',{name:'Use directional gaps',exact:true}).click();await apply();
  const after=await exportAssembly('legacy-converted.glb');before.metadata.cadTransformsMm.forEach((e,i)=>e.matrix.forEach((v,j)=>near(v,after.metadata.cadTransformsMm[i].matrix[j],1e-8)));
  await edit();holdNextValidation=true;await field(horizontal).fill('17');for(let i=0;i<250&&!heldValidation;i++)await page.waitForTimeout(20);assert.ok(heldValidation);
  assert.equal(await editor.getByRole('button',{name:'Apply position',exact:true}).isDisabled(),true);await field(horizontal).fill('27');await loaded();await heldValidation.route.fulfill(heldValidation.result).catch(()=>{});await apply();
  const latest=await exportAssembly('latest.glb');assert.equal(latest.metadata.assemblyEntries[1].gap,27);
  failNextStep=true;await page.getByRole('button',{name:'Export assembly as STEP (.step)',exact:true}).click();await page.getByRole('alert').filter({hasText:'Test CAD connection interrupted'}).waitFor();await exportSTEP('legacy-retry.step',latest.metadata.cadTransformsMm);
  // Retain entries whose source returned to review, and block partial exports.
  const retained=(await stored()).projects[project.id];
  const status=spawnSync(process.env.FLATFORGE_PYTHON||'python',['-c','import sys\nfrom flatforge.db import Session, Panel\nwith Session.begin() as s: s.get(Panel,sys.argv[1]).status="NEEDS_REVIEW"',sample.panels[1].id],{cwd:root,env:apiEnv,encoding:'utf8'});assert.equal(status.status,0,status.stderr);
  await page.reload({waitUntil:'networkidle'});await page.getByText(/Assembly source unavailable/).waitFor();assert.deepEqual((await stored()).projects[project.id],retained);assert.equal(await page.getByRole('button',{name:'Export assembly as STEP (.step)',exact:true}).isDisabled(),true);
  assert.deepEqual(errors,[]);console.log('PASS: preserved envelope and legacy-offset layouts; six measured gaps; all axes; invalid input; 3 panels; dimensions; collision recovery; rotations; stale approval rejection; project isolation; exact STEP/GLB exports and retry; unavailable-source preservation.');
} catch(error){console.error(logs.slice(-2000));try{const pages=browser?.contexts()[0]?.pages();if(pages?.length)await pages[0].screenshot({path:path.join(output,'failure.png'),fullPage:true});}catch{}throw error;}
finally{await browser?.close();server?.kill('SIGTERM');apiServer.kill('SIGTERM');}
