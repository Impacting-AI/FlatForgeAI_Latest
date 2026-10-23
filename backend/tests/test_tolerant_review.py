"""Dimensional and API regressions for tolerances and explicit missing values."""
import math
import os
from pathlib import Path

import ezdxf
import numpy as np
import pytest

from flatforge import geometry as g
from flatforge.engine import run
from test_complex_geometry import channel


def without_sections(path):
    channel(path)
    doc=ezdxf.readfile(path);ms=doc.modelspace()
    for e in list(ms):
        if e.dxf.layer=='חיפוי' or e.dxftype()=='INSERT':ms.delete_entity(e)
    doc.saveas(path)


def test_duplicate_closure_does_not_destroy_rotated_fold_topology(tmp_path):
    source=tmp_path/'different-name.dxf';channel(source,plan=-23)
    doc=ezdxf.readfile(source)
    outline=next(iter(doc.modelspace().query('LWPOLYLINE[layer=="CONTOR"]')))
    points=list(outline.get_points('xy'));first=np.array(points[0])
    outline.set_points([*points,tuple(first+[1e-9,-1e-9])],format='xy')
    doc.saveas(source)
    _,_,outer,blank,lines=g.read_drawing(source)
    faces,edges,*_=g.partition(outer,blank,lines,3.)
    assert len(faces)==3 and len(edges)==2
    assert sum(f.area for f in faces)==pytest.approx(265*80,abs=.1)
    assert any(r['kind']=='duplicate_contour_closure' for r in g.read_drawing.repairs)


def test_length_tolerance_is_used_in_mapping_and_actual_solid_checks(tmp_path,monkeypatch):
    from flatforge import tolerance_policy
    monkeypatch.setattr(tolerance_policy,'ENFORCE_DRAWING_TOLERANCES',True)
    source=tmp_path/'channel.dxf';channel(source)
    doc=ezdxf.readfile(source);line=next(iter(doc.modelspace().query('LINE[layer=="KIFOF"]')))
    shift=.65*np.array([math.cos(math.radians(37)),math.sin(math.radians(37)),0.])
    line.dxf.start=np.array(line.dxf.start)+shift;line.dxf.end=np.array(line.dxf.end)+shift;doc.saveas(source)
    low=run({'source':str(source),'output':str(tmp_path/'strict'),'overrides':{'confirm_parameters':True}})
    assert low['status']=='NEEDS_REVIEW'
    high=run({'source':str(source),'output':str(tmp_path/'reviewed'),'settings':{'strip_tolerance':.8},'overrides':{'confirm_parameters':True}})
    assert high['status']=='PASS',high['issues']
    assert .6<max(s['max_length_error_mm'] for s in high['section_checks'])<.8
    assert high['solid']['valid'] and high['solid']['solid_count']==1


def test_missing_sections_require_values_and_manual_review_builds_real_step(tmp_path):
    source=tmp_path/'missing-sections.dxf';without_sections(source)
    first=run({'source':str(source),'output':str(tmp_path/'first')})
    assert first['status']=='NEEDS_REVIEW'
    assert len(first['unresolved_bends'])==2
    values={b['key']:{'angle':60. if i==0 else -90.,'radius':1.7366 if i==0 else .7366} for i,b in enumerate(first['bends'])}
    out=tmp_path/'manual'
    result=run({'source':str(source),'output':str(out),'settings':{'bend_model':'fixed_deduction'},'overrides':{'manual_bends':True,'review_note':'Known test channel dimensions and rotations.','bend_parameters':values}})
    assert result['status']=='PASS',result['issues']
    assert result['section_checks']==[]
    assert result['validation_scope']=='user_confirmed_bends_and_solid_geometry'
    assert result['warnings'] and all(b['confirmed'] for b in result['bends'])
    import cadquery as cq
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    shape=cq.importers.importStep(str(out/'panel.step')).val()
    assert shape.isValid() and len(shape.Solids())==1
    radii={round(BRepAdaptor_Surface(f.wrapped).Cylinder().Radius(),4) for f in shape.Faces() if f.geomType()=='CYLINDER'}
    assert radii=={.7366,1.7366,2.7366,3.7366}
    assert result['unfold_check']['symmetric_difference_percent']<.01


