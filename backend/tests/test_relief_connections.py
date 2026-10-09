import math
import numpy as np
import pytest
from shapely.geometry import Polygon
from shapely.ops import unary_union
from flatforge import geometry as g


def line(a,b,id='hinge'):
    a=np.array(a,dtype=float);b=np.array(b,dtype=float)
    u,n,c=g.line_frame(a,b)
    return dict(a=a,b=b,id=id,handle=id,u=u,normal=n,offset=c,dim=0,c=0,orthogonal=False)


@pytest.mark.parametrize('angle,offset',[(0,(0,0)),(37,(0,0)),(-71,(187.3,-521.7)),(23,(1000000,-2000000))])
def test_bounded_contour_connection_and_exact_partition(angle,offset):
    v=math.radians(angle);r=np.array([[math.cos(v),-math.sin(v)],[math.sin(v),math.cos(v)]])
    def point(p):return r@p+offset
    outer=Polygon([point(p) for p in [(0,0),(100,0),(100,80),(0,80)]])
    hinges=[line(point([30,2]),point([30,78]))]
    cutters,records=g.relief_cutters(outer,hinges,3)
    assert [x['extension_mm'] for x in records]==pytest.approx([2,2],abs=1e-8)
    f,e,*_=g.partition(outer,outer,hinges,3)
    assert len(f)==2 and len(e)==1
    assert unary_union(f).symmetric_difference(outer).area<.001
    assert sorted(p.area for p in f)==pytest.approx([2400,5600],abs=.001)


def test_no_connection_does_not_extend_speculatively():
    outer=Polygon([(0,0),(100,0),(100,80),(0,80)])
    _,r=g.relief_cutters(outer,[line([30,4],[30,76])],3)
    assert all(x['extension_mm']==0 and x['target'] is None for x in r)


def test_first_boundary_of_concave_contour_wins():
    outer=Polygon([(0,0),(10,0),(10,10),(8,10),(8,2),(7,2),(7,10),(0,10)])
    _,r=g.relief_cutters(outer,[line([3,5],[6,5])],5)
    assert r[1]['connected_mm']==pytest.approx([7,5])
    assert r[1]['extension_mm']==pytest.approx(1)


def test_t_junction_stops_at_existing_hinge():
    outer=Polygon([(0,0),(100,0),(100,80),(0,80)])
    _,r=g.relief_cutters(outer,[line([0,40],[100,40],'parent'),line([30,2],[30,38],'child')],3)
    end=next(x for x in r if x['handle']=='child' and x['endpoint']=='b')
    assert end['target']=='parent' and end['extension_mm']==pytest.approx(2)


def test_existing_boundary_endpoint_is_not_extended():
    outer=Polygon([(0,0),(100,0),(100,80),(0,80)])
    _,r=g.relief_cutters(outer,[line([30,0],[30,80])],3)
    assert all(x['extension_mm']==0 for x in r)


@pytest.mark.parametrize('angle,offset',[(0,(0,0)),(37,(187.3,-521.7)),(-71,(1e6,-2e6))])
def test_nearly_parallel_boundary_junction_preserves_material(angle,offset):
    # The hinge meets the bottom outline at a 0.000057 degree angle. Its
    # infinite supports must not be confused with parallel or extrapolated.
    theta=math.radians(angle)
    rotation=np.array([[math.cos(theta),-math.sin(theta)],[math.sin(theta),math.cos(theta)]])
    def point(p):return rotation@p+offset
    outer=Polygon([point(p) for p in [(0,0),(1000000,0),(1000000,100),(0,100)]])
    hinges=[line(point([0,0]),point([1000000,1]))]
    faces,edges,*_=g.partition(outer,outer,hinges,3)
    assert len(faces)==2 and len(edges)==1
    assert sorted(p.area for p in faces)==pytest.approx([500000,99500000],abs=.002)
    assert unary_union(faces).symmetric_difference(outer).area<.002
    assert all(x['extension_mm']==0 for x in g.partition.extensions)


def test_roundoff_vertex_contact_is_recovered_but_real_gap_is_not():
    outer=Polygon([(0,0),(10,0),(10,8),(4,8),(2,6),(0,8)])
    # The ray touches the tip of the V; moving a few floating-point ulps off
    # the tip must not make the entire 2 mm connection disappear.
    _,records=g.relief_cutters(outer,[line([2+1e-10,2],[2+1e-10,4])],3)
    assert records[1]['extension_mm']==pytest.approx(2,abs=1e-8)
    assert records[1]['target']=='contour'
    # A real 0.01 mm near miss is NOT treated as the vertex. The first actual
    # segment intersection is 0.01 mm further along the relief ray.
    _,records=g.relief_cutters(outer,[line([2.01,2],[2.01,4])],3)
    assert records[1]['connected_mm']==pytest.approx([2.01,6.01],abs=1e-8)


def test_per_hinge_limit_is_not_exceeded():
    outer=Polygon([(0,0),(100,0),(100,80),(0,80)])
    hinge=line([30,2],[30,78]);hinge['relief_extension']=1.9
    _,records=g.relief_cutters(outer,[hinge],3)
    assert all(x['extension_mm']==0 for x in records)


def test_real_gap_just_beyond_limit_is_not_accepted_as_roundoff():
    outer=Polygon([(0,0),(100,0),(100,80),(0,80)])
    _,records=g.relief_cutters(outer,[line([30,3.000001],[30,76.999999])],3)
    assert all(x['extension_mm']==0 for x in records)
