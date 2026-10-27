"""Actual BREP faces, rigid frame placement, tree propagation and STEP roundtrips."""
import copy
import hashlib
import math
import cadquery as cq
import numpy as np
import pytest
from test_assembly_cad import api, panel, entry, check, place as legacy_place, ROOT
from flatforge.assembly import bounds, location


def catalog(client, project, row):
    result = client.post(f'/projects/{project}/assembly/faces', json={k: row[k] for k in ('id', 'panelId', 'revision')})
    assert result.status_code == 200, result.text
    return result.json()


def reference(catalog, normal, point=None):
    face = max((f for f in catalog['faces'] if f['supported']), key=lambda f: np.dot(f['normal'], normal))
    assert np.dot(face['normal'], normal) > .9999
    # A triangle centroid is on the trimmed face even when its centre lies in a hole.
    vertices = np.array(face['positions']).reshape((-1, 3))
    anchor = vertices[face['indices'][:3]].mean(axis=0).tolist() if point is None else point
    return dict(faceId=face['id'], sourceSha=catalog['sourceSha'], point=anchor)


def connect(row, a, b, **kwargs):
    return {**row, 'connection': {**dict(type='planar', reference=a, moving=b,
            offsetU=0, offsetV=0, normalOffset=0, twist=0), **kwargs}}


def place(client, project, rows):
    result = client.post(f'/projects/{project}/assembly/place', json={'entries': rows})
    assert result.status_code == 200, result.text
    return result.json()['entries']


def box_pair(client, project, tmp_path):
    pa, _ = panel(project, cq.Solid.makeBox(100, 200, 300), tmp_path)
    pb, _ = panel(project, cq.Solid.makeBox(40, 170, 260), tmp_path)
    a, b = entry('a', pa), entry('b', pb, 'a', gap=20)
    fa = reference(catalog(client, project, a), [1,0,0], [100,100,150])
    fb = reference(catalog(client, project, b), [-1,0,0], [0,85,130])
    return [a, connect(b, fa, fb)]


@pytest.mark.parametrize('u,v,normal,twist', [(0,50,0,0), (35,-50,0,0), (-25,40,7,21), (0,0,-20,0), (-15,-30,-5,-37)])
def test_actual_face_gap_and_signed_offsets(api, tmp_path, u, v, normal, twist):
    client, project = api
    rows = box_pair(client, project, tmp_path)
    baseline = place(client, project, rows)
    rows[1]['connection'].update(offsetU=u, offsetV=v, normalOffset=normal, twist=twist)
    placed = place(client, project, rows)
    result = check(client, project, placed)
    assert result['valid'], result
    assert placed[0]['matrix'] == baseline[0]['matrix'], 'Reference must stay fixed'
    measured = result['clearances'][0]
    assert measured['actual'] == pytest.approx(20+normal, abs=1e-5)
    assert measured['surfaceDistance'] == pytest.approx(20+normal, abs=1e-5)
    assert [measured['offsetU'], measured['offsetV']] == pytest.approx([u,v], abs=1e-5)
    if normal == -20:
        assert result['contacts'] and not result['collisions']


