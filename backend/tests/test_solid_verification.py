"""The STEP, section scope and export gate must agree before verification."""
import copy
import json
import numpy as np
import pytest
from flatforge import geometry as g
from flatforge import solid_validation as validation
from flatforge.engine import run
from test_complex_geometry import channel


@pytest.fixture
def reconstructed(tmp_path,monkeypatch):
    source=tmp_path/'channel.dxf';channel(source)
    captured={};original=g.build_cad
    def capture(*args,**kwargs):
        result=original(*args,**kwargs)
        captured.update(solid=result[0],trimmed=result[1],edges=args[2],tf=args[3],t=args[4],r=args[5])
        return result
    monkeypatch.setattr(g,'build_cad',capture)
    out=tmp_path/'out'
    report=run({'source':str(source),'output':str(out),'overrides':{'confirm_parameters':True}})
    assert report['status']=='PASS',report['issues']
    return captured,out,report


def test_valid_brep_with_wrong_dimensions_fails(reconstructed):
    data,out,report=reconstructed
    assert report['verification']['status']=='VERIFIED'
    # Valid topology alone must not approve a uniformly oversized solid.
    data['solid']=data['solid'].scale(1.01)
    assert data['solid'].isValid()
    assert validation.inspect_brep(**data)['status']=='FAIL'


def test_wrong_radius_and_thickness_fail(reconstructed):
    data,out,report=reconstructed
    assert validation.inspect_brep(**{**data,'r':data['r']+.1})['status']=='FAIL'
    assert validation.inspect_brep(**{**data,'t':data['t']+.1})['status']=='FAIL'


def test_wrong_bend_angle_fails(reconstructed):
    data,out,report=reconstructed
    edges=copy.deepcopy(data['edges']);edges[0]['angle']*=.9
    assert validation.inspect_brep(**{**data,'edges':edges})['status']=='FAIL'


def test_overlay_is_checked_against_step(reconstructed):
    data,out,report=reconstructed
    viewer=json.loads((out/'viewer.json').read_text())
    viewer['bends'][0]['folded_lines'][0]['points'][0][2]+=10
    assert validation.inspect_overlays(data['solid'],viewer)['status']=='FAIL'


@pytest.mark.parametrize('missing',['brep_check','corner_check','overlay_check','overlap_check','unfold_check','section_checks','bend_traceability'])
def test_missing_check_cannot_verify(reconstructed,missing):
    data,out,report=reconstructed
    report.pop(missing)
    result=validation.export_verification(report,'PASS',out)
    assert result['status']=='REVIEW'
    assert not (out/'panel.step').exists()
    assert (out/'review_model.step').exists()


def test_failed_dimension_cannot_be_waived(reconstructed):
    data,out,report=reconstructed
    report['section_checks'][0]['chain_status']='FAIL'
    report['review_decisions']={'accept_partial_sections':True,'accept_relief_extensions':True}
    assert validation.export_verification(report,'PASS',out)['status']=='REVIEW'


def test_partial_section_ignores_unrelated_arcs(tmp_path,monkeypatch):
    import cadquery as cq
    source=tmp_path/'channel.dxf';channel(source)
    original=g.check_sections;captured=[]
    def check(solid,profs,*args,**kwargs):
        profiles=copy.deepcopy(profs)
        for p in profiles:p['section_scope']='disconnected_region'
        combined=cq.Compound.makeCompound([solid,solid.translate((0,0,500))])
        result=original(combined,profiles,*args,**kwargs)
        captured.extend(result[0]);return result
    monkeypatch.setattr(g,'check_sections',check)
    report=run({'source':str(source),'output':str(tmp_path/'out'),'overrides':{'confirm_parameters':True}})
    assert captured and all(c['chain_status']=='PASS' for c in captured),captured
    assert all(c['full_plane_status']=='NOT_APPLICABLE' for c in captured)
    assert report['status']=='PASS',report['issues']


def test_corner_gap_is_measured_and_relief_is_not_closed():
    import cadquery as cq
    from shapely.geometry import box
    from shapely.ops import unary_union
    plates=[box(0,0,10,10),box(11,0,21,10)]
    solid=cq.Compound.makeCompound([cq.Workplane('XY').box(10,10,2,centered=(False,False,True)).val(),
                                   cq.Workplane('XY').box(10,10,2,centered=(False,False,True)).translate((11,0,0)).val()])
    before=solid.Volume()
    result=validation.inspect_corners(solid,unary_union(plates),plates,[],{i:(np.eye(3),np.zeros(3)) for i in range(2)},2.)
    assert result['status']=='NEEDS_REVIEW'
    assert result['corners'][0]['intended_continuity']=='UNKNOWN'
    gaps=[m['minimum_gap_mm'] for row in result['corners'][0]['edge_pairs'] for m in row['measurements']]
    assert min(gaps)==pytest.approx(1.)
    assert solid.Volume()==before


def test_reused_output_does_not_keep_previous_verified_step(tmp_path):
    import ezdxf
    source=tmp_path/'channel.dxf';channel(source)
    out=tmp_path/'out';config={'source':str(source),'output':str(out),'overrides':{'confirm_parameters':True}}
    assert run(config)['status']=='PASS'
    doc=ezdxf.readfile(source)
    for e in list(doc.modelspace().query('LINE[layer=="חיפוי"]')):doc.modelspace().delete_entity(e)
    doc.saveas(source)
    assert run(config)['status']!='PASS'
    assert not (out/'panel.step').exists()
    assert json.loads((out/'verification.json').read_text())['status']=='REVIEW'
