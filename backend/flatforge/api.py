import os, json, time, uuid, tempfile, hashlib, hmac, zipfile, shutil
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Literal
from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Header, BackgroundTasks, Request
from fastapi.responses import StreamingResponse, FileResponse
from pydantic import BaseModel, Field, ConfigDict, field_validator, ValidationError
from sqlalchemy import select, func, update
from sqlalchemy.exc import IntegrityError
from .db import init, Session, Project, Panel, Job, Setting
from .storage import store
from .dwg import available as dwg_available
from .parameters import Parameters, ParameterOverrides, BendOverride, DEFAULTS
from .review_files import select_review, MAX_REVIEW_BYTES
from . import tolerance_policy
MAX_BYTES=int(os.getenv('MAX_UPLOAD_MB','50'))*1024*1024
@asynccontextmanager
async def lifespan(app):
 if len(os.getenv('FLATFORGE_API_KEY',''))<24:raise RuntimeError('Set FLATFORGE_API_KEY to a random secret of at least 24 characters.')
 init()
 try:
  with Session.begin() as s:
   if not s.get(Setting,'defaults'):s.add(Setting(key='defaults',value=json.dumps(DEFAULTS)))
 except IntegrityError:pass
 yield
app=FastAPI(title='FlatForge CAD API',version='1.1.0',lifespan=lifespan)
def auth(request:Request,x_flatforge_key:str=Header(default=''),x_flatforge_project_id:str|None=Header(default=None)):
 expected=os.getenv('FLATFORGE_API_KEY','')
 if not expected or not hmac.compare_digest(x_flatforge_key,expected):raise HTTPException(401,'Authentication required')
 # Current clients send their route's project context. Check it before any
 # panel read/write; retain compatibility with existing workspace API clients.
 if x_flatforge_project_id is not None and request.url.path.startswith('/panels/'):
  with Session() as s:
   panel=s.get(Panel,request.path_params.get('id'))
   project=s.get(Project,x_flatforge_project_id)
   if not panel or panel.project_id!=x_flatforge_project_id or not project or project.deleted_at is not None:
    raise HTTPException(404,'Drawing is not available in this project')
def get_panel(s,id):
 p=s.get(Panel,id)
 if not p or p.deleted_at is not None:raise HTTPException(404,'Panel not found')
 return p
def pack_panel(p):
 configured={**DEFAULTS,**json.loads(p.settings)};report=json.loads(p.report)
 # A queued revision must not display the preceding revision's measurements.
 effective=report.get('settings',configured) if p.status not in ['QUEUED','CONVERTING','EXTRACTING','BUILDING'] else configured
 return {'id':p.id,'project_id':p.project_id,'filename':p.filename,'status':p.status,'settings':effective,'configured_settings':configured,'overrides':json.loads(p.overrides),'report':report,'artifacts':list(json.loads(p.artifacts)),'error':p.error,'manual_value':p.manual_value,'manual_axis':p.manual_axis,'revision':p.revision,'created':p.created,'updated':p.updated}
class ProjectInput(BaseModel):
 name:str=Field(min_length=1,max_length=160);client:str=Field(default='',max_length=160)
class ReviewInput(BaseModel):
 model_config=ConfigDict(extra='forbid',allow_inf_nan=False)
 expected_revision:int|None=Field(default=None,ge=1)
 settings:Parameters|None=None
 parameter_overrides:ParameterOverrides=Field(default_factory=ParameterOverrides)
 bend_angles:dict[str,float|None]=Field(default_factory=dict)
 bend_parameters:dict[str,BendOverride]=Field(default_factory=dict)
 section_choices:dict[str,str|None]=Field(default_factory=dict)
 relief_radii:dict[str,float|None]=Field(default_factory=dict)
 manual_bends:bool|None=None
 review_note:str|None=Field(default=None,max_length=2000)
 confirm_parameters:bool=False;accept_partial_sections:bool=False
 accept_relief_extensions:bool=False
 accept_corner_reliefs:bool=False
 @field_validator('bend_angles')
 @classmethod
 def angles_valid(cls,values):
  for angle in values.values():
   if angle is not None:BendOverride(angle=angle)
  return values

