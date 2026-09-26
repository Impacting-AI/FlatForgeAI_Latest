"""Real customer drawing regressions. Set FLATFORGE_REGRESSION_DXF_DIR.

Fixtures stay outside this repository; use the seven original supplied DXFs.
"""
import hashlib
import json
import os
import tempfile
from pathlib import Path

import pytest
from flatforge.engine import run
from flatforge import geometry as g

FIXTURES=Path(os.getenv('FLATFORGE_REGRESSION_DXF_DIR','backend/tests/fixtures'))
ROOT=Path(__file__).resolve().parents[2]

def fixture(name):
    source=FIXTURES/name
    if not source.exists():pytest.skip(f'Supply original fixture: {source}')
    return source

@pytest.mark.parametrize('name',[
    'PN_PL_5B(1).dxf','PN_PL_14(1).dxf','PN_PL_15(1).dxf',
    'PN_PL_16.dxf','PN_PL_19.dxf',
])
def test_drawing_validated_solid(name,tmp_path):
    import cadquery as cq
    source=fixture(name)
    result=run({'source':str(source),'output':str(tmp_path)})
    assert result['status']=='PASS',result.get('issues')
    assert result['unfold_check']['symmetric_difference_percent']<=.5
    for check in result['section_checks']:
        assert check['chain_status']==check['full_plane_status']=='PASS'
        assert check['max_length_error_mm']<=.5
        assert check['max_turn_error_deg']<=1
        assert check['max_paint_normal_error_deg']<=1
    solid=cq.importers.importStep(str(tmp_path/'panel.step')).val()
    assert solid.isValid() and len(solid.Solids())==1
    if name=='PN_PL_5B(1).dxf':
        assert sum(len(c['contour_openings']) for c in result['section_checks'])==1
        # Negative control: a missing wall with no matching source opening fails.
        d,o,outer,blank,lines=g.read_drawing(source)
        faces,edges,_,order,material=g.partition(outer,blank,lines,3.)
        profiles=g.profiles(d,o,2);g.map_sections(d,o,faces,outer,edges,profiles,2,2,4)
        transforms=g.transforms(faces,edges,order,2,2,4)
        checkdir=tmp_path/'negative';checkdir.mkdir()
        checks,_=g.check_sections(solid,profiles,faces,transforms,2,2,checkdir,faces)
        assert any(c['chain_status']=='FAIL' and c['missing_or_interrupted'] for c in checks)
    if name=='PN_PL_15(1).dxf':
        again=tmp_path/'repeat'
        run({'source':str(source),'output':str(again)})
        assert hashlib.sha256((tmp_path/'panel.step').read_bytes()).digest()==hashlib.sha256((again/'panel.step').read_bytes()).digest()

def test_missing_bend_data_stays_unknown(tmp_path):
    source=fixture('PN_PL_6(1).dxf')
    result=run({'source':str(source),'output':str(tmp_path)})
    assert result['status']=='NEEDS_REVIEW'
    assert result['issues'][0]['code']=='LAYERS'
    assert result['bend_lines']==0 and (tmp_path/'extraction.svg').exists()
    assert not (tmp_path/'panel.step').exists()

@pytest.mark.parametrize('number',['1570','1619'])
def test_previous_reference_panels(number,tmp_path):
    panel=next(p for p in json.loads((ROOT/'lib/sample-data.json').read_text())['panels'] if p['filename']==f'PN_PL_{number}.dxf')
    result=run({'source':str(ROOT/'public/samples'/number/'flat.dxf'),
                'output':str(tmp_path),'overrides':panel['overrides']})
    assert result['status']=='PASS',result.get('issues')
    assert max(abs(a-b) for a,b in zip(result['bbox'],panel['report']['bbox']))<.001

def test_gap_requires_explicit_review_before_step_export():
    os.environ.setdefault('FLATFORGE_API_KEY','test-only-key-never-use-in-production')
    os.environ.setdefault('FLATFORGE_DATA',tempfile.mkdtemp(prefix='ff-relief-test-'))
    from fastapi.testclient import TestClient
    from flatforge.api import app
    from flatforge import worker
    source=fixture('PN_PL_18.dxf')
    with TestClient(app) as client:
        client.headers['X-Flatforge-Key']=os.environ['FLATFORGE_API_KEY']
        client.put('/settings',json={'thickness':2,'radius':2,'deduction':4,'input_type':'flat_pattern'})
        project=client.post('/projects',json={'name':'Relief regression'}).json()
        with source.open('rb') as drawing:
            response=client.post(f"/projects/{project['id']}/upload",files=[('files',(source.name,drawing,'application/dxf'))])
        assert response.status_code==202
        panel=response.json()['panels'][0];url=f"/panels/{panel['id']}"
        worker.process(worker.claim())
        draft=client.get(url).json()
        assert draft['status']=='NEEDS_REVIEW'
        assert [i['code'] for i in draft['report']['issues']]==['RELIEF_EXTENSION']
        assert 'panel.glb' in draft['artifacts']
        assert client.get(url+'/files/panel.step').status_code==409
        assert client.post(url+'/review',json={'accept_relief_extensions':True}).status_code==202
        worker.process(worker.claim())
        approved=client.get(url).json()
        assert approved['status']=='PASS',approved
        assert approved['overrides']['accept_relief_extensions'] is True
        assert client.get(url+'/files/panel.step').status_code==200
        client.delete(f"/projects/{project['id']}")
