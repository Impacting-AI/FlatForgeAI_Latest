/** 3D Studio navigation with real WebGL and real panel GLBs. All API calls are mocked. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root=fileURLToPath(new URL('..',import.meta.url));
const output=process.env.FLATFORGE_QA_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'ff-orbit-'));
fs.mkdirSync(output,{recursive:true});
const url=process.env.FLATFORGE_TEST_URL||'http://127.0.0.1:5181';
const server=process.env.FLATFORGE_TEST_URL?null:spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5181','--strictPort'],{cwd:root,stdio:['ignore','pipe','pipe']});
let logs='',browser;
server?.stdout.on('data',data=>logs+=data);server?.stderr.on('data',data=>logs+=data);
const sample=JSON.parse(fs.readFileSync(path.join(root,'lib/sample-data.json')));
// A copy of a real panel that behaves as an uploaded drawing, so bends are editable.
const source=sample.panels.find(p=>p.id==='reference-1619'); // 21 bends
const data={...sample,mode:'live',panels:sample.panels.map(p=>p.id===source.id?{...p,sample:false}:p)};
const results=[];
const pass=message=>{results.push(message);console.log('PASS '+message);};

const sub=(a,b)=>a.map((v,i)=>v-b[i]),add=(a,b)=>a.map((v,i)=>v+b[i]),mul=(a,s)=>a.map(v=>v*s),length=a=>Math.hypot(...a),dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const distance=(a,b)=>length(sub(a,b));
/** Camera axes and position in model space, from the rendered view matrix. */
function camera(m){const right=[m[0],m[4],m[8]],up=[m[1],m[5],m[9]],back=[m[2],m[6],m[10]];return {right,up,back,position:mul(add(add(mul(right,m[12]),mul(up,m[13])),mul(back,m[14])),-1)};}
const angle=(a,b)=>Math.acos(Math.max(-1,Math.min(1,(dot(a.right,b.right)+dot(a.up,b.up)+dot(a.back,b.back)-1)/2)));
/** Orbit centre and distance shared by two views taken before and after a rotation. */
function pivot(a,b){const d=distance(a.position,b.position)/distance(a.back,b.back);const first=sub(a.position,mul(a.back,d)),second=sub(b.position,mul(b.back,d));return {point:first,error:distance(first,second)/d,distance:d};}
const same=(a,b,message,tolerance=.002)=>{assert.ok(angle(a,b)<tolerance,message+': orientation');assert.ok(distance(a.position,b.position)<tolerance*Math.max(1,length(a.position)),message+': position');};