def test_angled_irregular_faces_rotated_frame_and_step_export(api, tmp_path):
    client, project = api
    # A planar L outline with a circular cutout; rotate the original CAD solid.
    shape = cq.Workplane('XY').polyline([(0,0),(200,0),(200,130),(120,130),(120,200),(0,200)]).close().extrude(3).val()
    shape = shape.cut(cq.Solid.makeCylinder(12, 3, cq.Vector(40,40,0))).rotate((0,0,0),(0,1,0),31)
    other = cq.Solid.makeBox(90,110,2).rotate((0,0,0),(1,0,0),-24)
    pa, source_a = panel(project, shape, tmp_path); pb, source_b = panel(project, other, tmp_path)
    digests = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (source_a,source_b)]
    half = math.radians(19)/2
    a, b = entry('a', pa, rotation=[0,0,math.sin(half),math.cos(half)]), entry('b',pb,'a',gap=13.75)
    ca, cb = catalog(client,project,a), catalog(client,project,b)
    na = [math.sin(math.radians(31)),0,math.cos(math.radians(31))]
    nb = [0,-math.sin(math.radians(24)),-math.cos(math.radians(24))]
    # Pick triangle centroids rather than assuming an origin or rectangular face.
    rows=[a,connect(b,reference(ca,na),reference(cb,nb),offsetU=5.5,offsetV=-7.25,twist=17)]
    placed=place(client,project,rows);result=check(client,project,placed)
    assert result['valid'],result
    response=client.post(f'/projects/{project}/assembly/step',json={'token':result['token']})
    assert response.status_code==200,response.text[:300]
    path=tmp_path/'face-assembly.step';path.write_bytes(response.content)
    imported=cq.importers.importStep(str(path)).val()
    assert imported.isValid() and len(imported.Solids())==2
    for original,row in zip((shape,other),placed):
        expected=original.moved(location(row['matrix']));box=bounds(expected)
        actual=next(s for s in imported.Solids() if np.max(np.abs(np.array(list(bounds(s).values()))-np.array(list(box.values()))))<1e-5)
        assert actual.Volume()==pytest.approx(original.Volume(),rel=1e-7)
        assert sorted(f.geomType() for f in actual.Faces())==sorted(f.geomType() for f in original.Faces())
    assert [hashlib.sha256(p.read_bytes()).hexdigest() for p in (source_a,source_b)]==digests


def test_tree_descendants_follow_without_moving_unrelated_branch(api,tmp_path):
    client,project=api;rows=box_pair(client,project,tmp_path)
    a,b=rows
    c=entry('c',b['panelId'],'b',gap=9)
    cc=catalog(client,project,c);bc=catalog(client,project,b)
    c=connect(c,reference(bc,[1,0,0],[40,85,130]),reference(cc,[-1,0,0],[0,85,130]))
    d=entry('unrelated',a['panelId'],'a',face='-X',gap=80)
    rows += [c,d]
    before=place(client,project,rows)
    rows[1]['connection'].update(offsetV=50,twist=13)
    after=place(client,project,rows)
    result=check(client,project,after);assert result['valid'],result
    assert after[0]['matrix']==before[0]['matrix'] and after[3]['matrix']==before[3]['matrix']
    assert after[2]['matrix']!=before[2]['matrix']
    assert [r['actual'] for r in result['clearances']]==pytest.approx([20,9,80],abs=1e-5)
    bad=copy.deepcopy(rows);bad[1]['targetId']='c'
    assert client.post(f'/projects/{project}/assembly/place',json={'entries':bad}).status_code==422


def test_invalid_faces_holes_stale_sources_and_lost_overlap(api,tmp_path):
    client,project=api;rows=box_pair(client,project,tmp_path)
    rows[1]['connection']['offsetV']=1000
    invalid=check(client,project,place(client,project,rows))
    assert not invalid['valid'] and invalid['token'] is None and 'no longer overlap' in invalid['issues'][0]
    for key,value in [('sourceSha','0'*64),('faceId','face-999'),('point',[10000,0,0])]:
        bad=copy.deepcopy(rows);bad[1]['connection']['reference'][key]=value
        response=client.post(f'/projects/{project}/assembly/place',json={'entries':bad})
        assert response.status_code==(409 if key=='sourceSha' else 422),response.text
    tube=cq.Workplane('XY').circle(30).circle(12).extrude(50).val()
    pt,_=panel(project,tube,tmp_path);t=entry('t',pt,'a');ct=catalog(client,project,t)
    curved=next(f for f in ct['faces'] if f['type']=='CYLINDER')
    t=connect(t,rows[1]['connection']['reference'],dict(faceId=curved['id'],sourceSha=ct['sourceSha'],point=curved['center']))
    response=client.post(f'/projects/{project}/assembly/place',json={'entries':[rows[0],t]})
    assert response.status_code==422 and 'planar' in response.text
    t['connection']['moving']=reference(ct,[0,0,1],[0,0,50])
    response=client.post(f'/projects/{project}/assembly/place',json={'entries':[rows[0],t]})
    assert response.status_code==422 and 'inside a hole' in response.text
    rows[1]['connection']['normalOffset']=-21
    assert client.post(f'/projects/{project}/assembly/place',json={'entries':rows}).status_code==422


