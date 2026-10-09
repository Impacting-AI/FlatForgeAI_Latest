"""Geometry-driven variations, separate from known customer filenames."""
import math
import os
import random
from pathlib import Path
import ezdxf
from ezdxf.math import Matrix44
import numpy as np
import pytest
from flatforge import geometry as g
from flatforge.angle_evidence import annotate_profiles
from flatforge.detail_mapping import map_details
from flatforge.engine import run
from test_complex_geometry import channel, fixture_material


@pytest.mark.parametrize('angle,width,left,right,height,plan',[
    (30,573,24,46,123,113),(120.339,1100,52,39,194,-23)])
def test_unseen_sizes_angles_and_orientations_build_real_solid(tmp_path,angle,width,left,right,height,plan):
    source=tmp_path/'unseen.dxf'
    radius,deduction=fixture_material(angle)
    channel(source,angle,plan,main_width=width,left=left,right=right,height=height,deduction=deduction)
    r=run({'source':str(source),'output':str(tmp_path/'out'),'settings':{'radius':radius,'deduction':deduction},'overrides':{'accept_partial_sections':angle<45}})
    assert r['status']=='PASS',r.get('issues')
    assert sorted(abs(b['angle']) for b in r['bends'])==pytest.approx(sorted([angle,90]),abs=1e-5)
    assert r['solid']['valid'] and r['solid']['solid_count']==1
    assert r['unfold_check']['status']=='PASS'
    # Volume derived independently from straight neutral strips and bend sectors.
    allowance=2*(radius+2)*(math.tan(math.radians(angle)/2)+1)-2*deduction
    volume=2*height*(width+left+right-allowance+(radius+1)*math.radians(angle+90))
    assert r['solid']['volume_mm3']==pytest.approx(volume,abs=.3)


def batch_source(number):
    root=os.environ.get('FLATFORGE_BATCH_DXF_DIR')
    if not root:pytest.skip('Set FLATFORGE_BATCH_DXF_DIR to the unzipped production batch')
    matches=sorted(Path(root).glob(f'PN_NM_{number}*.dxf'))
    if len(matches)!=1:pytest.fail(f'Expected exactly one fixture for {number}')
    return matches[0]


def interpretation(path):
    d,o,outer,blank,lines=g.read_drawing(path);faces,edges,_,_,_=g.partition(outer,blank,lines,3)
    profiles=g.profiles(d,o,2);annotate_profiles(d,o,profiles,2)
    rows=map_details(faces,outer,edges,profiles,2,2,4)
    turns=[]
    for e in edges:
        if 'angle' not in e:continue
        _,n,c=g.support(e)
        side=np.sign(np.array(faces[e['child']].representative_point().coords[0])@n-c)
        turns.append(e['angle']*side)
    return len(faces),len(edges),blank.area,sorted(turns),sorted(row['status'] for row in rows)


@pytest.mark.parametrize('number',[n for n in range(135,150) if n!=147])
@pytest.mark.parametrize('rotation',[37,113])
def test_native_batch_rigid_transform_and_entity_reordering(number,rotation,tmp_path):
    source=batch_source(number);base=interpretation(source)
    d=ezdxf.readfile(source);ms=d.modelspace();entities=list(ms);random.Random(982).shuffle(entities)
    matrix=Matrix44.chain(Matrix44.z_rotate(math.radians(rotation)),Matrix44.translate(187.3,-521.7,0))
    for entity in entities:
        clone=entity.copy();clone.transform(matrix);ms.delete_entity(entity);ms.add_entity(clone)
    target=tmp_path/'unrelated-filename.dxf';d.saveas(target);variant=interpretation(target)
    assert variant[:2]==base[:2]
    assert variant[2]==pytest.approx(base[2],rel=1e-6)
    assert variant[3]==pytest.approx(base[3],abs=.002)
    assert variant[4]==base[4]


def test_native_relief_extension_removes_overshoot_but_reports_remaining_topology():
    source=batch_source(147)
    d,o,outer,blank,lines=g.read_drawing(source)
    with pytest.raises(g.GeometryEvidenceError) as raised:
        g.partition(outer,blank,lines,3)
    # Removing the numerical overshoot does not authorize deleting an
    # extension-only corner region to force a connected tree.
    assert 'Analytic hinge-junction recovery requires' not in str(raised.value)
    assert 'Face adjacency' in str(raised.value)
    assert raised.value.diagnostics['disconnected_faces']
    extensions=[r for r in g.partition.extensions if r['handle']=='2C2']
    assert len(extensions)==2
    assert [r['extension_mm'] for r in extensions]==pytest.approx([2,2],abs=1e-6)


@pytest.mark.parametrize('rotation,offset',[(37,(187.3,-521.7)),(-71,(100000,-200000)),(90,(1e6,-2e6)),(123.456,(-1e6,2e6))])
def test_native_relief_rigid_variants_report_topology_not_large_recovery(rotation,offset):
    from flatforge.drawing_normalization import normalize
    d=ezdxf.readfile(batch_source(147));normalize(d)
    matrix=Matrix44.chain(Matrix44.z_rotate(math.radians(rotation)),Matrix44.translate(*offset,0))
    for entity in d.modelspace():entity.transform(matrix)
    _,_,outer,blank,lines=g.read_drawing('rigid-variant.dxf',d)
    with pytest.raises(g.GeometryEvidenceError) as raised:
        g.partition(outer,blank,lines,3)
    assert 'Analytic hinge-junction recovery requires' not in str(raised.value)
    assert 'Face adjacency' in str(raised.value)
    evidence=raised.value.diagnostics
    assert evidence['code']=='RELIEF_CORNER_AMBIGUITY'
    assert evidence['face_count']==20 and evidence['edge_count']==18
    assert {r['handle'] for r in evidence['disconnected_faces'][0]['relief_connections']}=={'2B7','2C5'}
    assert len(evidence['disconnected_faces'])==1
    assert evidence['areas'][-1]==pytest.approx(1.75277674965,abs=1e-7)
    affected=[r['extension_mm'] for r in g.partition.extensions if r['handle']=='2C2']
    assert affected==pytest.approx([2,2],abs=1e-7)
    assert all(r['extension_mm']<=r['limit_mm']+1e-8 for r in g.partition.extensions)
