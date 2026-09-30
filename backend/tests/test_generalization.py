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
from test_complex_geometry import channel


@pytest.mark.parametrize('angle,width,left,right,height,plan',[
    (30,573,24,46,123,113),(120.339,1100,52,39,194,-23)])
def test_unseen_sizes_angles_and_orientations_build_real_solid(tmp_path,angle,width,left,right,height,plan):
    source=tmp_path/'unseen.dxf'
    channel(source,angle,plan,main_width=width,left=left,right=right,height=height)
    r=run({'source':str(source),'output':str(tmp_path/'out')})
    assert r['status']=='PASS',r.get('issues')
    assert sorted(abs(b['angle']) for b in r['bends'])==pytest.approx(sorted([angle,90]),abs=1e-5)
    assert r['solid']['valid'] and r['solid']['solid_count']==1
    assert r['unfold_check']['status']=='PASS'
    # Volume derived independently from straight neutral strips and bend sectors.
    allowance=4*(angle/90+1)
    volume=2*height*(width+left+right-allowance+3*math.radians(angle+90))
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


def test_ill_conditioned_native_junction_explains_rejection():
    source=batch_source(147)
    with pytest.raises(g.GeometryEvidenceError) as raised:interpretation(source)
    d=raised.value.diagnostics
    assert d['stage']=='face_topology'
    assert d['proposed_move_mm']>d['limit_mm']
    assert d['nearby_bend_handles']
