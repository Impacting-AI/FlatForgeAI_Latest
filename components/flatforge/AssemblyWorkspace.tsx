'use client';
import {Matrix4} from 'three';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Plus,Undo2,Redo2,List,Move3D,RotateCw,Link2,Maximize2,X,Trash2,Save,Focus} from 'lucide-react';
import AssemblyMateCard from './AssemblyMateCard';
import AssemblyPanelList from './AssemblyPanelList';
import {baseId,chooseMoving,currentPose,mateTitle,measureFaces,motionText,newSession,panelStatus,sessionMate,withMate,withoutMate,withoutTargets,type MateSession} from './plane-mates';
import AssemblyViewer,{type AssemblyViewerHandle} from './AssemblyViewer';
import AssemblyConnectionEditor from './AssemblyConnectionEditor';
import AssemblyMateEditor from './AssemblyMateEditor';
import {useAssemblyPopupDrag} from './useAssemblyPopupDrag';
import {useProjectAssembly} from './useProjectAssembly';
import type {AssemblyEntry,AssemblySide,Panel,CadFaceReference} from './types';
import type {CadFaceCatalog,CadPlacement} from './assembly-cad';
import {orderMateSelection,beginFaceDraft,previewFaceDraft,updateFaceDraft,type FaceDraft,type FaceRole,type FaceSelection} from './face-connection-state';
import {DEFAULT_ASSEMBLY_GAP_MM,removeAssemblyBranch} from './assembly-geometry';
import {connectionOccupants,descendants,namedEntries,nextLabel,stagedPanel,positionValues,freezePlacements,suspendMovedMates,moveIndependently,recordAction,type PositionValues,type AssemblyHistory} from './assembly-workspace-state';

