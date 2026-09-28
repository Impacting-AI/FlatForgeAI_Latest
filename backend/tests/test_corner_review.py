"""Continuation candidates depend on geometry, never a panel name or angle constant."""
import math
import numpy as np
import pytest
from shapely.geometry import Polygon,LineString
from flatforge import geometry as g
from flatforge.corner_review import continuation_candidates


def corner(slope):
    p=np.array([100.,-100*math.tan(math.radians(slope))])
    u=g.unit(p);n=np.array([-u[1],u[0]])
    origin=np.zeros(2);end=p-n*30
    faces=[Polygon([origin,p,[100,100],[0,100]]),Polygon([origin,p,end,origin-n*30]),
           Polygon([p,[100,100],[120,100],p+[20,0]]),Polygon([p,end,end+u*20,p+u*20])]
    edges=[]
    for i,(parent,child,a,b) in enumerate([(0,1,origin,p),(0,2,p,np.array([100.,100.])),(1,3,p,end)]):
        axis,normal,c=g.line_frame(a,b)
        edges.append({'index':i,'parent':parent,'child':child,'faces':[parent,child],'geom':LineString([a,b]),
                      'u':axis,'normal':normal,'offset':c,'angle':90.,'evidence':[{'profile':'section'}],
                      'source':[{'handle':str(i),'id':str(i)}]})
    return faces,edges


@pytest.mark.parametrize('slope',[10.,26.,35.,45.])
def test_geometric_candidate_changes_with_drawing(slope):
    faces,edges=corner(slope)
    candidates=continuation_candidates(faces,edges,[0,1,2,3],2,2,4)
    assert len(candidates)==1
    assert candidates[0]['candidate_rotation_deg']==pytest.approx(90+slope)
    assert candidates[0]['requires_confirmation']
    assert edges[2]['angle']==90,'Detection must not change a supplied angle'
    edges[2]['evidence']=[{'profile':'USER CONFIRMED'}]
    assert not continuation_candidates(faces,edges,[0,1,2,3],2,2,4)[0]['requires_confirmation']


def test_orthogonal_continuation_does_not_need_override():
    faces,edges=corner(0)
    assert continuation_candidates(faces,edges,[0,1,2,3],2,2,4)==[]


def test_unknown_angles_are_not_replaced_with_ninety():
    faces,edges=corner(25);edges[0].pop('angle')
    assert continuation_candidates(faces,edges,[0,1,2,3],2,2,4)==[]
    assert 'angle' not in edges[0]
