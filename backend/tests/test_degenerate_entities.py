"""Zero-size CAD debris does not create hinges; finite tiny axes remain errors."""
import ezdxf
import numpy as np
import pytest
from flatforge import geometry as g
from flatforge.engine import run
from test_complex_geometry import channel


def test_zero_bend_and_section_lines_are_audited_not_hinges(tmp_path):
    path=tmp_path/'source.dxf';channel(path,100)
    d=ezdxf.readfile(path);ms=d.modelspace()
    a=ms.add_line((100,100),(100,100),dxfattribs={'layer':'KIFOF'}).dxf.handle
    b=ms.add_line((1000,1000),(1000,1000),dxfattribs={'layer':'חיפוי'}).dxf.handle
    d.saveas(path)
    r=run({'source':str(path),'output':str(tmp_path/'out'),'overrides':{'confirm_parameters':True}})
    assert r['status']=='PASS',r
    assert r['physical_bends']==2
    assert {a,b}<={x.get('handle') for x in r['geometry_normalization']}
    assert (tmp_path/'out/panel.step').exists()


def test_nonzero_axis_below_resolution_is_not_silently_deleted(tmp_path):
    path=tmp_path/'tiny.dxf';channel(path)
    d=ezdxf.readfile(path)
    e=d.modelspace().add_line((0,0),(.0005,0),dxfattribs={'layer':'KIFOF'})
    d.saveas(path)
    with pytest.raises(ValueError,match='nonzero length.*below'):
        g.read_drawing(path)


def test_duplicate_contour_closing_vertex_preserves_oblique_topology(tmp_path):
    path=tmp_path/'repeat.dxf';channel(path,100)
    d=ezdxf.readfile(path)
    entity=next(iter(d.modelspace().query('LWPOLYLINE[layer=="CONTOR"]')))
    points=list(entity.get_points());entity.set_points([*points,points[0]])
    d.saveas(path)
    _,_,outer,blank,lines=g.read_drawing(path)
    faces,edges,_,_,_=g.partition(outer,blank,lines,3)
    assert len(edges)==2 and len(faces)==3
    assert sum(p.area for p in faces)==pytest.approx(outer.area,abs=.001)


def test_finite_short_boundary_support_is_not_called_zero_length():
    u,n,c=g.line_frame(np.array([0.,0.]),np.array([.0005,0.]))
    assert np.allclose(u,[1,0])
    with pytest.raises(ValueError,match='Coincident endpoints'):
        g.line_frame(np.zeros(2),np.zeros(2))


def test_only_zero_axes_remain_review_not_empty_fold_table_crash(tmp_path):
    path=tmp_path/'zero-only.dxf';channel(path,100)
    d=ezdxf.readfile(path)
    for e in d.modelspace().query('LINE[layer=="KIFOF"]'):e.dxf.end=e.dxf.start
    d.saveas(path)
    r=run({'source':str(path),'output':str(tmp_path/'out')})
    assert r['status']=='NEEDS_REVIEW' and r['physical_bends']==0
    assert any(i['code']=='LAYERS' and 'KIFOF' in i['message'] for i in r['issues'])
    assert not (tmp_path/'out/panel.step').exists()
