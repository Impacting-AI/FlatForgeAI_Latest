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
  const editor=page.getByRole('region',{name:'Panel position controls'});
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


  const angle=23*Math.PI/360;
  const initial=sample.panels.slice(0,2).map((p,index)=>({id:'legacy-'+index,panelId:p.id,targetId:index?'legacy-0':null,targetFace:index?'+X':null,myFace:'-X',gap:10,rotation:[0,0,Math.sin(angle),Math.cos(angle)],...(index?{offsets:{x:0,y:-20,z:50}}:{})}));
  await page.addInitScript(({id,rows})=>{if(!localStorage.getItem('flatforge.assemblies.v1'))localStorage.setItem('flatforge.assemblies.v1',JSON.stringify({version:1,units:'mm',projects:{[id]:rows}}));},{id:project.id,rows:initial});
  await page.goto(url,{waitUntil:'networkidle'});await openProject();await loaded();
  await page.getByText('Previous browser layout recovered.',{exact:false}).waitFor();
  const before=await exportAssembly('legacy-recovered.glb');assert.equal(before.bounds.length,2);
  const aBefore=before.metadata.cadTransformsMm[0].matrix,bBefore=before.metadata.cadTransformsMm[1].matrix;
  await edit();await field('Y offset — up').fill('50');await apply();
  const moved=await exportAssembly('legacy-moved.glb');
  moved.metadata.cadTransformsMm[0].matrix.forEach((v,i)=>near(v,aBefore[i],1e-8));
  moved.metadata.cadTransformsMm[1].matrix.forEach((v,i)=>near(v,bBefore[i]+(i===14?50:0),1e-8));
  await page.getByRole('button',{name:'Save Assembly',exact:true}).click();await page.getByText('Assembly saved to this project.',{exact:true}).waitFor();
  assert.deepEqual((await stored()).projects[project.id],initial,'legacy browser data is never deleted or overwritten');
  await page.reload({waitUntil:'networkidle'});await loaded();assert.equal(await page.locator('[data-unsaved-assembly="true"]').count(),0);
  const restored=await exportAssembly('legacy-restored.glb');assert.deepEqual(restored.metadata.cadTransformsMm,moved.metadata.cadTransformsMm);
  failNextStep=true;await page.getByRole('button',{name:'Export assembly as STEP (.step)',exact:true}).click();await page.getByRole('alert').filter({hasText:'Test CAD connection interrupted'}).waitFor();
  await exportSTEP('legacy-restored.step',restored.metadata.cadTransformsMm);
  await page.getByRole('button',{name:'All projects',exact:true}).click();await openProject('Assembly isolation test');assert.equal(await page.locator('.asm-model-label').count(),0);
  await page.getByRole('button',{name:'All projects',exact:true}).click();await openProject();await loaded();
  const status=spawnSync(process.env.FLATFORGE_PYTHON||'python',['-c','import sys\nfrom flatforge.db import Session, Panel\nwith Session.begin() as s: s.get(Panel,sys.argv[1]).status="NEEDS_REVIEW"'.replaceAll('\\n','\n'),sample.panels[1].id],{cwd:root,env:apiEnv,encoding:'utf8'});assert.equal(status.status,0,status.stderr);
  await page.reload({waitUntil:'networkidle'});await page.getByText(/Assembly source unavailable/).waitFor();
  assert.equal(await page.getByRole('button',{name:'Export assembly as STEP (.step)',exact:true}).isDisabled(),true);
  assert.deepEqual((await stored()).projects[project.id],initial);assert.deepEqual(errors,[]);
  console.log('PASS: legacy rotation/offset recovery, individual movement, explicit project save, reload, project isolation, export retry, exact CAD/GLB transforms, unavailable-source preservation.');
} catch(error){console.error(logs.slice(-2000));try{const pages=browser?.contexts()[0]?.pages();if(pages?.length)await pages[0].screenshot({path:path.join(output,'failure.png'),fullPage:true});}catch{}throw error;}
finally{await browser?.close();server?.kill('SIGTERM');apiServer.kill('SIGTERM');}
