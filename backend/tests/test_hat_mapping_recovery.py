import copy
import numpy as np
import pytest
from shapely.geometry import box,LineString
from flatforge import geometry as g
from flatforge.detail_mapping import (local_candidates,anchored_local_candidate,constrain_local_candidates,
    reconcile_local_candidates,local_angle_budgets,commit)
from flatforge.evidence_constraints import solve_domains
from flatforge.section_diagnostics import explain_mapping,explain_unmapped_hinges


def hinge(index,a,b,parent,child):
    u,n,c=g.line_frame(np.array(a,float),np.array(b,float))
    return dict(index=index,faces=(parent,child),parent=parent,child=child,u=u,normal=n,offset=c,
                geom=LineString([a,b]),source=[{'handle':str(index),'id':str(index)}])


def profile(name='detail',marker='paint'):
    return dict(name=name,paint_handle=marker,points=np.array([[0.,0.],[21.,0.],[21.,32.],[10.,32.]]),
                main=0,paint_normal=np.array([0.,1.]),segments=[{'handles':[str(i)],'parallel_error_deg':0.} for i in range(3)])


@pytest.mark.parametrize('turns',[(90,90),(60,121),(30,60)])
def test_terminal_detail_on_non_base_parent_has_measured_per_bend_angles(turns):
    faces=[box(-10,-100,10,0),box(-10,0,10,80),box(10,0,40,80),box(40,0,50,80)]
    edges=[hinge(0,[-10,0],[10,0],0,1),hinge(1,[10,0],[10,80],1,2),hinge(2,[40,0],[40,80],2,3)]
    p=profile()
    gains=2-np.tan(np.radians(turns)/2)
    lengths=np.array([20.,30.,10.])+np.r_[0,gains]+np.r_[gains,0]
    directions=np.radians([0,turns[0],sum(turns)])
    p['points']=np.vstack(([0.,0.],np.cumsum(lengths[:,None]*np.column_stack((np.cos(directions),np.sin(directions))),axis=0)))
    candidates=local_candidates(p,faces,edges,2,.7366,4)
    assert len(candidates)==1
    c=candidates[0]
    assert c['root_face']==1 and c['scope']=='terminal_return_detail'
    assert c['chain']==[1,2,3] and c['angles']==pytest.approx([-a for a in turns])
    assert anchored_local_candidate(p,candidates) is None
    edges[1].update(angle=-turns[0],evidence=[{'profile':'independent','paint_marker':'other'}])
    selected,anchors=anchored_local_candidate(p,candidates)
    assert anchors and commit(p,selected['hinges'],selected['angles'],'anchored terminal detail')
    assert edges[2]['angle']==pytest.approx(-turns[1]) and 'angle' not in edges[0]


def entry(name,marker,values,ids=(0,1)):
    p=profile(name,marker)
    c=dict(chain=[0,1,2],root_face=0,hinges=[{'index':i} for i in ids],angles=list(values),
           signature=tuple(zip(ids,values)),error=.1,boundary=None)
    return p,{},[c]


def test_whole_drawing_filters_local_candidates_with_independent_hinge():
    a=entry('a','a',[60,-30]);wrong=copy.deepcopy(a[2][0]);wrong.update(angles=[-60,30],signature=((0,-60),(1,30)))
    a[2].append(wrong)
    b=entry('b','b',[60,121],ids=(0,2))
    result=constrain_local_candidates([a,b],[{'index':2,'angle':121}])
    assert len(result)==2 and all(len(choices)==1 for _,_,choices in result)
    assert result[0][2][0]['angles']==[60,-30]
    assert result[1][2][0]['angles']==[60,121]


def test_local_conflict_does_not_poison_unrelated_profile():
    a=entry('a','a',[60,30]);b=entry('b','b',[90,90],ids=(8,9))
    result=constrain_local_candidates([a,b],[{'index':0,'angle':90},{'index':8,'angle':90}])
    assert [p['name'] for p,_,_ in result]==['b']
    assert a[1]['reason_code']=='LOCAL_SECTION_CONFLICT'
    explain_mapping(a[0],a[1],a[2])
    assert a[1]['missing_evidence'][0]['kind']=='contradictory_evidence'


