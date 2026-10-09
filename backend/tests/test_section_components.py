import numpy as np
from shapely.geometry import box
from flatforge.section_mapping import connected_traces, map_normal_sections


def test_gap_splits_scope_but_missing_hinge_does_not_invent_a_free_edge():
    items=[(0,10,0),(10,20,1),(40,50,2),(50,60,3)]
    assert connected_traces(items,{})==[items[:2],items[2:]]


def test_disjoint_section_region_can_establish_its_own_hinges():
    # A plane intersects an unrelated sheet region beyond a physical gap.
    # Full-chain matching used to discard this valid documented region.
    faces=[box(30,0,230,80),box(0,0,30,80),box(230,0,265,80),box(300,0,320,80)]
    outer=box(0,0,320,80)
    edges=[]
    for index,(child,x) in enumerate([(1,30),(2,230)]):
        edges.append(dict(index=index,faces=(0,child),parent=0,child=child,
                          u=np.array([0.,1.]),normal=np.array([-1.,0.]),offset=-float(x)))
    profile={'points':np.array([[0.,31.],[0.,0.],[202.,0.],[202.,36.]]),
             'segments':[{'handles':[str(i)]} for i in range(3)],'main':1,
             'paint_normal':np.array([0.,1.]),'paint_handle':'marker','layer':'HAT'}
    rows=map_normal_sections(faces,outer,edges,[profile],2,2,4)
    assert rows[0]['status']=='PASS',rows
    assert rows[0]['scope']=='disconnected_region'
    assert {abs(e['angle']) for e in edges}=={90}
    assert [x[2] for x in profile['trace']]==[1,0,2]
