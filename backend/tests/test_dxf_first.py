"""DXF-only input, explicit missing-value recovery, and recorded provenance."""
import math
import os
import tempfile

import ezdxf
import pytest
from ezdxf.math import Matrix44

from flatforge.drawing_parameters import drawing_evidence, resolve_parameters
from flatforge.engine import run
from flatforge.parameters import Parameters
from test_complex_geometry import channel


def drawing(path, angle=60, notes=True, section_rotation=29):
    channel(path, angle=angle)
    doc=ezdxf.readfile(path)
    # Rotate the section itself, not just the developed panel. Thickness must
    # come from wall separation in any orientation, with no filename lookup.
    for entity in doc.modelspace():
        if entity.dxf.layer=='חיפוי' or entity.dxftype()=='INSERT':
            entity.transform(Matrix44.z_rotate(math.radians(section_rotation)))
    if notes:
        doc.modelspace().add_text('ALL BENDS INSIDE RADIUS = 2 mm')
        doc.modelspace().add_mtext('ALL BENDS DEDUCTION AT 90° = 4 mm')
    doc.saveas(path)


@pytest.mark.parametrize('angle',[60,120])
def test_dxf_values_override_different_defaults_and_build_non_square_step(tmp_path,angle):
    source=tmp_path/'arbitrary-name.dxf';drawing(source,angle)
    result=run({'source':str(source),'output':str(tmp_path/'out'),
                'settings':{'thickness':5,'radius':3,'deduction':8,'default_angle':90}})
    assert result['status']=='PASS',result['issues']
    assert {key:result['settings'][key] for key in ('thickness','radius','deduction')}==dict(thickness=2,radius=2,deduction=4)
    assert all(row['source']=='drawing' for row in result['parameter_resolution'].values())
    assert sorted(abs(b['angle']) for b in result['bends'])==pytest.approx(sorted([angle,90]))
    assert all(not b['confirmed'] for b in result['bends'])
    assert result['solid']['valid'] and result['solid']['solid_count']==1
    assert (tmp_path/'out/panel.step').exists()


def test_unlabelled_numbers_and_hole_radii_do_not_supply_manufacturing_values(tmp_path):
    source=tmp_path/'no-notes.dxf';drawing(source,notes=False)
    doc=ezdxf.readfile(source)
    for text in ('2','R2','BEND RADIUS = 2 mm','ALL BENDS INSIDE RADIUS = 2 in','ALL BENDS INSIDE RADIUS = 2 mm EXCEPT AT ENDS'):
        doc.modelspace().add_text(text)
    doc.modelspace().add_circle((5000,5000),2)
    evidence=drawing_evidence(doc)
    assert evidence['thickness']['value']==2
    assert evidence['radius']['value'] is None
    assert evidence['deduction']['value'] is None
    settings=Parameters().model_dump()
    _,unresolved=resolve_parameters(settings,{},evidence)
    assert unresolved['radius']['needs_review'] and unresolved['deduction']['needs_review']
    _,rules=resolve_parameters({**settings,'use_material_defaults':True},{},evidence)
    assert rules['radius']['source']=='workspace_rule' and rules['thickness']['source']=='drawing'


def test_right_angle_dimensions_automatically_supply_deduction(tmp_path):
    source=tmp_path/'right-angle.dxf';drawing(source,angle=90,notes=False)
    doc=ezdxf.readfile(source);doc.modelspace().add_text('ALL BENDS INSIDE RADIUS = 2 mm');doc.saveas(source)
    result=run({'source':str(source),'output':str(tmp_path/'out'),'settings':{'thickness':5,'deduction':8}})
    assert result['status']=='PASS',result['issues']
    assert result['settings']['thickness']==2
    assert result['settings']['deduction']==pytest.approx(4,abs=1e-5)
    record=result['parameter_resolution']['deduction']
    assert record['source']=='drawing'
    assert record['evidence']['source']=='Normal right-angle section / flat-strip increments'
    assert all(m['max_residual_mm']<.001 for m in record['evidence']['measurements'])


def test_conflicting_drawing_sources_stay_editable_and_cannot_be_hidden_by_defaults(tmp_path):
    source=tmp_path/'conflicting.dxf';drawing(source)
    doc=ezdxf.readfile(source);doc.modelspace().add_text('MATERIAL THICKNESS = 3 mm');doc.saveas(source)
    settings={'use_material_defaults':True}
    r=run({'source':str(source),'output':str(tmp_path/'review'),'settings':settings})
    assert r['status']=='NEEDS_REVIEW'
    assert r['parameter_resolution']['thickness']['needs_review']
    assert r['parameter_resolution']['thickness']['evidence']['candidates']==[2,3]
    assert not (tmp_path/'review/panel.step').exists()
    fixed=run({'source':str(source),'output':str(tmp_path/'corrected'),'settings':settings,
               'overrides':{'parameter_overrides':{'thickness':2}}})
    assert fixed['status']=='PASS',fixed['issues']
    assert fixed['parameter_resolution']['thickness']['source']=='review'
    assert fixed['parameter_resolution']['thickness']['evidence']['candidates']==[2,3]