const MATE_PARKING_MM=250;
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
 const [active,setActive]=useState<string|null>(null),[listOpen,setListOpen]=useState(true),[addOpen,setAddOpen]=useState(false),[repeat,setRepeat]=useState(false);
 const [mateSelection,setMateSelection]=useState<FaceSelection|null>(null),[park,setPark]=useState(true);
 const [connectMode,setConnectMode]=useState<{from?:{id:string;side:AssemblySide};to?:{id:string;side:AssemblySide};pick:'from'|'to'}|null>(null);
 const [draft,setDraft]=useState<FaceDraft|null>(null),[base,setBase]=useState<AssemblyEntry[]>([]),[isNew,setIsNew]=useState(false);
 const [move,setMove]=useState<MoveDraft|null>(null),[collapsed,setCollapsed]=useState(false);
 const [catalogs,setCatalogs]=useState<Record<string,CadFaceCatalog>>({}),[placement,setPlacement]=useState<CadPlacement|null>(null);
 const [validation,setValidation]=useState({key:'',valid:false,token:null as string|null,checking:false,message:'',warning:''}),[ready,setReady]=useState(false),[dragging,setDragging]=useState(false);
 const [hidden,setHidden]=useState<string[]>([]),[wire,setWire]=useState(false),[paint,setPaint]=useState(false),[notice,setNotice]=useState('');
 const [history,setHistory]=useState<AssemblyHistory>({past:[],future:[]});
 // Default mates that hit folded returns raise the gap on their own until the CAD check passes.
 // Any manual edit hands control back to the user.
 const auto=useRef({on:false,bumped:0}),latest=useRef<{key:string;gap:number;ids:string[];bounds?:CadPlacement['bounds']}|null>(null);
 const [session,setSession]=useState<MateSession|null>(null),[mateOnAdd,setMateOnAdd]=useState(true);
 const catalogRef=useRef<Record<string,CadFaceCatalog>>({}),pendingMate=useRef<{id:string;label:string}|null>(null);
 const onValidation=useCallback((r:{key:string;valid:boolean;token:string|null;checking:boolean;message:string;warning:string})=>{
  setValidation(r);const now=latest.current;
  if(!auto.current.on||!now||r.key!==now.key||r.checking)return;
  if(r.valid){if(auto.current.bumped){setNotice(`Plane gap set to ${now.gap} mm automatically so the panels' folded returns clear each other. Edit Plane gap to change it.`);}auto.current.on=false;return;}
  if(!/intersect/i.test(r.message)){auto.current.on=false;return;}
  const extent=(id:string)=>{const b=now.bounds?.[id];return b?Math.max(...b.max.map((v,i)=>v-b.min[i])):0};
  const safe=Math.ceil(now.ids.reduce((sum,id)=>sum+extent(id),0))+1;
  const next=[5,10,25,50,100,250,500,1000,safe].filter(g=>g<=safe&&g>now.gap).sort((a,b)=>a-b)[0];
  if(next===undefined){auto.current.on=false;setNotice('No collision-free gap was found automatically. Pick different faces or change the in-plane rotation.');return;}
  auto.current.bumped++;setDraft(old=>old?updateFaceDraft(old,{fields:{...old.fields,gap:String(next)}}):old);
 },[]);
 const editing=!!draft||!!move||!!connectMode||!!mateSelection||!!session;
 const candidate=session?sessionMate(session):null;
 const legacy=mateSelection?.pick&&base.length?base:draft?(isNew?[...base,draft.preview??draft.original]:base.map(e=>e.id===draft.movingEntryId?(draft.preview??draft.original):e)):move?.preview??entries;
 const effective=session?(candidate&&session.start?withMate(entries,session.moving!.entryId,candidate,session.start):entries):legacy;
 const mateCheckId=session?(candidate?session.moving!.entryId:undefined):draft?.mate&&!mateSelection?.pick&&previewFaceDraft(draft)?draft.movingEntryId:undefined;
 const key=JSON.stringify({entries:effective,mateCheckId,insertId:draft&&!draft.mate&&previewFaceDraft(draft)?draft.movingEntryId:undefined,insertBranchId:draft?.insertBranchId}),valid=validation.key===key&&validation.valid&&!dragging;
 const solved=validation.key===key&&!validation.checking;
 const needsChoices=!!draft&&(!!draft.pick||connectionOccupants(effective,draft.movingEntryId,draft.referenceEntryId,draft.sides?.reference).length>1);
 const selected=effective.find(e=>e.id===active),moveError=move&&Object.values(move.fields).some(v=>!v.trim()||!Number.isFinite(Number(v)));
 const moving=!!move&&!move.rotate&&!moveError&&!store.saving;
 const selection:FaceSelection|null=session?{anyPanel:true,geometry:'face',alignment:'top',referenceEntryId:session.target?.entryId??'',movingEntryId:session.moving?.entryId??'',reference:session.target?.face,moving:session.moving?.face,pick:session.pick==='target'?'reference':session.pick}
  :mateSelection?{...mateSelection,...(draft?{reference:draft.reference,moving:draft.moving}:{}),anyPanel:true}:draft;
 const fileNames=Object.fromEntries(effective.map(e=>[e.id,panels.find(p=>p.id===e.panelId)?.filename??'Unavailable drawing']));
 const selectedReport=selected?placement?.constraints?.[selected.id]:undefined;
 const followers=effective.filter(e=>e.targetId!==null),definedCount=followers.filter(e=>panelStatus(e,placement?.constraints?.[e.id]).tone==='defined').length;
 const title=(id:string)=>`Panel ${effective.find(e=>e.id===id)?.label??'?'}`;
 useEffect(()=>{latest.current=draft?.mate&&mateSelection&&!mateSelection.pick?{key,gap:Number(draft.fields.gap),ids:[draft.referenceEntryId,draft.movingEntryId],bounds:placement?.bounds}:null;});
 const available=panels.filter(p=>p.status==='PASS'&&p.artifacts.includes('panel.glb')&&p.artifacts.includes('panel.step'));
 function commit(next:AssemblyEntry[]){setHistory(h=>recordAction(h,entries));store.setEntries(next);}
 function travel(direction:'undo'|'redo'){
  if(editing||dragging||store.saving)return;const from=direction==='undo'?history.past:history.future;if(!from.length)return;
  const next=from[from.length-1];store.setEntries(next);
  setHistory(direction==='undo'?{past:history.past.slice(0,-1),future:[...history.future,entries]}:{past:[...history.past,entries],future:history.future.slice(0,-1)});
  if(!next.some(e=>e.id===active))setActive(null);
 }
 function clearEdit(){setSession(null);setMateSelection(null);setConnectMode(null);setDraft(null);setMove(null);setIsNew(false);setAddOpen(false);setNotice('');setCollapsed(false);}
 function cancel(){if(isNew)setActive(entries.at(-1)?.id??null);clearEdit();}
 function select(id:string|null){if(connectMode){setActive(id);return;}if(editing){if(id!==active)setNotice('Apply or cancel the current preview before selecting another panel.');return;}setActive(id);setAddOpen(false);setNotice('');}
 function disconnect(id:string){
  if(!placement||!ready||store.saving)return;
  try{
   const row=freezePlacements(entries,placement,true).find(e=>e.id===id)!,{connection:_c,mateState:_m,sides:_s,...rest}=row;void _c;void _m;void _s;
   if(!row.pose)throw new Error('Current CAD placement is not available. Reload the assembly.');
   commit(entries.map(e=>e.id===id?{...rest,matrix:undefined}:e));setNotice(`${title(id)} disconnected. It stays where it is; use Mate to connect it again.`);
  }catch(error){setNotice((error as Error).message);}
 }
 function startMove(group=false,rotate=false){
  if(!selected||!placement||!ready||store.saving)return;
  if(selected.targetId===null&&entries.length>1&&!window.confirm(`${title(selected.id)} is the fixed base. Moving it also moves every panel mated to it. Continue?`))return;
  try{
   // A mated panel starts from where it is now and can only travel along its free directions.
   // Moving takes over the free directions, so faces are no longer pulled together there.
   const start=selected.planeMates?entries.map(e=>e.id===selected.id?{...e,planeMates:e.planeMates!.map(m=>({...m,lineUp:false})),pose:currentPose(e,placement,selectedReport?.rotationAxis)}:e):entries;
   const frozen=freezePlacements(start,placement,true),row=frozen.find(e=>e.id===selected.id)!,p=positionValues(row);
   setMove({id:row.id,base:frozen,preview:suspendMovedMates(frozen,row.id,group),group,rotate,fields:{u:String(p.u),v:String(p.v),normal:String(p.normal),turn:String(row.pose!.turn)}});setCollapsed(false);setNotice('');
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
  // A panel about to be mated parks far enough away that the facing sides stay clickable.
  if(park&&placement){const frozen=freezePlacements(entries,placement),staged=stagedPanel(frozen,panel.id,id,placement,live&&mateOnAdd?MATE_PARKING_MM:DEFAULT_ASSEMBLY_GAP_MM);if(live&&mateOnAdd)pendingMate.current={id,label:staged.original.label!};commit([...frozen,{...staged.original,revision:panel.revision}]);setActive(id);setAddOpen(false);return;}
  beginConnection(panel,id,true);
 }
 const receiveCatalog=useCallback((catalog:CadFaceCatalog)=>{
  // A later side-only response must not discard the full face geometry.
  const known=catalogRef.current[catalog.entryId];
  catalogRef.current={...catalogRef.current,[catalog.entryId]:!catalog.faces.length&&known?.faces.length?known:catalog};setCatalogs(catalogRef.current);
 },[]);
 const onPlaced=useCallback((next:CadPlacement)=>{
  setPlacement(next);const pending=pendingMate.current;
  if(!pending||!next.entries.some(e=>e.id===pending.id))return;
  pendingMate.current=null;setNotice('');setSession(newSession(pending.id,`Panel ${pending.label} was added beside the assembly. Mate it now, or click Done.`));
 },[]);
 function startPlaneMate(preferred?:string){
  if(!ready||store.saving)return;
  clearEdit();setHidden([]);setSession(newSession(preferred&&preferred!==baseId(entries)?preferred:undefined));
 }
 function oriented(next:MateSession,start:CadPlacement):MateSession{
  const info=(pick:NonNullable<MateSession['moving']>)=>{const row=start.entries.find(e=>e.id===pick.entryId),face=catalogRef.current[pick.entryId]?.faces.find(f=>f.id===pick.face.faceId);return row&&face?.normal?{matrix:row.matrix,normal:face.normal,point:pick.face.point}:null;};
  const a=info(next.moving!),b=info(next.target!),now=a&&b?measureFaces(a,b):{aligned:false,offset:0};
  // Like a CAD mate: keep the current facing and propose the current distance. A panel's first
  // touching pair also brings the two faces to each other; flush (same way) pairs only align.
  const first=!entries.find(e=>e.id===next.moving!.entryId)?.planeMates?.length;
  return {...next,pick:null,lineUp:next.editing?next.lineUp:first&&!now.aligned,mateId:next.editing?next.mateId:crypto.randomUUID(),aligned:now.aligned,distance:String(+Math.abs(now.offset).toFixed(3)),reverse:now.aligned&&now.offset<0,start};
 }
 function matePick(slot:'moving'|'target',face:CadFaceReference,id:string){
  if(!session||!placement)return;
  const other=slot==='moving'?session.target:session.moving;
  if(other?.entryId===id){setSession({...session,note:'Pick the second face on a different panel.'});return;}
  const next:MateSession={...session,[slot]:{entryId:id,face},note:''};
  next.pick=!next.moving?'moving':!next.target?'target':null;
  if(!next.moving||!next.target){setSession(next);return;}
  const done=Object.entries(placement.constraints??{}).filter(([,r])=>r.status==='defined').map(([entry])=>entry);
  const order=chooseMoving(entries,next.moving.entryId,next.target.entryId,next.preferred,done);
  if('error' in order){setSession({...session,note:order.error??''});return;}
  if(session.editing&&order.movingId!==session.preferred){setSession({...session,note:`This mate belongs to ${title(session.preferred!)}. Pick its face and a face on another panel.`});return;}
  if(order.swapped){[next.moving,next.target]=[next.target,next.moving];next.note=`${title(order.movingId)} will move and ${title(order.targetId)} stays${order.targetId===baseId(entries)?' (it is the fixed base)':''}.`;}
  setSession(oriented(next,session.start??placement));setActive(order.movingId);
 }
 function swapMate(){
  if(!session?.moving||!session.target||!session.start)return;
  const order=chooseMoving(entries,session.target.entryId,session.moving.entryId,session.target.entryId);
  if('error' in order||order.swapped||session.editing){setSession({...session,note:session.editing?'An existing mate keeps its moving panel. Remove it to mate the other way.':`${title(session.target.entryId)} cannot move: it is the base, or the other panel already depends on it.`});return;}
  setSession(oriented({...session,moving:session.target,target:session.moving,note:''},session.start));
 }
 function applyMate(){
  if(!session||!candidate||!valid||store.saving)return;
  const id=session.moving!.entryId,report=placement?.constraints?.[id];
  if(report?.mates.find(m=>m.id===candidate.id)?.state==='conflict')return;
  const name=mateTitle(candidate,title(id).slice(6),title(candidate.targetId).slice(6)),state=report?`${title(id)} ${report.dof?motionText(report).replace(/^Can/,'can'):'is fully defined'}.`:'';
  commit(effective);setActive(id);
  if(session.editing){setSession(null);setNotice(`Mate updated. ${state}`);return;}
  const open=!!report&&report.dof>0;
  setSession(newSession(open?id:undefined,`Added ${name}. ${state}${open?' Pick the next face pair.':' Mate another panel, or click Done.'}`));
 }
 function editMate(entryId:string,mateId:string){
  const mate=entries.find(e=>e.id===entryId)?.planeMates?.find(m=>m.id===mateId);
  if(!mate||!placement||!ready||store.saving)return;
  clearEdit();setHidden([]);setActive(entryId);
  setSession({moving:{entryId,face:mate.moving},target:{entryId:mate.targetId,face:mate.reference},pick:null,type:mate.type,distance:String(Math.abs(mate.offset)),reverse:mate.offset<0,aligned:mate.aligned,lineUp:!!mate.lineUp,mateId,editing:true,preferred:entryId,note:'',start:placement});
 }
 function removeMate(entryId:string,mateId:string){
  if(!placement||!ready||store.saving)return;
  if(!window.confirm(`Remove this mate from ${title(entryId)}? Its other mates stay.`))return;
  try{commit(withoutMate(entries,entryId,mateId,placement));setNotice(`Mate removed. ${title(entryId)} stays where it is until you move or mate it.`);}catch(error){setNotice((error as Error).message);}
 }
 function removePanel(id:string){
  const kept=removeAssemblyBranch(entries,id),gone=entries.filter(e=>!kept.includes(e)).map(e=>e.id);
  const mates=kept.reduce((sum,e)=>sum+(e.planeMates?.filter(m=>gone.includes(m.targetId)).length??0),0);
  if(!window.confirm(`Remove ${title(id)} and its connection branch?${mates?` ${mates} mate${mates>1?'s':''} on other panels that use it will also be removed.`:''}`))return;
  try{commit(withoutTargets(kept,gone,placement));setActive(null);}catch(error){setNotice((error as Error).message);}
 }
 const keys=useRef<(event:KeyboardEvent)=>void>(()=>{});
 useEffect(()=>{keys.current=event=>{
  if(!session)return;
  if(event.key==='Escape'){if(session.moving||session.target)setSession(session.editing?null:newSession(session.preferred));else setSession(null);}
  else if(event.key==='Enter'&&!(event.target instanceof HTMLButtonElement)&&!(event.target instanceof HTMLSelectElement)){event.preventDefault();applyMate();}
 };});
 useEffect(()=>{const listen=(event:KeyboardEvent)=>keys.current(event);window.addEventListener('keydown',listen);return()=>window.removeEventListener('keydown',listen);},[]);
 const mateStart=useRef(new Map<string,number[]>());
 function startMate(edit=false){
  if(!placement||!ready)return;auto.current.on=false;
  mateStart.current=new Map(placement.entries.map(e=>[e.id,e.matrix]));
  setBase(freezePlacements(entries,placement));setAddOpen(false);setHidden([]);setNotice('');
  if(edit&&selected?.connection){const next={...beginFaceDraft(selected),mate:true};next.preview=previewFaceDraft(next);setDraft(next);setMateSelection({...next,anyPanel:true,pick:null});}
  else {setDraft(null);setMateSelection({referenceEntryId:'',movingEntryId:'',pick:'reference',anyPanel:true,geometry:'face',alignment:'top'});}
 }
 function facePicked(role:FaceRole,face:CadFaceReference,id:string){
  if(session){matePick(role==='moving'?'moving':'target',face,id);return;}
  if(!mateSelection){setDraft(old=>old?updateFaceDraft(old,{[role]:face,pick:null,message:''}):null);return;}
  let next:FaceSelection={...mateSelection,[role]:face,[role==='reference'?'referenceEntryId':'movingEntryId']:id,pick:role==='reference'?'moving' as const:null};
  if(next.referenceEntryId===next.movingEntryId){setNotice('Select faces on two different panels.');return;}
  let selectionNotice='';
  if(next.reference&&next.moving){
   try{
    const ordered=orderMateSelection(next,base);next=ordered.selection;
    if(ordered.swapped)selectionNotice='Both faces selected. '+title(next.referenceEntryId)+' stays fixed; '+title(next.movingEntryId)+' moves to avoid reversing the existing connection tree.';
   }catch(error){setNotice((error as Error).message);return;}
   const original=base.find(e=>e.id===next.movingEntryId)!;
   const from=mateStart.current.get(next.referenceEntryId),to=mateStart.current.get(next.movingEntryId);
   if(!from||!to){setNotice('Panel positions changed. Cancel and select the mating faces again.');return;}
   // Repicking an active joint keeps its original roll datum. Capturing
   // its already twisted preview here would apply the user's twist twice.
   const reuse=draft?.startPose&&draft.referenceEntryId===next.referenceEntryId&&draft.movingEntryId===next.movingEntryId&&draft.original.mateState!=='suspended';
   const startPose=reuse?draft.startPose:new Matrix4().fromArray(from).invert().multiply(new Matrix4().fromArray(to)).toArray();
   const d:FaceDraft={...next,original,startPose,matchFootprints:next.geometry!=='edge',mate:true,pick:null,message:'',fields:draft?.fields??{gap:String(original.connection?original.gap:0),u:'0',v:'0',normal:'0',twist:'0'}};
   d.preview=previewFaceDraft(d);auto.current={on:!draft,bumped:0};setDraft(d);setActive(next.movingEntryId);next.pick=null;
  }
  if(!next.reference||!next.moving)setDraft(old=>old?{...old,...next,preview:undefined}:null);
  setMateSelection(next);setNotice(selectionNotice);
 }
 function repickMate(role:FaceRole){if(!mateSelection)return;auto.current.on=false;setDraft(old=>old?{...old,[role]:undefined,preview:undefined}:null);setMateSelection({...mateSelection,[role]:undefined,pick:role});}

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
  if(mateSelection||session)return;
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
  else if(draft&&previewFaceDraft(draft)&&placement){const labels=new Map(effective.map(e=>[e.id,e.label])),done=draft.mate?`Mate applied: ${title(draft.movingEntryId)} is connected to ${title(draft.referenceEntryId)}.`:'';commit(freezePlacements(placement.entries,placement).map(e=>({...e,label:labels.get(e.id)})));clearEdit();if(done)setNotice(done);}
 }
 async function save(){
  if(editing||store.saving||!store.loaded||entries.length&&!valid)return;
  // Labels are UI metadata. The API binds every engineering field to this exact
  // checked matrix snapshot; saving does not run placement again.
  setNotice('');
  await store.save(placement,validation.token);
 }
 return <section ref={workspace} className="assembly-workspace" data-tree-open={listOpen} aria-label="Interactive assembly workspace" data-connect-mode={!!connectMode} data-unsaved-assembly={store.dirty||editing?'true':undefined} aria-busy={store.saving}>
   {(notice||store.error||store.message||!store.loaded)&&<div className="asm-workspace-notice" role={store.error?'alert':'status'}>{store.error||notice||store.message||'Loading saved assembly…'}{store.error&&<button onClick={()=>{if((store.dirty||editing)&&!window.confirm('Discard current edits and reload the saved project assembly?'))return;clearEdit();setHistory({past:[],future:[]});store.reload();}}>Reload saved assembly</button>}</div>}
  <AssemblyViewer ref={view} projectId={projectId} live={live} entries={effective} panels={available} paint={paint} wire={wire} onReadyChange={setReady}
   mateCheckId={mateCheckId} insertId={draft&&!draft.mate&&previewFaceDraft(draft)?draft.movingEntryId:undefined} insertBranchId={draft?.insertBranchId} onSideSelected={clickSide} sideSelectionMode={!!connectMode} sideTargets={connectMode?[connectMode.from&&{...connectMode.from,role:'from' as const},connectMode.to&&{...connectMode.to,role:'to' as const}].filter((v):v is {id:string;side:AssemblySide;role:'from'|'to'}=>!!v):[]} selection={selection} previewOnly={editing||addOpen} onFacePicked={facePicked} onFaceMessage={faceMessage} onValidation={onValidation}
   activeId={active} hiddenIds={hidden} moving={moving} moveGroup={move?.group??false} onSelect={select} onMove={onMove} onDrag={setDragging} onCatalog={receiveCatalog} onPlaced={onPlaced}>
   <div className="asm-workspace-toolbar">
    <button className="primary" aria-label="Mate" title="Connect panels: click a face on each" disabled={!live||!ready||store.saving||editing||entries.length<2} onClick={()=>startPlaneMate(active??undefined)}><Link2 size={15}/>Mate</button>
    <button className="primary" disabled={!store.loaded||store.saving||editing||dragging||entries.length>=100||!!entries.length&&!ready} onClick={()=>setAddOpen(!addOpen)}><Plus size={15}/>{entries.length?'Add Panel':'Select First Panel'}</button>
    <button className="primary" disabled={!store.loaded||!live||store.saving||editing||!!entries.length&&!valid} onClick={()=>void save()}><Save size={15}/>{store.saving?'Saving…':'Save Assembly'}</button>
    <button aria-label="Undo" disabled={editing||store.saving||!history.past.length} onClick={()=>travel('undo')}><Undo2 size={15}/></button>
    <button aria-label="Redo" disabled={editing||store.saving||!history.future.length} onClick={()=>travel('redo')}><Redo2 size={15}/></button>
    <button aria-label="Panels" aria-expanded={listOpen} onClick={()=>setListOpen(!listOpen)}><List size={15}/><span>{effective.length}</span></button>
    <button aria-label="Fit Assembly" disabled={!effective.length} onClick={()=>view.current?.fit()}><Maximize2 size={15}/></button>
    <select aria-label="Assembly camera view" defaultValue="iso" onChange={e=>view.current?.fit(e.target.value)}><option value="iso">Isometric</option><option value="front">Front</option><option value="top">Top</option><option value="side">Side</option></select>
    <details className="asm-more"><summary>More</summary><div onClick={e=>{const menu=e.currentTarget.parentElement as HTMLDetailsElement;menu.open=false;}}>
     <button aria-label="Connect / Mate" title="One-step snap: a single face pair positions the whole panel" disabled={!live||!ready||store.saving||editing||entries.length<2} onClick={()=>startMate()}><Link2 size={15}/>One-step snap</button>
     <button aria-label="Connect panels in viewer" title="Connect using named sides (left/right/top/bottom)" aria-pressed={!!connectMode} disabled={!live||!ready||store.saving||editing||entries.length<2} onClick={()=>{setBase(freezePlacements(entries,placement!));setConnectMode({pick:'from'});setAddOpen(false);setNotice('');}}><Link2 size={15}/>Connect sides</button>
    </div></details>
   </div>
   {listOpen&&<aside className="asm-panel-list" aria-label="Assembly panels"><header><strong>Panels</strong><button aria-label="Close panel list" onClick={()=>setListOpen(false)}><X size={14}/></button></header>
    {!effective.length&&<p>Add the first panel. It becomes the fixed base.</p>}
    <AssemblyPanelList entries={effective} placement={placement} fileNames={fileNames} active={active} hidden={hidden} busy={editing||store.saving||!ready||!live} canHide={!editing||!!session}
     onSelect={select} onFocus={id=>{setActive(id);view.current?.fit('iso',id);}} onToggle={id=>setHidden(old=>old.includes(id)?old.filter(other=>other!==id):[...old,id])} onMate={startPlaneMate} onEdit={editMate} onRemove={removeMate}/>
    <details><summary>Display</summary><button onClick={()=>setHidden([])}>Show all panels</button><label><input type="checkbox" checked={wire} onChange={e=>setWire(e.target.checked)}/>Wireframe (mesh triangles)</label><label><input type="checkbox" checked={paint} onChange={e=>setPaint(e.target.checked)}/>Distinguish painted face</label><p>Visibility affects inspection only. Exports include all panels.</p></details>
   </aside>}
   {addOpen&&<section className="asm-context asm-add-picker" aria-label="Choose a panel"><header><strong>{entries.length?`Add Panel ${nextLabel(entries)}`:'Select First Panel'}</strong><button aria-label="Close panel picker" onClick={()=>setAddOpen(false)}><X size={15}/></button></header>
    <p>{entries.length?'Choose a drawing. It is placed beside the assembly, ready to mate.':'Choose a processed drawing to become Panel A, the fixed base.'}</p>
    {!!entries.length&&<><label><input type="checkbox" checked={park} onChange={e=>setPark(e.target.checked)}/>Place separately for face mating</label>{park&&<label><input type="checkbox" checked={mateOnAdd} onChange={e=>setMateOnAdd(e.target.checked)}/>Start mating it straight away</label>}{!park&&<p className="asm-hint">The side-by-side connection editor opens after adding.</p>}</>}
    <div className="asm-available-panels">{available.filter(p=>repeat||!entries.some(e=>e.panelId===p.id)).map(p=><button key={p.id} disabled={!live} onClick={()=>add(p)}>{p.filename}<small>Ready · folded CAD solid</small></button>)}</div>
    {!available.length&&<p>No approved panel solids are available.</p>}{!!entries.length&&<label><input type="checkbox" checked={repeat} onChange={e=>setRepeat(e.target.checked)}/>Include drawings already added</label>}
    {!live&&<p>Connect the CAD service to create and save assemblies.</p>}
   </section>}
   {selected&&!editing&&!addOpen&&<div className="asm-selection-toolbar"><strong>{title(selected.id)}</strong><span data-tone={panelStatus(selected,selectedReport).tone}>{panelStatus(selected,selectedReport).label}</span>
    {selected.targetId!==null&&<button className="primary" disabled={!live||!ready||store.saving||entries.length<2} onClick={()=>startPlaneMate(selected.id)}><Link2 size={15}/>Add mate</button>}
    <button disabled={hidden.includes(selected.id)} onClick={()=>view.current?.fit('iso',selected.id)}><Focus size={15}/>Focus</button>
    <button disabled={!live||!ready||store.saving||hidden.includes(selected.id)||selectedReport?.status==='defined'&&!!selected.planeMates} title={selectedReport?.status==='defined'&&selected.planeMates?'Fully defined. Remove a mate to free it.':undefined} onClick={()=>startMove()}><Move3D size={15}/>Move</button>
    <button disabled={!live||!ready||store.saving} onClick={()=>startMove(true)}>Move branch</button>
    {(selected.connection||!!selected.planeMates&&!!selectedReport?.rotationDof)&&<button disabled={!live||!ready||store.saving} onClick={()=>startMove(false,true)}><RotateCw size={15}/>Rotate</button>}
    {!selected.planeMates&&<button disabled={!live||!ready||store.saving} onClick={()=>{if(!selected.targetId){setAddOpen(true);return;}const panel=available.find(p=>p.id===selected.panelId);if(panel)beginConnection(panel,selected.id,false);}}><Link2 size={15}/>{selected.targetId?'Reconnect':'Connect'}</button>}
    <button disabled={store.saving} title="Remove panel and its connection branch" aria-label="Remove selected panel" onClick={()=>removePanel(selected.id)}><Trash2 size={15}/></button>
    {selected.connection&&<button disabled={!live||!ready||store.saving} title="Remove this connection but keep the panel where it is" onClick={()=>{if(window.confirm(`Disconnect ${title(selected.id)} from ${title(selected.targetId!)}? The panel keeps its current position.`))disconnect(selected.id);}}>Disconnect</button>}{selected.mateState&&<><button disabled={!ready||store.saving} onClick={()=>startMate(true)}>Edit mate</button><small>{selected.connection?.type==='straight-edge'?'Edge':'Planar'} mate: {selected.mateState==='active'?'Active — dependent panels follow mate edits':'Suspended by Free Move — Edit mate to resume'}</small></>}
    {selected.sides&&<small>{selected.sides.reference} → {selected.sides.moving} · Initial gap {selected.gap.toFixed(2)} mm · independent positioning</small>}
   </div>}
   {connectMode&&!needsChoices&&<section className="asm-context" aria-label="Interactive connection"><header><strong>Connect panel sides</strong></header>
    <p>{draft?'Review the connection preview, then join.':connectMode.pick==='from'?'Select the first panel side.':'Select a side on the second panel.'}</p>
    <button onClick={()=>{setDraft(null);setConnectMode({...connectMode,pick:'from'});}}>From: {connectMode.from?`${title(connectMode.from.id)} — ${connectMode.from.side}`:'Select side'}</button>
    <button onClick={()=>{setDraft(null);setConnectMode({...connectMode,pick:'to'});}}>To: {connectMode.to?`${title(connectMode.to.id)} — ${connectMode.to.side}`:'Select side'}</button>
    {draft?.message&&<p>{draft.message}</p>}
    <footer><button onClick={cancel}>Cancel</button><button className="primary" disabled={!draft||!valid||!!draft.pick} onClick={apply}>Join Panels</button></footer>
   </section>}
   {draft&&!draft.mate&&(!connectMode||needsChoices)&&<AssemblyConnectionEditor draft={draft} entries={effective} catalogs={catalogs} valid={valid} connecting={isNew} insertion={placement?.insertion} onBranch={id=>setDraft(old=>old?{...old,insertBranchId:id}:null)} onSide={chooseSide}
    onReference={id=>setDraft(updateFaceDraft(draft,{referenceEntryId:id,reference:undefined,insertBranchId:undefined,sides:{moving:draft.sides?.moving},sideNames:{moving:draft.sides?.moving},allowed:{moving:draft.allowed?.moving},pick:null,message:''}))}
    onGap={gap=>setDraft(updateFaceDraft(draft,{fields:{...draft.fields,gap}}))} onApply={apply} onCancel={cancel}/>}
   {mateSelection&&<AssemblyMateEditor selection={mateSelection} draft={draft?.mate?draft:null} entries={effective} placement={placement} valid={valid} status={{checking:validation.key!==key||validation.checking,message:validation.key===key?validation.message:''}} fileNames={fileNames} onPick={repickMate} onMode={geometry=>{auto.current.on=false;setDraft(null);setMateSelection({anyPanel:true,geometry,alignment:'top',referenceEntryId:'',movingEntryId:'',pick:'reference'});setNotice('');}} onOptions={patch=>{auto.current.on=false;setMateSelection({...mateSelection,...patch});setDraft(old=>old?updateFaceDraft(old,patch):null);}} onChange={fields=>{auto.current.on=false;setDraft(old=>old?updateFaceDraft(old,{fields}):null);}} onApply={apply} onCancel={cancel}/>}
   {session&&<AssemblyMateCard session={session} entries={effective} catalogs={catalogs} fileNames={fileNames} report={candidate&&solved?placement?.constraints?.[session.moving!.entryId]:undefined}
     checking={!!candidate&&!solved} valid={valid} problem={solved?validation.message:''} warning={candidate&&solved?validation.warning:''}
     onFace={slot=>setSession({...session,[slot]:undefined,pick:slot,note:''})} onSwap={swapMate} onChange={patch=>setSession({...session,...patch,note:''})}
     onClear={()=>setSession(session.editing?null:newSession(session.preferred))} onApply={applyMate} onDone={()=>setSession(null)}/>}
   {move&&<section className="asm-context asm-position-card" data-position-popup="true" data-unsaved-assembly="true" aria-label="Panel position controls"><header><strong>{title(move.id)} · {move.rotate?'Rotate':move.group?'Move branch':'Move panel'}</strong><button aria-label={collapsed?'Expand position controls':'Collapse position controls'} onClick={()=>setCollapsed(!collapsed)}>{collapsed?'+':'−'}</button></header>
    {collapsed?<p>X {move.fields.u} · Y {move.fields.v} · Z {move.fields.normal} mm</p>:<>
    <div className="asm-inline-values">{(move.rotate?[['turn','Rotation','°']]:[['u','X offset — right','mm'],['v','Y offset — up','mm'],['normal','Z offset — forward','mm']]).map(([axis,label,unit])=><label key={axis}><span>{label}</span><span><input type="number" step="any" aria-label={label} value={move.fields[axis as keyof MoveDraft['fields']]} disabled={dragging} onChange={e=>updateMove({...move.fields,[axis]:e.target.value})}/><small>{unit}</small></span></label>)}</div>
    <p>{move.group?'Moves this panel and its connection descendants.':'Moves this panel; panels mated to it follow.'} {move.rotate?'Rotation is about its initial connection normal.':'X = world X, Y = world Z (up), Z = world −Y (forward).'}</p><p>Free Move suspends mates between moved and stationary panels. Other active mates remain intact. Signed offsets can move through other panels.</p>
    {!move.rotate&&<p>Drag · 1 mm steps · Shift for 0.1 mm. Type any exact value.</p>}{moveError&&<p role="alert">Enter complete, finite values.</p>}
    <footer><button disabled={dragging} onClick={()=>{const original=move.base.find(e=>e.id===move.id)!,p=positionValues(original);setMove({...move,preview:suspendMovedMates(move.base,move.id,move.group),fields:{u:String(p.u),v:String(p.v),normal:String(p.normal),turn:String(original.pose!.turn)}});}}>Reset position</button><button disabled={dragging} onClick={cancel}>Cancel</button><button className="primary" disabled={!valid||!!moveError} onClick={apply}>Apply position</button></footer></>}
   </section>}
   <div className="asm-mode-indicator">{dragging?'Moving · mm':session?(session.pick==='moving'?'Mate · click a face on the panel to move':session.pick==='target'?'Mate · click the face it should meet':'Mate · check the preview, then Apply (Enter)'):mateSelection?(mateSelection.pick==='reference'?'Mate · click the first panel’s connecting surface':mateSelection.pick==='moving'?'Mate · click the matching surface on the other panel':'Mate · review the preview, then Apply Mate'):draft?.pick?'Choose a highlighted connection region':moving?move?.group?'Move branch · X / Y / Z':'Move panel · X / Y / Z':followers.length?`${definedCount} of ${followers.length} panel${followers.length>1?'s':''} fully positioned`:'Select · click a panel'}{(editing||store.dirty)&&<span>Unsaved changes</span>}</div>
  </AssemblyViewer>
 </section>;
}
