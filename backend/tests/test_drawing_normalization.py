import ezdxf
import pytest
from flatforge.drawing_normalization import normalize
from flatforge.engine import run
from test_complex_geometry import channel


@pytest.mark.parametrize('representation', ['lines', 'polyline'])
def test_equivalent_contour_and_hinge_entities_build_same_solid(tmp_path, representation):
    source=tmp_path/'source.dxf'
    channel(source,60,plan=27,main_width=217,left=33,right=42,height=91)
    baseline=run({'source':str(source),'output':str(tmp_path/'baseline'),
                  'overrides':{'confirm_parameters':True}})
    doc=ezdxf.readfile(source);ms=doc.modelspace()
    outline=next(iter(ms.query('LWPOLYLINE[layer=="CONTOR"]')))
    points=list(outline.get_points('xy'))
    if representation=='lines':
        for a,b in zip(points,points[1:]+points[:1]):
            ms.add_line(a,b,dxfattribs={'layer':'CONTOR'})
    else:
        ms.add_polyline2d(points,close=True,dxfattribs={'layer':'CONTOR'})
    ms.delete_entity(outline)
    for hinge in list(ms.query('LINE[layer=="KIFOF"]')):
        ms.add_lwpolyline([tuple(hinge.dxf.start)[:2],tuple(hinge.dxf.end)[:2]],dxfattribs={'layer':'KIFOF'})
        ms.delete_entity(hinge)
    doc.saveas(source)
    converted=run({'source':str(source),'output':str(tmp_path/'converted'),
                   'overrides':{'confirm_parameters':True}})
    assert baseline['status']==converted['status']=='PASS'
    assert converted['entity_normalization']
    assert converted['bbox']==pytest.approx(baseline['bbox'],abs=1e-6)
    assert converted['solid']['volume_mm3']==pytest.approx(baseline['solid']['volume_mm3'],abs=.001)
    assert sorted(b['angle'] for b in converted['bends'])==pytest.approx(sorted(b['angle'] for b in baseline['bends']))


def test_open_contour_is_not_healed():
    doc=ezdxf.new();doc.layers.new('CONTOR')
    doc.modelspace().add_line((0,0),(10,0),dxfattribs={'layer':'CONTOR'})
    with pytest.raises(ValueError,match='closed rings'):normalize(doc)


def test_curved_hinge_is_not_straightened():
    doc=ezdxf.new();doc.layers.new('KIFOF')
    doc.modelspace().add_lwpolyline([(0,0,1),(10,0,0)],format='xyb',dxfattribs={'layer':'KIFOF'})
    with pytest.raises(ValueError,match='Curved KIFOF'):normalize(doc)


def test_nested_line_rings_preserve_hole_area():
    from flatforge import geometry as g
    import tempfile
    from pathlib import Path
    doc=ezdxf.new();doc.layers.new('CONTOR')
    for points in [[(0,0),(100,0),(100,100),(0,100)],[(40,40),(60,40),(60,60),(40,60)]]:
        for a,b in zip(points,points[1:]+points[:1]):doc.modelspace().add_line(a,b,dxfattribs={'layer':'CONTOR'})
    with tempfile.TemporaryDirectory() as tmp:
        path=Path(tmp)/'rings.dxf';doc.saveas(path)
        _,_,_,blank,_=g.read_drawing(path)
        assert blank.area==pytest.approx(9600)
