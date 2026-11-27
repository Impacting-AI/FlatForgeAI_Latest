'use client';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Plus,Undo2,Redo2,Link2,Maximize2,Minimize2,Save} from 'lucide-react';
import AssemblyPanelList from './AssemblyPanelList';
import AssemblyViewer,{type AssemblyViewerHandle} from './AssemblyViewer';
import {useProjectAssembly} from './useProjectAssembly';
import {baseId,type Pick} from './plane-mates';
import {canMove,movePanel,planConnection,removePanel,type Connection} from './assembly-actions';
import type {AssemblyEntry,Panel,CadFaceReference} from './types';
import type {CadFaceCatalog,CadPlacement} from './assembly-cad';
import type {FaceRole,FaceSelection} from './face-connection-state';
import {DEFAULT_ASSEMBLY_GAP_MM} from './assembly-geometry';
import {namedEntries,stagedPanel,freezePlacements,recordAction,type AssemblyHistory} from './assembly-workspace-state';

/** A new panel waits this far from the assembly, so the facing sides stay clickable. */
const PARKING_MM=250;
/** Keyboard step directions: [screen-right, away from the viewer, up]. */
const NUDGES:Record<string,number[]>={ArrowLeft:[-1,0,0],ArrowRight:[1,0,0],ArrowUp:[0,1,0],ArrowDown:[0,-1,0],PageUp:[0,0,1],PageDown:[0,0,-1]};
type Hold={id:string;placement:CadPlacement|null;delta:number[];keys:boolean};