def test_collisions_tampered_transforms_and_cross_project_faces(api,tmp_path):
    client,project=api;rows=box_pair(client,project,tmp_path)
    rows.append({**copy.deepcopy(rows[1]),'id':'duplicate-position'})
    result=check(client,project,place(client,project,rows))
    assert not result['valid'] and result['collisions'] and result['token'] is None
    rows=place(client,project,rows[:2]);rows[1]['matrix'][12]-=1
    result=check(client,project,rows)
    assert not result['valid'] and 'offsets do not match' in result['issues'][0]
    rows[1]['matrix'][0]=-1
    assert client.post(f'/projects/{project}/assembly/validate',json={'entries':rows}).status_code==422
    other=client.post('/projects',json={'name':'Other'}).json()['id']
    assert client.post(f'/projects/{other}/assembly/faces',json={k:rows[0][k] for k in ('id','panelId','revision')}).status_code==404


def test_legacy_placements_match_previous_engine_and_real_folded_faces(api,tmp_path):
    client,project=api
    for fixture in sorted((ROOT/'public/samples').glob('*/panel.step')):
        shape=cq.importers.importStep(str(fixture)).val();pa,_=panel(project,shape,tmp_path)
        angle=math.radians(23)/2
        rows=[entry('a',pa),entry('b',pa,'a',rotation=[0,math.sin(angle),0,math.cos(angle)],gaps={'z':{'side':-1,'gap':17}})]
        old=legacy_place(client,project,rows);new=place(client,project,rows)
        for first,second in zip(old,new):assert first['matrix']==pytest.approx(second['matrix'],abs=1e-8)
        ca=catalog(client,project,rows[0]);cb=catalog(client,project,rows[1])
        face=max((f for f in ca['faces'] if f['supported']),key=lambda f:f['area'])
        r=reference(ca,face['normal'])
        rows[1]=connect(rows[1],r,{**r,'sourceSha':cb['sourceSha']},offsetU=3,offsetV=5)
        result=check(client,project,place(client,project,rows))
        # Real folded panels may collide away from selected faces. Surface gap
        # must still be measured and collisions must block approval, not be hidden.
        assert result['clearances'][0]['actual']==pytest.approx(10,abs=1e-5)
        if result['collisions']:assert not result['valid'] and result['token'] is None


def test_controller_frames_and_root_translation_match_shared_cad_matrices(api, tmp_path):
    client, project = api
    rows = box_pair(client, project, tmp_path)
    angle = math.radians(29)/2
    rows[0]['rotation'] = [0, 0, math.sin(angle), math.cos(angle)]
    response = client.post(f'/projects/{project}/assembly/place', json={'entries': rows})
    assert response.status_code == 200, response.text
    original = response.json()
    frame = original['frames']['b']
    basis = np.column_stack([frame[k] for k in ('u','v','n')])
    assert basis.T @ basis == pytest.approx(np.eye(3), abs=1e-8)
    assert np.linalg.det(basis) == pytest.approx(1)
    matrix = np.array(original['entries'][1]['matrix']).reshape(4,4).T
    assert frame['origin'] == pytest.approx(matrix[:3,:3] @ np.array(rows[1]['connection']['moving']['point']) + matrix[:3,3])
    shift = np.array([17.25,-28.5,50.125])
    rows[0]['rootOffset'] = shift.tolist()
    moved = client.post(f'/projects/{project}/assembly/place', json={'entries': rows}).json()
    for index, name in enumerate(('a','b')):
        assert np.array(moved['entries'][index]['matrix'][12:15])-np.array(original['entries'][index]['matrix'][12:15]) == pytest.approx(shift)
        assert np.array(moved['frames'][name]['origin'])-np.array(original['frames'][name]['origin']) == pytest.approx(shift)
    checked = check(client,project,moved['entries'])
    assert checked['valid'], checked
    assert checked['clearances'][0]['surfaceDistance'] == pytest.approx(20, abs=1e-5)
    # Source origin belongs only to the root; children retain face relationships.
    rows[1]['rootOffset'] = [0,0,0]
    assert client.post(f'/projects/{project}/assembly/place',json={'entries':rows}).status_code == 422
