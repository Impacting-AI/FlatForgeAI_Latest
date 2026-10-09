"""Real API/worker regression. No mocked CAD: imports the exported STEP again."""
import os,tempfile,json,hashlib,zipfile,io
import pytest
from pathlib import Path
os.environ['FLATFORGE_DATA']=tempfile.mkdtemp(prefix='ff-test-')
os.environ['FLATFORGE_API_KEY']='test-only-key-never-use-in-production'
os.environ['OPENBLAS_NUM_THREADS']='1'
from fastapi.testclient import TestClient
from flatforge.api import app
from flatforge import worker
from flatforge.db import Session,Panel,Job
ROOT=Path(__file__).resolve().parents[2]
SOURCE=ROOT/'public/samples/1648/flat.dxf'

def test_review_decisions_are_reversible_and_diagnostics_are_private():
 from flatforge.db import Project
 with TestClient(app) as c:
  c.headers['X-Flatforge-Key']=os.environ['FLATFORGE_API_KEY']
  with Session.begin() as s:
   project=Project(name='Review controls');s.add(project);s.flush()
   panel=Panel(project_id=project.id,filename='source.dxf',source_key='not-in-bundle',status='NEEDS_REVIEW',
    settings=json.dumps({'thickness':2,'radius':2,'deduction':4,'input_type':'flat_pattern'}),
    overrides=json.dumps({'confirm_parameters':True,'accept_partial_sections':True,'accept_relief_extensions':True}),
    report=json.dumps({'source_sha256':'test-source-digest','issues':[{'code':'PARTIAL_SECTION','message':'Review scope'}]}))
   s.add(panel);s.flush();pid=panel.id
   s.add(Job(panel_id=pid,revision=1,status='DONE',log='section evidence recorded'))
  url='/panels/'+pid
  response=c.get(url+'/diagnostics');assert response.status_code==200
  archive=zipfile.ZipFile(io.BytesIO(response.content))
  payload=json.loads(archive.read('diagnostics.json'))
  assert payload['revision']==1 and payload['report']['source_sha256']=='test-source-digest'
  assert payload['jobs'][0]['log']=='section evidence recorded'
  assert not any(name.endswith(('.dxf','.dwg')) for name in archive.namelist())
  assert os.environ['FLATFORGE_API_KEY'].encode() not in archive.read('diagnostics.json')
  assert c.post(url+'/review',json={'expected_revision':0,'accept_partial_sections':False}).status_code==409
  response=c.post(url+'/review',json={'expected_revision':1,'accept_partial_sections':False,
    'accept_relief_extensions':False,'confirm_parameters':False,'build_review_model':True})
  assert response.status_code==202
  values=response.json()['overrides']
  assert not any(values[k] for k in ('accept_partial_sections','accept_relief_extensions','confirm_parameters'))
  assert values['build_review_model']
  # Clean up this queued synthetic job so other worker integration tests do not claim it.
  with Session.begin() as s:
   for job in s.query(Job).filter_by(panel_id=pid):job.status='DONE'
  c.headers.clear();assert c.get(url+'/diagnostics').status_code==401

