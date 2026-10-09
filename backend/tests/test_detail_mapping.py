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
    assert (tmp_path/'initial/review_model.step').exists()
    solid=cq.importers.importStep(str(tmp_path/'initial/review_model.step')).val()
    assert solid.isValid() and len(solid.Solids())==1
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
    assert any(i['code']=='BEND_PARAMETERS' for i in rebuilt['issues'])
    assert not (out/'review_model.step').exists()


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
    # Kinematic continuation is independent of the unresolved physical
    # deduction/radius policy. Do not bypass its solid-generation gate.
    rotations={0:np.eye(3)}
    for child in order[1:]:
        edge=next(item for item in e if item['child']==child)
        rotations[child]=rotations[edge['parent']]@g.rotation(g.lift(g.support(edge)[0]),np.radians(edge['angle']))
    for c in choices:assert rotations[c['child']][:,2]@rotations[c['adjacent_face']][:,2]==pytest.approx(1,abs=1e-9)
    with pytest.raises(g.GeometryEvidenceError,match='Fixed bend parameters'):
        g.transforms(f,e,order,2,2,4)


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


def reconciliation_entry(name,marker,angles,noise=0.,hinges=(0,1)):
    import numpy as np
    p={'name':name,'paint_handle':marker,'points':np.array([[0.,0.],[30.,0.],[30.,100.],[60.,100.]]),
       'segments':[{'parallel_error_deg':noise} for _ in range(3)]}
    c={'hinges':[{'index':i} for i in hinges],'angles':list(angles),'error':.1,
       'signature':tuple(zip(hinges,angles))}
    return p,{},[c]


def test_independent_local_profiles_reconcile_drafting_noise_without_rounding():
    from flatforge.detail_mapping import reconcile_local_candidates
    a=reconciliation_entry('first','paintA',[89.959,90],noise=.001)
    b=reconciliation_entry('second','paintB',[90,90])
    r=reconcile_local_candidates([a,b])
    assert len(r)==2
    assert all(c['angles']==[90,90] for _,_,c,_ in r)
    assert r[0][3]['original_angles_deg']==[89.959,90]
    assert r[0][3]['max_adjustment_deg']==pytest.approx(.041)
    assert r[0][3]['authority_profile']=='second'


@pytest.mark.parametrize('angles',[[60,90],[120,90],[-90,90]])
def test_conflicting_local_profiles_are_not_reconciled(angles):
    from flatforge.detail_mapping import reconcile_local_candidates
    assert not reconcile_local_candidates([reconciliation_entry('a','a',[90,90]),reconciliation_entry('b','b',angles)])


def test_local_reconciliation_preserves_nonstandard_measurement():
    from flatforge.detail_mapping import reconcile_local_candidates
    r=reconcile_local_candidates([reconciliation_entry('a','a',[60.041,120.339],noise=.001),
                                  reconciliation_entry('b','b',[60,120.339])])
    assert len(r)==2 and all(c['angles']==[60,120.339] for _,_,c,_ in r)


def test_one_marker_or_multiple_hinge_groups_cannot_establish_local_mapping():
    from flatforge.detail_mapping import reconcile_local_candidates
    a=reconciliation_entry('a','same',[90,90]);b=reconciliation_entry('b','same',[90,90])
    assert not reconcile_local_candidates([a,b])
    a=reconciliation_entry('a','a',[90,90]);b=reconciliation_entry('b','b',[90,90])
    a[2].append(reconciliation_entry('x','x',[90,90],hinges=(2,3))[2][0])
    b[2].append(reconciliation_entry('x','x',[90,90],hinges=(2,3))[2][0])
    assert not reconcile_local_candidates([a,b])