export default function AssemblyWorkspace({projectId,live,panels}:{projectId:string;live:boolean;panels:Panel[]}){
 const store=useProjectAssembly(projectId,live),entries=useMemo(()=>namedEntries(store.entries),[store.entries]);
 const workspace=useRef<HTMLElement|null>(null);
 useEffect(()=>{
  const root=workspace.current,toolbar=root?.querySelector<HTMLElement>('.asm-workspace-toolbar');if(!root||!toolbar)return;
  const update=()=>root.style.setProperty('--assembly-toolbar-bottom',`${toolbar.offsetTop+toolbar.offsetHeight+8}px`);
  const observer=new ResizeObserver(update);observer.observe(toolbar);update();return()=>observer.disconnect();
 },[]);
 const view=useRef<AssemblyViewerHandle|null>(null);
 const [active,setActive]=useState<string|null>(null),[addOpen,setAddOpen]=useState(false),[fullscreen,setFullscreen]=useState(false);
 // Picking two faces: the first is kept here until the second one completes the connection.
 const [mating,setMating]=useState<{first?:Pick;preferred?:string}|null>(null);
 // A connection being solved. It is saved to the working layout only once the CAD service accepts it.
 const [pending,setPending]=useState<(Connection&{attempt:number})|null>(null);
 const [placement,setPlacement]=useState<CadPlacement|null>(null);
 const [validation,setValidation]=useState({key:'',valid:false,token:null as string|null,checking:false,message:'',warning:''}),[ready,setReady]=useState(false);
 const [drag,setDrag]=useState<number[]|null>(null),[notice,setNotice]=useState('');
 const [history,setHistory]=useState<AssemblyHistory>({past:[],future:[]});
 const catalogs=useRef<Record<string,CadFaceCatalog>>({}),added=useRef<string|null>(null);
 const hold=useRef<Hold|null>(null);

 const effective=pending?pending.attempts[pending.attempt]:entries;
 const mateCheckId=pending?.movingId;
 const key=JSON.stringify({entries:effective,mateCheckId}),valid=validation.key===key&&validation.valid&&!drag;
 const selected=effective.find(e=>e.id===active);
 const title=(id:string)=>`Panel ${effective.find(e=>e.id===id)?.label??'?'}`;
 const fileNames=Object.fromEntries(effective.map(e=>[e.id,panels.find(p=>p.id===e.panelId)?.filename??'Unavailable drawing']));
 const available=panels.filter(p=>p.status==='PASS'&&p.artifacts.includes('panel.glb')&&p.artifacts.includes('panel.step'));
 const busy=!store.loaded||store.saving||!!pending;
 const movable=live&&!busy&&!mating&&!!selected&&(!!drag||canMove(entries,selected.id,ready));
 const selection=useMemo<FaceSelection|null>(()=>mating?{anyPanel:true,geometry:'face',alignment:'top',referenceEntryId:'',movingEntryId:mating.first?.entryId??'',moving:mating.first?.face,pick:mating.first?'reference':'moving'}:null,[mating]);

 function commit(next:AssemblyEntry[]){setHistory(h=>recordAction(h,entries));store.setEntries(next);}
 function travel(direction:'undo'|'redo'){
  if(busy||drag)return;const from=direction==='undo'?history.past:history.future;if(!from.length)return;
  const next=from[from.length-1];store.setEntries(next);setMating(null);setNotice('');
  setHistory(direction==='undo'?{past:history.past.slice(0,-1),future:[...history.future,entries]}:{past:[...history.past,entries],future:history.future.slice(0,-1)});
  if(!next.some(e=>e.id===active))setActive(null);
 }
 function select(id:string|null){if(pending||mating)return;setActive(id);setAddOpen(false);setNotice('');}
 function toggleMate(){
  if(!live||busy||!ready||entries.length<2)return;
  setAddOpen(false);setNotice('');
  setMating(mating?null:{preferred:active&&active!==baseId(entries)?active:undefined});
 }
 function add(panel:Panel){
  if(busy||drag)return;const id=crypto.randomUUID();
  setAddOpen(false);setMating(null);setNotice('');
  if(!entries.length){commit([{id,label:'A',revision:panel.revision,panelId:panel.id,myFace:'-X',targetId:null,targetFace:null,gap:DEFAULT_ASSEMBLY_GAP_MM}]);setActive(null);return;}
  if(!placement||!ready)return;
  try{
   const frozen=freezePlacements(entries,placement),staged=stagedPanel(frozen,panel.id,id,placement,live?PARKING_MM:DEFAULT_ASSEMBLY_GAP_MM);
   if(live)added.current=id;
   commit([...frozen,{...staged.original,revision:panel.revision}]);setActive(id);
  }catch(error){setNotice((error as Error).message);}
 }
 const onPlaced=useCallback((next:CadPlacement)=>{
  setPlacement(next);const id=added.current;
  if(!id||!next.entries.some(e=>e.id===id))return;
  // The new panel is on screen: go straight to picking the faces that join it.
  added.current=null;setMating({preferred:id});
 },[]);
 const onCatalog=useCallback((catalog:CadFaceCatalog)=>{
  if(catalog.faces.length||!catalogs.current[catalog.entryId])catalogs.current={...catalogs.current,[catalog.entryId]:catalog};
 },[]);
 function facePicked(_role:FaceRole,face:CadFaceReference,id:string){
  if(!mating||busy)return;
  if(!ready||!placement){setNotice('Panel positions are still updating. Click the face again.');return;}
  const pick={entryId:id,face};setNotice('');
  // Clicking the same panel again simply replaces the first face.
  if(!mating.first||mating.first.entryId===id){setMating({...mating,first:pick});return;}
  try{
   const plan=planConnection(entries,mating.first,pick,catalogs.current,placement,crypto.randomUUID(),mating.preferred);
   if('error' in plan){setMating({preferred:mating.preferred});setNotice(plan.error);return;}
   setMating(null);setPending({...plan,attempt:0});
  }catch(error){setMating({preferred:mating.preferred});setNotice((error as Error).message);}
 }
 // Apply the connection as soon as the CAD service has placed and checked it.
 function settle(result:typeof validation){
  setValidation(result);
  if(!pending||result.key!==key||result.checking)return;
  // Only a real mate conflict moves on to replacing earlier mates; a service error changes nothing.
  const report=placement?.constraints?.[pending.movingId];
  if(result.valid&&report?.status!=='conflict'){
   commit(effective);setPending(null);setActive(pending.movingId);
   setNotice(`${title(pending.movingId)} connected to ${title(pending.targetId)}.${result.warning?` ${result.warning} Undo, or drag the panel clear.`:''}`);
  }else if(report?.status==='conflict'&&pending.attempt+1<pending.attempts.length)setPending({...pending,attempt:pending.attempt+1});
  else{
   setPending(null);setMating({preferred:pending.movingId});
   setNotice(`Those faces could not be connected. ${report?.mates.find(m=>m.id===pending.mateId)?.message||result.message} Pick another pair.`);
  }
 }
 const settleLatest=useRef(settle);
 useEffect(()=>{settleLatest.current=settle;});
 const onValidation=useCallback((result:Parameters<typeof settle>[0])=>settleLatest.current(result),[]);

 const onDrag=useCallback((delta:number[])=>{
  // Captured when the drag starts, while the shown positions still match the layout.
  if(!hold.current&&active)hold.current={id:active,placement:ready?placement:null,delta,keys:false};
  setDrag(delta);
 },[active,ready,placement]);
 function finishMove(id:string,delta:number[]){
  const start=hold.current;hold.current=null;setDrag(null);
  if(delta.every(v=>!v))return false;
  try{commit(movePanel(entries,id,delta,start?.placement??(ready?placement:null)));setNotice('');return true;}
  catch(error){setNotice((error as Error).message);return false;}
 }
 /** A held key is previewed as it repeats and saved once, on release. */
 function finishKeys(){const start=hold.current;if(start?.keys&&!finishMove(start.id,start.delta))view.current?.relayout();}
 function nudge(direction:number[],step:number){
  const axes=view.current?.axes();if(!axes||!selected||!movable&&!hold.current?.keys)return;
  if(hold.current&&!hold.current.keys)return;
  const delta=[0,1,2].map(i=>(axes.right[i]*direction[0]+axes.forward[i]*direction[1]+(i===2?direction[2]:0))*step);
  const start=hold.current??={id:selected.id,placement:ready?placement:null,delta:[0,0,0],keys:true};
  start.delta=start.delta.map((v,i)=>Math.round((v+delta[i])*10)/10);
  view.current!.shift(start.id,delta);setDrag(start.delta);
 }
 function remove(id:string){
  if(busy||drag)return;
  try{const name=title(id);commit(removePanel(entries,id,ready?placement:null));setActive(null);setMating(null);setNotice(`${name} removed. Undo (Ctrl+Z) restores it.`);}
  catch(error){setNotice((error as Error).message);}
 }
 async function save(){
  if(busy||drag||entries.length&&!valid)return;
  // Labels are UI metadata. The API binds every engineering field to this exact
  // checked matrix snapshot; saving does not run placement again.
  setNotice('');
  await store.save(placement,validation.token);
 }
 // Full screen fills the display; the overlay alone still works if the browser refuses.
 useEffect(()=>{if(!fullscreen)return;
  const change=()=>{if(!document.fullscreenElement)setFullscreen(false)};
  document.documentElement.requestFullscreen?.().catch(()=>{});document.addEventListener('fullscreenchange',change);
  return()=>{document.removeEventListener('fullscreenchange',change);if(document.fullscreenElement)void document.exitFullscreen().catch(()=>{})};
 },[fullscreen]);

 const keys=useRef<(event:KeyboardEvent)=>void>(()=>{}),release=useRef<(event?:KeyboardEvent)=>void>(()=>{});
 useEffect(()=>{keys.current=event=>{
  const target=event.target as Element|null;
  if(event.defaultPrevented||target?.closest?.('input,textarea,select,[contenteditable="true"]')||document.querySelector('[role="dialog"],[role="alertdialog"],[role="menu"]'))return;
  const command=event.ctrlKey||event.metaKey,name=event.key.toLowerCase();
  if(command){if(name==='z'||name==='y'){event.preventDefault();travel(name==='y'||event.shiftKey?'redo':'undo');}return;}
  if(event.altKey)return;
  if(event.key==='Escape'){
   if(addOpen)setAddOpen(false);else if(pending)setPending(null);else if(mating){setMating(null);setNotice('');}
   else if(fullscreen)setFullscreen(false);else setActive(null);
  }else if(NUDGES[event.key]&&(movable||hold.current?.keys)){event.preventDefault();nudge(NUDGES[event.key],event.shiftKey?.1:1);}
  else if(event.key==='Delete'&&selected){event.preventDefault();remove(selected.id);}
  else if(name==='m')toggleMate();
  else if(name==='f')view.current?.fit();
 };release.current=event=>{if(!event||NUDGES[event.key])finishKeys();};});
 useEffect(()=>{
  const down=(event:KeyboardEvent)=>keys.current(event),up=(event:KeyboardEvent)=>release.current(event),blur=()=>release.current();
  window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',blur);
  return()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',blur);};
 },[]);

 const problem=!pending&&ready&&validation.key===key&&!validation.checking&&!validation.valid?validation.message:'';
 const message=store.error||notice||problem||store.message;
 const axisText=(delta:number[])=>delta.map((v,i)=>`${'XYZ'[i]} ${v>0?'+':''}${v}`).join(' · ')+' mm';
 const working=pending?'Connecting…':drag?`${selected?title(selected.id):'Moving'} · ${axisText(drag)}`
  :mating?(mating.first?'Now click the face it should join, on another panel.':mating.preferred?`Click a face on ${title(mating.preferred)}.`:'Click a face on the panel to move.'):'';
 const hint=!store.loaded?(store.error?'':'Loading saved assembly…'):working||(fullscreen?''
  :!entries.length?'Add Panel to start. The first panel is the fixed base.'
  :selected&&live?`${title(selected.id)} · drag an arrow, or use arrow keys and Page Up / Down (1 mm, Shift 0.1 mm).`
  :entries.length>1?'Click a panel to move it. Use Mate to connect two faces.':'Add another panel to connect it.');

 return <section ref={workspace} className={'assembly-workspace'+(fullscreen?' is-fullscreen':'')} aria-label="Interactive assembly workspace" data-mating={!!mating||undefined} data-unsaved-assembly={store.dirty||pending?'true':undefined} aria-busy={store.saving}>
  <AssemblyViewer ref={view} projectId={projectId} live={live} entries={effective} panels={available} onReadyChange={setReady}
   mateCheckId={mateCheckId} selection={selection} previewOnly={!!pending} onFacePicked={facePicked} onFaceMessage={setNotice} onValidation={onValidation}
   activeId={active} movable={movable} onSelect={select} onMove={finishMove} onDrag={onDrag} onCatalog={onCatalog} onPlaced={onPlaced}>
   <div className="asm-workspace-toolbar">
    {!fullscreen&&<button className="primary" title="Connect two panels: click a face on each (M)" aria-pressed={!!mating} disabled={!live||busy||!ready||entries.length<2} onClick={toggleMate}><Link2 size={15}/>Mate</button>}
    <button className="primary" aria-expanded={addOpen} disabled={busy||!!drag||entries.length>=100||!!entries.length&&!ready} onClick={()=>setAddOpen(!addOpen)}><Plus size={15}/>Add Panel</button>
    <button className="primary" disabled={busy||!live||!!drag||!!entries.length&&!valid} onClick={()=>void save()}><Save size={15}/>{store.saving?'Saving…':'Save Assembly'}</button>
    {!fullscreen&&<>
     <button aria-label="Undo" title="Undo (Ctrl+Z)" disabled={busy||!history.past.length} onClick={()=>travel('undo')}><Undo2 size={15}/></button>
     <button aria-label="Redo" title="Redo (Ctrl+Y)" disabled={busy||!history.future.length} onClick={()=>travel('redo')}><Redo2 size={15}/></button>
     <button onClick={()=>setFullscreen(true)}><Maximize2 size={15}/>Full Screen</button>
    </>}
   </div>
   {fullscreen&&<button className="asm-exit-fullscreen" aria-label="Exit full screen" title="Exit full screen (Esc)" onClick={()=>setFullscreen(false)}><Minimize2 size={16}/></button>}
   {addOpen&&<section className="asm-context asm-add-picker" aria-label="Choose a panel">
    <div className="asm-available-panels">{available.map(p=><button key={p.id} disabled={!live||busy} onClick={()=>add(p)}>{p.filename}</button>)}</div>
    {!available.length&&<p>No approved panel solids are available.</p>}{!live&&<p>Connect the CAD service to create and save assemblies.</p>}
   </section>}
   {!fullscreen&&!!effective.length&&<aside className="asm-panel-list" aria-label="Assembly panels">
    <AssemblyPanelList entries={effective} placement={placement} fileNames={fileNames} active={active} busy={busy||!!drag} onSelect={select} onRemove={remove}/>
   </aside>}
   {(message||hint)&&<div className="asm-status">
    {message&&<p role={store.error?'alert':'status'} className="asm-message">{message}{store.error&&<button onClick={()=>{if((store.dirty||pending)&&!window.confirm('Discard current edits and reload the saved project assembly?'))return;setPending(null);setMating(null);setActive(null);setNotice('');setHistory({past:[],future:[]});store.reload();}}>Reload saved assembly</button>}</p>}
    {hint&&<p role="status" className="asm-mode-indicator">{hint}{(store.dirty||pending)&&<span>Unsaved changes</span>}</p>}
   </div>}
  </AssemblyViewer>
 </section>;
}