def test_upload_review_worker_exports_and_persistence(tmp_path):
 from test_complex_geometry import channel
 source=tmp_path/'channel.dxf';channel(source)
 with TestClient(app) as c:
  assert c.get('/bootstrap').status_code==401
  c.headers['X-Flatforge-Key']=os.environ['FLATFORGE_API_KEY']
  defaults={'thickness':3,'radius':2,'deduction':4,'input_type':'flat_pattern'}
  assert c.put('/settings',json=defaults).status_code==200
  project=c.post('/projects',json={'name':'Regression project','client':'Engineering QA'}).json()
  bad=c.post('/projects/'+project['id']+'/upload',files=[('files',('bad.dxf',b'not a drawing','application/octet-stream'))]);assert bad.status_code==422
  with source.open('rb') as f:r=c.post('/projects/'+project['id']+'/upload',files=[('files',('panel.dxf',f,'application/dxf'))])
  assert r.status_code==202;p=r.json()['panels'][0];assert p['settings']['thickness']==3
  id=worker.claim();assert id and worker.claim() is None
  worker.process(id)
  p=c.get('/panels/'+p['id']).json();assert p['status']=='NEEDS_REVIEW',p
  assert p['report']['issues'][0]['code']=='THICKNESS'
  assert c.post('/panels/'+p['id']+'/review',json={'settings':{**defaults,'thickness':2}}).status_code==202
  worker.process(worker.claim());p=c.get('/panels/'+p['id']).json()
  assert p['status']=='PASS',p
  assert p['report']['verification']['status']=='VERIFIED'
  assert p['report']['unfold_check']['symmetric_difference_percent']<.5
  assert c.get('/bootstrap').json()['settings']['thickness']==3,'Panel override changed global defaults'
  assert c.put('/panels/'+p['id']+'/measurement',json={'value':990.2,'axis':'folded_x'}).status_code==200
  assert c.get('/panels/'+p['id']).json()['manual_value']==990.2
  step=c.get('/panels/'+p['id']+'/files/panel.step');assert step.status_code==200
  saved=Path(os.environ['FLATFORGE_DATA'])/'roundtrip.step';saved.write_bytes(step.content)
  import cadquery as cq
  shape=cq.importers.importStep(str(saved)).val();assert shape.isValid() and len(shape.Solids())==1
  assert c.get('/panels/'+p['id']+'/files/unknown.step').status_code==404
  archive=c.get('/projects/'+project['id']+'/export');assert archive.status_code==200
  assert any(n.endswith('panel.step') for n in zipfile.ZipFile(io.BytesIO(archive.content)).namelist())
  # Rebuild from identical source/decisions must reproduce the STEP bytes.
  assert c.post('/panels/'+p['id']+'/review',json={}).status_code==202
  worker.process(worker.claim());again=c.get('/panels/'+p['id']+'/files/panel.step')
  assert again.status_code==200
  assert hashlib.sha256(step.content).hexdigest()==hashlib.sha256(again.content).hexdigest()
  assert c.get('/panels/'+p['id']+'/log').json()['jobs'][0]['status']=='DONE'


def test_complex_upload_keeps_measured_angles_with_corner_review():
 folder=os.getenv('FLATFORGE_REGRESSION_DXF_DIR')
 if not folder:pytest.skip('Supply original customer DXFs')
 with TestClient(app) as c:
  c.headers['X-Flatforge-Key']=os.environ['FLATFORGE_API_KEY']
  settings={'thickness':2,'radius':2,'deduction':4,'input_type':'flat_pattern'}
  assert c.put('/settings',json=settings).status_code==200
  project=c.post('/projects',json={'name':'Approved complex convention','client':'Regression'}).json()
  with (Path(folder)/'PN_NM_149.dxf').open('rb') as f:
   upload=c.post('/projects/'+project['id']+'/upload',files=[('files',('renamed-panel.dxf',f,'application/dxf'))])
  assert upload.status_code==202
  panel=upload.json()['panels'][0]
  worker.process(worker.claim())
  p=c.get('/panels/'+panel['id']).json()
  assert p['status']=='NEEDS_REVIEW',p['report']
  assert p['overrides']=={}
  assert p['settings']==settings
  assert p['report']['physical_bends']==27
  assert len(p['report']['corner_angle_candidates'])==2
  assert c.get('/panels/'+p['id']+'/files/viewer.json').status_code==200
  assert p['report']['unresolved_bends']==[]
  assert all(b['angle'] is not None for b in p['report']['bends'])
  assert c.get('/panels/'+p['id']+'/files/panel.step').status_code==409
  assert c.get('/projects/'+project['id']+'/export').status_code==409