def validate_review_decisions(report,body):
 allowed={b['key'] for field in ('bends','unresolved_bends','unmapped_hinges') for b in report.get(field,[])}
 if (set(body.bend_angles)|set(body.bend_parameters))-allowed:raise HTTPException(422,'Unknown bend key in review decision')
 for key,values in body.bend_parameters.items():
  if values.angle is not None and body.bend_angles.get(key) is not None and values.angle!=body.bend_angles[key]:
   raise HTTPException(422,'Conflicting rotations supplied for the same bend')
 circles={c['handle']:c for c in report.get('relief_circles',[])}
 for handle,radius in body.relief_radii.items():
  if handle not in circles:raise HTTPException(422,'Unknown corner-relief circle')
  if radius is not None and not circles[handle]['original_radius_mm']<=radius<=circles[handle]['max_radius_mm']:
   raise HTTPException(422,'Corner-relief radius is outside the permitted range; shrinking cuts is not allowed')
 choices={row['profile']:{v['id'] for v in row.get('review_candidates',[])} for row in report.get('section_mapping',[])}
 for profile,choice in body.section_choices.items():
  if choice is not None and choice not in choices.get(profile,set()):raise HTTPException(422,'Unknown section chain. Refresh the drawing review before selecting it.')
 return allowed

@app.post('/panels/{id}/review-file',dependencies=[Depends(auth)])
async def preview_review_file(id:str,file:UploadFile=File(...)):
 # Preview only: source identity comes from this revision's extracted DXF.
 raw=await file.read(MAX_REVIEW_BYTES+1)
 if len(raw)>MAX_REVIEW_BYTES:raise HTTPException(413,'Review file exceeds 1 MB')
 with Session() as s:
  p=get_panel(s,id)
  if p.status in ['QUEUED','CONVERTING','EXTRACTING','BUILDING']:raise HTTPException(409,'Wait for the current conversion to finish')
  report=json.loads(p.report);digest=report.get('source_sha256')
  if not digest:raise HTTPException(409,'Extract the drawing successfully before importing review values')
  try:
   entry=select_review(raw,digest)
   incoming=dict(entry['overrides'])
   if {'settings','expected_revision'}&incoming.keys():raise ValueError('Put settings in the settings object; revision is assigned by the application.')
   settings=Parameters(**{**DEFAULTS,**json.loads(p.settings),**entry['settings']})
   body=ReviewInput(**incoming,settings=settings,expected_revision=p.revision)
  except (ValueError,TypeError,ValidationError) as exc:
   raise HTTPException(422,str(exc)) from exc
  allowed=validate_review_decisions(report,body)
  if any(v is not None for v in body.relief_radii.values()) and not (body.review_note or '').strip():
   raise HTTPException(422,'The review file must identify the source of corner-cut values')
  previous=json.loads(p.overrides)
  result=body.model_dump()
  # Imported values are explicit review decisions, not new workspace rules.
  result['parameter_overrides']={field:entry['settings'].get(field) for field in ('thickness','radius','deduction')}
  result['parameter_overrides'].update(body.parameter_overrides.model_dump(exclude_unset=True))
  result['manual_bends']=body.manual_bends is True;result['review_note']=body.review_note or ''
  # Replace prior decisions, including omitted angles, so stale values cannot
  # silently complete an incomplete imported schedule.
  for field,empty in [('bend_parameters',{}),('section_choices',None),('relief_radii',None)]:
   result[field]={**{key:empty for key in previous.get(field,{})},**result[field]}
  for key,angle in body.bend_angles.items():
   if angle is not None:result['bend_parameters'][key]={**result['bend_parameters'].get(key,{}),'angle':angle}
  result['bend_angles']={key:None for key in previous.get('bend_angles',{})}
  explicit={key for key,values in result['bend_parameters'].items() if values.get('angle') is not None}
  return {'review':result,'source_sha256':digest,'explicit_angles':len(explicit),
          'missing_bend_keys':sorted(allowed-explicit) if body.manual_bends else [],
          'inherited_settings':sorted(set(DEFAULTS)-entry['settings'].keys()),
          'message':'Values are staged for inspection. Nothing is saved until Save & rebuild.'}
class MeasurementInput(BaseModel):
 value:float|None=Field(default=None,gt=0,le=1000000)
 axis:Literal['flat_width','flat_height','folded_x','folded_y','folded_z']='flat_width'
