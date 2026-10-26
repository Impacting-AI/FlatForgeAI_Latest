/** Real WebGL rendering and static CAD artifacts. No engineering API mutations. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const root=fileURLToPath(new URL('..',import.meta.url));
const output=process.env.FLATFORGE_QA_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'ff-inspection-'));
fs.mkdirSync(output,{recursive:true});
const url=process.env.FLATFORGE_TEST_URL||'http://127.0.0.1:5179';
const server=process.env.FLATFORGE_TEST_URL?null:spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5179','--strictPort'],{cwd:root,stdio:['ignore','pipe','pipe']});
let logs='',browser;
server?.stdout.on('data',data=>logs+=data);server?.stderr.on('data',data=>logs+=data);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sample=JSON.parse(fs.readFileSync(path.join(root,'lib/sample-data.json')));
const sources=sample.panels.flatMap(panel=>['panel.glb','panel.step','panel.stl','viewer.json'].map(file=>path.join(root,'public',panel.asset_base,file))).filter(file=>fs.existsSync(file));
const originalHashes=sources.map(file=>hash(fs.readFileSync(file)));
try {
  for(let i=0;i<180;i++){try{if((await fetch(url)).ok)break;}catch{}if(i===179)throw Error(logs);await new Promise(r=>setTimeout(r,200));}
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
  browser=await chromium.launch({executablePath:process.env.FLATFORGE_CHROMIUM||undefined,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1500,height:1100}}),errors=[],writes=[],exportResponses=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(!['GET','HEAD'].includes(request.method()))writes.push(request.method()+' '+request.url());});
  await page.addInitScript(()=>{
    window.__inspectionStats={uploads:0,draws:0,lines:0,triangles:0};
    const proto=WebGL2RenderingContext.prototype;
    for(const name of ['bufferData','bufferSubData','drawElements','drawArrays']){
      const original=proto[name];
      proto[name]=function(...args){const stats=window.__inspectionStats;if(name.startsWith('buffer'))stats.uploads++;else{stats.draws++;if(args[0]===this.LINES)stats.lines++;if(args[0]===this.TRIANGLES)stats.triangles++;}return original.apply(this,args);};
    }
  });
  await page.route('**/api/bootstrap',route=>route.fulfill({json:sample}));
  // The app opens CAD exports with noopener. Capture the actual static response
  // before Chromium detaches its temporary download tab; preserve its response.
  await page.context().route('**/samples/**/panel.{step,stl}',async route=>{
    const response=await route.fetch(),body=await response.body();
    exportResponses.push({url:route.request().url(),status:response.status(),body});
    await route.fulfill({response});
  });
  const stage=page.locator('.viewer-stage'),canvas=page.locator('.viewer-stage canvas');
  async function loaded(){await canvas.waitFor();await page.locator('.viewer-loading').waitFor({state:'hidden',timeout:45000});}
  async function open(panel){await page.goto(`${url}/projects/${panel.project_id}/drawings/${panel.id}/step/5`,{waitUntil:'networkidle'});await loaded();}
  async function imageStats(){return canvas.evaluate(async canvas=>{
    const image=new Image();image.src=canvas.toDataURL();await image.decode();
    const copy=document.createElement('canvas');copy.width=image.width;copy.height=image.height;const ctx=copy.getContext('2d');ctx.drawImage(image,0,0);
    const rgba=ctx.getImageData(0,0,copy.width,copy.height).data;let green=0,dark=0,model=0;
    for(let i=0;i<rgba.length;i+=4){const [r,g,b]=rgba.slice(i,i+3);if(g>r*1.18&&g>b*1.03)green++;if(Math.max(r,g,b)<125)dark++;if(Math.min(r,g,b)<220)model++;}
    return {green,dark,model,pixels:rgba.length/4};
  });}
  for(const panel of sample.panels){
    await open(panel);
    const image=await imageStats();assert.ok(image.green<image.pixels*.001,'Neutral model must have no green paint');assert.ok(image.model>5000&&image.dark>100,'Surfaces and contrasting edges must be visible');
    await stage.screenshot({path:path.join(output,panel.id+'-iso.png')});
    for(const view of ['top','front','side']){await page.getByLabel('Camera view').selectOption(view);await stage.screenshot({path:path.join(output,panel.id+'-'+view+'.png')});}
  }
  const panel=sample.panels.at(-1);await page.getByLabel('Camera view').selectOption('iso');
  const originalCanvas=await canvas.elementHandle();
  await page.getByRole('checkbox',{name:'Distinguish painted face',exact:true}).uncheck();
  assert.equal(await originalCanvas.evaluate(node=>node.isConnected),true,'Appearance changes preserve the canvas/camera');
  await page.getByRole('checkbox',{name:'Distinguish painted face',exact:true}).check();
  await page.getByRole('checkbox',{name:'Wireframe (mesh triangles)',exact:true}).check();
  await stage.screenshot({path:path.join(output,'wireframe-explicit.png')});
  await page.getByRole('checkbox',{name:'Wireframe (mesh triangles)',exact:true}).uncheck();
  await page.getByRole('button',{name:'Flat',exact:true}).click();await page.getByRole('button',{name:'Fit model to view',exact:true}).click();
  assert.ok((await imageStats()).green<100);await stage.screenshot({path:path.join(output,'flat.png')});
  const slider=page.locator('.fold-timeline').getByRole('slider');await slider.focus();await slider.press('Home');
  for(let i=0;i<10;i++)await slider.press('ArrowRight');
  await page.getByRole('button',{name:'Fit model to view',exact:true}).click();
  await stage.screenshot({path:path.join(output,'partial-fold.png')});
  await page.getByRole('button',{name:'Play fold animation',exact:true}).click();
  await page.getByRole('button',{name:'Pause fold animation',exact:true}).click();
  await page.getByRole('button',{name:'Folded',exact:true}).click();await page.getByRole('button',{name:'Fit model to view',exact:true}).click();
  // Orbit/pan/zoom reuse existing geometry buffers; rendering does not rebuild edges.
  await page.waitForTimeout(250);const before=await page.evaluate(()=>({...window.__inspectionStats}));
  const box=await canvas.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  await page.mouse.wheel(0,-260);await page.mouse.down();await page.mouse.move(box.x+box.width/2+170,box.y+box.height/2-180,{steps:12});await page.mouse.up();
  await page.mouse.down({button:'right'});await page.mouse.move(box.x+box.width/2+190,box.y+box.height/2-150,{steps:5});await page.mouse.up({button:'right'});
  await stage.screenshot({path:path.join(output,'detail-orbit.png')});
  const after=await page.evaluate(()=>({...window.__inspectionStats}));
  assert.equal(after.uploads,before.uploads,'No new mesh/line buffers during orbit/pan/zoom');
  assert.ok(after.lines>before.lines&&after.triangles>before.triangles,'Both surface and feature lines rendered');
  assert.equal(await originalCanvas.evaluate(node=>node.isConnected),true);
  await page.getByRole('button',{name:'Fit model to view',exact:true}).click();
  // Hover a visible bend; helper lines must not intercept raycasting.
  let hovered=false;
  for(let y=box.y+box.height*.27;y<box.y+box.height*.78&&!hovered;y+=14)for(let x=box.x+box.width*.15;x<box.x+box.width*.9&&!hovered;x+=14){
    await page.mouse.move(x,y);hovered=await page.locator('.bend-tooltip').count()>0;
  }
  assert.ok(hovered,'Existing bend hover remains available');
  // PNG contains the new appearance. CAD downloads remain byte-for-byte identical.
  let waiting=page.waitForEvent('download');await page.getByRole('button',{name:'Download viewport PNG',exact:true}).click();
  const png=await waiting;await png.saveAs(path.join(output,'viewport.png'));assert.ok(fs.statSync(path.join(output,'viewport.png')).size>10000);
  for(const [file,label]of [['panel.step','STEP · BREP solid'],['panel.stl','STL · mesh']]){
    await page.getByRole('button',{name:'Export',exact:true}).first().click();
    await page.getByRole('menuitem',{name:label,exact:true}).click();
    const expectedURL=url+panel.asset_base+'/'+file;
    for(let i=0;i<500&&!exportResponses.some(response=>response.url===expectedURL);i++)await page.waitForTimeout(20);
    const response=exportResponses.find(response=>response.url===expectedURL);assert.ok(response,'Export action must request the selected drawing artifact');
    assert.equal(response.status,200);const destination=path.join(output,file);fs.writeFileSync(destination,response.body);
    assert.equal(hash(fs.readFileSync(destination)),hash(fs.readFileSync(path.join(root,'public',panel.asset_base,file))));
    for(const popup of page.context().pages())if(popup!==page)await popup.close();
  }
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Fit model to view',exact:true}).click();
  await stage.screenshot({path:path.join(output,'mobile.png')});assert.ok((await imageStats()).model>1000);
  // Project comparison is outside this visual change and keeps its original styling.
  await page.goto(`${url}/projects/${panel.project_id}/compare`,{waitUntil:'networkidle'});await loaded();
  assert.equal(await page.locator('.inspection-studio').count(),0);
  assert.ok((await imageStats()).green>500,'Comparison styling remains unchanged');
  // Existing software fallback remains usable with neutral materials.
  const fallback=await browser.newPage({viewport:{width:1200,height:1000}});fallback.on('pageerror',error=>errors.push(error.message));
  await fallback.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return ['webgl','webgl2','experimental-webgl'].includes(type)?null:original.call(this,type,...args);};});
  await fallback.route('**/api/bootstrap',route=>route.fulfill({json:sample}));
  await fallback.goto(`${url}/projects/${panel.project_id}/drawings/${panel.id}/step/5`,{waitUntil:'networkidle'});
  await fallback.locator('.viewer-loading').waitFor({state:'hidden',timeout:45000});await fallback.getByText(/Software preview/).waitFor();
  await fallback.locator('.viewer-stage').screenshot({path:path.join(output,'software-fallback.png')});await fallback.close();
  assert.deepEqual(sources.map(file=>hash(fs.readFileSync(file))),originalHashes);
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  console.log('PASS: three real panel GLBs, neutral pixels, edge rendering, four camera presets, flat/partial/folded states, paint distinction, explicit wireframe, hover, zoom/pan/orbit, cached buffers, PNG, identical STEP/STL downloads, mobile, unchanged comparison and software fallback.');
  console.log('Artifacts: '+output);
}catch(error){console.error(logs.slice(-2500));throw error;}finally{await browser?.close();server?.kill('SIGTERM');}
