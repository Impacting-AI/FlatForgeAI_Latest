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
