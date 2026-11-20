"""Shaped ends, local defects and conservative section evidence regressions."""
import math
import numpy as np
import pytest
from shapely.geometry import Polygon,box,Point

from flatforge.bend_geometry import cylindrical_solid
from flatforge.local_validation import compare_boundaries
from flatforge.section_evidence import remove_unmarked_duplicates


@pytest.mark.parametrize('angle',[60.,-90.,120.])
def test_stepped_bend_with_hole_preserves_cylinders_and_developed_volume(angle):
    import cadquery as cq
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    p=Polygon([(0,0),(40,0),(40,2),(20,2),(20,4),(0,4)],
              holes=[[(4,.5),(4,1),(5,1),(5,.5)]])
    e={'axis':np.array([1.,0,0]),'d':np.array([0.,1,0]),'hinge':np.array([0,2.,0]),
       'w':np.array([0.,0,1]),'center':np.array([0.,0,3.]),'angle':angle,'allowance':4.,'radius':2.}
    s=cylindrical_solid(p,e,(np.eye(3),np.zeros(3)),2.)
    assert s.isValid() and len(s.Solids())==1
    assert sum(f.geomType()=='CYLINDER' for f in s.Faces())==2
    assert s.Volume()==pytest.approx(p.area*abs(math.radians(angle))/4*6,rel=1e-6)
    def point(x,y):
        a=math.radians(angle)*y/4
        return cq.Vertex.makeVertex(x,3*math.sin(a),3-3*math.cos(a))
    # This wing occupies only the first half of the angular bend. A uniform
    # extrusion either loses the first point or wrongly includes the second.
    assert BRepExtrema_DistShapeShape(point(30,1).wrapped,s.wrapped).Value()<1e-6
    assert BRepExtrema_DistShapeShape(point(30,3).wrapped,s.wrapped).Value()>.5
    assert BRepExtrema_DistShapeShape(point(4.5,.75).wrapped,s.wrapped).Value()>.05


def test_local_check_catches_small_area_notch_and_missing_hole():
    expected=box(0,0,1000,1000).difference(Point(500,500).buffer(2))
    for actual in (expected.difference(box(999,490,1001,491)),box(0,0,1000,1000)):
        assert expected.symmetric_difference(actual).area/expected.area<.005
        result=compare_boundaries(expected,actual,.5)
        assert result['status']=='FAIL'
        assert result['sampled_max_mm']>.5
    assert compare_boundaries(expected,expected,.5)['status']=='PASS'


def test_duplicate_detail_requires_rigid_match_to_marked_section():
    points=np.array([[0,0],[0,5],[12,5],[12,9],[15,9]],dtype=float)
    donor={'points':points,'segments':[{'handles':[str(i)]} for i in range(4)]}
    rotation=np.array([[0,-1],[1,0]])
    copy={'points':points[1:]@rotation+[100,100],'segments':[{'handles':['copy'+str(i)]} for i in range(3)]}
    marker=[('paint',np.array([[4,6],[6,6],[5,5.5]]))]
    kept,duplicates=remove_unmarked_duplicates([copy,donor],marker,2)
    assert len(kept)==1 and kept[0] is donor and len(duplicates)==1
    assert duplicates[0]['matches'][0]['max_vertex_error_mm']<1e-8
    copy['points'][0,0]+=.02
    kept,duplicates=remove_unmarked_duplicates([copy,donor],marker,2)
    assert len(kept)==2 and not duplicates


def test_corner_radius_changes_only_selected_junction_and_preserves_source(tmp_path):
    import ezdxf
    from flatforge import geometry as g
    doc=ezdxf.new();ms=doc.modelspace()
    ms.add_lwpolyline([(0,0),(20,0),(20,20),(0,20)],close=True,dxfattribs={'layer':'CONTOR'})
    ms.add_line((0,10),(20,10),dxfattribs={'layer':'KIFOF'})
    ms.add_line((10,0),(10,10),dxfattribs={'layer':'KIFOF'})
    corner=ms.add_circle((10,10),1.5,dxfattribs={'layer':'CONTOR'})
    ordinary=ms.add_circle((4,4),1.5,dxfattribs={'layer':'CONTOR'})
    path=tmp_path/'corners.dxf';doc.saveas(path)
    _,_,_,original,_=g.read_drawing(path)
    _,_,_,adjusted,_=g.read_drawing(path,{corner.dxf.handle:3.})
    assert original.area-adjusted.area==pytest.approx(math.pi*(9-2.25),abs=.1)
    assert len(g.read_drawing.relief_circles)==1
    assert next(iter(ezdxf.readfile(path).modelspace().query('CIRCLE'))).dxf.radius==1.5
    for values in ({corner.dxf.handle:1.},{ordinary.dxf.handle:3.},{'unknown':3.}):
        with pytest.raises(ValueError):g.read_drawing(path,values)