def test_drawing_review_revision_persistence_and_export_gate(tmp_path):
 from test_geometry_review import conflicting_channel
 source=tmp_path/'conflict.dxf';conflicting_channel(source)
 with TestClient(app) as c:
  c.headers['X-Flatforge-Key']=os.environ['FLATFORGE_API_KEY']
  settings={'thickness':2,'radius':2,'deduction':4,'input_type':'flat_pattern'}
  assert c.put('/settings',json=settings).status_code==200
  project=c.post('/projects',json={'name':'Geometry review','client':'Regression'}).json()
  with source.open('rb') as f:
   upload=c.post('/projects/'+project['id']+'/upload',files=[('files',('conflict.dxf',f,'application/dxf'))])
  p=upload.json()['panels'][0];worker.process(worker.claim())
  url='/panels/'+p['id'];p=c.get(url).json()
  assert p['status']=='NEEDS_REVIEW'
  row=p['report']['review_catalog'][0];candidate=row['candidates'][0]
  choices={row['profile']:candidate['id']}
  assert c.post(url+'/review',json={'section_choices':choices}).status_code==422
  assert c.post(url+'/review',json={'expected_revision':p['revision']-1,'section_choices':choices}).status_code==409
  assert c.post(url+'/review',json={'expected_revision':p['revision'],'section_choices':{row['profile']:'unknown'}}).status_code==422
  key=candidate['folds'][0]['key'];angle=candidate['folds'][0]['angle']
  payload={'expected_revision':p['revision'],'section_choices':choices,'bend_angles':{key:angle},'build_review_model':True,'confirm_parameters':True}
  assert c.post(url+'/review',json=payload).status_code==202
  worker.process(worker.claim());p=c.get(url).json()
  assert p['status']=='NEEDS_REVIEW',p['report']
  assert p['overrides']['section_choices']==choices
  assert p['overrides']['bend_angles'][key]==angle
  assert p['report']['review_model']['status']=='UNVALIDATED'
  assert c.get(url+'/files/panel.step').status_code==404
  assert c.get(url+'/files/review_model.step').status_code==200
  assert c.get('/projects/'+project['id']+'/export').status_code==409
  assert c.post(url+'/review',json={'expected_revision':p['revision'],'bend_angles':{key:None},'section_choices':{},'build_review_model':False}).status_code==202
  worker.process(worker.claim());p=c.get(url).json()
  assert key not in p['overrides']['bend_angles']
  assert p['overrides']['section_choices']=={}
  assert c.get(url+'/files/review_model.step').status_code==404
  assert c.get('/bootstrap').json()['settings']==settings


def test_direction_review_requires_revision_and_can_be_revoked():
 from flatforge.db import Project
 from flatforge.bend_rules import DEFAULTS
 with TestClient(app) as c:
  c.headers['X-Flatforge-Key']=os.environ['FLATFORGE_API_KEY']
  with Session.begin() as s:
   project=Project(name='Direction review');s.add(project);s.flush()
   panel=Panel(project_id=project.id,filename='synthetic.dxf',source_key='unused',status='NEEDS_REVIEW',
    settings=json.dumps(DEFAULTS),overrides='{}',report=json.dumps({'unresolved_bends':[{'key':'A:F0:F1'}]}))
   s.add(panel);s.flush();pid=panel.id
  url='/panels/'+pid;decision={'bend_directions':{'A:F0:F1':'up'}}
  assert c.post(url+'/review',json=decision).status_code==422
  assert c.post(url+'/review',json={**decision,'expected_revision':0}).status_code==409
  assert c.post(url+'/review',json={'expected_revision':1,'bend_directions':{'unknown':'up'}}).status_code==422
  saved=c.post(url+'/review',json={**decision,'expected_revision':1})
  assert saved.status_code==202
  assert saved.json()['overrides']['bend_directions']==decision['bend_directions']
  with Session.begin() as s:
   s.get(Panel,pid).status='NEEDS_REVIEW'
   for job in s.query(Job).filter_by(panel_id=pid):job.status='DONE'
  p=c.get(url).json()
  cleared=c.post(url+'/review',json={'expected_revision':p['revision'],'bend_directions':{'A:F0:F1':None}})
  assert cleared.status_code==202 and cleared.json()['overrides']['bend_directions']=={}
  with Session.begin() as s:
   for job in s.query(Job).filter_by(panel_id=pid):job.status='DONE'


def test_legacy_pass_does_not_bypass_verification_gate():
 from flatforge.db import Project
 with TestClient(app) as client:
  client.headers['X-Flatforge-Key']=os.environ['FLATFORGE_API_KEY']
  with Session.begin() as session:
   project=Project(name='Legacy PASS gate');session.add(project);session.flush()
   panel=Panel(project_id=project.id,filename='legacy.dxf',source_key='unused',status='PASS',
               artifacts=json.dumps({'panel.step':'unused-step'}),report='{}',settings='{}')
   session.add(panel);session.flush();pid=panel.id;project_id=project.id
  assert client.get(f'/panels/{pid}/files/panel.step').status_code==409
  assert client.get(f'/projects/{project_id}/export').status_code==409