def test_invalid_drawing_value_is_shown_for_correction_instead_of_replaced(tmp_path):
    source=tmp_path/'invalid-radius.dxf';drawing(source,notes=False)
    doc=ezdxf.readfile(source);doc.modelspace().add_text('ALL BENDS INSIDE RADIUS = -1 mm');doc.saveas(source)
    result=run({'source':str(source),'output':str(tmp_path/'out'),'settings':{'use_material_defaults':True}})
    assert result['status']=='NEEDS_REVIEW'
    assert result['settings']['radius']==-1
    assert result['parameter_resolution']['radius']['drawing_value']==-1
    assert result['issues'][0]['code']=='PARAMETER_INVALID'
    assert result['issues'][0]['field']=='radius'
    assert not (tmp_path/'out/panel.step').exists()


def test_missing_outline_returns_actionable_review_instead_of_worker_failure(tmp_path):
    source=tmp_path/'missing-outline.dxf'
    doc=ezdxf.new();doc.units=4;doc.layers.new('CONTOR')
    doc.modelspace().add_text('No outline',dxfattribs={'layer':'CONTOR'});doc.saveas(source)
    result=run({'source':str(source),'output':str(tmp_path/'out')})
    assert result['status']=='NEEDS_REVIEW'
    assert result['issues'][0]['code']=='DRAWING_GEOMETRY'
    assert 'replace the drawing' in result['issues'][0]['message']
    assert not (tmp_path/'out/panel.step').exists()


def test_upload_reads_dxf_and_only_missing_fields_need_correction(tmp_path):
    os.environ.setdefault('FLATFORGE_API_KEY','test-only-key-never-use-in-production')
    os.environ.setdefault('FLATFORGE_DATA',tempfile.mkdtemp(prefix='ff-dxf-first-'))
    from fastapi.testclient import TestClient
    from flatforge.api import app
    from flatforge import worker
    source=tmp_path/'input.dxf';drawing(source,notes=False)
    with TestClient(app) as client:
        client.headers['X-Flatforge-Key']=os.environ['FLATFORGE_API_KEY']
        client.put('/settings',json={'thickness':5,'radius':2,'deduction':4})
        defaults=client.get('/bootstrap').json()['settings']
        project=client.post('/projects',json={'name':'DXF-only recovery'}).json()
        with source.open('rb') as f:
            uploaded=client.post('/projects/'+project['id']+'/upload',files=[('files',('renamed.dxf',f,'application/dxf'))])
        assert uploaded.status_code==202
        url='/panels/'+uploaded.json()['panels'][0]['id']
        worker.process(worker.claim());panel=client.get(url).json()
        assert panel['status']=='NEEDS_REVIEW'
        assert panel['settings']['thickness']==2
        assert panel['configured_settings']['thickness']==5
        assert panel['report']['unresolved_bends']==[]
        assert {i['field'] for i in panel['report']['issues'] if i['code']=='PARAMETER_REQUIRED'}=={'radius','deduction'}
        assert client.get(url+'/files/panel.step').status_code!=200
        for values in ({'radius':0},{'thickness':21},{'unknown':2}):
            assert client.post(url+'/review',json={'parameter_overrides':values}).status_code==422
        # Only supply the two missing scalar fields through the normal form.
        body={'expected_revision':panel['revision'],'settings':panel['configured_settings'],
              'parameter_overrides':{'radius':2,'deduction':4}}
        assert client.post(url+'/review',json=body).status_code==202
        worker.process(worker.claim());built=client.get(url).json()
        assert built['status']=='PASS',built['report']
        assert client.post(url+'/review',json=body).status_code==409
        assert client.get(url+'/files/panel.step').status_code==200
        assert built['overrides']['parameter_overrides']=={'radius':2,'deduction':4}
        assert built['report']['parameter_resolution']['thickness']['source']=='drawing'
        assert sorted(abs(b['angle']) for b in built['report']['bends'])==pytest.approx([60,90])
        assert not built['overrides'].get('manual_bends')
        assert not built['overrides'].get('bend_parameters')
        # An inaccurate manual field does not crash or overwrite the source.
        assert client.post(url+'/review',json={'parameter_overrides':{'thickness':3}}).status_code==202
        worker.process(worker.claim());wrong=client.get(url).json()
        assert wrong['status']=='NEEDS_REVIEW'
        assert wrong['settings']['thickness']==3
        assert wrong['report']['parameter_resolution']['thickness']['drawing_value']==2
        # Clearing that one field restores automatic detection.
        assert client.post(url+'/review',json={'parameter_overrides':{'thickness':None}}).status_code==202
        worker.process(worker.claim());restored=client.get(url).json()
        assert restored['status']=='PASS',restored['report']
        assert restored['settings']['thickness']==2
        assert 'thickness' not in restored['overrides']['parameter_overrides']
        assert client.get('/bootstrap').json()['settings']==defaults
        client.delete('/projects/'+project['id'])
