'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, Trash2, MoreHorizontal, ArrowLeft, Layers3, Upload, Box, Settings2, FolderOpen, Plus, ChevronRight, ChevronDown, ArrowDownToLine, Check, CircleAlert, CircleCheck, FileUp, ScanLine, Ruler, Play, Pause, X, RotateCw, FileText, LoaderCircle, Download, Package, ArrowLeftRight, PanelTop, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { SidebarProvider, Sidebar, SidebarHeader, SidebarContent, SidebarFooter, SidebarMenu, SidebarMenuItem, SidebarMenuButton } from '@/components/ui/sidebar';
import { Toaster, toast } from 'sonner';
import ModelViewer from './ModelViewer';
import AssemblyViewer, { AssemblyViewerHandle, ClashResult } from './AssemblyViewer';
import { AssemblyEntry, Bootstrap, Face, Panel, Settings, api, fileUrl } from './types';
const FACES:[Face,string][]=[
 ['-X','Left (−X)'],['+X','Right (+X)'],
 ['+Z','Top (+Z)'],['-Z','Bottom (−Z)'],
 ['-Y','Front (−Y)'],['+Y','Back (+Y)'],
];
function FacePicker({value,onChange}:{value:Face;onChange:(f:Face)=>void}){
 return(
  <div className="face-picker">
   {FACES.map(([face,label])=>(
    <button key={face} type="button" className={'face-btn '+(value===face?'selected':'')} onClick={()=>onChange(face)}>
     {label.split(' ')[0]}<code>{face}</code>
    </button>
   ))}
  </div>
 );
}
const labels:Record<string,string>={PASS:'Ready',NEEDS_REVIEW:'Needs review',FAILED:'Failed',QUEUED:'Queued',CONVERTING:'Converting DWG',EXTRACTING:'Reading drawing',BUILDING:'Building solid'};
function Status({value}:{value:string}){return <span className={'status status-'+value.toLowerCase()}>{value==='PASS'?<CircleCheck/>:value==='NEEDS_REVIEW'?<CircleAlert/>:value==='FAILED'?<X/>:<LoaderCircle className="spin"/>}{labels[value]||value}</span>}
const mm=(value?:number)=>value===undefined?'—':value.toLocaleString('en',{maximumFractionDigits:2});
const activeStatuses=['QUEUED','CONVERTING','EXTRACTING','BUILDING'];
function ParameterFields({value,onChange}:{value:Settings;onChange:(s:Settings)=>void}){return <div className="parameter-grid">{([['thickness','Material thickness'],['radius','Inside bend radius'],['deduction','Bend deduction / 90°']] as const).map(([key,title])=><div className="field" key={key}><Label htmlFor={'param-'+key}>{title}</Label><div className="unit-input"><Input id={'param-'+key} type="number" min={key==='deduction'?0:.1} step="0.1" value={value[key]} onChange={e=>onChange({...value,[key]:Number(e.target.value)})}/><span>mm</span></div></div>)}<div className="field"><Label htmlFor="input-type">Input type</Label><select id="input-type" value={value.input_type} onChange={e=>onChange({...value,input_type:e.target.value as Settings['input_type']})}><option value="flat_pattern">Developed flat pattern</option><option value="folded_dimensions">Folded dimensions · review required</option></select></div></div>}
export default function FlatForge(){
 const [data,setData]=useState<Bootstrap|null>(null),[projectId,setProjectId]=useState(''),[panelId,setPanelId]=useState(''),[tab,setTab]=useState('panels'),[screen,setScreen]=useState<'home'|'workspace'>('home');
 const [dialog,setDialog]=useState<null|'project'|'upload'|'settings'|'logs'|'connect'|'sections'|'edit_project'|'edit_drawing'|'assembly_add'>(null);const [busy,setBusy]=useState(false);const [name,setName]=useState(''),[client,setClient]=useState('');const [files,setFiles]=useState<File[]>([]);const [drag,setDrag]=useState(false);const input=useRef<HTMLInputElement>(null);
 const [deleteTarget,setDeleteTarget]=useState<{kind:'projects'|'panels';id:string;name:string}|null>(null);const [drawingName,setDrawingName]=useState('');const [replacement,setReplacement]=useState<File|null>(null);
 const [defaults,setDefaults]=useState<Settings>({thickness:2,radius:2,deduction:4,input_type:'flat_pattern'});const [panelSettings,setPanelSettings]=useState(defaults);const [decisions,setDecisions]=useState<Record<string,number>>({});const [confirm,setConfirm]=useState(false),[partial,setPartial]=useState(false),[relief,setRelief]=useState(false);const [logs,setLogs]=useState<{revision:number;log:string;status:string}[]>([]);
 const [fraction,setFraction]=useState(1),[playing,setPlaying]=useState(false),[paint,setPaint]=useState(true),[wire,setWire]=useState(false),[view3d,setView3d]=useState('iso');const [hover,setHover]=useState<string|null>(null);const [assembly,setAssembly]=useState(false),[compare,setCompare]=useState<string[]>([]),[gap,setGap]=useState(100),[alignment,setAlignment]=useState('center');const [zoom,setZoom]=useState(1);
 const [asmEntries,setAsmEntries]=useState<AssemblyEntry[]>([]);
 const [addPanelId,setAddPanelId]=useState('');const [addTargetId,setAddTargetId]=useState('');const [addMyFace,setAddMyFace]=useState<Face>('-X');const [addTargetFace,setAddTargetFace]=useState<Face>('+X');const [addGap,setAddGap]=useState(10);
 const asmViewRef=useRef<AssemblyViewerHandle|null>(null);
 const [clashResults,setClashResults]=useState<ClashResult[]|null>(null);
 const [clashRunning,setClashRunning]=useState(false);
 const refresh=useCallback(async()=>{try{const r=await fetch('/api/bootstrap');if(!r.ok)throw new Error('Could not load workspace');const next=await r.json() as Bootstrap;setData(next);setProjectId(id=>next.projects.some(p=>p.id===id)?id:next.projects[0]?.id||'');setPanelId(id=>next.panels.some(p=>p.id===id)?id:next.panels[0]?.id||'');return next}catch(e){toast.error((e as Error).message);return null}},[]);
 useEffect(()=>{refresh()},[refresh]);
 useEffect(()=>{if(!data||data.mode!=='live')return;const id=setInterval(refresh,data.panels.some(p=>activeStatuses.includes(p.status))?2000:12000);return()=>clearInterval(id)},[data?.mode,data?.panels.some(p=>activeStatuses.includes(p.status)),refresh]);
 const project=data?.projects.find(p=>p.id===projectId);const panels=data?.panels.filter(p=>p.project_id===projectId)||[];const panel=panels.find(p=>p.id===panelId)||panels[0];const live=data?.mode==='live';const ready=panels.filter(p=>p.artifacts.includes('panel.glb'));const selectedModels=assembly?ready.filter(p=>compare.includes(p.id)).slice(0,5):panel&&panel.artifacts.includes('panel.glb')?[panel]:[];
 useEffect(()=>{setPlaying(false);setFraction(1);if(panel){setPanelSettings(panel.settings);setDecisions({});setPartial(false);setRelief(false);setConfirm(false);setZoom(1)}},[panel?.id,panel?.revision]);
 useEffect(()=>{if(!playing)return;let raf=0;const started=performance.now();function step(t:number){const p=Math.min(1,(t-started)/2400);setFraction(p*p*(3-2*p));if(p<1)raf=requestAnimationFrame(step);else setPlaying(false)}setFraction(0);raf=requestAnimationFrame(step);return()=>cancelAnimationFrame(raf)},[playing]);
 useEffect(()=>{if(dialog!=='logs'||!panel||panel.sample)return;let cancelled=false;const id=setInterval(async()=>{try{const r=await api<{jobs:{revision:number;log:string;status:string}[]}>(`/panels/${panel.id}/log`,undefined,'GET');if(!cancelled)setLogs(r.jobs)}catch{/* Initial errors are shown by showLogs. */}},2000);return()=>{cancelled=true;clearInterval(id)}},[dialog,panel?.id]);
 const chooseProject=(id:string)=>{setProjectId(id);setPanelId(data?.panels.find(p=>p.project_id===id)?.id||'');setCompare([]);setAssembly(false);setAsmEntries([]);setTab('panels');setScreen('workspace')};
 const goHome=()=>{setScreen('home')};
 function asmAddEntry(){if(!addPanelId)return;const isRoot=asmEntries.length===0;setAsmEntries(prev=>[...prev,{id:Math.random().toString(36).slice(2,8),panelId:addPanelId,myFace:addMyFace,targetId:isRoot?null:addTargetId||null,targetFace:isRoot?null:addTargetFace,gap:addGap}]);setDialog(null);setAddPanelId('');}
 function asmRemove(id:string){setAsmEntries(prev=>prev.filter(e=>e.id!==id&&e.targetId!==id));}
 function asmSetMyFace(id:string,f:Face){setAsmEntries(prev=>prev.map(e=>e.id===id?{...e,myFace:f}:e));}
 function asmSetTargetFace(id:string,f:Face){setAsmEntries(prev=>prev.map(e=>e.id===id?{...e,targetFace:f}:e));}
 function asmSetTarget(id:string,targetId:string){setAsmEntries(prev=>prev.map(e=>e.id===id?{...e,targetId}:e));}
 function asmSetGap(id:string,g:number){setAsmEntries(prev=>prev.map(e=>e.id===id?{...e,gap:Math.max(0,g)}:e));}
 // Clear clash results whenever the assembly configuration changes
 useEffect(()=>{setClashResults(null);asmViewRef.current?.clearClash();},[asmEntries]);
 async function runClashCheck(){
  if(!asmViewRef.current||asmEntries.length<2) return;
  setClashRunning(true);setClashResults(null);asmViewRef.current.clearClash();
  await new Promise(r=>setTimeout(r,60)); // yield so UI shows "Checking…"
  const results=asmViewRef.current.runClash();
  setClashResults(results);setClashRunning(false);
 }
 async function task(fn:()=>Promise<unknown>,message?:string){setBusy(true);try{await fn();if(message)toast.success(message);await refresh();return true}catch(e){toast.error((e as Error).message);return false}finally{setBusy(false)}}
 const steps=['panels','conversion','review','calculate','viewer'];
 const canStep=(step:string)=>step==='panels'||step==='conversion'?!!project:step==='review'?!!panel&&(panel.artifacts.includes('extraction.svg')||!activeStatuses.includes(panel.status)):step==='calculate'?!!panel&&panel.report.flat_width!==undefined&&!activeStatuses.includes(panel.status):!!panel&&panel.artifacts.includes('panel.glb');
 const stepIndex=steps.indexOf(tab);
 function editProject(){if(!project)return;setName(project.name);setClient(project.client);setDialog('edit_project')}
 function editDrawing(p:Panel){setPanelId(p.id);setDrawingName(p.filename);setReplacement(null);setDialog('edit_drawing')}
 async function saveProject(){if(!project)return;if(await task(()=>api(`/projects/${project.id}`,{name,client},'PUT'),'Project updated'))setDialog(null)}
 async function saveDrawing(){if(!panel)return;const ok=await task(async()=>{if(replacement){const form=new FormData();form.append('file',replacement);await api(`/panels/${panel.id}/source`,form);setTab('conversion')}else await api(`/panels/${panel.id}`,{filename:drawingName},'PUT')},replacement?'Source replaced. Rebuilding panel…':'Drawing renamed');if(ok)setDialog(null)}
 async function removeItem(){if(!deleteTarget)return;const target=deleteTarget;if(await task(()=>api(`/${target.kind}/${target.id}`,undefined,'DELETE'))){setDeleteTarget(null);setTab('panels');if(target.kind==='projects')setScreen('home');toast.success(`${target.name} deleted`,{action:{label:'Undo',onClick:()=>{void task(()=>api(`/${target.kind}/${target.id}/restore`,{}),'Restored')}}})}}
 const drawingMenu=(p:Panel)=><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={'Manage '+p.filename}><MoreHorizontal size={15}/></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={()=>{setPanelId(p.id);setTab('review')}}><ScanLine size={14}/>View drawing & evidence</DropdownMenuItem><DropdownMenuItem onSelect={()=>window.open(p.sample?fileUrl(p,'flat.dxf'):`/api/engine/panels/${p.id}/source`,'_blank','noopener')}><Download size={14}/>Download original</DropdownMenuItem><DropdownMenuItem disabled={!live} onSelect={()=>editDrawing(p)}><Pencil size={14}/>Edit / replace drawing</DropdownMenuItem><DropdownMenuItem disabled={!live} onSelect={()=>setDeleteTarget({kind:'panels',id:p.id,name:p.filename})}><Trash2 size={14}/>Delete drawing</DropdownMenuItem></DropdownMenuContent></DropdownMenu>;
 const openSettings=()=>{setDefaults(data?.settings||defaults);setDialog('settings')};
 async function create(){if(!name.trim())return;const ok=await task(async()=>{const p=await api<{id:string}>('/projects',{name,client});setProjectId(p.id);setPanelId('');setTab('panels');setScreen('workspace')},'Project created');if(ok){setDialog('upload');setName('');setClient('')}}
 function addFiles(chosen:File[]){const wrong=chosen.find(f=>!/^.+\.(dwg|dxf)$/i.test(f.name)||f.size>(data?.capabilities.max_upload_mb||50)*1024*1024);if(wrong){toast.error(`${wrong.name}: use a DWG/DXF file up to ${data?.capabilities.max_upload_mb||50} MB.`);return}setFiles(previous=>[...previous,...chosen].slice(0,20))}
 async function upload(){const form=new FormData();files.forEach(f=>form.append('files',f));const ok=await task(async()=>{const r=await api<{panels:Panel[]}>(`/projects/${projectId}/upload`,form);setPanelId(r.panels[0]?.id);setTab('conversion')},'Files queued for conversion');if(ok){setFiles([]);setDialog(null)}}
 async function saveReview(){if(!panel)return;const ok=await task(()=>api(`/panels/${panel.id}/review`,{settings:panelSettings,bend_angles:decisions,confirm_parameters:confirm,accept_partial_sections:partial,accept_relief_extensions:relief}),'Panel decisions saved. Rebuilding…');if(ok)setTab('conversion')}
 async function showLogs(p:Panel){setPanelId(p.id);setDialog('logs');setLogs([]);if(p.sample){setLogs([{revision:p.revision,status:p.status,log:'Validated reference conversion.\nRead CONTOR, KIFOF and HAT.\nMapped signed section turns and constructed the fold tree.\nBuilt and re-imported a valid STEP solid.\nSection and unfolding results are available in the validation report.'}]);return}try{const r=await api<{jobs:{revision:number;log:string;status:string}[]}>(`/panels/${p.id}/log`,undefined,'GET');setLogs(r.jobs)}catch(e){toast.error((e as Error).message)}}
 async function saveMeasurement(p:Panel,value:string,axis:string){if(!live)return;const n=value===''?null:Number(value);if(n!==null&&(!Number.isFinite(n)||n<=0)){toast.error('Enter a positive measurement in millimetres');return}await task(()=>api(`/panels/${p.id}/measurement`,{value:n,axis},'PUT'))}
 function download(name:string){if(!panel)return;window.open(fileUrl(panel,name),'_blank','noopener')}
 function exports(){return <DropdownMenu><DropdownMenuTrigger asChild><Button disabled={!panel||!panel.artifacts.length} className="download-button"><ArrowDownToLine size={16}/> Export <ChevronDown size={14}/></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="export-menu">{[['panel.step','STEP · BREP solid'],['panel.glb','GLB · 3D preview'],['panel.stl','STL · mesh'],['flat.dxf','DXF · flat pattern'],['flat.dwg','DWG · flat pattern'],['fold_table.csv','CSV · fold table'],['report.json','JSON · validation report']].map(([file,title])=><DropdownMenuItem key={file} disabled={!panel?.artifacts.includes(file)||(panel?.status!=='PASS'&&['panel.step','panel.stl','flat.dwg'].includes(file))} onSelect={()=>download(file)}><Download size={15}/>{title}</DropdownMenuItem>)}<DropdownMenuSeparator/><DropdownMenuItem disabled={!panels.some(p=>p.status==='PASS')} onSelect={()=>window.open(live?`/api/engine/projects/${projectId}/export`:'/samples/project.zip','_blank','noopener')}><Package size={15}/>Whole project · ZIP</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
 if(!data)return <div className="app-loading"><Layers3 size={35}/><h1>FlatForge</h1><LoaderCircle className="spin"/><p>Opening your panel workspace…</p><Button variant="outline" onClick={refresh}>Retry connection</Button><Toaster/></div>;
 return <SidebarProvider style={{'--sidebar-width':'238px'} as React.CSSProperties}><div className="shell"><Sidebar collapsible="none" className="rail"><SidebarHeader><div className="brand"><Layers3/>FlatForge<span>STUDIO</span></div></SidebarHeader>
 <SidebarContent>
 {screen==='home'?(<>
  <div className="rail-label">WORKSPACE</div>
  <SidebarMenu>
   <SidebarMenuItem><SidebarMenuButton className="nav-item active" onClick={goHome}><FolderOpen/><span>Projects</span><span className="nav-count">{data.projects.length}</span></SidebarMenuButton></SidebarMenuItem>
   <SidebarMenuItem><SidebarMenuButton className="nav-item" onClick={openSettings}><Settings2/><span>Material defaults</span></SidebarMenuButton></SidebarMenuItem>
  </SidebarMenu>
 </>):(<>
  <button className="back-to-projects" onClick={goHome}><ArrowLeft size={14}/><span>All projects</span></button>
  <div className="project-navigation" style={{marginBottom:4}}><div className="ws-project-item"><span className="project-symbol"><PanelTop size={15}/></span><span>{project?.name}<small>{project?.client||'No client'}</small></span></div></div>
  <SidebarMenu style={{marginTop:'auto'}}><SidebarMenuItem><SidebarMenuButton className="nav-item" onClick={openSettings}><Settings2/><span>Material defaults</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu>
 </>)}
 </SidebarContent>
 <SidebarFooter><div className="rail-material"><span>DEFAULT MATERIAL</span><strong>Aluminium <small>{data.settings.thickness} mm</small></strong><p>R{data.settings.radius} inside · BD {data.settings.deduction}</p><button onClick={openSettings}>Edit defaults <Settings2 size={13}/></button></div><div className="rail-bottom">FLATFORGE<br/><span>Panel engineering workspace</span></div></SidebarFooter></Sidebar>
 <section className="workspace">
 <header className="topbar">
 {screen==='home'
  ?<div className="breadcrumb"><FolderOpen size={15}/><strong>Projects</strong></div>
  :<div className="breadcrumb"><button className="breadcrumb-link" onClick={goHome}><FolderOpen size={15}/><span>Projects</span></button><ChevronRight size={13}/><strong>{project?.name||'Workspace'}</strong></div>}
 <button className={'engine-state '+(live&&data.capabilities.worker_online?'online':'')} onClick={()=>setDialog('connect')}>{live?(data.capabilities.worker_online?'Python engine connected':'Engine connected · worker offline'):'Sample workspace'}<ExternalLink size={12}/></button>
 </header>

 {screen==='home'?(
 <>
 <div className="page-heading">
  <div>
   <p className="eyebrow">WORKSPACE</p>
   <h1>Projects</h1>
   <p>{data.projects.length?`${data.projects.length} project${data.projects.length===1?'':'s'} · ${data.panels.length} panel${data.panels.length===1?'':'s'} total`:'Create a project to start uploading your fabrication drawings.'}</p>
  </div>
  <div className="heading-actions">
   <Button variant="outline" onClick={openSettings}><Settings2 size={16}/>Material defaults</Button>
   <Button onClick={()=>{setName('');setClient('');setDialog('project')}}><Plus size={16}/>New project</Button>
  </div>
 </div>
 {!live&&<div className="sample-banner"><CircleAlert size={16}/><span>Explore your three validated panels. Connect the Python service to upload drawings and save projects.</span><button onClick={()=>setDialog('connect')}>Connection guide <ChevronRight size={13}/></button></div>}
 {live&&!data.capabilities.worker_online&&<div className="sample-banner warning"><CircleAlert size={16}/><span>The conversion worker is offline. Uploaded files stay safely queued until it reconnects.</span></div>}
 <div className="project-strip">
  <div><span className="strip-icon"><FolderOpen size={18}/></span><strong>{data.projects.length}</strong><span>projects</span></div>
  <div><CircleCheck className="text-green" size={17}/><strong>{data.panels.filter(p=>p.status==='PASS').length}</strong><span>ready</span></div>
  <div><CircleAlert size={17}/><strong>{data.panels.filter(p=>p.status==='NEEDS_REVIEW').length}</strong><span>need review</span></div>
  <div><LoaderCircle size={17}/><strong>{data.panels.filter(p=>activeStatuses.includes(p.status)).length}</strong><span>processing</span></div>
  <div className="strip-material"><span>Material</span><strong>Aluminium</strong><span className="divider"/><span>Units</span><strong>mm</strong></div>
 </div>
 <div className="project-grid">
  {data.projects.map(proj=>{
   const projPanels=data.panels.filter(p=>p.project_id===proj.id);
   const thumbs=projPanels.filter(p=>p.artifacts.includes('extraction.svg')).slice(0,4);
   const readyCount=projPanels.filter(p=>p.status==='PASS').length;
   const reviewCount=projPanels.filter(p=>p.status==='NEEDS_REVIEW').length;
   const processingCount=projPanels.filter(p=>activeStatuses.includes(p.status)).length;
   return(
    <article key={proj.id} className="project-card">
     <button className="project-card-thumb" onClick={()=>chooseProject(proj.id)} aria-label={'Open '+proj.name}>
      {thumbs.length>0
       ?<div className={'thumb-mosaic mosaic-'+Math.min(thumbs.length,4)}>{thumbs.map(p=><img key={p.id} src={fileUrl(p,'extraction.svg')} alt={p.filename}/>)}</div>
       :<div className="thumb-empty"><Layers3 size={30}/><span>{processingCount?`${processingCount} converting`:'No drawings yet'}</span></div>}
      <span className="thumb-count">{projPanels.length} panel{projPanels.length===1?'':'s'}</span>
     </button>
     <div className="project-card-body">
      <div className="card-line">
       <h3>{proj.name}</h3>
       <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={'Manage '+proj.name}><MoreHorizontal size={15}/></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
         <DropdownMenuItem onSelect={()=>chooseProject(proj.id)}><FolderOpen size={14}/>Open project</DropdownMenuItem>
         <DropdownMenuItem disabled={!live} onSelect={()=>{setProjectId(proj.id);setName(proj.name);setClient(proj.client);setDialog('edit_project')}}><Pencil size={14}/>Edit project</DropdownMenuItem>
         <DropdownMenuSeparator/>
         <DropdownMenuItem disabled={!live} onSelect={()=>{setProjectId(proj.id);setDialog('upload')}}><Upload size={14}/>Upload drawings</DropdownMenuItem>
         <DropdownMenuSeparator/>
         <DropdownMenuItem disabled={!live} onSelect={()=>setDeleteTarget({kind:'projects',id:proj.id,name:proj.name})}><Trash2 size={14}/>Delete project</DropdownMenuItem>
        </DropdownMenuContent>
       </DropdownMenu>
      </div>
      <p className="proj-client">{proj.client||'No client assigned'}</p>
      <div className="proj-stats">
       {readyCount>0&&<span className="ps-ready"><CircleCheck size={11}/>{readyCount} ready</span>}
       {reviewCount>0&&<span className="ps-review"><CircleAlert size={11}/>{reviewCount} to review</span>}
       {processingCount>0&&<span className="ps-active"><LoaderCircle size={11} className="spin"/>{processingCount} processing</span>}
       {projPanels.length===0&&<span className="ps-none">No drawings</span>}
      </div>
      <div className="card-actions">
       <Button size="sm" onClick={()=>chooseProject(proj.id)}>Open project<ChevronRight size={13}/></Button>
       <Button size="sm" variant="outline" disabled={!live} onClick={()=>{setProjectId(proj.id);setDialog('upload')}}><Upload size={13}/>Upload</Button>
      </div>
     </div>
    </article>
   );
  })}
  <button className="new-project-card" onClick={()=>{setName('');setClient('');setDialog('project')}} disabled={!live}><Plus size={22}/><strong>New project</strong><span>Create a project to start organizing panel drawings</span></button>
 </div>
 {!data.projects.length&&<div className="empty-state"><FolderOpen size={42}/><h3>No projects yet</h3><p>Create your first project to start uploading and reconstructing your fabrication drawings.</p><Button onClick={()=>{setName('');setClient('');setDialog('project')}}><Plus size={15}/>Create project</Button></div>}
 <footer className="workspace-footer"><span>FlatForge <span>·</span> Evidence-driven panel reconstruction</span><span>STEP / GLB / DXF <span>·</span> Millimetres</span></footer>
 </>
 ):(
 <>
 <div className="page-heading"><div><p className="eyebrow">PROJECT WORKSPACE</p><h1>{project?.name||'Your next panel starts here.'}</h1><p>{project?`${project.client||'No client assigned'} · ${panels.length} panel${panels.length===1?'':'s'}`:'Create a project to upload and reconstruct your fabrication drawings.'}</p></div><div className="heading-actions">{project&&<DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" aria-label="Manage project"><MoreHorizontal size={16}/></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={()=>setTab('panels')}><FolderOpen size={14}/>View project drawings</DropdownMenuItem><DropdownMenuItem disabled={!live} onSelect={editProject}><Pencil size={14}/>Edit project</DropdownMenuItem><DropdownMenuItem disabled={!live} onSelect={()=>setDeleteTarget({kind:'projects',id:project.id,name:project.name})}><Trash2 size={14}/>Delete project</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}<Button variant="outline" onClick={()=>{setName('');setClient('');setDialog('project')}}><Plus size={16}/>New project</Button><Button onClick={()=>setDialog(project?'upload':'project')}><Upload size={16}/>Upload drawings</Button></div></div>
 {!live&&<div className="sample-banner"><CircleAlert size={16}/><span>Explore your three validated panels. Connect the Python service to upload drawings and save projects.</span><button onClick={()=>setDialog('connect')}>Connection guide <ChevronRight size={13}/></button></div>}
 {live&&!data.capabilities.worker_online&&<div className="sample-banner warning"><CircleAlert size={16}/><span>The conversion worker is offline. Uploaded files stay safely queued until it reconnects.</span></div>}
 <div className="project-strip"><div><span className="strip-icon"><Layers3 size={18}/></span><strong>{panels.length}</strong><span>panels</span></div><div><CircleCheck className="text-green" size={17}/><strong>{panels.filter(p=>p.status==='PASS').length}</strong><span>ready</span></div><div><CircleAlert size={17}/><strong>{panels.filter(p=>p.status==='NEEDS_REVIEW').length}</strong><span>need review</span></div><div className="strip-material"><span>Material</span><strong>Aluminium</strong><span className="divider"/><span>Units</span><strong>mm</strong></div></div>
 <Tabs value={tab} onValueChange={setTab} className="workflow"><div className="workflow-bar"><TabsList variant="line" className="workflow-tabs"><TabsTrigger value="panels"><Upload size={15}/><span>01</span> Drawings</TabsTrigger><TabsTrigger value="conversion" disabled={!project}><RotateCw size={15}/><span>02</span> Conversion</TabsTrigger><TabsTrigger value="review" disabled={!canStep('review')}><ScanLine size={15}/><span>03</span> Extract & review</TabsTrigger><TabsTrigger value="calculate" disabled={!canStep('calculate')}><Ruler size={15}/><span>04</span> Calculate</TabsTrigger><TabsTrigger value="viewer" disabled={!canStep('viewer')}><Box size={15}/><span>05</span> 3D studio</TabsTrigger><TabsTrigger value="assembly" disabled={!ready.length}><ArrowLeftRight size={15}/><span>06</span> Assembly</TabsTrigger></TabsList>{exports()}</div>
 <TabsContent value="panels" className="tab-page"><div className={'upload-surface '+(drag?'drag-active':'')} onDragOver={e=>{e.preventDefault();setDrag(true)}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);addFiles(Array.from(e.dataTransfer.files));setDialog(project?'upload':'project')}}><div className="upload-icon"><FileUp/></div><div><h2>Bring your fabrication drawings.</h2><p>Drop DWG or DXF files here. We'll read the layers, sections and bend evidence.</p><span>Up to {data.capabilities.max_upload_mb} MB per file · CONTOR / KIFOF / HAT</span></div><Button variant="outline" onClick={()=>setDialog(project?'upload':'project')}>Browse files <Plus size={15}/></Button></div><div className="section-title"><h2>Project drawings <span>{panels.length}</span></h2><button onClick={refresh}><RotateCw size={14}/>Refresh</button></div><div className="panel-cards">{panels.map((p,i)=><article className="panel-card" key={p.id}><button className="panel-card-preview" onClick={()=>{setPanelId(p.id);setTab(p.artifacts.includes('panel.glb')?'viewer':'review')}}>{p.artifacts.includes('extraction.svg')?<img src={fileUrl(p,'extraction.svg')} alt={'Flat pattern '+p.filename}/>:<FileText size={48}/>}<span>{String(i+1).padStart(2,'0')}</span></button><div className="panel-card-body"><div className="card-line"><h3>{p.filename.replace(/\.dxf$/i,'')}</h3><Status value={p.status}/></div><p>{mm(p.report.flat_width)} × {mm(p.report.flat_height)} mm <span>·</span> {p.report.physical_bends??'—'} hinges</p>{p.report.issues?.length?<div className="card-warning">{p.report.issues[0].message}</div>:<div className="card-meta">{p.report.faces??'—'} faces <span>·</span> {p.settings.thickness} mm aluminium</div>}<div className="card-actions"><Button variant="outline" size="sm" onClick={()=>{setPanelId(p.id);setTab(p.status==='PASS'?'viewer':'review')}}>{p.status==='PASS'?<Box size={14}/>:<ScanLine size={14}/>} {p.status==='PASS'?'Open model':'Review drawing'}</Button>{drawingMenu(p)}<button aria-label={'Conversion log for '+p.filename} onClick={()=>showLogs(p)}><FileText size={16}/></button></div></div></article>)}</div>{!panels.length&&<div className="empty-state"><Layers3/><h3>No panels yet</h3><p>Upload a drawing to begin the extraction and validation workflow.</p></div>}</TabsContent>
 <TabsContent value="conversion" className="tab-page"><div className="section-title"><div><h2>Conversion & processing</h2><p>Actual file status, extracted geometry and results for each drawing.</p></div><button onClick={refresh}><RotateCw size={14}/>Refresh</button></div><div className="conversion-grid">{panels.map(p=><article className={'conversion-card '+(panel?.id===p.id?'selected':'')} key={p.id}><div className="card-line"><button className="table-link" onClick={()=>setPanelId(p.id)}>{p.filename}</button><Status value={p.status}/>{drawingMenu(p)}</div><div className="conversion-preview">{p.artifacts.includes('extraction.svg')?<img src={fileUrl(p,'extraction.svg')} alt={'Rendered DXF '+p.filename}/>:<div className="empty-state">{activeStatuses.includes(p.status)?<LoaderCircle className="spin"/>:<FileText/>}<p>{p.status==='CONVERTING'?'ODA is converting the DWG file…':p.status==='QUEUED'?'Waiting for a CAD worker.':p.report.issues?.[0]?.message||p.error||'Reading drawing entities…'}</p></div>}</div><div className="conversion-facts"><span>Input <strong>{p.filename.split('.').pop()?.toUpperCase()}</strong></span><span>DWG → DXF <strong>{p.report.conversion?.status==='DONE'?'Done · ODA':/\.dxf$/i.test(p.filename)?'Not needed':p.status==='CONVERTING'?'Converting':p.artifacts.includes('flat.dxf')?'Done':'Pending'}</strong></span><span>Geometry <strong>{p.report.physical_bends??'—'} hinges / {p.report.faces??'—'} faces</strong></span></div><p className="conversion-message">{activeStatuses.includes(p.status)?p.report.phase_message||labels[p.status]:p.report.issues?.[0]?.message||p.error||'Solid and validation results are ready.'}</p><div className="card-actions"><Button size="sm" variant="outline" onClick={()=>showLogs(p)}><FileText size={14}/>Processing log</Button><Button size="sm" disabled={!p.artifacts.includes('extraction.svg')&&activeStatuses.includes(p.status)} onClick={()=>{setPanelId(p.id);setTab('review')}}>Review result <ChevronRight size={14}/></Button></div></article>)}</div>{!panels.length&&<div className="empty-state"><FileUp/><p>Upload a drawing to begin.</p></div>}</TabsContent>
 <TabsContent value="review" className="tab-page">{panel?<><div className="section-title"><div className="panel-picker"><select aria-label="Panel to review" value={panel.id} onChange={e=>setPanelId(e.target.value)}>{panels.map(p=><option value={p.id} key={p.id}>{p.filename}</option>)}</select><Status value={panel.status}/></div><div className="heading-actions">{drawingMenu(panel)}<Button variant="outline" size="sm" onClick={()=>showLogs(panel)}><FileText size={15}/>Conversion log</Button></div></div><div className="review-layout"><div className="drawing-window"><div className="drawing-toolbar"><span><ScanLine size={15}/>Extracted flat pattern</span><div><button onClick={()=>setZoom(z=>Math.max(.5,z-.25))} aria-label="Zoom out drawing">−</button><button onClick={()=>setZoom(1)}>{Math.round(zoom*100)}%</button><button onClick={()=>setZoom(z=>Math.min(3,z+.25))} aria-label="Zoom in drawing">+</button></div></div><div className="drawing-canvas">{panel.artifacts.includes('extraction.svg')?<img style={{transform:`scale(${zoom})`}} src={fileUrl(panel,'extraction.svg')} alt="Panel outline, holes, painted side and numbered fold axes"/>:<div className="empty-state"><ScanLine/><p>{activeStatuses.includes(panel.status)?'Extraction is in progress…':'Drawing extraction is not available.'}</p></div>}</div><div className="drawing-legend"><span><i className="contour-key"/>CONTOR</span><span><i className="fold-key"/>KIFOF · bend axes</span><span>PAINT · visible face</span></div></div><aside className="review-inspector"><h3>Drawing evidence</h3><div className="evidence-list"><div><span>Section thickness</span><strong>{panel.report.thickness_evidence?.value!=null?panel.report.thickness_evidence.value+' mm':'Not established'}</strong></div><div><span>Bend deduction</span><strong>{panel.report.deduction_evidence?.value!=null?panel.report.deduction_evidence.value+' mm':'Not established'}</strong></div><div><span>Input interpretation</span><strong>{panel.report.input_evidence?.classification==='flat_pattern_supported'?'Flat pattern supported':'Needs confirmation'}</strong></div></div><h3>Section control</h3>{panel.report.section_mapping?.map(s=><div className="section-evidence" key={s.profile}><ScanLine size={16}/><div><strong>{s.profile.replaceAll('_',' ')}</strong><span>{s.cut_axis} = {mm(s.coordinate)} mm</span></div></div>)}<h3>Layers</h3><div className="layer-tags">{['CONTOR','KIFOF','HAT'].map(l=><span key={l} className={!panel.report.layers?.[l]?'missing':''}>{panel.report.layers?.[l]?<Check size={12}/>:<X size={12}/>} {l} <small>{panel.report.layers?.[l]??0}</small></span>)}</div>{panel.artifacts.includes('section_comparison.png')&&<Button variant="outline" onClick={()=>setDialog('sections')}><ScanLine size={15}/>View section checks</Button>}</aside></div>
 {panel.report.bends?.length?<div className="table-wrap bend-evidence-table"><table className="calculation-table"><thead><tr><th>Bend</th><th>Parent → child</th><th>Signed rotation</th><th>Source section / vertex</th></tr></thead><tbody>{panel.report.bends.map(b=><tr key={b.key}><td>{b.bend_ids.join(' / ')}</td><td>F{b.parent} → F{b.child}</td><td>{b.angle==null?'UNKNOWN':`${b.angle>0?'+':''}${b.angle}°`}</td><td>{b.source.length?Array.from(new Set(b.source.map(s=>`${s.profile} / ${s.vertex??'confirmed'}`))).join('; '):'Needs confirmation'}</td></tr>)}</tbody></table></div>:null}<div className="review-decisions"><div className="section-title"><div><h2>Panel parameters</h2><p>Changes apply to this panel only. Workspace defaults stay unchanged.</p></div><span className="subtle-tag">Revision {panel.revision}</span></div>{panel.report.issues?.map((issue,i)=><div className="issue-card" key={i}><CircleAlert size={18}/><div><strong>{issue.code.replaceAll('_',' ')}</strong><p>{issue.message}</p></div>{issue.field&&issue.suggested!=null&&<Button variant="outline" size="sm" onClick={()=>setPanelSettings(s=>({...s,[issue.field!]:issue.suggested!}))}>Use {issue.suggested} mm</Button>}</div>)}{panel.error&&<div className="issue-card error">{panel.error}</div>}<ParameterFields value={panelSettings} onChange={setPanelSettings}/>{panel.report.unresolved_bends?.map(b=><div className="bend-decision" key={b.key}><div><strong>{b.bend_ids.join(' / ')} · F{b.parent} → F{b.child}</strong><p>{b.reason}</p></div><select aria-label={'Direction for '+b.bend_ids.join('/')} value={decisions[b.key]??''} onChange={e=>setDecisions(d=>({...d,[b.key]:Number(e.target.value)}))}><option value="">Choose direction</option><option value={90}>+90° about parent {b.axis}</option><option value={-90}>−90° about parent {b.axis}</option></select></div>)}<div className="review-checks">{panel.report.issues?.some(i=>i.code==='RELIEF_EXTENSION')&&<label><Checkbox checked={relief} onCheckedChange={c=>setRelief(c===true)}/>I approve the endpoint extensions listed above after inspecting the drawing and draft model.</label>}{panel.report.issues?.some(i=>i.code==='EVIDENCE')&&<label><Checkbox checked={confirm} onCheckedChange={c=>setConfirm(c===true)}/>I confirm these thickness, radius and deduction values.</label>}{panel.report.issues?.some(i=>i.code==='PARTIAL_SECTION')&&<label><Checkbox checked={partial} onCheckedChange={c=>setPartial(c===true)}/>The named section is a partial detail; accept the documented chain check.</label>}</div><div className="review-footer"><span>{panel.sample?'Reference samples are read-only.':`Source: ${panel.filename}`}</span><Button disabled={!live||busy||activeStatuses.includes(panel.status)||panel.report.unresolved_bends?.some(b=>decisions[b.key]===undefined)} onClick={saveReview}>{busy?<LoaderCircle className="spin" size={15}/>:<Check size={15}/>}Save & rebuild panel</Button></div></div></>:<div className="empty-state"><ScanLine/><h3>Select a drawing to review</h3></div>}</TabsContent>
 <TabsContent value="calculate" className="tab-page"><div className="section-title"><div><h2>Panel calculations</h2><p>Compare the drawing-derived dimensions with your manual measurements.</p></div><span className="subtle-tag">All dimensions in mm</span></div><div className="table-wrap"><table className="calculation-table"><thead><tr><th>Panel</th><th>Flat width</th><th>Flat height</th><th>Hinges</th><th>Validation</th><th>Manual measurement</th><th>Difference</th><th/></tr></thead><tbody>{panels.map(p=>{const axis=p.manual_axis||'flat_width';const measured=axis==='flat_width'?p.report.flat_width:axis==='flat_height'?p.report.flat_height:p.report.bbox?.[['folded_x','folded_y','folded_z'].indexOf(axis)];const delta=p.manual_value!=null&&measured!=null?p.manual_value-measured:null;return <tr key={p.id}><td><strong>{p.filename.replace(/\.dxf$/i,'')}</strong><small>{p.settings.thickness} mm · R{p.settings.radius}</small></td><td>{mm(p.report.flat_width)}</td><td>{mm(p.report.flat_height)}</td><td>{p.report.physical_bends??'—'}</td><td><Status value={p.status}/>{p.report.issues?.[0]&&<small className="table-reason">{p.report.issues[0].message}</small>}</td><td><div className="manual-entry"><select disabled={!live} aria-label={'Measurement axis for '+p.filename} value={axis} onChange={e=>saveMeasurement(p,p.manual_value?.toString()||'',e.target.value)}><option value="flat_width">Flat width</option><option value="flat_height">Flat height</option><option value="folded_x">Folded X</option><option value="folded_y">Folded Y</option><option value="folded_z">Folded Z</option></select><input key={p.id+axis} disabled={!live} type="number" min="0" placeholder="Enter mm" aria-label={'Manual measurement for '+p.filename} defaultValue={p.manual_value??''} onBlur={e=>{if(e.target.value!==(p.manual_value?.toString()||''))saveMeasurement(p,e.target.value,axis)}}/></div></td><td className={delta!==null&&Math.abs(delta)>.5?'difference-warning':''}>{delta===null?'—':`${delta>0?'+':''}${mm(delta)}`}</td><td><button className="table-link" onClick={()=>{setPanelId(p.id);setTab('review')}}>Adjust <ChevronRight size={13}/></button></td></tr>})}</tbody></table></div><div className="calculation-note"><CircleAlert size={16}/><span>PASS requires a valid solid and accepted drawing checks. Unresolved directions stay in review; they are never guessed.</span></div></TabsContent>
 <TabsContent value="viewer" className="studio"><div className="studio-panels"><div className="studio-panel-title"><span>PANELS</span><small>{panels.length}</small></div>{panels.map((p,i)=><button key={p.id} className={'studio-panel '+(panel?.id===p.id?'selected':'')} onClick={()=>{setPanelId(p.id);setAssembly(false);setFraction(1)}}><div className="mini-panel">{p.artifacts.includes('extraction.svg')?<img src={fileUrl(p,'extraction.svg')} alt=""/>:<FileText size={24}/>}</div><div><strong>{p.filename.replace(/\.dxf$/i,'')}</strong><small>{p.report.physical_bends??'—'} hinges · {p.settings.thickness} mm</small><Status value={p.status}/></div></button>)}<button className="add-panel" onClick={()=>setDialog(project?'upload':'project')}><Plus size={15}/>Add drawing</button><div className="studio-tip"><ScanLine size={17}/><p>Every fold keeps a link to its source section. Hover over a bend to inspect it.</p></div></div><div className="studio-main"><div className="viewer-toolbar"><div className="segmented"><button className={fraction===1?'selected':''} onClick={()=>{setPlaying(false);setFraction(1)}}><Box size={14}/>Folded</button><button className={fraction===0?'selected':''} onClick={()=>{setPlaying(false);setFraction(0)}}><PanelTop size={14}/>Flat</button></div><div className="toolbar-right"><select aria-label="Camera view" value={view3d} onChange={e=>setView3d(e.target.value)}><option value="iso">Isometric</option><option value="top">Top</option><option value="front">Front</option><option value="side">Side</option></select><button className={assembly?'toolbar-button selected':'toolbar-button'} disabled={ready.length<2} onClick={()=>{setAssembly(!assembly);setCompare(ready.slice(0,3).map(p=>p.id))}}><ArrowLeftRight size={15}/><span>Compare</span></button></div></div>{assembly&&<div className="assembly-bar"><span>Side by side</span>{ready.map(p=><label key={p.id}><Checkbox checked={compare.includes(p.id)} disabled={!compare.includes(p.id)&&compare.length>=5} onCheckedChange={c=>setCompare(ids=>c?[...ids,p.id]:ids.filter(id=>id!==p.id))}/>{p.filename.replace(/\.dxf$/i,'')}</label>)}<label>Gap <input type="number" min="0" max="5000" value={gap} onChange={e=>setGap(Math.max(0,Math.min(5000,Number(e.target.value))))}/>mm</label><select aria-label="Assembly alignment" value={alignment} onChange={e=>setAlignment(e.target.value)}><option value="center">Centre</option><option value="near">Near edge</option><option value="far">Far edge</option></select></div>}<div className="viewer-wrapper">{selectedModels.length&&(!assembly||selectedModels.length>=2)?<ModelViewer panels={selectedModels} fraction={fraction} gap={gap} alignment={alignment} paint={paint} wire={wire} view={view3d} onHover={setHover}/>:<div className="viewer-empty"><Box size={42}/><h3>{assembly?'Select 2–5 panels':'Your solid will appear here'}</h3><p>{panel?.status==='NEEDS_REVIEW'?'Confirm the highlighted drawing evidence to finish reconstruction.':panel?.status==='FAILED'?'Review the conversion log to see what needs correcting.':'Upload a drawing to start the conversion.'}</p>{panel&&<Button variant="outline" onClick={()=>setTab('review')}>Review drawing <ChevronRight size={15}/></Button>}</div>}{hover&&<div className="bend-tooltip"><Layers3 size={15}/>{hover}</div>}</div><div className="fold-timeline"><Button variant="ghost" size="icon" aria-label={playing?'Pause fold animation':'Play fold animation'} disabled={!selectedModels.length} onClick={()=>setPlaying(!playing)}>{playing?<Pause size={17}/>:<Play size={17}/>}</Button><span>Fold sequence</span><Slider aria-label="Fold progress" min={0} max={100} step={1} value={[Math.round(fraction*100)]} onValueChange={v=>{setPlaying(false);setFraction(v[0]/100)}}/><strong>{Math.round(fraction*100)}%</strong></div><div className="viewer-bottom"><span><i/>Painted face</span><span>Motion preview · export uses final BREP solid</span></div></div><aside className="model-inspector"><div className="inspector-title"><h3>Panel details</h3><Box size={17}/></div>{panel?<><div className="inspector-name">{panel.filename.replace(/\.dxf$/i,'')}<Status value={panel.status}/></div><h4>FOLDED ENVELOPE</h4><div className="dimension-grid">{['X','Y','Z'].map((a,i)=><div key={a}><span>{a}</span><strong>{mm(panel.report.bbox?.[i])}</strong><small>mm</small></div>)}</div><h4>MATERIAL & BENDS</h4><dl className="properties"><div><dt>Material</dt><dd>Aluminium</dd></div><div><dt>Thickness</dt><dd>{panel.settings.thickness} mm</dd></div><div><dt>Inside radius</dt><dd>R{panel.settings.radius}</dd></div><div><dt>Deduction / 90°</dt><dd>{panel.settings.deduction} mm</dd></div><div><dt>Physical hinges</dt><dd>{panel.report.physical_bends??'—'}</dd></div><div><dt>Rigid faces</dt><dd>{panel.report.faces??'—'}</dd></div></dl><h4>DISPLAY</h4><div className="display-options"><label><Checkbox checked={paint} onCheckedChange={c=>setPaint(c===true)}/>Painted face colour</label><label><Checkbox checked={wire} onCheckedChange={c=>setWire(c===true)}/>Wireframe</label></div><h4>VALIDATION</h4><div className="validation-compact">{panel.report.section_checks?.map(s=><div key={s.profile}><span>{s.chain_status==='PASS'?<Check size={14}/>:<CircleAlert size={14}/>}</span><div>{s.profile.replaceAll('_',' ')}<small>{mm(s.max_length_error_mm)} mm max error{s.full_plane_status==='FAIL'?' · partial detail':''}</small></div></div>)}{panel.report.unfold_check&&<div><Check size={14}/><div>Unfold comparison<small>{panel.report.unfold_check.symmetric_difference_percent.toFixed(4)}% area difference</small></div></div>}</div><button className="inspector-link" onClick={()=>setTab('review')}>Inspect drawing evidence <ChevronRight size={13}/></button></>:<p>Select a panel.</p>}</aside></TabsContent><TabsContent value="assembly" className="tab-page">
 <div className="asm-studio">
  {/* Left panel: entry list */}
  <div className="asm-pane">
   <div className="asm-pane-header"><span>ASSEMBLY</span>{asmEntries.length>0&&<button onClick={()=>setAsmEntries([])} title="Clear all"><X size={13}/> Clear</button>}</div>
   {asmEntries.length===0&&<div className="asm-empty"><Box size={28}/><p>Add panels and connect them face-to-face to build the assembly.</p></div>}
   {asmEntries.map((entry,i)=>{
    const p=ready.find(p=>p.id===entry.panelId);
    return(
     <div key={entry.id} className="asm-entry">
      <div className="asm-entry-head">
       <strong className="asm-letter">{String.fromCharCode(65+i)}</strong>
       <span className="asm-name" title={p?.filename}>{p?.filename.replace(/\.(dxf|dwg)$/i,'')}</span>
       <button className="asm-remove" onClick={()=>asmRemove(entry.id)} title="Remove"><X size={13}/></button>
      </div>
      {entry.targetId===null
       ?<p className="asm-root">Root · placed at origin</p>
       :<div className="asm-conn">
        <select className="face-sel" value={entry.myFace} onChange={e=>asmSetMyFace(entry.id,e.target.value as Face)}>
         {FACES.map(([f,l])=><option key={f} value={f}>{l}</option>)}
        </select>
        <span className="conn-arrow">→</span>
        <select className="face-sel" value={entry.targetFace!} onChange={e=>asmSetTargetFace(entry.id,e.target.value as Face)}>
         {FACES.map(([f,l])=><option key={f} value={f}>{l}</option>)}
        </select>
        <span>of</span>
        <select className="target-sel" value={entry.targetId} onChange={e=>asmSetTarget(entry.id,e.target.value)}>
         {asmEntries.slice(0,i).map((e2,j)=>{const p2=ready.find(p=>p.id===e2.panelId);return <option key={e2.id} value={e2.id}>{String.fromCharCode(65+j)} · {p2?.filename.replace(/\.(dxf|dwg)$/i,'')}</option>;})}
        </select>
       </div>}
      {entry.targetId!==null&&<div className="asm-gap-row">Gap <input type="number" min={0} step={1} value={entry.gap} onChange={e=>asmSetGap(entry.id,Number(e.target.value))}/> mm</div>}
     </div>
    );
   })}
   <button className="asm-add-btn" disabled={!ready.length} onClick={()=>{setAddPanelId('');setAddTargetId(asmEntries[asmEntries.length-1]?.id||'');setAddMyFace('-X');setAddTargetFace('+X');setDialog('assembly_add');}}><Plus size={15}/>{asmEntries.length===0?'Add first panel':'Add next panel'}</button>
   {!ready.length&&<p className="asm-hint">Process panels to completion (PASS) to enable assembly.</p>}
   {asmEntries.length>1&&<div className="asm-summary"><span>{asmEntries.length} panels</span><span>·</span><span>{asmEntries.length-1} connection{asmEntries.length>2?'s':''}</span></div>}
  </div>
  {/* 3D viewer */}
  <div className="asm-viewer-wrap">
   <AssemblyViewer ref={asmViewRef} entries={asmEntries} panels={ready} paint={paint} wire={wire}/>
  </div>
  {/* Right: face reference */}
  <div className="asm-inspector">
   <p className="inspector-section">FACE REFERENCE</p>
   <div className="face-ref">
    {FACES.map(([face,label])=>(
     <div key={face} className="face-ref-row">
      <code>{face}</code><span>{label.split(' ')[0]}</span>
     </div>
    ))}
   </div>
   <p className="inspector-section" style={{marginTop:22}}>DISPLAY</p>
   <div className="display-options">
    <label><Checkbox checked={paint} onCheckedChange={c=>setPaint(c===true)}/>Painted face colour</label>
    <label><Checkbox checked={wire} onCheckedChange={c=>setWire(c===true)}/>Wireframe</label>
   </div>
   <p className="inspector-section" style={{marginTop:22}}>CLASH DETECTION</p>
   <Button size="sm" variant="outline" className="clash-check-btn" disabled={asmEntries.length<2||clashRunning} onClick={runClashCheck}>
    {clashRunning?<LoaderCircle size={13} className="spin"/>:<ScanLine size={13}/>}
    {clashRunning?'Checking…':'Run clash check'}
   </Button>
   {clashResults!==null&&(
    <div className="clash-report">
     {clashResults.length===0?(
      <div className="clash-ok"><CircleCheck size={14}/><span>No clashes — all clear</span></div>
     ):(
      <>
       <div className="clash-warn"><CircleAlert size={14}/><strong>{clashResults.length} clash{clashResults.length>1?'es':''} detected</strong></div>
       {clashResults.map((r,i)=>{
        const la=String.fromCharCode(65+asmEntries.findIndex(e=>e.id===r.entryIdA));
        const lb=String.fromCharCode(65+asmEntries.findIndex(e=>e.id===r.entryIdB));
        return(
         <div key={i} className="clash-item">
          <span className="clash-pair">Panel {la} ↔ Panel {lb}</span>
          <div className="clash-meta">
           <span className="clash-depth">{r.depth.toFixed(1)} mm</span>
           <span className="clash-pts">{r.pointCount} pt{r.pointCount>1?'s':''}</span>
          </div>
         </div>
        );
       })}
       <p className="clash-note">Clashing panels highlighted red in the viewer. Adjust gaps or face connections to resolve.</p>
      </>
     )}
    </div>
   )}
   <p className="inspector-section" style={{marginTop:22}}>HOW TO</p>
   <ol className="asm-how">
    <li>Add the <strong>root panel</strong> — it anchors the assembly at the origin.</li>
    <li>Add each <strong>next panel</strong>, pick which face of the new panel meets which face of an existing panel.</li>
    <li>Set the <strong>gap</strong> in mm (sealant / structural gap between faces).</li>
    <li>Edit any connection inline, or remove and re-add a panel to change it.</li>
   </ol>
  </div>
 </div>
</TabsContent>
<div className="wizard-navigation"><Button variant="outline" disabled={stepIndex<=0||tab==='assembly'} onClick={()=>setTab(steps[stepIndex-1])}><ArrowLeft size={15}/>Back</Button><span>{tab==='assembly'?`Assembly · ${asmEntries.length} panel${asmEntries.length===1?'':'s'}`:`Step ${stepIndex+1} of 5${panel?` · ${panel.filename}`:''}`}</span>{stepIndex<4&&tab!=='assembly'?<Button disabled={!canStep(steps[stepIndex+1])} onClick={()=>setTab(steps[stepIndex+1])}>Continue to {['Drawings','Conversion','Review','Calculate','3D studio'][stepIndex+1]}<ChevronRight size={15}/></Button>:tab!=='assembly'?exports():<span/>}</div></Tabs>
 <footer className="workspace-footer"><span>FlatForge <span>·</span> Evidence-driven panel reconstruction</span><span>STEP / GLB / DXF <span>·</span> Millimetres</span></footer>
 </>
 )}
 </section></div>
 <Dialog open={dialog!==null} onOpenChange={open=>{if(!open)setDialog(null)}}><DialogContent className={dialog==='sections'?'wide-dialog':dialog==='logs'?'log-dialog':''}><DialogHeader><DialogTitle>{dialog==='edit_project'?'Edit project':dialog==='edit_drawing'?'Edit drawing':dialog==='project'?'Create a project':dialog==='upload'?'Upload panel drawings':dialog==='settings'?'Material defaults':dialog==='logs'?'Conversion log':dialog==='sections'?'Section comparison':dialog==='assembly_add'?'Add panel to assembly':'Connect the conversion service'}</DialogTitle><DialogDescription>{dialog==='edit_project'?'Update this project\u2019s name and client.':dialog==='edit_drawing'?'Rename the drawing or replace its source file. A replacement clears old bend decisions and results.':dialog==='project'?'Keep all drawings and results for one client together.':dialog==='upload'?'Files are checked against this project\u2019s material settings.':dialog==='settings'?'Defaults apply to new panels. Existing panels keep their own parameters.':dialog==='logs'?'Conversion history and exact processing messages.':dialog==='sections'?'Actual solid cuts compared with the drawing section profiles.':dialog==='assembly_add'?'Select a panel and define which of its faces connects to an existing panel in the assembly.':'The interface is ready. Live conversion requires the supplied Python CAD service.'}</DialogDescription></DialogHeader>
 {(dialog==='project'||dialog==='edit_project')&&<><div className="field"><Label htmlFor="project-name">Project name</Label><Input id="project-name" placeholder="e.g. North elevation panels" value={name} onChange={e=>setName(e.target.value)}/></div><div className="field"><Label htmlFor="client-name">Client name</Label><Input id="client-name" placeholder="Client or contractor" value={client} onChange={e=>setClient(e.target.value)}/></div>{!live&&<div className="dialog-notice">Project creation becomes available when the Python service is connected. Sample projects are read-only.</div>}<Button disabled={!live||!name.trim()||busy} onClick={dialog==='edit_project'?saveProject:create}>{busy?<LoaderCircle className="spin"/>:<Plus/>}{dialog==='edit_project'?'Save project':'Create project'}</Button></>}
 {dialog==='edit_drawing'&&panel&&<><div className="field"><Label htmlFor="drawing-name">Drawing filename</Label><Input id="drawing-name" disabled={!!replacement} value={drawingName} onChange={e=>setDrawingName(e.target.value)}/></div><div className="field"><Label htmlFor="replace-source">Replace source (optional)</Label><Input id="replace-source" type="file" accept=".dxf,.dwg" disabled={['CONVERTING','EXTRACTING','BUILDING'].includes(panel.status)} onChange={e=>{const file=e.target.files?.[0];if(file&&(!/\.(dxf|dwg)$/i.test(file.name)||file.size>data.capabilities.max_upload_mb*1024*1024)){toast.error('Select a DXF/DWG within the upload size limit');e.target.value='';return}setReplacement(file||null)}}/></div>{replacement&&<div className="dialog-notice">{replacement.name} will replace this source. The panel keeps its project and material settings, and all geometry will be recalculated.</div>}<Button disabled={!live||busy||!drawingName.trim()} onClick={saveDrawing}>Save drawing</Button></>}
 {dialog==='upload'&&<><input ref={input} type="file" accept=".dxf,.dwg" multiple className="sr-only" onChange={e=>{addFiles(Array.from(e.target.files||[]));e.target.value=''}}/><button className={'modal-drop '+(drag?'drag-active':'')} onClick={()=>input.current?.click()} onDragOver={e=>{e.preventDefault();setDrag(true)}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);addFiles(Array.from(e.dataTransfer.files))}}><Upload size={30}/><strong>Drop your drawings here</strong><span>or click to browse · DWG / DXF · {data.capabilities.max_upload_mb} MB max</span></button><div className="upload-file-list">{files.map((f,i)=><div key={i}><FileText size={16}/><span>{f.name}<small>{(f.size/1024).toFixed(0)} KB</small></span><button aria-label={'Remove '+f.name} onClick={()=>setFiles(v=>v.filter((_,j)=>j!==i))}><X size={15}/></button></div>)}</div>{!data.capabilities.dwg&&files.some(f=>/\.dwg$/i.test(f.name))&&<div className="dialog-notice">DWG files will need review until ODA File Converter is installed on the worker. DXF conversion is available with the Python service.</div>}{!live&&<div className="dialog-notice">Uploads are unavailable in the sample workspace. Connect the Python service to process your own drawings.</div>}<Button disabled={!live||!files.length||busy||!project} onClick={upload}>{busy?<LoaderCircle className="spin"/>:<Upload/>}Upload {files.length||''} drawing{files.length===1?'':'s'}</Button></>}
 {dialog==='settings'&&<><ParameterFields value={defaults} onChange={setDefaults}/><div className="dialog-notice">Inside radius cannot be recovered from sharp schematic sections. Use your fabrication standard. Folded-dimension inputs are flagged for a developed-pattern review.</div><Button disabled={!live||busy} onClick={async()=>{if(await task(()=>api('/settings',defaults,'PUT'),'Workspace defaults saved'))setDialog(null)}}><Check size={16}/>Save defaults</Button>{!live&&<small className="muted">Sample defaults are read-only.</small>}</>}
 {dialog==='logs'&&<div className="logs">{logs.length?logs.map((l,i)=><div key={i}><h4>Revision {l.revision} <span>{l.status}</span></h4><pre>{l.log}</pre></div>):<LoaderCircle className="spin"/>}</div>}
 {dialog==='sections'&&panel&&<img className="section-image" src={fileUrl(panel,'section_comparison.png')} alt="Overlay of drawing sections and actual solid sections"/>}
 {dialog==='assembly_add'&&<>
  <div className="field"><Label>Panel</Label>
   <select value={addPanelId} onChange={e=>setAddPanelId(e.target.value)}>
    <option value="">Select a panel…</option>
    {ready.map(p=><option key={p.id} value={p.id}>{p.filename.replace(/\.(dxf|dwg)$/i,'')}</option>)}
   </select>
  </div>
  {asmEntries.length>0&&<>
   <div className="field"><Label>Connect to existing panel</Label>
    <select value={addTargetId} onChange={e=>setAddTargetId(e.target.value)}>
     <option value="">Select…</option>
     {asmEntries.map((e,i)=>{const p=ready.find(p=>p.id===e.panelId);return <option key={e.id} value={e.id}>{String.fromCharCode(65+i)} · {p?.filename.replace(/\.(dxf|dwg)$/i,'')}</option>;})}
    </select>
   </div>
   <div className="asm-face-row">
    <div className="field"><Label>New panel's mating face</Label><FacePicker value={addMyFace} onChange={setAddMyFace}/></div>
    <span className="face-row-arrow">→</span>
    <div className="field"><Label>Target panel's mating face</Label><FacePicker value={addTargetFace} onChange={setAddTargetFace}/></div>
   </div>
   <div className="field"><Label>Gap between faces</Label><div className="unit-input"><Input type="number" min={0} step={1} value={addGap} onChange={e=>setAddGap(Math.max(0,Number(e.target.value)))}/><span>mm</span></div></div>
  </>}
  <Button disabled={!addPanelId||(asmEntries.length>0&&!addTargetId)} onClick={asmAddEntry}><Plus/>Add to assembly</Button>
 </>}
 {dialog==='connect'&&<div className="connection-guide"><div className="connection-status"><Box/><div><strong>{live?'Python API connected':'Python API not connected'}</strong><p>{live?(data.capabilities.worker_online?'CAD worker is accepting jobs.':'Start the CAD worker to process queued jobs.'):'Your reference models remain available for inspection and download.'}</p></div></div><ol><li>Deploy the included Python API and CAD worker containers with PostgreSQL and shared file storage.</li><li>Set <code>FLATFORGE_API_URL</code> and the matching <code>FLATFORGE_API_KEY</code> on this site.</li><li>Rebuild the supplied Docker stack to install ODA automatically for DWG input and export.</li></ol><p>Use the architecture guide for setup, operating limits and scaling.</p><div className="heading-actions"><a className="table-link" href="/downloads/ARCHITECTURE.md" download>Architecture guide ↗</a><a className="table-link" href="/downloads/FlatForge-source.zip" download>Download source package ↗</a></div><Button variant="outline" onClick={refresh}><RotateCw size={15}/>Check connection</Button></div>}
 </DialogContent></Dialog><AlertDialog open={!!deleteTarget} onOpenChange={open=>{if(!open)setDeleteTarget(null)}}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete {deleteTarget?.kind==='projects'?'project':'drawing'}?</AlertDialogTitle><AlertDialogDescription>{deleteTarget?.name} will be removed from this workspace{deleteTarget?.kind==='projects'?', including its drawings':''}. Queued and running conversions will be cancelled. You can undo this deletion from the confirmation notification.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={e=>{e.preventDefault();void removeItem()}}>Delete</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog><Toaster richColors position="bottom-right"/></SidebarProvider>
}