def test_native_opposite_profiles_resolve_with_provenance():
    import os
    from pathlib import Path
    from flatforge import geometry as g
    from flatforge.angle_evidence import annotate_profiles
    from flatforge.detail_mapping import map_details
    root=os.getenv('FLATFORGE_BATCH_DXF_DIR')
    if not root:pytest.skip('Set FLATFORGE_BATCH_DXF_DIR for native reference drawings')
    paths=sorted(Path(root).glob('PN_NM_148*.dxf'))
    if len(paths)!=1:pytest.skip('Requires one unambiguous PN_NM_148 fixture')
    d,o,outer,blank,lines=g.read_drawing(paths[0]);faces,edges,*_=g.partition(outer,blank,lines,3)
    ps=g.profiles(d,o,2);annotate_profiles(d,o,ps,2)
    rows=map_details(faces,outer,edges,ps,2,.7366,4)
    reconciled=[r for r in rows if 'authority_profile' in r]
    assert len(reconciled)==2
    assert max(r['max_adjustment_deg'] for r in reconciled)==pytest.approx(.0409923323,abs=1e-6)
    # Searching only the base face hid a second equally fitting chain.
    # Both chains have independent anchors; neither may win by strip residual.
    assert sum('angle' not in e for e in edges)==9
    ambiguous=[r for r in rows if r.get('reason_code')=='AMBIGUOUS_LOCAL_CHAIN']
    assert len(ambiguous)==1 and ambiguous[0]['local_candidate_count']==2
    assert len({c['root_face'] for c in ambiguous[0]['local_candidates']})==2
    assert ambiguous[0]['missing_evidence'][0]['kind']=='section_correspondence'
    assert all(abs(a)==pytest.approx(90) for p in ps if 'angle_reconciliation' in p for a in p['local_chain']['angles'])


def anchor_fixture():
    p={'paint_handle':'paintB'}
    edge={'index':1,'angle':90.,'evidence':[{'profile':'normal','paint_marker':'paintA','angle':90.}]}
    c={'hinges':[edge,{'index':2}], 'angles':[90.,60.], 'signature':((1,90.),(2,60.)),
       'error':.1,'chain':[0,1,2],'boundary':[[0,0],[10,0]]}
    return p,c


def test_unique_anchored_chain_uses_measured_turns():
    from flatforge.detail_mapping import anchored_local_candidate
    p,c=anchor_fixture();result=anchored_local_candidate(p,[c])
    assert result[0]['angles']==[90.,60.]
    assert result[1][0]['sources'][0]['paint_marker']=='paintA'


@pytest.mark.parametrize('case',['same_marker','manual','conflict','wrong_sign','no_anchor','ambiguous'])
def test_unsafe_local_anchor_is_rejected(case):
    import copy
    from flatforge.detail_mapping import anchored_local_candidate
    p,c=anchor_fixture();choices=[c];edge=c['hinges'][0]
    if case=='same_marker':edge['evidence'][0]['paint_marker']='paintB'
    if case=='manual':edge['evidence'][0]['profile']='USER CONFIRMED'
    if case=='conflict':edge['evidence_conflict']=True
    if case=='wrong_sign':edge['angle']=-90
    if case=='no_anchor':edge.pop('angle')
    if case=='ambiguous':
        other=copy.deepcopy(c);other['signature']=((1,90.),(3,60.));choices.append(other)
    assert anchored_local_candidate(p,choices) is None


def test_native_mapping_ambiguity_keeps_unresolved_bends_visible(tmp_path):
    import os
    from pathlib import Path
    from flatforge.engine import run
    root=os.getenv('FLATFORGE_BATCH_DXF_DIR')
    if not root:pytest.skip('Set FLATFORGE_BATCH_DXF_DIR for native reference drawings')
    paths=sorted(Path(root).glob('PN_NM_148*.dxf'))
    if len(paths)!=1:pytest.skip('Requires one unambiguous PN_NM_148 fixture')
    result=run({'source':str(paths[0]),'output':str(tmp_path/'out'),
                'settings':{'thickness':2.,'radius':.7366,'deduction':4.,'input_type':'flat_pattern'},
                'overrides':{'confirm_parameters':True}})
    assert result['status']=='NEEDS_REVIEW'
    assert 'SECTION_CORRESPONDENCE' in {i['code'] for i in result['issues']}
    assert len(result['unresolved_bends'])==9
    assert len(result['unmapped_hinge_evidence'])==9
    assert any(row.get('missing_evidence') for row in result['review_catalog'])
    assert not (tmp_path/'out'/'panel.step').exists()