def test_short_return_does_not_relax_other_vertex_uncertainty():
    a=entry('a','a',[60,90]);b=entry('b','b',[60.05,90])
    for p,_,_ in (a,b):p['points']=np.array([[0.,0.],[1000.,0.],[1000.,1000.],[1001.,1000.]])
    assert not reconcile_local_candidates([a,b])
    budgets=local_angle_budgets(a[0],a[2][0])
    assert budgets[0]<.006 and budgets[1]==1


def test_associated_numeric_dimension_is_not_relaxed_as_wall_noise():
    p,_,choices=entry('a','a',[60,90])
    p['angle_dimensions']=[{'wall_handles':['0','1'],'status':'MATCHED'}]
    assert local_angle_budgets(p,choices[0])[0]==1e-5


def test_interval_consistency_does_not_accumulate_pairwise_drift():
    domains=[[{0:60}],[{0:60.08}],[{0:60.16}]]
    budgets=[[{0:.05}],[{0:.05}],[{0:.05}]]
    supported,reports=solve_domains(domains,angle_budgets=budgets)
    assert supported==[set(),set(),set()] and reports[0]['status']=='CONFLICT'
    supported,_=solve_domains([[{0:60}],[{0:60.04}]],angle_budgets=[[{0:.03}],[{0:.03}]])
    assert supported==[{0},{0}]
    supported,_=solve_domains([[{0:.1}],[{0:-.1}]],angle_budgets=[[{0:1}],[{0:1}]])
    assert supported==[set(),set()]


def test_projected_diagnostics_never_turn_apparent_angles_into_rotations():
    p=profile();row={'status':'NEEDS_REVIEW','reason_code':'NON_NORMAL_CHAIN',
        'nearest_projected_candidate':{'hinges':[4],'turn_angles_deg':[121.],'normal_to_all_hinges':False}}
    explain_mapping(p,row,[])
    assert row['projected_evidence']['angle_role'].startswith('apparent')
    assert row['missing_evidence'][0]['kind']=='projection_definition'
    edges=[hinge(4,[0,0],[1,1],0,1)]
    missing=explain_unmapped_hinges(edges,[p],[row])
    assert missing[0]['source_handles']==['4'] and 'angle' not in edges[0]


def test_annotation_contradiction_is_quarantined_before_normal_mapping(tmp_path):
    from test_complex_geometry import channel
    from flatforge.section_mapping import map_normal_sections
    path=tmp_path/'panel.dxf';channel(path)
    d,o,outer,blank,lines=g.read_drawing(path);faces,edges,*_=g.partition(outer,blank,lines,3)
    ps=g.profiles(d,o,2)
    ps[0]['angle_dimensions']=[{'status':'CONFLICT','handle':'dimension','reason':'wrong sector'}]
    rows=map_normal_sections(faces,outer,edges,ps,2,.7366,4)
    assert rows[0]['reason_code']=='ANGLE_EVIDENCE_CONFLICT'
    assert all('angle' not in e for e in edges)


def client_source(filename):
    import os
    from pathlib import Path
    root=os.getenv('FLATFORGE_CLIENT_DXF_DIR')
    if not root:pytest.skip('Set FLATFORGE_CLIENT_DXF_DIR for approved-client native regressions')
    return Path(root)/filename


def test_approved_90_degree_marker_sections_remain_mapped():
    path=client_source('PN_PL_1570.dxf')
    d,o,outer,blank,lines=g.read_drawing(path);faces,edges,*_=g.partition(outer,blank,lines,3)
    ps=g.profiles(d,o,2)
    g.map_sections(d,o,faces,outer,edges,ps,2,.7366,4)
    # Baseline topology: 21 source lines, 20 physical hinge adjacencies. This
    # regression checks mapping continuity, not approved-STEP equivalence.
    assert len(lines)==21 and len(edges)==20
    assert all(abs(e['angle'])==pytest.approx(90) for e in edges)
    from flatforge.section_diagnostics import bend_traceability
    assert all(row['status']=='RESOLVED_FROM_DRAWING' for row in bend_traceability(faces,edges,ps,[]))


def test_legacy_mapper_does_not_choose_between_distinct_chains_by_lane_width():
    path=client_source('PN_PL_1648 (1).dxf')
    d,o,outer,blank,lines=g.read_drawing(path);faces,edges,*_=g.partition(outer,blank,lines,3)
    ps=g.profiles(d,o,2)
    with pytest.raises(ValueError,match='multiple physical section chains'):
        g.map_sections(d,o,faces,outer,edges,ps,2,.7366,4)
