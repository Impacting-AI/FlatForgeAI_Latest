"""Real OpenCascade checks for rotated hinges, plus the supplied-file regressions."""
import hashlib
import math
import os
from pathlib import Path

import ezdxf
import numpy as np
import pytest
from flatforge import geometry as g
from flatforge.engine import run


def channel(path, angle=90., plan=37., layer='חיפוי', mirrored=False):
    doc=ezdxf.new('R2010');doc.units=4
    for name in ('CONTOR','KIFOF',layer):doc.layers.new(name)
    ms=doc.modelspace();phi=math.radians(plan)
    rot=np.array([[math.cos(phi),-math.sin(phi)],[math.sin(phi),math.cos(phi)]])
    def point(x,y):return tuple(rot@np.array([x,y]))
    ms.add_lwpolyline([point(0,0),point(265,0),point(265,80),point(0,80)],close=True,dxfattribs={'layer':'CONTOR'})
    for x in (30,230):ms.add_line(point(x,0),point(x,80),dxfattribs={'layer':'KIFOF'})
    # An annotation on the cutting layer must not turn into a hole or error.
    ms.add_linear_dim(base=point(0,-20),p1=point(0,0),p2=point(265,0),dxfattribs={'layer':'CONTOR'})
    gain=3*math.tan(math.radians(angle)/2)-4*(angle/90)/2
    lengths=[30+gain,200+gain+1,36]
    p1=np.array([1000.,1000.]);p2=p1+[lengths[1],0]
    pts=np.array([p1+lengths[0]*np.array([-math.cos(math.radians(angle)),math.sin(math.radians(angle))]),p1,p2,p2+[0,lengths[2]]])
    vectors=np.diff(pts,axis=0);vectors/=np.linalg.norm(vectors,axis=1)[:,None]
    normals=np.column_stack([-vectors[:,1],vectors[:,0]])
    for sign in (-1,1):
        offset=[pts[0]+sign*normals[0]]
        for i in range(2):
            offset.append(np.linalg.solve(np.array([normals[i],normals[i+1]]),[normals[i]@pts[i+1]+sign,normals[i+1]@pts[i+1]+sign]))
        offset.append(pts[-1]+sign*normals[-1])
        for a,b in zip(offset,offset[1:]):ms.add_line(a,b,dxfattribs={'layer':layer})
    marker=doc.blocks.new('Zeva');marker.add_lwpolyline([(0,0),(-3,-7),(3,-7)],close=True)
    ms.add_blockref('Zeva',((p1[0]+p2[0])/2,997),dxfattribs={'xscale':-1 if mirrored else 1})
    doc.saveas(path)


@pytest.mark.parametrize('angle,plan,mirrored',[(90,37,False),(60,37,True),(90,-31,True)])
def test_arbitrary_axis_solid_sections_unfold_and_step(tmp_path,angle,plan,mirrored):
    source=tmp_path/'source.dxf';channel(source,angle,plan,mirrored=mirrored)
    out=tmp_path/'result'
    result=run({'source':str(source),'output':str(out),'overrides':{'confirm_parameters':True}})
    assert result['status']=='PASS',result
    assert result['faces']==3 and result['physical_bends']==2
    assert result['contour_annotations'][0]['type']=='DIMENSION'
    assert all(c['chain_status']=='PASS' for c in result['section_checks'])
    assert result['unfold_check']['symmetric_difference_percent']<.01
    import cadquery as cq
    solid=cq.importers.importStep(str(out/'panel.step')).val()
    assert solid.isValid() and len(solid.Solids())==1
    # Independent physical invariant: disjoint cylindrical/planar strips.
    ba=4*angle/90+4
    expected_volume=(265-ba)*80*2+(3*math.radians(angle)+3*math.pi/2)*80*2
    assert solid.Volume()==pytest.approx(expected_volume,abs=.2)
    if angle==60:
        before=hashlib.sha256((out/'panel.step').read_bytes()).digest()
        again=run({'source':str(source),'output':str(tmp_path/'again'),'overrides':{'confirm_parameters':True}})
        assert again['status']=='PASS'
        assert hashlib.sha256((tmp_path/'again/panel.step').read_bytes()).digest()==before


def test_conflicting_section_lengths_do_not_export_solid(tmp_path):
    source=tmp_path/'source.dxf';channel(source,60)
    doc=ezdxf.readfile(source)
    # Change a real panel strip width while preserving all its section evidence.
    line=list(doc.modelspace().query('LINE[layer=="KIFOF"]'))[0]
    u=np.array([math.cos(math.radians(37)),math.sin(math.radians(37)),0])
    line.dxf.start=np.array(line.dxf.start)+5*u;line.dxf.end=np.array(line.dxf.end)+5*u
    doc.saveas(source)
    result=run({'source':str(source),'output':str(tmp_path/'out'),'overrides':{'confirm_parameters':True}})
    assert result['status']=='NEEDS_REVIEW'
    assert result['issues'][0]['code']=='SECTION_CORRESPONDENCE'
    assert not (tmp_path/'out/panel.step').exists()


def test_invalid_k_reports_the_actual_panel_settings(tmp_path):
    source=tmp_path/'source.dxf';channel(source)
    result=run({'source':str(source),'output':str(tmp_path/'out'),
                'settings':{'thickness':2.,'radius':2.,'deduction':8.}})
    issue=result['issues'][0]
    assert result['status']=='NEEDS_REVIEW'
    assert issue['code']=='BEND_PARAMETERS'
    assert issue['calculated_k']==-1
    assert issue['deduction_90_mm']==8
    assert 'BD90=8' in issue['message']
    assert not (tmp_path/'out/panel.step').exists()


@pytest.mark.parametrize('name,axes,faces',[('135',21,22),('145',14,17),('148',19,22)])
def test_supplied_complex_drawings_report_remaining_evidence(tmp_path,name,axes,faces):
    folder=os.environ.get('FLATFORGE_REGRESSION_DXF_DIR')
    if not folder:pytest.skip('Set FLATFORGE_REGRESSION_DXF_DIR to the supplied drawing directory')
    source=Path(folder)/f'PN_NM_{name}.dxf'
    result=run({'source':str(source),'output':str(tmp_path/'out')})
    assert result['bend_lines']==axes and result['faces']==faces
    assert result['unassigned_axes']==[]
    assert result['section_convention']['layer']=='חיפוי'
    assert result['status']=='NEEDS_REVIEW'
    assert result['issues'][0]['code']=='SECTION_CORRESPONDENCE'
    assert (tmp_path/'out/extraction.svg').exists()
    assert not (tmp_path/'out/panel.step').exists()
    unresolved=[m for m in result['section_mapping'] if m['status']!='PASS']
    assert all(m['reason_code'] in {'AMBIGUOUS_CHAIN','NO_CHAIN','NON_NORMAL_CHAIN','STRIP_LENGTH_MISMATCH'} for m in unresolved)
    for mapping in unresolved:
        nearest=mapping['nearest_candidate']
        if nearest:
            assert len(nearest['segment_checks'])==len(nearest['faces'])
