'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Undo2, Redo2, List, Move3D, RotateCw, Link2, Maximize2, X, Eye, EyeOff, Trash2 } from 'lucide-react';
import AssemblyViewer, { type AssemblyViewerHandle } from './AssemblyViewer';
import AssemblyConnectionEditor from './AssemblyConnectionEditor';
import AssemblySpacing from './AssemblySpacing';
import type { AssemblyEntry, Panel, CadFaceReference, Face } from './types';
import type { CadFaceCatalog, CadPlacement } from './assembly-cad';
import { beginFaceDraft, faceDraftError, previewFaceDraft, updateFaceDraft, type FaceDraft, type FaceRole, type FaceSelection } from './face-connection-state';
import { DEFAULT_ASSEMBLY_GAP_MM, removeAssemblyBranch, setAssemblyTargetFace } from './assembly-geometry';
import { namedEntries, nextLabel, stagedPanel, positionValues, withPosition, recordAction, type PositionValues, type AssemblyHistory } from './assembly-workspace-state';

const sides:[Face,string][]=[['+X','Right (+X)'],['-X','Left (−X)'],['+Z','Top (+Z)'],['-Z','Bottom (−Z)'],['-Y','Front (−Y)'],['+Y','Back (+Y)']];
export default function AssemblyWorkspace({projectId,live,entries:stored,onChange,panels,storageError}:{
 projectId:string;live:boolean;entries:AssemblyEntry[];onChange:(entries:AssemblyEntry[])=>void;panels:Panel[];storageError:string;
}){
 const entries=useMemo(()=>namedEntries(stored),[stored]),view=useRef<AssemblyViewerHandle|null>(null);
 const [active,setActive]=useState<string|null>(null),[listOpen,setListOpen]=useState(false),[addOpen,setAddOpen]=useState(false),[repeat,setRepeat]=useState(false);
 const [draft,setDraft]=useState<FaceDraft|null>(null),[isNew,setIsNew]=useState(false),[mode,setMode]=useState<'select'|'connect'|'move'|'rotate'>('select');
 const [rootDraft,setRootDraft]=useState<AssemblyEntry|null>(null),[legacyDraft,setLegacyDraft]=useState<AssemblyEntry|null>(null);
 const [legacyValid,setLegacyValid]=useState(true);
 const [rootFields,setRootFields]=useState({u:'0',v:'0',normal:'0'}),[seed,setSeed]=useState<{id:string;reference?:CadFaceReference}|null>(null);
 const [catalogs,setCatalogs]=useState<Record<string,CadFaceCatalog>>({}),[placement,setPlacement]=useState<CadPlacement|null>(null);
 const [validation,setValidation]=useState({key:'',valid:false}),[ready,setReady]=useState(false),[dragging,setDragging]=useState(false);
 const [hidden,setHidden]=useState<string[]>([]),[wire,setWire]=useState(false),[paint,setPaint]=useState(false),[checking,setChecking]=useState(false),[notice,setNotice]=useState('');
 const [history,setHistory]=useState<AssemblyHistory>({past:[],future:[]});
 const expected=useRef(JSON.stringify(stored));
 const [draftBase,setDraftBase]=useState(JSON.stringify(stored));
 const storedKey=JSON.stringify(stored),editing=!!draft||!!rootDraft||!!legacyDraft||!!seed;
 const stale=editing&&draftBase!==storedKey;
 const preview=draft?.preview??rootDraft??legacyDraft;
 const effective=isNew&&draft?[...entries,preview??draft.original]:preview?entries.map(e=>e.id===preview.id?preview:e):entries;
 const key=JSON.stringify(effective),valid=validation.key===key&&validation.valid&&!dragging&&!stale;
 const selected=effective.find(e=>e.id===active);
 const rootError=Object.values(rootFields).some(v=>!v.trim()||!Number.isFinite(Number(v)));
 const moving=mode==='move'&&(!!rootDraft&&!rootError||!!draft&&!faceDraftError(draft)&&!!previewFaceDraft(draft));
 const selection:FaceSelection|null=draft?draft:seed?{referenceEntryId:seed.id,movingEntryId:seed.id,reference:seed.reference,pick:'reference'}:selected?.connection?{referenceEntryId:selected.targetId!,movingEntryId:selected.id,reference:selected.connection.reference,moving:selected.connection.moving,pick:null}:null;
 const title=(id:string)=>`Panel ${effective.find(e=>e.id===id)?.label??'?'}`;
 const filename=(e:AssemblyEntry)=>panels.find(p=>p.id===e.panelId)?.filename??'Unavailable drawing';
 const available=panels.filter(p=>p.status==='PASS'&&p.artifacts.includes('panel.glb')&&p.artifacts.includes('panel.step'));
 useEffect(()=>{if(expected.current!==storedKey){expected.current=storedKey;queueMicrotask(()=>setHistory({past:[],future:[]}));}},[storedKey]);
 function commit(next:AssemblyEntry[]){setHistory(h=>recordAction(h,entries));expected.current=JSON.stringify(next);onChange(next);}
 function travel(direction:'undo'|'redo'){
  if(editing||dragging)return;const from=direction==='undo'?history.past:history.future;if(!from.length)return;
  const next=from[from.length-1];expected.current=JSON.stringify(next);onChange(next);
  setHistory(direction==='undo'?{past:history.past.slice(0,-1),future:[...history.future,entries]}:{past:[...history.past,entries],future:history.future.slice(0,-1)});
  if(!next.some(e=>e.id===active))setActive(null);
 }
 function clearEdit(){setDraft(null);setRootDraft(null);setLegacyDraft(null);setSeed(null);setMode('select');setIsNew(false);setAddOpen(false);setNotice('');}
 function cancel(){if(isNew)setActive(entries.at(-1)?.id??null);clearEdit();}
 function startEdit(nextMode:'move'|'rotate'|'connect'){
  if(!selected)return;setDraftBase(storedKey);setNotice('');setMode(nextMode);setHidden(ids=>ids.filter(id=>id!==selected.id&&id!==selected.targetId));
  if(selected.targetId===null){
   if(nextMode==='connect'){setSeed({id:selected.id});return;}
   setRootDraft(selected);const p=positionValues(selected);setRootFields({u:String(p.u),v:String(p.v),normal:String(p.normal)});return;
  }
  setLegacyValid(true);
  if(!selected.connection&&nextMode!=='connect'){setLegacyDraft(selected);return;}
  setDraft({...beginFaceDraft(selected),pick:nextMode==='connect'&&!selected.connection?'reference':null});
 }
 function select(id:string|null){if(editing){if(id!==active)setNotice('Apply or cancel the current preview before selecting another panel.');return;}setActive(id);setAddOpen(false);setNotice('');}
 function add(panel:Panel){
  const id=crypto.randomUUID();setAddOpen(false);setNotice('');
  if(!entries.length){const entry:AssemblyEntry={id,label:'A',panelId:panel.id,myFace:'-X',targetId:null,targetFace:null,gap:DEFAULT_ASSEMBLY_GAP_MM};commit([entry]);setActive(id);return;}
  if(!placement||!ready){setNotice('Wait for the current assembly to load before adding a panel.');return;}
  const next=stagedPanel(entries,panel.id,id,placement,DEFAULT_ASSEMBLY_GAP_MM);
  const reference=seed?.id??active??entries[0].id;
  setDraft({...next,referenceEntryId:reference,reference:seed?.reference,pick:seed?.reference?'moving':'reference'});
  setDraftBase(storedKey);setIsNew(true);setActive(id);setMode('connect');setSeed(null);setHidden([]);
 }
 const receiveCatalog=useCallback((catalog:CadFaceCatalog)=>setCatalogs(old=>({...old,[catalog.entryId]:catalog})),[]);
 const facePicked=useCallback((role:FaceRole,face:CadFaceReference)=>{
  if(seed){setSeed({...seed,reference:face});setAddOpen(true);return;}
  setDraft(old=>old?updateFaceDraft(old,{[role]:face,pick:role==='reference'&&!old.moving?'moving':null,message:''}):null);
 },[seed]);
 const faceMessage=useCallback((message:string)=>setNotice(message),[]);
 const onMove=useCallback((p:PositionValues)=>{
  setDraft(old=>old?updateFaceDraft(old,{fields:{...old.fields,u:String(p.u),v:String(p.v),normal:String(p.normal)}}):null);
  setRootDraft(old=>old?withPosition(old,p):null);setRootFields({u:String(p.u),v:String(p.v),normal:String(p.normal)});
 },[]);
 function apply(){
  if(!valid||legacyDraft&&!legacyValid)return;const next=draft?previewFaceDraft(draft):rootDraft??legacyDraft;if(!next)return;
  if(rootDraft&&rootError)return;
  commit(isNew?[...entries,next]:entries.map(e=>e.id===next.id?next:e));clearEdit();
 }
 const renderNumbers=()=>Object.entries(rootFields).map(([axis,value])=><label key={axis}><span>{({u:'X offset — right',v:'Y offset — up',normal:'Z offset — forward'})[axis]}</span><span><input type="number" step="any" aria-label={({'u':'X offset — right','v':'Y offset — up','normal':'Z offset — forward'})[axis]} value={value} disabled={dragging} onChange={event=>{
  const next={...rootFields,[axis]:event.target.value};setRootFields(next);
  if(Object.values(next).every(v=>v.trim()&&Number.isFinite(Number(v))))setRootDraft(old=>old?withPosition(old,{u:Number(next.u),v:Number(next.v),normal:Number(next.normal)}):null);
 }}/><small>mm</small></span></label>);
 return <section className="assembly-workspace" aria-label="Interactive assembly workspace">
  <AssemblyViewer ref={view} projectId={projectId} live={live} entries={effective} panels={available} paint={paint} wire={wire} onReadyChange={setReady}
   selection={selection} previewOnly={editing||addOpen} onFacePicked={facePicked} onFaceMessage={faceMessage} onValidation={setValidation}
   activeId={active} hiddenIds={hidden} moving={moving} onSelect={select} onMove={onMove} onDrag={setDragging} onCatalog={receiveCatalog} onPlaced={setPlacement}>
   <div className="asm-workspace-toolbar">
    <button className="primary" disabled={!!draft||!!rootDraft||!!legacyDraft||dragging||entries.length>=100||!!entries.length&&!ready} onClick={()=>setAddOpen(!addOpen)}><Plus size={15}/>{entries.length?'Add Panel':'Select First Panel'}</button>
    <button aria-label="Undo" title="Undo last saved assembly action" disabled={editing||!history.past.length} onClick={()=>travel('undo')}><Undo2 size={15}/></button>
    <button aria-label="Redo" title="Redo assembly action" disabled={editing||!history.future.length} onClick={()=>travel('redo')}><Redo2 size={15}/></button>
    <button aria-label="Panels" aria-expanded={listOpen} onClick={()=>setListOpen(!listOpen)}><List size={15}/><span>{effective.length}</span></button>
    <button aria-label="Fit Assembly" disabled={!effective.length} onClick={()=>view.current?.fit()}><Maximize2 size={15}/></button>
    <select aria-label="Assembly camera view" defaultValue="iso" onChange={e=>view.current?.fit(e.target.value)}><option value="iso">Isometric</option><option value="front">Front</option><option value="top">Top</option><option value="side">Side</option></select>
   </div>
   {(notice||storageError||stale)&&<div className="asm-workspace-notice" role="alert">{stale?'Saved assembly changed in another window. Cancel and reopen this edit before applying.':storageError||notice}</div>}
   {listOpen&&<aside className="asm-panel-list" aria-label="Assembly panels"><header><strong>Panels</strong><button aria-label="Close panel list" onClick={()=>setListOpen(false)}><X size={14}/></button></header>
    {effective.map(e=><div key={e.id} className={e.id===active?'selected':''}><button onClick={()=>select(e.id)}><b>{e.label}</b><span>{filename(e)}<small>{isNew&&draft?.movingEntryId===e.id?'Preview · not connected':e.targetId?`Connected to ${title(e.targetId)}`:'Reference panel'}</small></span></button><button aria-label={`${hidden.includes(e.id)?'Show':'Hide'} Panel ${e.label}`} disabled={editing} onClick={()=>setHidden(old=>old.includes(e.id)?old.filter(id=>id!==e.id):[...old,e.id])}>{hidden.includes(e.id)?<EyeOff size={14}/>:<Eye size={14}/>}</button></div>)}
    <p>Visibility affects inspection only. Exports include every assembled panel.</p><button onClick={()=>setHidden([])}>Show all panels</button><label><input type="checkbox" checked={wire} onChange={e=>setWire(e.target.checked)}/>Wireframe (mesh triangles)</label><label><input type="checkbox" checked={paint} onChange={e=>setPaint(e.target.checked)}/>Distinguish painted face</label><button disabled={!ready||editing||checking} onClick={async()=>{setChecking(true);try{const clashes=await view.current?.runClash();setNotice(clashes?.length?`${clashes.length} intersecting panel pairs. Correct the layout before export.`:live?'CAD check complete: no solid intersections.':'Sample mesh check: no sampled intersections. Connect the CAD service for exact solid validation.');}catch(error){setNotice((error as Error).message);}finally{setChecking(false);}}}>{checking?'Checking…':'Check clearances'}</button>
   </aside>}
   {addOpen&&<section className="asm-context asm-add-picker" aria-label="Choose a panel"><header><strong>{entries.length?`Add Panel ${nextLabel(entries)}`:'Select First Panel'}</strong><button aria-label="Close panel picker" onClick={()=>{setAddOpen(false);if(seed)clearEdit();}}><X size={15}/></button></header>
    <p>{entries.length?'Choose a drawing, then select its connection sides in the viewer.':'Choose a processed drawing to become Panel A.'}</p>
    <div className="asm-available-panels">{available.filter(p=>repeat||!entries.some(e=>e.panelId===p.id)).map(p=><button key={p.id} disabled={!live} onClick={()=>add(p)}>{p.filename}<small>Ready · folded CAD solid</small></button>)}</div>
    {!available.length&&<p>No approved panel solids are available in this project.</p>}
    {!!entries.length&&<label><input type="checkbox" checked={repeat} onChange={e=>setRepeat(e.target.checked)}/>Include drawings already added</label>}
    {!live&&<p>Connect the CAD service to create verified face connections. Existing sample layouts remain viewable.</p>}
   </section>}
   {seed&&!addOpen&&<div className="asm-context" data-unsaved-assembly="true"><strong>{title(seed.id)} · Choose connection side</strong><p>Hover and click a planar surface. Then choose the panel to add.</p><button onClick={cancel}>Cancel</button></div>}
   {selected&&!editing&&!addOpen&&<div className="asm-selection-toolbar"><strong>{title(selected.id)}</strong><span>{selected.targetId?`→ ${title(selected.targetId)}`:'Reference'}</span>
    <button disabled={!live||hidden.includes(selected.id)} onClick={()=>startEdit('move')}><Move3D size={15}/>Move</button>
    {selected.connection&&<button disabled={!live||hidden.includes(selected.id)} onClick={()=>startEdit('rotate')}><RotateCw size={15}/>Rotate</button>}
    <button disabled={!live} onClick={()=>startEdit('connect')}><Link2 size={15}/>{selected.connection?'Connection':'Connect'}</button>
    <button title="Remove selected panel and its dependent branch" aria-label="Remove selected panel" onClick={()=>{if(window.confirm(`Remove ${title(selected.id)} and its connected descendants?`)){commit(removeAssemblyBranch(entries,selected.id));setActive(null);}}}><Trash2 size={15}/></button>
    {selected.connection&&<small>Gap {(selected.gap+selected.connection.normalOffset).toFixed(2)} mm · X {selected.connection.offsetU.toFixed(2)} · Y {selected.connection.offsetV.toFixed(2)} · Z {selected.connection.normalOffset.toFixed(2)} mm</small>}
   </div>}
   {draft&&<AssemblyConnectionEditor draft={draft} entries={effective} catalogs={catalogs} valid={valid} connecting={isNew} picking={mode==='connect'} rotating={mode==='rotate'} dragging={dragging} onChange={setDraft} onApply={apply} onCancel={cancel}/>}
   {rootDraft&&<section className="asm-context asm-position-card" data-position-popup="true" data-unsaved-assembly="true" aria-label="Root position controls"><header><strong>{title(rootDraft.id)} · Move assembly</strong></header><div className="asm-inline-values">{renderNumbers()}</div><p>Moves the connected assembly together. X = world X, Y = world Z (up), Z = world −Y (forward).</p><p>Drag · 1 mm steps · Shift for 0.1 mm. Exact typed values are unrestricted.</p>{rootError&&<p role="alert">Enter complete, finite offsets.</p>}<footer><button disabled={dragging} onClick={()=>{const original=entries.find(e=>e.id===rootDraft.id)!;setRootDraft(original);const p=positionValues(original);setRootFields({u:String(p.u),v:String(p.v),normal:String(p.normal)});}}>Reset position</button><button disabled={dragging} onClick={cancel}>Cancel</button><button className="primary" disabled={!valid||rootError} onClick={apply}>Apply position</button></footer></section>}
   {legacyDraft&&<section className="asm-context asm-legacy-card" data-unsaved-assembly="true" aria-label="Saved envelope layout"><header><strong>{title(legacyDraft.id)} · Saved layout</strong></header><p>This layout uses global envelope gaps. Its geometry is preserved. Choose Connect to select actual surfaces for the drag controller.</p><label>Reference panel<select aria-label="Envelope reference panel" value={legacyDraft.targetId!} onChange={e=>setLegacyDraft({...legacyDraft,targetId:e.target.value})}>{entries.slice(0,entries.findIndex(e=>e.id===legacyDraft.id)).map(e=><option key={e.id} value={e.id}>Panel {e.label}</option>)}</select></label><label>Moving side<select aria-label="Envelope moving side" value={legacyDraft.myFace} onChange={e=>setLegacyDraft({...legacyDraft,myFace:e.target.value as Face})}>{sides.map(([face,label])=><option key={face} value={face}>{label}</option>)}</select></label><label>Reference side<select aria-label="Envelope reference side" value={legacyDraft.targetFace!} onChange={e=>setLegacyDraft(setAssemblyTargetFace(legacyDraft,e.target.value as Face))}>{sides.map(([face,label])=><option key={face} value={face}>{label}</option>)}</select></label><AssemblySpacing entry={legacyDraft} onChange={setLegacyDraft} onValidityChange={setLegacyValid}/><footer><button onClick={cancel}>Cancel</button><button className="primary" disabled={!valid||!legacyValid} onClick={apply}>Apply position</button></footer></section>}
   <div className="asm-mode-indicator">{dragging?'Moving · release to check CAD clearances':draft?.pick?`Select ${draft.pick==='reference'?'reference':'moving'} face · click a surface`:moving?'Move · local X / Y / Z':mode==='rotate'?'Rotate about connection normal':'Select · click a panel'}{editing&&<span>Unsaved preview</span>}</div>
  </AssemblyViewer>
 </section>;
}
