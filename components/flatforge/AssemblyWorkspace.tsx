'use client';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Plus,Undo2,Redo2,List,Move3D,RotateCw,Link2,Maximize2,X,Eye,EyeOff,Trash2,Save} from 'lucide-react';
import AssemblyViewer,{type AssemblyViewerHandle} from './AssemblyViewer';
import AssemblyConnectionEditor from './AssemblyConnectionEditor';
import {useAssemblyPopupDrag} from './useAssemblyPopupDrag';
import {useProjectAssembly} from './useProjectAssembly';
import type {AssemblyEntry,AssemblySide,Panel,CadFaceReference} from './types';
import type {CadFaceCatalog,CadPlacement} from './assembly-cad';
import {previewFaceDraft,updateFaceDraft,type FaceDraft,type FaceRole,type FaceSelection} from './face-connection-state';
import {DEFAULT_ASSEMBLY_GAP_MM,removeAssemblyBranch} from './assembly-geometry';
import {connectionOccupants,descendants,namedEntries,nextLabel,stagedPanel,positionValues,freezePlacements,moveIndependently,recordAction,type PositionValues,type AssemblyHistory} from './assembly-workspace-state';

type MoveDraft={id:string;base:AssemblyEntry[];preview:AssemblyEntry[];group:boolean;rotate:boolean;fields:{u:string;v:string;normal:string;turn:string}};
export default function AssemblyWorkspace({projectId,live,panels}:{projectId:string;live:boolean;panels:Panel[]}){
 const store=useProjectAssembly(projectId,live),entries=useMemo(()=>namedEntries(store.entries),[store.entries]);
 const workspace=useRef<HTMLElement|null>(null);useAssemblyPopupDrag(workspace,projectId);
 useEffect(()=>{
  const root=workspace.current,toolbar=root?.querySelector<HTMLElement>('.asm-workspace-toolbar');if(!root||!toolbar)return;
  const update=()=>root.style.setProperty('--assembly-toolbar-bottom',`${toolbar.offsetTop+toolbar.offsetHeight+8}px`);
  const observer=new ResizeObserver(update);observer.observe(toolbar);update();return()=>observer.disconnect();
 },[]);
 const view=useRef<AssemblyViewerHandle|null>(null);
 const [active,setActive]=useState<string|null>(null),[listOpen,setListOpen]=useState(false),[addOpen,setAddOpen]=useState(false),[repeat,setRepeat]=useState(false);
 const [connectMode,setConnectMode]=useState<{from?:{id:string;side:AssemblySide};to?:{id:string;side:AssemblySide};pick:'from'|'to'}|null>(null);
 const [draft,setDraft]=useState<FaceDraft|null>(null),[base,setBase]=useState<AssemblyEntry[]>([]),[isNew,setIsNew]=useState(false);
 const [move,setMove]=useState<MoveDraft|null>(null),[collapsed,setCollapsed]=useState(false);
 const [catalogs,setCatalogs]=useState<Record<string,CadFaceCatalog>>({}),[placement,setPlacement]=useState<CadPlacement|null>(null);
 const [validation,setValidation]=useState({key:'',valid:false,token:null as string|null}),[ready,setReady]=useState(false),[dragging,setDragging]=useState(false);
 const [hidden,setHidden]=useState<string[]>([]),[wire,setWire]=useState(false),[paint,setPaint]=useState(false),[notice,setNotice]=useState('');
 const [history,setHistory]=useState<AssemblyHistory>({past:[],future:[]});
 const editing=!!draft||!!move||!!connectMode;
 const effective=draft?(isNew?[...base,draft.preview??draft.original]:base.map(e=>e.id===draft.movingEntryId?(draft.preview??draft.original):e)):move?.preview??entries;
 const key=JSON.stringify({entries:effective,insertId:draft&&previewFaceDraft(draft)?draft.movingEntryId:undefined,insertBranchId:draft?.insertBranchId}),valid=validation.key===key&&validation.valid&&!dragging;
 const needsChoices=!!draft&&(!!draft.pick||connectionOccupants(effective,draft.movingEntryId,draft.referenceEntryId,draft.sides?.reference).length>1);
 const selected=effective.find(e=>e.id===active),moveError=move&&Object.values(move.fields).some(v=>!v.trim()||!Number.isFinite(Number(v)));
 const moving=!!move&&!move.rotate&&!moveError&&!store.saving;
 const selection:FaceSelection|null=draft;
 const title=(id:string)=>`Panel ${effective.find(e=>e.id===id)?.label??'?'}`;
 const filename=(e:AssemblyEntry)=>panels.find(p=>p.id===e.panelId)?.filename??'Unavailable drawing';
 const available=panels.filter(p=>p.status==='PASS'&&p.artifacts.includes('panel.glb')&&p.artifacts.includes('panel.step'));
 function commit(next:AssemblyEntry[]){setHistory(h=>recordAction(h,entries));store.setEntries(next);}
 function travel(direction:'undo'|'redo'){
  if(editing||dragging||store.saving)return;const from=direction==='undo'?history.past:history.future;if(!from.length)return;
  const next=from[from.length-1];store.setEntries(next);
  setHistory(direction==='undo'?{past:history.past.slice(0,-1),future:[...history.future,entries]}:{past:[...history.past,entries],future:history.future.slice(0,-1)});
  if(!next.some(e=>e.id===active))setActive(null);
 }
 function clearEdit(){setConnectMode(null);setDraft(null);setMove(null);setIsNew(false);setAddOpen(false);setNotice('');setCollapsed(false);}
 function cancel(){if(isNew)setActive(entries.at(-1)?.id??null);clearEdit();}
 function select(id:string|null){if(connectMode){setActive(id);return;}if(editing){if(id!==active)setNotice('Apply or cancel the current preview before selecting another panel.');return;}setActive(id);setAddOpen(false);setNotice('');}
 function startMove(group=false,rotate=false){
  if(!selected||!placement||!ready||store.saving)return;
  try{const frozen=freezePlacements(entries,placement),row=frozen.find(e=>e.id===selected.id)!,p=positionValues(row);
   setMove({id:row.id,base:frozen,preview:frozen,group,rotate,fields:{u:String(p.u),v:String(p.v),normal:String(p.normal),turn:String(row.pose!.turn)}});setCollapsed(false);setNotice('');
  }catch(error){setNotice((error as Error).message);}
 }
 function beginConnection(panel:Panel,id:string,newPanel:boolean){
  if(!placement||!ready)return;
  try{
   const old=entries.find(e=>e.id===id);
   const frozen=freezePlacements(entries,placement),next=stagedPanel(frozen,panel.id,id,placement,old?.gap??DEFAULT_ASSEMBLY_GAP_MM);
   const reference=newPanel?(active??entries[0].id):old!.targetId!;
   const original={...next.original,label:old?.label??next.original.label,revision:panel.revision};
   setBase(frozen);setDraft({...next,original,preview:original,referenceEntryId:reference,pick:null,sides:{}});
   setIsNew(newPanel);setActive(id);setAddOpen(false);setHidden([]);setNotice('');
  }catch(error){setNotice((error as Error).message);}
 }
 function add(panel:Panel){
  if(store.saving)return;const id=crypto.randomUUID();
  if(!entries.length){commit([{id,label:'A',revision:panel.revision,panelId:panel.id,myFace:'-X',targetId:null,targetFace:null,gap:DEFAULT_ASSEMBLY_GAP_MM}]);setActive(id);setAddOpen(false);return;}
  beginConnection(panel,id,true);
 }
 const receiveCatalog=useCallback((catalog:CadFaceCatalog)=>setCatalogs(old=>({...old,[catalog.entryId]:catalog})),[]);
 const facePicked=useCallback((role:FaceRole,face:CadFaceReference)=>setDraft(old=>old?updateFaceDraft(old,{[role]:face,pick:null,message:''}):null),[]);
 const faceMessage=useCallback((message:string)=>setNotice(message),[]);
 function withSide(current:FaceDraft,role:FaceRole,side:AssemblySide){
  const id=role==='reference'?current.referenceEntryId:current.movingEntryId,catalog=catalogs[id],region=catalog?.sides?.[side];if(!catalog||!region)return current;
  const chosen=region.candidates.find(c=>c.faceId===region.automatic);
  const next=updateFaceDraft(current,{insertBranchId:undefined,sides:{...current.sides,[role]:side},sideNames:{...current.sideNames,[role]:side},allowed:{...current.allowed,[role]:region.candidates.map(c=>c.faceId)},
   [role]:chosen?{faceId:chosen.faceId,sourceSha:catalog.sourceSha,point:chosen.point}:undefined,pick:!chosen&&region.candidates.length?role:null,message:chosen?'':region.message});
  if(!next.reference&&next.allowed?.reference?.length)next.pick='reference';
  else if(!next.moving&&next.allowed?.moving?.length)next.pick='moving';
  return next;
 }
 function chooseSide(role:FaceRole,side:AssemblySide){if(draft)setDraft(withSide(draft,role,side));}
 function clickSide(id:string,side:AssemblySide){
  if(!connectMode){if(draft){const role=id===draft.referenceEntryId?'reference':id===draft.movingEntryId?'moving':null;if(role)chooseSide(role,side);}else select(id);return;}
  const next={...connectMode,[connectMode.pick]:{id,side},pick:'to' as const};
  if(next.from?.id===next.to?.id){setNotice('Choose two different panels.');return;}
  setConnectMode(next);setDraft(null);setNotice('');
  if(!next.from||!next.to)return;
  if(descendants(entries,next.to.id).has(next.from.id)){setNotice('This would create a connection cycle. Choose an unrelated reference panel or reverse the selection.');return;}
  if(!placement)return;
  const movingEntry=entries.find(e=>e.id===next.to!.id)!;
  const frozen=base,staged=stagedPanel(frozen,movingEntry.panelId,movingEntry.id,placement,movingEntry.gap??DEFAULT_ASSEMBLY_GAP_MM);
  let nextDraft={...staged,original:{...staged.original,label:movingEntry.label,revision:movingEntry.revision},referenceEntryId:next.from.id,pick:null,sides:{}} as FaceDraft;
  nextDraft=withSide(nextDraft,'reference',next.from.side);nextDraft=withSide(nextDraft,'moving',next.to.side);
  setBase(frozen);setDraft(nextDraft);setIsNew(false);setActive(next.to.id);setHidden([]);
 }
 const updateMove=useCallback((fields:MoveDraft['fields'])=>setMove(old=>{
  if(!old)return old;let preview=old.preview;
  if(Object.values(fields).every(v=>v.trim()&&Number.isFinite(Number(v)))){
   preview=moveIndependently(old.base,old.id,{u:Number(fields.u),v:Number(fields.v),normal:Number(fields.normal)},old.group);
   preview=preview.map(e=>e.id===old.id?{...e,pose:{...e.pose!,turn:Number(fields.turn)}}:e);
  }return {...old,fields,preview};
 }),[]);
 const onMove=useCallback((p:PositionValues)=>setMove(old=>old?{...old,fields:{...old.fields,u:String(p.u),v:String(p.v),normal:String(p.normal)},preview:moveIndependently(old.base,old.id,p,old.group)}:null),[]);
 function apply(){
  if(!valid||store.saving)return;
  if(move&&!moveError){commit(move.preview);clearEdit();}
  else if(draft&&previewFaceDraft(draft)&&placement){const labels=new Map(effective.map(e=>[e.id,e.label]));commit(freezePlacements(placement.entries,placement).map(e=>({...e,label:labels.get(e.id)})));clearEdit();}
 }
 async function save(){
  if(editing||store.saving||!store.loaded||entries.length&&!valid)return;
  // Labels are UI metadata. The API binds every engineering field to this exact
  // checked matrix snapshot; saving does not run placement again.
  await store.save(placement,validation.token);
 }
 return <section ref={workspace} className="assembly-workspace" aria-label="Interactive assembly workspace" data-connect-mode={!!connectMode} data-unsaved-assembly={store.dirty||editing?'true':undefined} aria-busy={store.saving}>
   {(notice||store.error||store.message||!store.loaded)&&<div className="asm-workspace-notice" role={store.error?'alert':'status'}>{store.error||notice||store.message||'Loading saved assembly…'}{store.error&&<button onClick={()=>{if((store.dirty||editing)&&!window.confirm('Discard current edits and reload the saved project assembly?'))return;clearEdit();setHistory({past:[],future:[]});store.reload();}}>Reload saved assembly</button>}</div>}
  <AssemblyViewer ref={view} projectId={projectId} live={live} entries={effective} panels={available} paint={paint} wire={wire} onReadyChange={setReady}
   insertId={draft&&previewFaceDraft(draft)?draft.movingEntryId:undefined} insertBranchId={draft?.insertBranchId} onSideSelected={clickSide} sideSelectionMode={!!connectMode} sideTargets={connectMode?[connectMode.from&&{...connectMode.from,role:'from' as const},connectMode.to&&{...connectMode.to,role:'to' as const}].filter((v):v is {id:string;side:AssemblySide;role:'from'|'to'}=>!!v):[]} selection={selection} previewOnly={editing||addOpen} onFacePicked={facePicked} onFaceMessage={faceMessage} onValidation={setValidation}
   activeId={active} hiddenIds={hidden} moving={moving} moveGroup={move?.group??false} onSelect={select} onMove={onMove} onDrag={setDragging} onCatalog={receiveCatalog} onPlaced={setPlacement}>
   <div className="asm-workspace-toolbar">
    <button aria-label="Connect panels in viewer" aria-pressed={!!connectMode} disabled={!live||!ready||store.saving||editing||entries.length<2} onClick={()=>{setBase(freezePlacements(entries,placement!));setConnectMode({pick:'from'});setAddOpen(false);setNotice('');}}><Link2 size={15}/>Connect</button>
    <button className="primary" disabled={!store.loaded||store.saving||editing||dragging||entries.length>=100||!!entries.length&&!ready} onClick={()=>setAddOpen(!addOpen)}><Plus size={15}/>{entries.length?'Add Panel':'Select First Panel'}</button>
    <button className="primary" disabled={!store.loaded||!live||store.saving||editing||!!entries.length&&!valid} onClick={()=>void save()}><Save size={15}/>{store.saving?'Saving…':'Save Assembly'}</button>
    <button aria-label="Undo" disabled={editing||store.saving||!history.past.length} onClick={()=>travel('undo')}><Undo2 size={15}/></button>
    <button aria-label="Redo" disabled={editing||store.saving||!history.future.length} onClick={()=>travel('redo')}><Redo2 size={15}/></button>
    <button aria-label="Panels" aria-expanded={listOpen} onClick={()=>setListOpen(!listOpen)}><List size={15}/><span>{effective.length}</span></button>
    <button aria-label="Fit Assembly" disabled={!effective.length} onClick={()=>view.current?.fit()}><Maximize2 size={15}/></button>
    <select aria-label="Assembly camera view" defaultValue="iso" onChange={e=>view.current?.fit(e.target.value)}><option value="iso">Isometric</option><option value="front">Front</option><option value="top">Top</option><option value="side">Side</option></select>
   </div>
   {listOpen&&<aside className="asm-panel-list" aria-label="Assembly panels"><header><strong>Panels</strong><button aria-label="Close panel list" onClick={()=>setListOpen(false)}><X size={14}/></button></header>
    {effective.map(e=><div key={e.id} className={e.id===active?'selected':''}><button onClick={()=>select(e.id)}><b>{e.label}</b><span>{filename(e)}<small>{isNew&&draft?.movingEntryId===e.id?'Connection preview':e.targetId?`Initially connected to ${title(e.targetId)}`:'First panel'}</small></span></button><button aria-label={`${hidden.includes(e.id)?'Show':'Hide'} Panel ${e.label}`} disabled={editing} onClick={()=>setHidden(old=>old.includes(e.id)?old.filter(id=>id!==e.id):[...old,e.id])}>{hidden.includes(e.id)?<EyeOff size={14}/>:<Eye size={14}/>}</button></div>)}
    <p>Visibility affects inspection only. Exports include all panels.</p><button onClick={()=>setHidden([])}>Show all panels</button><label><input type="checkbox" checked={wire} onChange={e=>setWire(e.target.checked)}/>Wireframe (mesh triangles)</label><label><input type="checkbox" checked={paint} onChange={e=>setPaint(e.target.checked)}/>Distinguish painted face</label>
   </aside>}
   {addOpen&&<section className="asm-context asm-add-picker" aria-label="Choose a panel"><header><strong>{entries.length?`Add Panel ${nextLabel(entries)}`:'Select First Panel'}</strong><button aria-label="Close panel picker" onClick={()=>setAddOpen(false)}><X size={15}/></button></header>
    <p>{entries.length?'Choose a drawing, then choose the two connection sides.':'Choose a processed drawing to become Panel A.'}</p>
    <div className="asm-available-panels">{available.filter(p=>repeat||!entries.some(e=>e.panelId===p.id)).map(p=><button key={p.id} disabled={!live} onClick={()=>add(p)}>{p.filename}<small>Ready · folded CAD solid</small></button>)}</div>
    {!available.length&&<p>No approved panel solids are available.</p>}{!!entries.length&&<label><input type="checkbox" checked={repeat} onChange={e=>setRepeat(e.target.checked)}/>Include drawings already added</label>}
    {!live&&<p>Connect the CAD service to create and save assemblies.</p>}
   </section>}
   {selected&&!editing&&!addOpen&&<div className="asm-selection-toolbar"><strong>{title(selected.id)}</strong><span>{selected.targetId?`Initially → ${title(selected.targetId)}`:'First panel'}</span>
    <button disabled={!live||!ready||store.saving||hidden.includes(selected.id)} onClick={()=>startMove()}><Move3D size={15}/>Move</button>
    <button disabled={!live||!ready||store.saving} onClick={()=>startMove(true)}>Move branch</button>
    {selected.connection&&<button disabled={!live||!ready||store.saving} onClick={()=>startMove(false,true)}><RotateCw size={15}/>Rotate</button>}
    <button disabled={!live||!ready||store.saving} onClick={()=>{if(!selected.targetId){setAddOpen(true);return;}const panel=available.find(p=>p.id===selected.panelId);if(panel)beginConnection(panel,selected.id,false);}}><Link2 size={15}/>{selected.targetId?'Reconnect':'Connect'}</button>
    <button disabled={store.saving} title="Remove panel and its connection branch" aria-label="Remove selected panel" onClick={()=>{if(window.confirm(`Remove ${title(selected.id)} and its connection branch?`)){commit(removeAssemblyBranch(entries,selected.id));setActive(null);}}}><Trash2 size={15}/></button>
    {selected.sides&&<small>{selected.sides.reference} → {selected.sides.moving} · Initial gap {selected.gap.toFixed(2)} mm · independent positioning</small>}
   </div>}
   {connectMode&&!needsChoices&&<section className="asm-context" aria-label="Interactive connection"><header><strong>Connect panel sides</strong></header>
    <p>{draft?'Review the connection preview, then join.':connectMode.pick==='from'?'Select the first panel side.':'Select a side on the second panel.'}</p>
    <button onClick={()=>{setDraft(null);setConnectMode({...connectMode,pick:'from'});}}>From: {connectMode.from?`${title(connectMode.from.id)} — ${connectMode.from.side}`:'Select side'}</button>
    <button onClick={()=>{setDraft(null);setConnectMode({...connectMode,pick:'to'});}}>To: {connectMode.to?`${title(connectMode.to.id)} — ${connectMode.to.side}`:'Select side'}</button>
    {draft?.message&&<p>{draft.message}</p>}
    <footer><button onClick={cancel}>Cancel</button><button className="primary" disabled={!draft||!valid||!!draft.pick} onClick={apply}>Join Panels</button></footer>
   </section>}
   {draft&&(!connectMode||needsChoices)&&<AssemblyConnectionEditor draft={draft} entries={effective} catalogs={catalogs} valid={valid} connecting={isNew} insertion={placement?.insertion} onBranch={id=>setDraft(old=>old?{...old,insertBranchId:id}:null)} onSide={chooseSide}
    onReference={id=>setDraft(updateFaceDraft(draft,{referenceEntryId:id,reference:undefined,insertBranchId:undefined,sides:{moving:draft.sides?.moving},sideNames:{moving:draft.sides?.moving},allowed:{moving:draft.allowed?.moving},pick:null,message:''}))}
    onGap={gap=>setDraft(updateFaceDraft(draft,{fields:{...draft.fields,gap}}))} onApply={apply} onCancel={cancel}/>}
   {move&&<section className="asm-context asm-position-card" data-position-popup="true" data-unsaved-assembly="true" aria-label="Panel position controls"><header><strong>{title(move.id)} · {move.rotate?'Rotate':move.group?'Move branch':'Move panel'}</strong><button aria-label={collapsed?'Expand position controls':'Collapse position controls'} onClick={()=>setCollapsed(!collapsed)}>{collapsed?'+':'−'}</button></header>
    {collapsed?<p>X {move.fields.u} · Y {move.fields.v} · Z {move.fields.normal} mm</p>:<>
    <div className="asm-inline-values">{(move.rotate?[['turn','Rotation','°']]:[['u','X offset — right','mm'],['v','Y offset — up','mm'],['normal','Z offset — forward','mm']]).map(([axis,label,unit])=><label key={axis}><span>{label}</span><span><input type="number" step="any" aria-label={label} value={move.fields[axis as keyof MoveDraft['fields']]} disabled={dragging} onChange={e=>updateMove({...move.fields,[axis]:e.target.value})}/><small>{unit}</small></span></label>)}</div>
    <p>{move.group?'Moves this panel and its connection descendants.':'Moves only this panel. Other panels stay fixed.'} {move.rotate?'Rotation is about its initial connection normal.':'X = world X, Y = world Z (up), Z = world −Y (forward).'}</p><p>Connections set initial alignment. Signed offsets can move through or beyond other panels.</p>
    {!move.rotate&&<p>Drag · 1 mm steps · Shift for 0.1 mm. Type any exact value.</p>}{moveError&&<p role="alert">Enter complete, finite values.</p>}
    <footer><button disabled={dragging} onClick={()=>{const original=move.base.find(e=>e.id===move.id)!,p=positionValues(original);setMove({...move,preview:move.base,fields:{u:String(p.u),v:String(p.v),normal:String(p.normal),turn:String(original.pose!.turn)}});}}>Reset position</button><button disabled={dragging} onClick={cancel}>Cancel</button><button className="primary" disabled={!valid||!!moveError} onClick={apply}>Apply position</button></footer></>}
   </section>}
   <div className="asm-mode-indicator">{dragging?'Moving · mm':draft?.pick?'Choose a highlighted connection region':moving?move?.group?'Move branch · X / Y / Z':'Move panel · X / Y / Z':'Select · click a panel'}{(editing||store.dirty)&&<span>Unsaved changes</span>}</div>
  </AssemblyViewer>
 </section>;
}
