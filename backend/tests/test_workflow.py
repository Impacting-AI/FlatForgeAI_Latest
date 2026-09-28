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
def test_upload_review_worker_exports_and_persistence():
 with TestClient(app) as c:
  assert c.get('/bootstrap').status_code==401
  c.headers['X-Flatforge-Key']=os.environ['FLATFORGE_API_KEY']
  defaults={'thickness':3,'radius':2,'deduction':4,'input_type':'flat_pattern'}
  assert c.put('/settings',json=defaults).status_code==200
  project=c.post('/projects',json={'name':'Regression project','client':'Engineering QA'}).json()
  bad=c.post('/projects/'+project['id']+'/upload',files=[('files',('bad.dxf',b'not a drawing','application/octet-stream'))]);assert bad.status_code==422
  with SOURCE.open('rb') as f:r=c.post('/projects/'+project['id']+'/upload',files=[('files',('panel.dxf',f,'application/dxf'))])
  assert r.status_code==202;p=r.json()['panels'][0];assert p['settings']['thickness']==3
  id=worker.claim();assert id and worker.claim() is None
  worker.process(id)
  p=c.get('/panels/'+p['id']).json();assert p['status']=='NEEDS_REVIEW',p
  assert p['report']['issues'][0]['code']=='THICKNESS'
  assert c.post('/panels/'+p['id']+'/review',json={'settings':{**defaults,'thickness':2}}).status_code==202
  worker.process(worker.claim());p=c.get('/panels/'+p['id']).json()
  assert p['status']=='PASS',p
  assert max(abs(a-b) for a,b in zip(p['report']['bbox'],[990,2917,55]))<.001
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


def test_complex_upload_stops_for_corner_angle_confirmation():
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
  assert c.get('/panels/'+p['id']+'/files/panel.step').status_code==404
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
  assert c.get(url+'/files/panel.step').status_code==409
  assert c.get(url+'/files/review_model.step').status_code==200
  assert c.get('/projects/'+project['id']+'/export').status_code==409
  assert c.post(url+'/review',json={'expected_revision':p['revision'],'bend_angles':{key:None},'section_choices':{},'build_review_model':False}).status_code==202
  worker.process(worker.claim());p=c.get(url).json()
  assert key not in p['overrides']['bend_angles']
  assert p['overrides']['section_choices']=={}
  assert c.get(url+'/files/review_model.step').status_code==404
  assert c.get('/bootstrap').json()['settings']==settings
