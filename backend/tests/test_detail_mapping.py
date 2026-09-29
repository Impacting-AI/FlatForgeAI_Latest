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


def test_complex_corner_retains_drawing_angles_and_allows_correction(tmp_path):
    import json
    import cadquery as cq
    r=run({'source':str(source()),'output':str(tmp_path/'initial')})
    assert r['status']=='NEEDS_REVIEW'
    assert r['physical_bends']==27 and r['faces']==28
    choices=r['corner_angle_candidates']
    assert len(choices)==2
    assert sorted(c['candidate_rotation_deg'] for c in choices)==pytest.approx([-59.6613411117,120.3386588883])
    assert r['unresolved_bends']==[]
    assert all(b['angle'] is not None for b in r['bends'])
    assert (tmp_path/'initial/panel.step').exists()
    # Re-selecting the section retains its measured angle without manual entry.
    target=choices[0]['key']
    row=next(row for row in r['review_catalog'] if any(target in [b['key'] for b in c['folds']] for c in row['candidates']))
    candidate=next(c for c in row['candidates'] if target in [b['key'] for b in c['folds']])
    selected=run({'source':str(source()),'output':str(tmp_path/'selected'),
                  'overrides':{'section_choices':{row['profile']:candidate['id']}}})
    assert selected['status']=='NEEDS_REVIEW'
    assert any(c['key']==target and c['requires_confirmation'] for c in selected['corner_angle_candidates'])
    angles={c['key']:c['candidate_rotation_deg'] for c in choices}
    out=tmp_path/'confirmed'
    rebuilt=run({'source':str(source()),'output':str(out),'overrides':{'bend_angles':angles,'build_review_model':True}})
    assert rebuilt['status']=='NEEDS_REVIEW' # The original 90-degree section still conflicts.
    assert rebuilt['review_model']['status']=='UNVALIDATED'
    assert any(c['chain_status']=='FAIL' for c in rebuilt['section_checks'])
    assert rebuilt['unfold_check']['status']=='PASS'
    solid=cq.importers.importStep(str(out/'review_model.step')).val()
    assert solid.isValid() and len(solid.Solids())==1
    viewer=json.loads((out/'viewer.json').read_text());faces={f['id']:f for f in viewer['faces']}
    for c in choices:
        a=np.array(faces[c['adjacent_face']]['rotation'])[:,2]
        b=np.array(faces[c['child']]['rotation'])[:,2]
        assert np.dot(a,b)==pytest.approx(1,abs=1e-9)


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
    from flatforge.corner_review import continuation_candidates
    order=[0]
    while len(order)<len(f):order.extend(x['child'] for x in e if x['parent'] in order and x['child'] not in order)
    choices=continuation_candidates(f,e,order,2,2,4)
    # Canonical axes can reverse when the whole drawing rotates: angle signs
    # must reverse too. Check physical continuation rather than fixed signs.
    assert sorted(abs(c['candidate_rotation_deg']) for c in choices)==pytest.approx([59.6613411117,120.3386588883],abs=.002)
    from flatforge.review import bend_key
    for edge in e:
        choice=next((c for c in choices if c['key']==bend_key(edge)),None)
        if choice:edge['angle']=choice['candidate_rotation_deg']
    tf=g.transforms(f,e,order,2,2,4)
    for c in choices:assert tf[c['child']][0][:,2]@tf[c['adjacent_face']][0][:,2]==pytest.approx(1,abs=1e-9)


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
