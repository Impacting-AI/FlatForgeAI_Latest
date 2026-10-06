import math,json
import numpy as np
import pytest
from flatforge import geometry as g
from flatforge.engine import run
from flatforge.bend_rules import DEFAULTS,parameter_check,apply_directions,direction_factor
from flatforge.panel_angle import apply_panel_angle
from test_complex_geometry import channel

@pytest.mark.parametrize('angle',[30,60,90,110,120])
def test_fixed_total_deduction_not_scaled(angle):
    ba=g.bend_allowance(2,.7366,4,angle)
    assert 2*(.7366+2)*math.tan(math.radians(angle)/2)-ba==pytest.approx(4)
    gain=(.7366+1)*math.tan(math.radians(angle)/2)-ba/2
    assert gain==pytest.approx(2-math.tan(math.radians(angle)/2))

def test_defaults_and_shallow_fold_conflict():
    assert DEFAULTS=={'thickness':2.,'radius':.7366,'deduction':4.,'input_type':'flat_pattern'}
    assert parameter_check(2,.7366,4,90)['valid']
    assert not parameter_check(2,.7366,4,60)['valid']
    assert parameter_check(2,.7366,4,60)['allowance_mm']<0

@pytest.mark.parametrize('angle',[90,110,60])
def test_fixed_deduction_sections_to_brep_or_explicit_review(tmp_path,angle):
    # Reuse the CAD fixture builder with the newly confirmed development convention.
    path=tmp_path/'generic.dxf';channel(path,angle)
    result=run({'source':str(path),'output':str(tmp_path/'out'),'overrides':{'confirm_parameters':True}})
    if angle==60:
        assert result['status']=='NEEDS_REVIEW'
        assert any(x['code']=='BEND_PARAMETERS' for x in result['issues']),result['issues']
        assert not (tmp_path/'out/panel.step').exists()
    else:
        assert result['status']=='PASS',result['issues']
        import cadquery as cq
        solid=cq.importers.importStep(str(tmp_path/'out/panel.step')).val()
        assert solid.isValid() and len(solid.Solids())==1
        data=json.loads((tmp_path/'out/viewer.json').read_text())
        assert any(abs(abs(b['angle'])-angle)<1e-6 for b in data['bends'])
        assert all(b['k_factor'] is not None for b in data['bends'])
        assert result['unfold_check']['status']=='PASS'
        for b in data['bends']:
            assert b['allowance']==pytest.approx(g.bend_allowance(2,.7366,4,b['angle']))
            assert len(b['folded_lines'])==4

def test_user_direction_resolves_missing_direction_without_guess(tmp_path):
    path=tmp_path/'generic.dxf';channel(path)
    doc,origin,outer,blank,lines=g.read_drawing(path)
    faces,edges,parents,order,material=g.partition(outer,blank,lines,3)
    e=edges[0];key=':'.join(sorted(l['handle'] for l in e['source']))+f':F{e["parent"]}:F{e["child"]}'
    assert apply_panel_angle(edges,90) # unknown direction still blocks
    apply_directions(edges,faces,{key:'up'})
    apply_panel_angle(edges,90)
    assert e['angle']*direction_factor(e,faces)>0
    apply_directions(edges,faces,{key:'down'})
    assert e['angle']*direction_factor(e,faces)<0


@pytest.mark.parametrize('angle,radius,deduction',[(30,.01,1),(60,2,2)])
def test_shallow_angles_build_with_compatible_fixed_parameters(tmp_path,angle,radius,deduction):
    path=tmp_path/'any-panel.dxf';channel(path,angle,deduction=deduction)
    result=run({'source':str(path),'output':str(tmp_path/'out'),
                'settings':{'radius':radius,'deduction':deduction},'overrides':{'confirm_parameters':True,'accept_partial_sections':angle<45}})
    assert result['status']=='PASS',result['issues']
    assert any(abs(abs(b['angle'])-angle)<1e-6 for b in result['bends'])
    assert result['solid']['valid'] and result['solid']['solid_count']==1
    assert result['unfold_check']['status']=='PASS'
