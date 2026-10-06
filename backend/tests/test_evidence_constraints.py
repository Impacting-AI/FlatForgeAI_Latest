import copy
import numpy as np
import pytest
from shapely.geometry import box,LineString
from flatforge.evidence_constraints import solve_domains,propagate_source_axes


def test_shared_hinge_resolves_ambiguous_section_without_guessing():
    supported,report=solve_domains([[{0:60,1:-30},{0:-60,1:30}],[{0:60,2:121}]])
    assert supported==[{0},{0}]
    assert report[0]['solutions']==1 and report[0]['search_complete']


def test_cycle_conflict_is_not_accepted_by_pairwise_checks():
    # Every pair has a compatible choice, but the full cycle is inconsistent.
    domains=[[{0:30,1:30},{0:-30,1:-30}],
             [{1:30,2:30},{1:-30,2:-30}],
             [{2:30,0:-30},{2:-30,0:30}]]
    supported,report=solve_domains(domains)
    assert supported==[set(),set(),set()]
    assert report[0]['status']=='CONFLICT'


def test_conflict_is_component_scoped_and_order_independent():
    domains=[[{0:90}],[{0:60}],[{9:-121}]]
    a,ra=solve_domains(domains);b,rb=solve_domains(domains[::-1])
    assert a==b[::-1]==[set(),set(),{0}]
    assert sorted(r['status'] for r in ra)==['CONFLICT','CONSISTENT']


def test_search_budget_never_proves_uniqueness():
    supported,report=solve_domains([[{0:30},{0:60}],[{0:30},{0:60}]],limit=2)
    assert supported==[{0,1},{0,1}]
    assert report[0]['status']=='SEARCH_LIMIT'
    assert not report[0]['search_complete']


def edge(index,child,handle,angle=None,reverse=False):
    sign=-1 if reverse else 1
    result={'index':index,'child':child,'parent':0,'source':[{'handle':handle}],
            'u':np.array([0.,sign]),'normal':np.array([-sign,0.]),'offset':0.}
    if angle is not None:result.update(angle=angle,evidence=[{'angle':angle,'profile':'measured','vertex':1}])
    return result


def test_split_source_axis_transports_child_side_and_axis_orientation():
    faces=[box(-2,-1,2,1),box(-2,2,-1,3),box(1,2,2,3),box(1,4,2,5)]
    edges=[edge(0,1,'a',60),edge(1,2,'a'),edge(2,3,'a',reverse=True),edge(3,2,'different')]
    assert not propagate_source_axes(faces,edges)
    assert [e.get('angle') for e in edges]==[60,-60,60,None]
    assert edges[1]['evidence'][0]['source_hinge']==0
    again=copy.deepcopy(edges[::-1]);assert not propagate_source_axes(faces,again)
    assert [e.get('angle') for e in again[::-1]]==[60,-60,60,None]


def test_conflicting_source_axis_clears_all_affected_rotations():
    faces=[box(0,0,1,1),box(-2,2,-1,3)]
    edges=[edge(0,1,'a',60),edge(1,1,'a',90),edge(2,1,'a')]
    assert propagate_source_axes(faces,edges)
    assert all('angle' not in e for e in edges)


def test_real_section_conflict_does_not_keep_first_profile_angle(tmp_path):
    from test_complex_geometry import channel
    from flatforge import geometry as g
    from flatforge.section_mapping import map_normal_sections
    path=tmp_path/'panel.dxf';channel(path,60)
    d,o,out,b,lines=g.read_drawing(path);faces,edges,_,_,_=g.partition(out,b,lines,3)
    profiles=g.profiles(d,o,2);opposite=copy.deepcopy(profiles[0]);opposite['paint_normal']*=-1;opposite['paint_handle']='other'
    rows=map_normal_sections(faces,out,edges,[profiles[0],opposite],2,2,4)
    assert all(row['reason_code']=='SECTION_CONFLICT' for row in rows)
    assert all('angle' not in e for e in edges)


def test_agreement_range_does_not_drift_with_profile_order():
    domains=[[{0:60}],[{0:60.000009}],[{0:60.000018}]]
    for order in (domains,domains[::-1],[domains[1],domains[0],domains[2]]):
        supported,reports=solve_domains(order)
        assert all(not s for s in supported)
        assert reports[0]['status']=='CONFLICT'


def test_conflict_cannot_leak_through_an_overlapping_source():
    faces=[box(0,0,1,1),box(-2,2,-1,3)]
    edges=[edge(0,1,'a',60),edge(1,1,'a',90),edge(2,1,'z')]
    edges[0]['source'].append({'handle':'z'})
    assert propagate_source_axes(faces,edges)
    assert all('angle' not in e for e in edges)
