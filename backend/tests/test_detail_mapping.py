"""Approved complex-panel regression and anti-hardcoding/negative controls."""
import os
from pathlib import Path
import numpy as np
import pytest
import ezdxf
from ezdxf.math import Matrix44
from flatforge import geometry as g
from flatforge.detail_mapping import map_details
from flatforge.engine import run


def source():
    folder=os.getenv('FLATFORGE_REGRESSION_DXF_DIR')
    if not folder:pytest.skip('Supply original customer DXFs via FLATFORGE_REGRESSION_DXF_DIR')
    return Path(folder)/'PN_NM_149.dxf'


def map_file(path):
    d,o,outer,blank,lines=g.read_drawing(path)
    f,e,parents,order,material=g.partition(outer,blank,lines,3.)
    p=g.profiles(d,o,2.)
    return f,e,p,map_details(f,outer,e,p,2.,2.,4.)


def test_approved_complex_panel_automatic_solid(tmp_path):
    import cadquery as cq
    r=run({'source':str(source()),'output':str(tmp_path)})
    assert r['status']=='PASS',r.get('issues')
    assert r['physical_bends']==27 and r['faces']==28
    assert np.allclose(r['bbox'],[729.1647801204218,1315.0277050265272,400.0802267167521],atol=.001)
    assert r['unfold_check']['symmetric_difference_percent']<.02
    assert len(r['section_checks'])==6
    assert all(c['chain_status']=='PASS' for c in r['section_checks'])
    assert sum(c.get('validation_scope')=='local_edge_profile' for c in r['section_checks'])==2
    s=cq.importers.importStep(str(tmp_path/'panel.step')).val()
    assert s.isValid() and len(s.Solids())==1
    assert s.Volume()==pytest.approx(3135385.3349138047,abs=.1)


def test_rotated_renamed_drawing_maps_without_fixed_ids(tmp_path):
    d=ezdxf.readfile(source());m=Matrix44.z_rotate(np.radians(37))
    for entity in d.modelspace():entity.transform(m)
    # Re-create all modelspace entities to invalidate the original DXF handles.
    ms=d.modelspace()
    for entity in list(ms):
        clone=entity.copy();ms.delete_entity(entity);ms.add_entity(clone)
    path=tmp_path/'arbitrary-project-panel.dxf';d.saveas(path)
    f,e,p,rows=map_file(path)
    assert all(r['status']=='PASS' for r in rows),rows
    assert len(e)==27 and all('angle' in x for x in e)


def test_uncorroborated_side_profile_does_not_supply_rotations():
    d,o,outer,blank,lines=g.read_drawing(source())
    f,e,_,_,_=g.partition(outer,blank,lines,3)
    p=g.profiles(d,o,2)
    # Remove one independent side view, retaining the other and both transverse details.
    p.pop(next(i for i,x in enumerate(p) if x['name']=='SIDE_RIGHT'))
    rows=map_details(f,outer,e,p,2,2,4)
    assert any(x['status']!='PASS' for x in rows)
    assert any('angle' not in x for x in e)


def test_changed_profile_length_is_not_forced_to_fit():
    d,o,outer,blank,lines=g.read_drawing(source())
    f,e,_,_,_=g.partition(outer,blank,lines,3)
    p=g.profiles(d,o,2)
    side=next(x for x in p if x['name']=='SIDE_LEFT')
    side['points'][0]+=g.unit(side['points'][0]-side['points'][1])*5
    rows=map_details(f,outer,e,p,2,2,4)
    assert any(x['status']!='PASS' for x in rows)
    assert any('angle' not in x for x in e)
