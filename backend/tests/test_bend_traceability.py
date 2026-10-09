import copy
import json
import numpy as np
from shapely.geometry import box
from flatforge.section_diagnostics import bend_traceability
from test_hat_mapping_recovery import hinge


def fixture():
    faces=[box(-10,0,0,30),box(0,0,10,30)]
    e=hinge(0,[0,0],[0,30],0,1)
    e.update(angle=-60,review_key='source:0:1',evidence=[{'profile':'HAT-A','vertex':2,'angle':-60,
        'handles_before':['wall-a','wall-b'],'handles_after':['wall-c','wall-d'],'paint_marker':'paint-1'}])
    return faces,e


def test_resolved_bend_traces_parent_signed_angle_direction_and_walls():
    faces,e=fixture();row=bend_traceability(faces,[e],[],[])[0]
    assert row['status']=='RESOLVED_FROM_DRAWING'
    assert (row['parent'],row['child'])==(0,1)
    assert row['signed_rotation_deg']==-60 and row['included_angle_deg']==120
    assert row['direction']=='up' and row['kifof_handles']==['0']
    assert row['drawing_sources'][0]['vertex']==2 and not row['reasons']


def test_angle_without_source_does_not_count_as_resolved():
    faces,e=fixture();e['evidence'][0].pop('paint_marker')
    row=bend_traceability(faces,[e],[],[])[0]
    assert row['status']=='NEEDS_REVIEW'
    assert 'DRAWING_PROVENANCE_INCOMPLETE' in {r['code'] for r in row['reasons']}


def test_operator_choice_is_not_mislabelled_drawing_evidence():
    faces,e=fixture();e['source_evidence']=copy.deepcopy(e['evidence'])
    e['evidence']=[{'profile':'USER CONFIRMED','angle':-30}];e['angle']=-30
    row=bend_traceability(faces,[e],[],[])[0]
    assert row['status']=='OPERATOR_OVERRIDE' and not row['drawing_sources']
    assert row['original_drawing_sources'][0]['profile']=='HAT-A'


def test_unresolved_projection_retains_specific_missing_evidence():
    faces,e=fixture();e.pop('angle');e['evidence']=[]
    p={'name':'HAT-X'}
    diagnostic={'status':'NEEDS_REVIEW','reason_code':'NON_NORMAL_CHAIN','reason':'View direction is not established.',
        'nearest_projected_candidate':{'hinges':[0]},'source_handles':[['w1','w2']],
        'missing_evidence':[{'kind':'projection_definition','required':'Linked view plane'}]}
    row=bend_traceability(faces,[e],[p],[diagnostic])[0]
    assert row['signed_rotation_deg'] is None and row['direction'] is None
    assert row['reasons'][0]['profile']=='HAT-X'
    assert row['reasons'][0]['missing_evidence'][0]['required']=='Linked view plane'
    assert row['reasons'][0]['candidate_role']=='diagnostic only'


def test_engine_writes_traceability_before_material_validation(tmp_path):
    from test_complex_geometry import channel
    from flatforge.engine import run
    path=tmp_path/'source.dxf';channel(path,60)
    result=run({'source':str(path),'output':str(tmp_path/'out'),
                'settings':{'thickness':2,'radius':.7366,'deduction':4},'overrides':{'confirm_parameters':True}})
    assert any(i['code']=='BEND_PARAMETERS' for i in result['issues'])
    trace=result['bend_traceability']
    assert len(trace)==2 and all(x['status']=='RESOLVED_FROM_DRAWING' for x in trace)
    assert json.loads((tmp_path/'out/bend_traceability.json').read_text())==trace
    assert not (tmp_path/'out/panel.step').exists()


def test_source_less_angle_cannot_reach_solid_build(tmp_path,monkeypatch):
    from test_complex_geometry import channel
    from flatforge import engine
    original=engine.map_details
    def remove_provenance(*args,**kwargs):
        rows=original(*args,**kwargs)
        for e in args[2]:e['evidence']=[]
        return rows
    monkeypatch.setattr(engine,'map_details',remove_provenance)
    path=tmp_path/'source.dxf';channel(path,90)
    result=engine.run({'source':str(path),'output':str(tmp_path/'out'),'overrides':{'confirm_parameters':True}})
    assert any(i['code']=='BEND_TRACEABILITY' for i in result['issues'])
    assert result['traceability_summary']['NEEDS_REVIEW']==2
    assert not (tmp_path/'out/panel.step').exists()


def test_angle_changed_without_updating_source_is_not_resolved():
    faces,e=fixture();e['angle']=-90
    row=bend_traceability(faces,[e],[],[])[0]
    assert row['status']=='NEEDS_REVIEW'
    assert row['drawing_sources'][0]['angle']==-60
    assert 'DRAWING_PROVENANCE_INCOMPLETE' in {r['code'] for r in row['reasons']}
