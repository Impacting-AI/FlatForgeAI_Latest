"""Per-panel strip limits affect matching and solid length checks, not defaults."""
import os
import json
import numpy as np
import ezdxf
import pytest
from flatforge.engine import run
from test_complex_geometry import channel


def near_limit(path):
    channel(path,60)
    doc=ezdxf.readfile(path)
    line=list(doc.modelspace().query('LINE[layer=="KIFOF"]'))[0]
    shift=.672*np.array([np.cos(np.radians(37)),np.sin(np.radians(37)),0])
    line.dxf.start=np.array(line.dxf.start)+shift
    line.dxf.end=np.array(line.dxf.end)+shift
    doc.saveas(path)


def test_panel_tolerance_controls_matching_and_solid_validation(tmp_path):
    path=tmp_path/'source.dxf';near_limit(path)
    config={'source':str(path),'overrides':{'confirm_parameters':True}}
    strict=run({**config,'output':str(tmp_path/'strict')})
    assert strict['status']=='NEEDS_REVIEW'
    assert strict['strip_tolerance_mm']==.5
    relaxed=run({**config,'output':str(tmp_path/'relaxed'),'overrides':{**config['overrides'],'strip_tolerance_mm':.7}})
    assert relaxed['status']=='PASS',relaxed['issues']
    assert relaxed['strip_tolerance_mm']==.7
    assert all(c['chain_status']=='PASS' for c in relaxed['section_checks'])
    assert any(.5<c['max_length_error_mm']<.7 for c in relaxed['section_checks'])
    assert json.loads((tmp_path/'relaxed/report.json').read_text())['strip_tolerance_mm']==.7
    other=run({**config,'output':str(tmp_path/'other')})
    assert other['status']=='NEEDS_REVIEW' and other['strip_tolerance_mm']==.5


def test_tolerance_rejects_invalid_values():
    from flatforge.api import ReviewInput
    from pydantic import ValidationError
    for value in [0,-1,float('inf'),float('nan')]:
        with pytest.raises(ValidationError):ReviewInput(strip_tolerance_mm=value)
    assert ReviewInput(strip_tolerance_mm=.7).strip_tolerance_mm==.7


def test_tolerance_saved_reset_and_global_defaults_unchanged(tmp_path):
    from fastapi.testclient import TestClient
    from flatforge.api import app
    from flatforge import worker
    source=tmp_path/'source.dxf';near_limit(source)
    with TestClient(app) as c:
        c.headers['X-Flatforge-Key']=os.environ['FLATFORGE_API_KEY']
        defaults={'thickness':2,'radius':2,'deduction':4,'input_type':'flat_pattern'}
        assert c.put('/settings',json=defaults).status_code==200
        project=c.post('/projects',json={'name':'Tolerance test','client':'QA'}).json()
        with source.open('rb') as f:
            uploaded=c.post('/projects/'+project['id']+'/upload',files=[('files',('source.dxf',f,'application/dxf'))])
        url='/panels/'+uploaded.json()['panels'][0]['id']
        worker.process(worker.claim())
        assert c.get(url).json()['status']=='NEEDS_REVIEW'
        assert c.post(url+'/review',json={'strip_tolerance_mm':.7,'confirm_parameters':True}).status_code==202
        worker.process(worker.claim());panel=c.get(url).json()
        assert panel['status']=='PASS',panel['report']
        assert panel['overrides']['strip_tolerance_mm']==.7
        assert c.get('/bootstrap').json()['settings']==defaults
        assert c.post(url+'/review',json={'strip_tolerance_mm':.5}).status_code==202
        worker.process(worker.claim());panel=c.get(url).json()
        assert panel['status']=='NEEDS_REVIEW'
        assert panel['report']['strip_tolerance_mm']==.5