def test_angle_noise_keeps_true_oblique_folds_and_normalizes_near_square(tmp_path):
    source=tmp_path/'noisy.dxf';channel(source,angle=90.04)
    r=run({'source':str(source),'output':str(tmp_path/'out'),'overrides':{'confirm_parameters':True}})
    assert r['status']=='PASS',r['issues']
    assert all(abs(abs(b['angle'])-90)<1e-8 for b in r['bends'])
    assert max(c['max_turn_error_deg'] for c in r['section_checks'])==pytest.approx(.04,abs=.001)


def test_review_api_accepts_non_square_values_rejects_unknown_keys_and_clears(tmp_path):
    from fastapi.testclient import TestClient
    from flatforge.api import app
    from flatforge import worker
    source=tmp_path/'api-channel.dxf';without_sections(source)
    with TestClient(app) as client:
        client.headers['X-Flatforge-Key']=os.environ['FLATFORGE_API_KEY']
        client.put('/settings',json={'thickness':2,'radius':2,'deduction':4})
        project=client.post('/projects',json={'name':'Missing values regression'}).json()
        with source.open('rb') as f:
            uploaded=client.post(f"/projects/{project['id']}/upload",files=[('files',(source.name,f,'application/dxf'))])
        assert uploaded.status_code==202
        panel=uploaded.json()['panels'][0];url=f"/panels/{panel['id']}"
        worker.process(worker.claim());panel=client.get(url).json()
        keys=[b['key'] for b in panel['report']['bends']]
        assert client.post(url+'/review',json={'bend_angles':{'unknown':60}}).status_code==422
        for angle in (0,180,-180):
            assert client.post(url+'/review',json={'bend_angles':{keys[0]:angle}}).status_code==422
        assert client.post(url+'/review',json={'manual_bends':True}).status_code==202
        worker.process(worker.claim());pending=client.get(url).json()
        assert pending['status']=='NEEDS_REVIEW' and len(pending['report']['unresolved_bends'])==2
        assert client.post(url+'/review',json={'section_choices':{'invented':'local-1'}}).status_code==422
        response=client.post(url+'/review',json={'manual_bends':True,'review_note':'Reviewed two channel bends.','bend_angles':{keys[0]:60,keys[1]:-120}})
        assert response.status_code==202
        worker.process(worker.claim());panel=client.get(url).json()
        assert panel['status']=='PASS',panel['report']
        assert client.get(url+'/files/panel.step').status_code==200
        assert {b['angle'] for b in panel['report']['bends']}=={60,-120}
        assert client.post(url+'/review',json={'bend_angles':{keys[0]:None}}).status_code==202
        worker.process(worker.claim());panel=client.get(url).json()
        assert panel['status']=='NEEDS_REVIEW' and len(panel['report']['unresolved_bends'])==1
        assert client.get(url+'/files/panel.step').status_code==404
        client.delete(f"/projects/{project['id']}")


@pytest.mark.parametrize('index',[0,1])
def test_supplied_drawings_keep_outside_tolerance_choices_unselectable(tmp_path,index,monkeypatch):
    from flatforge import tolerance_policy
    monkeypatch.setattr(tolerance_policy,'ENFORCE_DRAWING_TOLERANCES',True)
    folder=os.getenv('FLATFORGE_PAIR_DXF_DIR')
    if not folder:pytest.skip('Set FLATFORGE_PAIR_DXF_DIR for private drawing regressions')
    drawings=sorted(Path(folder).glob('*.dxf'))
    if index>=len(drawings):pytest.skip('Private drawing fixture is unavailable')
    r=run({'source':str(drawings[index]),'output':str(tmp_path),'settings':{'bend_model':'fixed_deduction'}})
    assert r['status']=='NEEDS_REVIEW'
    assert r['bends'] and r['unresolved_bends']
    assert (tmp_path/'extraction.svg').exists()
    assert not any(i['code']=='SECTION_EVIDENCE' for i in r['issues'])
    for section in r['section_mapping']:
        for candidate in section.get('review_candidates',[]):
            assert candidate['max_strip_error_mm']<=r['settings']['strip_tolerance']
        nearest=section.get('nearest_local_candidate')
        if section.get('reason_code')=='LOCAL_DIMENSION_MISMATCH':
            assert nearest['max_strip_error_mm']>r['settings']['strip_tolerance']
            assert section['status']=='NEEDS_REVIEW'
