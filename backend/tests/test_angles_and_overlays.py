"""Section angles survive correspondence, BREP and the exact viewer hinge set."""
import json
import math
import shutil
import subprocess
from pathlib import Path
import numpy as np
import pytest
from flatforge import geometry as g
from flatforge.engine import run, viewer_data
from test_complex_geometry import channel


@pytest.mark.parametrize('angle',[30.,60.,59.661,120.339,90.,90.005])
def test_legacy_hat_mapper_preserves_section_rotation(tmp_path,angle):
    path=tmp_path/'any-name.dxf';channel(path,angle,plan=0,layer='HAT')
    doc,origin,outer,blank,lines=g.read_drawing(path)
    faces,edges,parents,order,material=g.partition(outer,blank,lines,3.)
    profiles=g.profiles(doc,origin,2)
    g.map_sections(doc,origin,faces,outer,edges,profiles,2,2,4)
    measured=90. if abs(angle-90)<.01 else angle
    assert sorted(abs(e['angle']) for e in edges)==pytest.approx(sorted([90.,measured]),abs=1e-6)
    tf=g.transforms(faces,edges,order,2,2,4)
    solid,trimmed,stats=g.build_cad(faces,material,edges,tf,2,2,4,3.,tmp_path)
    assert stats['valid'] and stats['solid_count']==1
    import cadquery as cq
    exported=cq.importers.importStep(str(tmp_path/'panel.step')).val()
    normals=[np.array(f.normalAt().toTuple()) for f in exported.Faces() if f.geomType()=='PLANE']
    assert any(abs(abs(n[2])-abs(math.cos(math.radians(measured))))<1e-6 for n in normals)
    data=viewer_data(faces,trimmed,edges,tf,2,2,4)
    assert len(data['bends'])==len(edges)
    for e,b in zip(edges,data['bends']):
        assert b['angle']==e['angle']
        assert b['included_angle']==pytest.approx(180-abs(e['angle']))
        assert b['allowance']==pytest.approx(4*abs(e['angle'])/90)
        assert len(b['folded_lines'])==4
        for line in b['folded_lines']:
            a,z=np.array(line['points'])
            assert np.linalg.norm(z-a)==pytest.approx(b['high']-b['low'])
            # The graphic is on the actual BREP surface, not a bounding box.
            midpoint=(a+z)/2
            assert exported.distance(cq.Vertex.makeVertex(*midpoint))<.005


@pytest.mark.parametrize('angle',[30.,59.661,120.339])
def test_profile_to_export_and_folded_overlay(tmp_path,angle):
    path=tmp_path/'unrelated.dxf';channel(path,angle,plan=37)
    result=run({'source':str(path),'output':str(tmp_path/'out'),'overrides':{'confirm_parameters':True}})
    assert result['status']=='PASS',result
    data=json.loads((tmp_path/'out/viewer.json').read_text())
    assert data['mode']=='folded'
    assert any(abs(abs(e['angle'])-angle)<1e-6 for e in data['bends'])
    if angle==59.661:
        assert any(abs(e['included_angle']-120.339)<1e-6 for e in data['bends'])
    assert all(len(e['folded_lines'])==4 for e in data['bends'])
    root=Path(__file__).resolve().parents[2]
    if shutil.which('node') and (root/'node_modules/three').exists():
        subprocess.run(['node','tests/check-overlay-frames.mjs',str(tmp_path/'out/viewer.json')],cwd=root,check=True,capture_output=True,text=True)


def test_unresolved_axes_are_visible_without_inventing_a_fold(tmp_path):
    from test_geometry_review import conflicting_channel
    path=tmp_path/'unresolved.dxf';conflicting_channel(path)
    result=run({'source':str(path),'output':str(tmp_path/'out')})
    assert result['status']=='NEEDS_REVIEW'
    data=json.loads((tmp_path/'out/viewer.json').read_text())
    assert data['mode']=='flat_review'
    assert len(data['bends'])==result['physical_bends']
    assert any(e['angle'] is None and e['status']=='NEEDS_REVIEW' for e in data['bends'])
    assert not (tmp_path/'out/panel.step').exists()


def test_missing_sections_can_be_explicitly_rebuilt_only_as_review(tmp_path):
    import ezdxf
    path=tmp_path/'source.dxf';channel(path,60)
    reference=run({'source':str(path),'output':str(tmp_path/'reference'),'overrides':{'confirm_parameters':True}})
    angles={b['key']:b['angle'] for b in reference['bends']}
    doc=ezdxf.readfile(path)
    for entity in list(doc.modelspace()):
        if entity.dxf.layer=='חיפוי':doc.modelspace().delete_entity(entity)
    doc.saveas(path)
    initial=run({'source':str(path),'output':str(tmp_path/'initial')})
    assert initial['status']=='NEEDS_REVIEW'
    assert all(b['angle'] is None for b in initial['bends'])
    reviewed=run({'source':str(path),'output':str(tmp_path/'review'),
                  'overrides':{'bend_angles':angles,'confirm_parameters':True,'build_review_model':True}})
    assert reviewed['status']=='NEEDS_REVIEW'
    assert reviewed['review_model']['status']=='UNVALIDATED'
    assert any(i['code']=='LAYERS' for i in reviewed['issues'])
    assert {b['key']:b['angle'] for b in reviewed['bends']}==angles
    assert (tmp_path/'review/review_model.step').exists()