def test_hidden_contact_coverage_checks_material_through_thickness():
    import cadquery as cq
    from flatforge.local_validation import contact_coverage
    blank=box(0,0,10,10);missing=box(4,4,6,6);visible=blank.difference(missing)
    solid=cq.Solid.makeBox(10,10,2,cq.Vector(0,0,-1))
    tf={0:(np.eye(3),np.zeros(3))}
    covered,proof=contact_coverage(solid,visible,blank,[blank],[],tf,2,.5)
    assert proof['verified_area_mm2']==pytest.approx(4)
    assert compare_boundaries(blank,covered,.5)['status']=='PASS'
    # Intact top and bottom skins must not conceal an internal void.
    cavity=cq.Solid.makeBox(2,2,1.5,cq.Vector(4,4,-.75))
    covered,proof=contact_coverage(solid.cut(cavity),visible,blank,[blank],[],tf,2,.5)
    assert proof['verified_area_mm2']==0
    assert compare_boundaries(blank,covered,.5)['status']=='FAIL'


def test_corner_review_api_records_exports_and_clears_the_cut(tmp_path):
    import os,io,ezdxf
    from fastapi.testclient import TestClient
    from flatforge.api import app
    from flatforge import worker
    doc=ezdxf.new();doc.units=4;ms=doc.modelspace()
    for layer in ('CONTOR','KIFOF'):doc.layers.new(layer)
    ms.add_lwpolyline([(0,0),(20,0),(20,10),(10,10),(10,20),(0,20)],close=True,dxfattribs={'layer':'CONTOR'})
    ms.add_line((0,10),(20,10),dxfattribs={'layer':'KIFOF'})
    ms.add_line((10,0),(10,10),dxfattribs={'layer':'KIFOF'})
    circle=ms.add_circle((10,10),1.5,dxfattribs={'layer':'CONTOR'});key=circle.dxf.handle
    source=tmp_path/'corner.dxf';doc.saveas(source)
    with TestClient(app) as client:
        client.headers['X-Flatforge-Key']=os.environ['FLATFORGE_API_KEY']
        project=client.post('/projects',json={'name':'Corner cuts regression'}).json()
        with source.open('rb') as f:
            response=client.post(f"/projects/{project['id']}/upload",files=[('files',(source.name,f,'application/dxf'))])
        url='/panels/'+response.json()['panels'][0]['id'];worker.process(worker.claim())
        assert client.get(url).json()['report']['relief_circles'][0]['original_radius_mm']==1.5
        for payload in ({'relief_radii':{'unknown':3}}, {'relief_radii':{key:1}}, {'relief_radii':{key:3}}):
            assert client.post(url+'/review',json=payload).status_code==422
        assert client.post(url+'/review',json={'relief_radii':{key:3},'review_note':'Radius measured from approved shape.'}).status_code==202
        worker.process(worker.claim());panel=client.get(url).json()
        assert panel['overrides']['relief_radii']=={key:3}
        assert panel['report']['relief_cut_area_removed_mm2']==pytest.approx(math.pi*6.75*.75,abs=.1)
        for name,radius in [('flat.dxf',3),('original_flat.dxf',1.5)]:
            drawing=ezdxf.read(io.StringIO(client.get(url+'/files/'+name).text))
            assert next(iter(drawing.modelspace().query('CIRCLE'))).dxf.radius==radius
        assert client.post(url+'/review',json={'relief_radii':{key:None}}).status_code==202
        worker.process(worker.claim());panel=client.get(url).json()
        assert not panel['overrides']['relief_radii']
        assert panel['report']['relief_circles'][0]['used_radius_mm']==1.5
        client.delete(f"/projects/{project['id']}")