def capabilities():
 with Session() as s:
  heartbeat=s.get(Setting,'worker_heartbeat');last=float(heartbeat.value) if heartbeat else 0
 return {'engine':'python-opencascade','connected':True,'worker_online':time.time()-last<60,'dwg':dwg_available(),'max_upload_mb':MAX_BYTES//1024//1024,'drawing_tolerances_enforced':tolerance_policy.ENFORCE_DRAWING_TOLERANCES,'exports':['step','glb','stl','dxf','csv','json']+(['dwg'] if dwg_available() else [])}
@app.get('/health')
def health():return {'status':'ok','service':'FlatForge CAD API'}
@app.get('/bootstrap',dependencies=[Depends(auth)])
def bootstrap():
 with Session() as s:
  projects=[{'id':p.id,'name':p.name,'client':p.client,'created':p.created} for p in s.scalars(select(Project).where(Project.deleted_at.is_(None)).order_by(Project.created.desc()))]
  panels=[pack_panel(p) for p in s.scalars(select(Panel).where(Panel.deleted_at.is_(None)).order_by(Panel.created))]
  defaults={**DEFAULTS,**json.loads(s.get(Setting,'defaults').value)}
 return {'mode':'live','capabilities':capabilities(),'settings':defaults,'projects':projects,'panels':panels}
@app.put('/settings',dependencies=[Depends(auth)])
def settings(p:Parameters):
 with Session.begin() as s:s.get(Setting,'defaults').value=json.dumps(p.model_dump())
 return p.model_dump()
@app.post('/projects',dependencies=[Depends(auth)],status_code=201)
def create_project(p:ProjectInput):
 if not p.name.strip():raise HTTPException(422,'Project name cannot be blank')
 with Session.begin() as s:
  project=Project(name=p.name.strip(),client=p.client.strip());s.add(project);s.flush();result={'id':project.id,'name':project.name,'client':project.client,'created':project.created}
 return result
@app.post('/projects/{project_id}/upload',dependencies=[Depends(auth)],status_code=202)
async def upload(project_id:str,files:list[UploadFile]=File(...)):
 if not 1<=len(files)<=20:raise HTTPException(422,'Upload between 1 and 20 files at a time')
 with Session() as s:
  get_project(s,project_id)
  defaults=s.get(Setting,'defaults').value
 # Validate every file before adding rows: one bad file cannot cause a half-import.
 staged=[]
 with tempfile.TemporaryDirectory(prefix='ff-upload-') as td:
  for file in files:
   filename=Path((file.filename or '').replace('\\','/')).name[:240];ext=Path(filename).suffix.lower()
   if ext not in ['.dxf','.dwg']:raise HTTPException(415,f'{filename}: only DXF and DWG files are accepted')
   id=str(uuid.uuid4());p=Path(td)/(id+ext);size=0
   with p.open('wb') as f:
    while chunk:=await file.read(1024*1024):
     size+=len(chunk)
     if size>MAX_BYTES:raise HTTPException(413,f'{filename}: file exceeds {MAX_BYTES//1024//1024} MB')
     f.write(chunk)
   if not size:raise HTTPException(422,f'{filename}: empty file')
   with p.open('rb') as header_file:head=header_file.read(8192)
   if ext=='.dwg' and not head.startswith(b'AC10'):raise HTTPException(422,f'{filename}: invalid DWG header')
   if ext=='.dxf' and b'SECTION' not in head and not head.startswith(b'AutoCAD Binary DXF'):raise HTTPException(422,f'{filename}: invalid DXF header')
   key=store.put(p,f'panels/{id}/source{ext}');staged.append((id,filename,key))
  with Session.begin() as s:
   get_project(s,project_id,True)
   result=[]
   for id,filename,key in staged:
    panel=Panel(id=id,project_id=project_id,filename=filename,source_key=key,settings=defaults);s.add(panel);s.flush();s.add(Job(panel_id=id,revision=1));result.append(pack_panel(panel))
 return {'panels':result}
@app.get('/panels/{id}',dependencies=[Depends(auth)])
def panel(id:str):
 with Session() as s:return pack_panel(get_panel(s,id))
@app.get('/panels/{id}/log',dependencies=[Depends(auth)])
def log(id:str):
 with Session() as s:
  get_panel(s,id);jobs=list(s.scalars(select(Job).where(Job.panel_id==id).order_by(Job.created.desc())))
  return {'jobs':[{'id':j.id,'status':j.status,'revision':j.revision,'log':j.log,'created':j.created} for j in jobs]}
@app.post('/panels/{id}/review',dependencies=[Depends(auth)],status_code=202)
def review(id:str,body:ReviewInput):
 with Session.begin() as s:
  p=lock_panel(s,id)
  if body.expected_revision is not None and p.revision!=body.expected_revision:raise HTTPException(409,'Drawing revision changed. Reload the panel and review its current values.')
  if p.status in ['QUEUED','CONVERTING','EXTRACTING','BUILDING']:raise HTTPException(409,'Wait for the current conversion to finish')
  report=json.loads(p.report);validate_review_decisions(report,body)
  overrides=json.loads(p.overrides)
  parameters={**overrides.get('parameter_overrides',{})}
  explicit=body.parameter_overrides.model_dump(exclude_unset=True)
  # Older clients send only settings. Preserve their intentional edits, but
  # never turn unchanged displayed/detected fields into manual overrides.
  if body.settings and 'parameter_overrides' not in body.model_fields_set:
   previous={**DEFAULTS,**json.loads(p.settings),**report.get('settings',{})}
   for field in ('thickness','radius','deduction'):
    value=getattr(body.settings,field)
    if value!=previous[field]:explicit[field]=value
  for field,value in explicit.items():
   if value is None:parameters.pop(field,None)
   else:parameters[field]=value
  overrides['parameter_overrides']=parameters
  angles={**overrides.get('bend_angles',{})}
  for key,value in body.bend_angles.items():
   if value is None:angles.pop(key,None)
   else:angles[key]=value
  overrides['bend_angles']=angles
  bends={**overrides.get('bend_parameters',{})}
  for key,value in body.bend_parameters.items():
   values=value.model_dump(exclude_none=True)
   if values:bends[key]=values
   else:bends.pop(key,None)
  overrides['bend_parameters']=bends
  selected={**overrides.get('section_choices',{})}
  for key,value in body.section_choices.items():
   if value is None:selected.pop(key,None)
   else:selected[key]=value
  overrides['section_choices']=selected
  reliefs={**overrides.get('relief_radii',{})}
  for key,value in body.relief_radii.items():
   if value is None:reliefs.pop(key,None)
   else:reliefs[key]=value
  overrides['relief_radii']=reliefs
  if body.manual_bends is not None:overrides['manual_bends']=body.manual_bends
  if body.review_note is not None:overrides['review_note']=body.review_note.strip()
  # Bend confirmation is performed in the viewer. Notes remain optional and
  # existing notes are preserved; corner-cut provenance retains its own rule.
  if reliefs and not overrides.get('review_note'):raise HTTPException(422,'Identify the approved shape or dimensions for changed corner cuts in the review note.')
  for flag in ('confirm_parameters','accept_partial_sections','accept_relief_extensions','accept_corner_reliefs'):
   if flag in body.model_fields_set:overrides[flag]=getattr(body,flag)
  if body.settings:p.settings=json.dumps(body.settings.model_dump())
  p.overrides=json.dumps(overrides);p.revision+=1;p.status='QUEUED';p.error='';p.updated=time.time();p.artifacts='{}'
  s.add(Job(panel_id=p.id,revision=p.revision,log='Panel-only review decisions recorded. Queued for reconstruction.\n'))
  return pack_panel(p)
@app.put('/panels/{id}/measurement',dependencies=[Depends(auth)])
def measurement(id:str,body:MeasurementInput):
 with Session.begin() as s:
  p=get_panel(s,id);p.manual_value=body.value;p.manual_axis=body.axis;p.updated=time.time();return pack_panel(p)
MIME={'.glb':'model/gltf-binary','.json':'application/json','.svg':'image/svg+xml','.csv':'text/csv','.png':'image/png','.dxf':'application/dxf','.step':'application/step','.stl':'model/stl'}
@app.get('/panels/{id}/files/{name}',dependencies=[Depends(auth)])
def file(id:str,name:str):
 with Session() as s:
  p=get_panel(s,id);artifacts=json.loads(p.artifacts)
  if name not in artifacts:raise HTTPException(404,'Artifact is not available for this panel revision')
  if p.status!='PASS' and name in ['panel.step','panel.stl','flat.dwg']:raise HTTPException(409,'Confirm outstanding review items before final export')
  key=artifacts[name];label=Path(p.filename).stem+'_'+name
 return StreamingResponse(store.stream(key),media_type=MIME.get(Path(name).suffix,'application/octet-stream'),headers={'Content-Disposition':"attachment; filename*=UTF-8''"+__import__('urllib.parse',fromlist=['quote']).quote(label),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'})
@app.get('/projects/{id}/export',dependencies=[Depends(auth)])
def export_project(id:str,background_tasks:BackgroundTasks):
 td=Path(tempfile.mkdtemp(prefix='ff-export-'));archive=td/'project.zip'
 try:
  with Session() as s:
   get_project(s,id)
   panels=list(s.scalars(select(Panel).where(Panel.project_id==id,Panel.deleted_at.is_(None),Panel.status=='PASS')))
   if not panels:raise HTTPException(409,'This project has no approved panel results to export')
   with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED) as z:
    for p in panels:
     for name,key in json.loads(p.artifacts).items():
      local=td/(p.id+'_'+name);store.get(key,local);z.write(local,f'{Path(p.filename).stem}_{p.id[:8]}/{name}');local.unlink()
  background_tasks.add_task(shutil.rmtree,td,True)
  return FileResponse(archive,filename='FlatForge_project.zip',media_type='application/zip',background=background_tasks)
 except Exception:shutil.rmtree(td,ignore_errors=True);raise


def get_project(s,id,lock=False):
 query=select(Project).where(Project.id==id)
 if lock:query=query.with_for_update()
 p=s.scalar(query)
 if not p or p.deleted_at is not None:raise HTTPException(404,'Project not found')
 return p

def lock_panel(s,id):
 p=s.scalar(select(Panel).where(Panel.id==id).with_for_update())
 if not p or p.deleted_at is not None:raise HTTPException(404,'Panel not found')
 return p

@app.get('/projects',dependencies=[Depends(auth)])
def list_projects():
 with Session() as s:return {'projects':[{'id':p.id,'name':p.name,'client':p.client,'created':p.created} for p in s.scalars(select(Project).where(Project.deleted_at.is_(None)).order_by(Project.created.desc()))]}

@app.get('/projects/{id}',dependencies=[Depends(auth)])
def view_project(id:str):
 with Session() as s:
  p=get_project(s,id)
  return {'id':p.id,'name':p.name,'client':p.client,'created':p.created,'panels':[pack_panel(v) for v in s.scalars(select(Panel).where(Panel.project_id==id,Panel.deleted_at.is_(None)).order_by(Panel.created))]}

@app.put('/projects/{id}',dependencies=[Depends(auth)])
def edit_project(id:str,body:ProjectInput):
 if not body.name.strip():raise HTTPException(422,'Project name cannot be blank')
 with Session.begin() as s:
  p=get_project(s,id,True);p.name=body.name.strip();p.client=body.client.strip()
  return {'id':p.id,'name':p.name,'client':p.client,'created':p.created}

def remove_panel(s,p,now):
 p.deleted_at=now;p.updated=now
 s.execute(update(Job).where(Job.panel_id==p.id,Job.status.in_(['QUEUED','RUNNING'])).values(status='CANCELLED'))

@app.delete('/projects/{id}',dependencies=[Depends(auth)])
def delete_project(id:str):
 with Session.begin() as s:
  p=get_project(s,id,True);now=time.time();p.deleted_at=now
  for panel in s.scalars(select(Panel).where(Panel.project_id==id,Panel.deleted_at.is_(None)).with_for_update()):remove_panel(s,panel,now)
 return {'deleted':True,'recoverable':True}

@app.delete('/panels/{id}',dependencies=[Depends(auth)])
def delete_panel(id:str):
 with Session.begin() as s:remove_panel(s,lock_panel(s,id),time.time())
 return {'deleted':True,'recoverable':True}

@app.post('/projects/{id}/restore',dependencies=[Depends(auth)])
def restore_project(id:str):
 with Session.begin() as s:
  p=s.scalar(select(Project).where(Project.id==id).with_for_update())
  if not p:raise HTTPException(404,'Project not found')
  stamp=p.deleted_at;p.deleted_at=None
  if stamp is not None:
   for v in s.scalars(select(Panel).where(Panel.project_id==id,Panel.deleted_at==stamp).with_for_update()):restore_record(s,v)
 return {'restored':True}

def restore_record(s,p):
 p.deleted_at=None
 if p.status in ['QUEUED','CONVERTING','EXTRACTING','BUILDING']:
  p.revision+=1;p.status='QUEUED';p.report='{}';p.artifacts='{}';s.add(Job(panel_id=p.id,revision=p.revision,log='Restored drawing queued.\n'))
 p.updated=time.time()

@app.post('/panels/{id}/restore',dependencies=[Depends(auth)])
def restore_panel(id:str):
 with Session.begin() as s:
  p=s.scalar(select(Panel).where(Panel.id==id).with_for_update())
  if not p:raise HTTPException(404,'Panel not found')
  get_project(s,p.project_id)
  if p.deleted_at is not None:restore_record(s,p)
 return {'restored':True}

class DrawingInput(BaseModel):
 filename:str=Field(min_length=1,max_length=200)

@app.put('/panels/{id}',dependencies=[Depends(auth)])
def edit_panel(id:str,body:DrawingInput):
 name=body.filename.strip()
 if not name or any(c in name for c in ['/',chr(92),chr(0)]) or any(ord(c)<32 for c in name):raise HTTPException(422,'Enter a valid drawing filename')
 with Session.begin() as s:
  p=lock_panel(s,id)
  if Path(name).suffix.lower()!=Path(p.filename).suffix.lower():raise HTTPException(422,'Keep the original file extension when renaming')
  p.filename=name;p.updated=time.time();return pack_panel(p)

@app.get('/panels/{id}/source',dependencies=[Depends(auth)])
def original_source(id:str):
 with Session() as s:
  p=get_panel(s,id);key=p.source_key;name=p.filename
 return StreamingResponse(store.stream(key),media_type='application/octet-stream',headers={'Content-Disposition':"attachment; filename*=UTF-8''"+__import__('urllib.parse',fromlist=['quote']).quote(name),'Cache-Control':'private, no-store'})

@app.post('/panels/{id}/source',dependencies=[Depends(auth)],status_code=202)
async def replace_source(id:str,file:UploadFile=File(...)):
 with Session() as s:
  p=get_panel(s,id)
  if p.status in ['CONVERTING','EXTRACTING','BUILDING']:raise HTTPException(409,'Wait for this conversion to finish before replacing its source')
 name=Path((file.filename or '').replace(chr(92),'/')).name[:200];ext=Path(name).suffix.lower()
 if ext not in ['.dxf','.dwg']:raise HTTPException(415,'Select a DXF or DWG drawing')
 with tempfile.TemporaryDirectory(prefix='ff-replace-') as td:
  path=Path(td)/('source'+ext);size=0
  with path.open('wb') as f:
   while chunk:=await file.read(1024*1024):
    size+=len(chunk)
    if size>MAX_BYTES:raise HTTPException(413,'Drawing exceeds the upload limit')
    f.write(chunk)
  with path.open('rb') as f:head=f.read(8192)
  if not size or (ext=='.dwg' and not head.startswith(b'AC10')) or (ext=='.dxf' and b'SECTION' not in head and not head.startswith(b'AutoCAD Binary DXF')):raise HTTPException(422,'Invalid drawing header')
  key=store.put(path,f'panels/{id}/sources/{uuid.uuid4()}{ext}')
  with Session.begin() as s:
   p=lock_panel(s,id)
   if p.status in ['CONVERTING','EXTRACTING','BUILDING']:raise HTTPException(409,'Conversion started; retry replacement when it finishes')
   s.execute(update(Job).where(Job.panel_id==id,Job.status=='QUEUED').values(status='SUPERSEDED'))
   p.filename=name;p.source_key=key;p.revision+=1;p.status='QUEUED';p.report='{}';p.artifacts='{}';p.overrides='{}';p.error='';p.manual_value=None;p.updated=time.time()
   s.add(Job(panel_id=id,revision=p.revision,log='Source replaced; old bend decisions cleared. Queued.\n'))
   return pack_panel(p)
