import math
import numpy as np
import pytest
from flatforge import geometry as g
from flatforge.wall_pairing import parallel_pair


def wall(a,b):
    a=np.array(a,dtype=float);b=np.array(b,dtype=float);u,n,c=g.line_frame(a,b)
    return dict(a=a,b=b,u=u,normal=n,c=c)


@pytest.mark.parametrize('angle',[0,37,113,179])
def test_skew_wall_spacing_is_local_and_rigid_motion_invariant(angle):
    theta=math.radians(angle);r=np.array([[math.cos(theta),-math.sin(theta)],[math.sin(theta),math.cos(theta)]])
    shift=np.array([2e6,-3e6])
    a=wall(r@np.array([0,0])+shift,r@np.array([120,0])+shift)
    b=wall(r@np.array([0,2])+shift,r@np.array([120,2.006])+shift)
    pair=parallel_pair(a,b,2)
    assert pair is not None
    assert pair['wall_spacing_mm']==pytest.approx(2.003,abs=1e-6)
    assert pair['spacing_range_mm']==pytest.approx([2,2.006],abs=1e-6)


def test_spacing_violation_at_far_end_is_not_hidden_by_midpoint():
    assert parallel_pair(wall([0,0],[2000,0]),wall([0,2],[2000,2.09]),2) is None


def test_no_overlap_or_wrong_thickness_stays_unpaired():
    assert parallel_pair(wall([0,0],[100,0]),wall([101,2],[200,2]),2) is None
    assert parallel_pair(wall([0,0],[100,0]),wall([0,3],[100,3]),2) is None


def test_rotated_thickness_is_detected_without_confirmation(tmp_path):
    import ezdxf
    from ezdxf.math import Matrix44
    from flatforge.engine import thickness_evidence
    from test_complex_geometry import channel
    path=tmp_path/'p.dxf';channel(path,60)
    d=ezdxf.readfile(path)
    for e in d.modelspace():e.transform(Matrix44.z_rotate(math.radians(113)))
    evidence=thickness_evidence(d)
    assert evidence['value']==2
    assert evidence['confidence']=='drawing'


@pytest.mark.parametrize('rotation',[0,37,113])
def test_unique_paired_miter_recovers_one_gapped_skin(rotation):
    from flatforge.wall_pairing import ends_supported
    theta=math.radians(rotation);r=np.array([[math.cos(theta),-math.sin(theta)],[math.sin(theta),math.cos(theta)]])
    def w(a,b):return wall(r@np.array(a)+[20000,-30000],r@np.array(b)+[20000,-30000])
    # Acute 60-degree included corner, outer skin is connected exactly;
    # inner skin is deliberately short by 0.3 mm along its direction.
    u=np.array([.5,math.sqrt(3)/2]);normal=np.array([-u[1],u[0]])
    a=w([0,0],u*30)
    # Construct the parallel sloped skin by a signed normal offset directly.
    origin=-2*normal;vertex=origin+u*((2-origin[1])/u[1])
    b=w(vertex+.3*u,origin+30*u)
    c=w([0,0],[30,0]);d=w(vertex,[30,2])
    pair=parallel_pair(a,b,2)
    assert pair is not None
    assert ends_supported(pair,[a,b,c,d],2)
    assert pair['endpoint_recovery']
    assert ends_supported(pair,[a,b,c],2) is False