try {
  for(let i=0;i<180;i++){try{if((await fetch(url)).ok)break;}catch{}if(i===179)throw Error(logs);await new Promise(r=>setTimeout(r,200));}
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
  // Full Chromium on the machine's graphics hardware. Headless software GL (SwiftShader)
  // crashes the tab after about a hundred orbit drags, too few for this run.
  browser=await chromium.launch({executablePath:process.env.FLATFORGE_CHROMIUM||undefined,channel:'chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=default','--enable-gpu','--ignore-gpu-blocklist']});
  const context=await browser.newContext({viewport:{width:1500,height:1000},hasTouch:true});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('crash',()=>console.error('Browser tab crashed after: '+results.at(-1)));
  await page.addInitScript(()=>{
    localStorage.setItem('flatforge_admin_token','x'.repeat(40));
    // Three.js announces each renderer to its developer tools; record the camera it draws with.
    const tools=window.__THREE_DEVTOOLS__=new EventTarget();
    tools.addEventListener('observe',({detail:renderer})=>{if(!renderer.isWebGLRenderer)return;const render=renderer.render;
      renderer.render=function(scene,camera){render.call(this,scene,camera);window.__view=Array.from(camera.matrixWorldInverse.elements);};});
  });
  await page.route('**/api/bootstrap',route=>route.fulfill({json:data}));
  await page.route('**/api/engine/**',async route=>{
    const request=route.request(),target=new URL(request.url()).pathname;
    const file=target.match(/\/panels\/reference-1619\/files\/(.+)$/);
    if(file){const found=path.join(root,'public',source.asset_base,decodeURIComponent(file[1]));return fs.existsSync(found)?route.fulfill({body:fs.readFileSync(found)}):route.fulfill({status:404,json:{detail:'Missing'}});}
    if(request.method()==='POST'&&target.endsWith('/panels/reference-1619/review')){const panel=data.panels.find(p=>p.id===source.id);panel.revision+=1;return route.fulfill({json:{ok:true}});}
    return route.fulfill({status:404,json:{detail:'Not mocked'}});
  });

  const stage=page.locator('.viewer-stage'),canvas=page.locator('.viewer-stage canvas');
  const frames=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  /** The camera once its movement has finished. */
  async function view(){let last,still=0;for(let i=0;i<200;i++){await frames();const now=await page.evaluate(()=>window.__view);assert.ok(now,'a view matrix was rendered');still=last&&now.every((v,k)=>Math.abs(v-last[k])<1e-7)?still+1:0;if(still>=3)return camera(now);last=now;}throw Error('The camera never came to rest');}
  async function loaded(){await canvas.waitFor();await page.locator('.viewer-loading').waitFor({state:'hidden',timeout:60000});}
  const size=async()=>await canvas.boundingBox();
  // Start low and to one side, clear of the toolbar, labels and help card.
  async function drag(dx,dy,{button='left',key}={}){
    const box=await size(),x=box.x+box.width/2-dx/2,y=box.y+box.height/2-dy/2;
    await page.mouse.move(x,y);if(key)await page.keyboard.down(key);await page.mouse.down({button});await page.mouse.move(x+dx,y+dy,{steps:8});await page.mouse.up({button});if(key)await page.keyboard.up(key);
    return view();
  }
  const reset=async()=>{await page.getByRole('button',{name:'Fit model to view',exact:true}).click();return view();};
  const turnPixels=async()=>(await size()).height/.6;

  /** Orbit, zoom, pan and reset checks, shared by the normal and full screen viewer. */
  async function navigation(mode){
    const home=await reset(),turn=await turnPixels();
    assert.ok(home.up[2]>0&&Math.abs(home.right[2])<1e-5,'default view is upright');
    // Vertical: over one pole, underneath and back.
    for(const sign of [1,-1]){
      await reset();let previous=home,centre=null;const heights=[],inverted=[];
      for(let i=0;i<12;i++){
        const now=await drag(0,sign*(turn/12+0),{});const moved=angle(previous,now),at=pivot(previous,now);
        assert.ok(moved>.35&&moved<.56,`${mode} vertical step ${i} turned ${moved}`);
        assert.ok(at.error<.002,`${mode} orbit centre ${at.error}`);
        if(centre)assert.ok(distance(centre,at.point)<.002*at.distance,'one stable orbit centre');
        centre=at.point;assert.ok(Math.abs(now.right[2])<1e-4,'level horizon');
        heights.push(now.back[2]);inverted.push(now.up[2]<0);previous=now;
      }
      assert.ok(Math.max(...heights)>.9&&Math.min(...heights)<-.9,`${mode}: top and bottom reached ${heights}`);
      assert.ok(inverted.some(Boolean),'passed beyond the poles');
    }
    pass(`${mode}: vertical orbit passes over both poles in both directions, stable centre, level horizon`);
    await reset();const turned=[];let previous=home;
    for(let i=0;i<16;i++){const now=await drag(turn/12,0);assert.ok(angle(previous,now)>.2,`${mode} horizontal never stops (step ${i})`);assert.ok(Math.abs(now.back[2]-home.back[2])<1e-4,'constant elevation');turned.push(Math.atan2(now.back[1],now.back[0]));previous=now;}
    for(const target of [-Math.PI/2,0,Math.PI/2,Math.PI])assert.ok(turned.some(a=>Math.abs(Math.atan2(Math.sin(a-target),Math.cos(a-target)))<.45),`${mode}: side ${target} reached`);
    pass(`${mode}: horizontal orbit continues past 360°, front, back, left and right reached`);
    const before=await reset(),box=await size();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,-600);const near=await view();
    assert.ok(angle(before,near)<1e-3&&distance(before.position,near.position)>.05,'zoom moves without turning');
    await page.mouse.wheel(0,600);const far=await view();assert.ok(distance(far.position,before.position)<distance(near.position,before.position),'zoom out reverses');
    const rest=await reset(),panned=await drag(120,70,{button:'right'});
    assert.ok(angle(rest,panned)<1e-3&&distance(rest.position,panned.position)>.02,'right drag pans without turning');
    const shifted=await drag(-90,40,{key:'Shift'});assert.ok(angle(panned,shifted)<1e-3&&distance(panned.position,shifted.position)>.02,'Shift + left drag pans');
    same(home,await reset(),`${mode} reset`);
    pass(`${mode}: wheel zoom, right-drag pan, Shift-drag pan and Reset view`);
    return home;
  }

  await page.goto(`${url}/projects/${source.project_id}/drawings/${source.id}/step/5`,{waitUntil:'networkidle'});await loaded();
  const home=await navigation('normal');

  // Pictures from every side.
  const turn=await turnPixels();
  await stage.screenshot({path:path.join(output,'01-default.png')});
  await drag(turn/2,0);await stage.screenshot({path:path.join(output,'02-opposite.png')});
  await reset();await drag(0,turn*.2);await stage.screenshot({path:path.join(output,'03-top.png')});
  await reset();await drag(0,-turn*.27);await stage.screenshot({path:path.join(output,'04-underneath.png')});
  await reset();await drag(0,turn/2);await stage.screenshot({path:path.join(output,'05-upside-down.png')});

  // Smoothness: sample every frame of one long drag through a pole.
  await reset();
  await page.evaluate(()=>{window.__frames=[];const record=()=>{window.__frames.push(window.__view);window.__recording=requestAnimationFrame(record);};record();});
  {const box=await size(),x=box.x+box.width*.4,y=box.y+20+60;await page.mouse.move(x,y);await page.mouse.down();
   for(let i=1;i<=60;i++){await page.mouse.move(x+i*2,y+i*7);await frames();}await page.mouse.up();await view();}
  const recorded=await page.evaluate(()=>{cancelAnimationFrame(window.__recording);return window.__frames;});
  const steps=recorded.slice(1).map((m,i)=>angle(camera(recorded[i]),camera(m)));
  // 7 px per mouse move is about 0.05 rad; a pole flip or snap would be far larger.
  assert.ok(Math.max(...steps)<.12,`largest single-frame turn ${Math.max(...steps)}`);
  assert.ok(steps.reduce((a,b)=>a+b,0)>2,'the drag really rotated');
  pass(`no jumps: ${steps.length} frames through a pole, largest step ${(Math.max(...steps)*180/Math.PI).toFixed(2)}°`);

  // Press and release without movement leaves the camera where it is.
  const still=await view();{const box=await size();await page.mouse.move(box.x+30,box.y+box.height-30);await page.mouse.down();await page.mouse.up();}
  same(still,await view(),'click',1e-5);pass('starting and stopping a press causes no camera jump');

  // Resize keeps the orientation and fills the new area.
  await drag(160,-120);const sized=await view();
  await page.setViewportSize({width:1100,height:760});await page.waitForTimeout(400);
  same(sized,await view(),'resize');
  const fills=async()=>page.evaluate(()=>{const host=document.querySelector('.webgl-host'),c=host.querySelector('canvas');return Math.abs(c.clientWidth-host.clientWidth)<2&&Math.abs(c.clientHeight-host.clientHeight)<2;});
  assert.ok(await fills());await drag(50,90);await page.setViewportSize({width:1500,height:1000});await page.waitForTimeout(400);assert.ok(await fills());
  pass('viewer resize keeps the camera and fills the viewer');

  // Full screen: same canvas, same camera, full navigation, and back.
  await reset();const posed=await drag(210,330),element=await canvas.elementHandle(),smaller=await size();
  await page.getByRole('button',{name:'Open full screen'}).click();await page.waitForTimeout(600);
  same(posed,await view(),'enter full screen');assert.ok((await size()).width>smaller.width&&await fills());
  assert.equal(await element.evaluate(node=>node.isConnected),true,'same canvas');
  await stage.screenshot({path:path.join(output,'06-fullscreen.png')});
  await navigation('full screen');
  const kept=await drag(-140,260);
  await page.getByRole('button',{name:'Close full screen'}).click();await page.waitForTimeout(600);
  same(kept,await view(),'exit by button');assert.ok(await fills());
  await page.getByRole('button',{name:'Open full screen'}).click();await page.waitForTimeout(600);
  const escaped=await drag(100,-200);await page.keyboard.press('Escape');await page.getByRole('button',{name:'Open full screen'}).waitFor();await page.waitForTimeout(600);
  same(escaped,await view(),'exit by Escape');await drag(80,80);
  pass('full screen entry, exit by button and by Escape keep the camera');

  // Camera presets still apply, then orbit freely from them.
  for(const [name,expected] of [['top',[0,0,1]],['front',[0,-1,0]],['side',[1,0,0]],['iso',null]]){
    await page.getByLabel('Camera view').selectOption(name);const preset=await view();
    if(expected)assert.ok(distance(preset.back,expected)<.01,name+' preset');
    const moved=await drag(0,150);assert.ok(angle(preset,moved)>.4,name+' preset can be orbited');
  }
  pass('Top, Front, Side and Isometric presets apply and can be orbited');

  // Flat and Folded keep the orientation.
  await reset();const folded=await drag(130,90);
  await page.getByRole('button',{name:'Flat',exact:true}).click();const flat=await view();
  assert.ok(angle(folded,flat)<1e-3,'Flat keeps the orientation');
  await page.getByRole('button',{name:'Folded',exact:true}).click();same(folded,await view(),'back to Folded');
  pass('switching Flat / Folded keeps orientation and returns to the same view');

  // Bend selection and editing, including from underneath.
  const editor=page.getByRole('button',{name:'Cancel',exact:true});
  async function findBend(){const box=await size();for(let y=box.y+box.height*.2;y<box.y+box.height*.85;y+=11)for(let x=box.x+box.width*.2;x<box.x+box.width*.8;x+=11){await page.mouse.move(x,y);if(await page.locator('.bend-tooltip').count())return {x,y};}throw Error('No bend under the pointer');}
  for(const [label,dy] of [['above',0],['underneath',-turn*.27]]){
    await reset();if(dy)await drag(0,dy);
    let at=await findBend();
    await page.mouse.down();await page.mouse.move(at.x+90,at.y+40,{steps:6});await page.mouse.up();await view();
    assert.equal(await editor.count(),0,'dragging from a bend only orbits');
    at=await findBend();await page.mouse.down();await page.mouse.move(at.x+80,at.y,{steps:5});await page.mouse.move(at.x,at.y,{steps:5});await page.mouse.up();await view();
    assert.equal(await editor.count(),0,'a drag that returns to its start is not a click');
    at=await findBend();await page.mouse.click(at.x,at.y,{button:'right'});assert.equal(await editor.count(),0,'right click does not select');
    const unmoved=await view();await page.mouse.click(at.x,at.y);await editor.waitFor({timeout:5000});
    same(unmoved,await view(),'selecting a bend',1e-4);
    await stage.screenshot({path:path.join(output,`07-bend-selected-${label}.png`)});
    await editor.click();await editor.waitFor({state:'hidden'});
  }
  pass('bend selection works from above and underneath; drags and right clicks do not select');

  await reset();await page.getByRole('button',{name:'Flat',exact:true}).click();await view();
  await page.locator('.bend-labels button:visible').first().click();await editor.waitFor();
  const field=page.locator('.viewer-stage input[type=number]').first(),old=await field.inputValue();
  await field.fill(String(Number(old||90)-5));
  await page.getByRole('button',{name:/apply/i}).first().click();
  await page.getByText('Change applied').first().waitFor({timeout:5000});
  await page.getByRole('button',{name:'Folded',exact:true}).click();
  const inspected=await drag(190,240);
  await stage.screenshot({path:path.join(output,'08-pending-angle.png')});
  pass('bend editing applies a new angle and the preview can still be orbited');

  // Save & rebuild replaces the scene; the camera stays.
  const old3d=await canvas.elementHandle();
  await page.getByRole('button',{name:'Save & rebuild'}).first().click();
  await page.waitForFunction(node=>!node.isConnected,old3d,{timeout:30000});await loaded();
  const rebuilt=await view();assert.ok(angle(inspected,rebuilt)<.002,'orientation after rebuild');
  assert.ok(distance(inspected.position,rebuilt.position)<.1*Math.max(1,length(inspected.position)),'position after rebuild');
  same(home,await reset(),'reset after rebuild');
  pass('camera is kept across Save & rebuild, and Reset view still returns home');

  // Small details: zoom into a corner of the model and orbit about what is in view.
  await reset();const mid=await size();await page.mouse.move(mid.x+mid.width/2,mid.y+mid.height/2);
  await drag(160,0,{button:'right'});for(let i=0;i<25;i++)await page.mouse.wheel(0,-120);
  const close=await view(),orbited=await drag(60,40);assert.ok(pivot(close,orbited).error<.01,'detail orbit has one centre');
  await stage.screenshot({path:path.join(output,'09-detail.png')});
  pass('zoomed-in orbit turns about the point in view');

  // Touch: one finger orbits, two fingers zoom/pan, lifting one finger causes no error.
  await reset();const cdp=await context.newCDPSession(page),area=await size(),cx=area.x+area.width/2,cy=area.y+area.height/2;
  const touch=(type,points)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([x,y,id])=>({x,y,id}))});
  const start=await view();await touch('touchStart',[[cx,cy,1]]);for(let i=1;i<=8;i++)await touch('touchMove',[[cx+i*20,cy+i*8,1]]);await touch('touchEnd',[]);
  const fingered=await view();assert.ok(angle(start,fingered)>.4,'one finger orbits');
  await touch('touchStart',[[cx-60,cy,1],[cx+60,cy,2]]);for(let i=1;i<=8;i++)await touch('touchMove',[[cx-60-i*12,cy,1],[cx+60+i*12,cy,2]]);
  await touch('touchEnd',[[cx-156,cy,1]]);await touch('touchMove',[[cx-130,cy+30,1]]);await touch('touchMove',[[cx-100,cy+60,1]]);await touch('touchEnd',[]);
  const pinched=await view();assert.ok(distance(pinched.position,fingered.position)>.02,'pinch zooms');
  pass('touch: one-finger orbit, two-finger zoom, lifting one finger');

  for(const width of [800,390]){
    await page.setViewportSize({width,height:844});await page.waitForTimeout(400);
    await stage.evaluate(node=>node.scrollIntoView({block:'start'}));
    assert.ok((await size()).height>=300,`the viewer keeps its height at ${width} px`);await reset();assert.ok(await fills());
    const narrow=await view();assert.ok(angle(narrow,await drag(60,90))>.3,'narrow viewer orbits');
    await page.screenshot({path:path.join(output,`10-narrow-${width}.png`)});
  }
  pass('800 px and 390 px wide: viewer stays visible, resets and orbits');
  // Project comparison uses the same viewer.
  await page.setViewportSize({width:1500,height:1000});
  await page.goto(`${url}/projects/${source.project_id}/compare`,{waitUntil:'networkidle'});await loaded();
  const compared=await view(),over=await drag(0,(await turnPixels())/2);assert.ok(angle(compared,over)>2.5&&over.up[2]<0);
  pass('Compare panels view orbits past the pole too');

  assert.deepEqual(errors,[]);pass('no page errors');
  console.log(`\n${results.length} browser checks passed. Screenshots: ${output}`);
}catch(error){console.error(logs.slice(-1500));console.error('Screenshots: '+output);try{await browser?.contexts()[0]?.pages()[0]?.screenshot({path:path.join(output,'failure.png')});}catch{}throw error;}finally{await browser?.close();server?.kill('SIGTERM');}
