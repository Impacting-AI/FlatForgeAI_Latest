"""Free STEP 6 placement, side classification, project saves and solid export."""
import copy
import json
import math
import numpy as np
import cadquery as cq
import pytest
from test_assembly_cad import api, panel, entry, ROOT
from test_face_connections import catalog
from flatforge.assembly import bounds, location
from flatforge.db import Session, ProjectAssembly


def placed(client,project,rows):
    response=client.post(f'/projects/{project}/assembly/place',json={'policy':'free','entries':rows})
    assert response.status_code==200,response.text
    return response.json()


def approved(client,project,rows):
    response=client.post(f'/projects/{project}/assembly/validate',json={'policy':'free','entries':rows})
    assert response.status_code==200,response.text
    return response.json()


def freeze(result):
    rows=copy.deepcopy(result['entries'])
    for row in rows:
        frame=result['frames'][row['id']]
        row['pose']=dict(matrix=row['matrix'],sourceSha=result['sourceHashes'][row['id']],pivot=frame['origin'],axis=frame['n'],offset=[0,0,0],turn=0)
    return rows


def side_mate(client,project,a,b,side_a='right',side_b='left'):
    ca,cb=catalog(client,project,a),catalog(client,project,b)
    refs=[]
    for cat,side in [(ca,side_a),(cb,side_b)]:
        regions=cat['sides'][side];assert regions['automatic'],(side,regions)
        region=next(r for r in regions['candidates'] if r['faceId']==regions['automatic'])
        refs.append(dict(faceId=region['faceId'],sourceSha=cat['sourceSha'],point=region['point']))
    return {**b,'sides':{'reference':side_a,'moving':side_b},'connection':dict(type='planar',reference=refs[0],moving=refs[1],offsetU=0,offsetV=0,normalOffset=0,twist=0)}


def test_source_local_sides_rotated_irregular_panel_and_trimmed_anchors(api,tmp_path):
    client,project=api
    body=cq.Workplane('XY').polyline([(0,0),(200,0),(200,80),(120,80),(120,130),(0,130)]).close().extrude(3).val()
    body=body.cut(cq.Solid.makeCylinder(9,3,cq.Vector(40,40,0))).rotate((0,0,0),(0,1,0),31)
    pid,_=panel(project,body,tmp_path);row=entry('a',pid);cat=catalog(client,project,row)
    assert set(cat['sides'])=={'left','right','top','bottom'}
    for side in cat['sides'].values():
        assert side['automatic']
        for region in side['candidates']:
            face=body.Faces()[int(region['faceId'].split('-')[1])-1]
            assert face.distance(cq.Vertex.makeVertex(*region['point']))<1e-5
    # Largest panel plane rotates with its CAD source; side planes are not world X/Y.
    right=cat['sides']['right']['candidates'][0]['normal']
    assert right==pytest.approx([math.cos(math.radians(31)),0,-math.sin(math.radians(31))],abs=1e-6)


def test_each_panel_moves_independently_and_overlaps_export_as_separate_solids(api,tmp_path):
    client,project=api
    pid,source=panel(project,cq.Solid.makeBox(100,150,3),tmp_path)
    rows=[entry('a',pid),entry('b',pid,'a'),entry('c',pid,'b')]
    rows[1]=side_mate(client,project,rows[0],rows[1]);rows[2]=side_mate(client,project,rows[1],rows[2])
    initial=placed(client,project,rows);frozen=freeze(initial)
    for index in range(3):
        moved=copy.deepcopy(frozen);moved[index]['pose']['offset']=[-20,40,50]
        result=placed(client,project,moved)
        for j,row in enumerate(result['entries']):
            if index!=j:assert row['matrix']==pytest.approx(initial['entries'][j]['matrix'],abs=1e-8)
            else:assert np.array(row['matrix'][12:15])-np.array(initial['entries'][j]['matrix'][12:15])==pytest.approx([-20,40,50])
    # Full coincident solids are intentional. No collision gate or fusion.
    frozen[1]['pose']=copy.deepcopy(frozen[0]['pose'])
    final=placed(client,project,frozen);check=approved(client,project,final['entries'])
    assert check['valid'] and check['token'] and not check['collisions']
    response=client.post(f'/projects/{project}/assembly/step',json={'token':check['token']});assert response.status_code==200,response.text[:300]
    out=tmp_path/'overlapping.step';out.write_bytes(response.content)
    solids=cq.importers.importStep(str(out)).val().Solids();assert len(solids)==3
    assert sum(s.Volume() for s in solids)==pytest.approx(3*100*150*3,rel=1e-7)
    # The same shared strict validation path remains collision-sensitive.
    strict=copy.deepcopy(initial['entries']);strict[2]=copy.deepcopy(strict[1]);strict[2]['id']='duplicate'
    response=client.post(f'/projects/{project}/assembly/validate',json={'entries':strict});assert not response.json()['valid']


def test_project_save_restore_update_conflict_and_no_recalculation(api,tmp_path,monkeypatch):
    client,project=api
    pid,_=panel(project,cq.Solid.makeBox(40,70,2),tmp_path)
    rows=[entry('a',pid),entry('b',pid,'a')];layout=placed(client,project,rows);rows=freeze(layout)
    rows[1]['pose']['offset']=[-90,-12.75,50];rows[1]['pose']['turn']=-19
    layout=placed(client,project,rows);check=approved(client,project,layout['entries'])
    body={'revision':0,'token':check['token'],'entries':[{**e,'label':chr(65+i)} for i,e in enumerate(layout['entries'])]}
    assert client.get(f'/projects/{project}/assembly').json()['revision']==0
    from flatforge import assembly_connections
    monkeypatch.setattr(assembly_connections,'solve',lambda *a,**k:pytest.fail('Save must not recalculate placement'))
    saved=client.put(f'/projects/{project}/assembly',json=body);assert saved.status_code==200,saved.text
    snapshot=saved.json();assert snapshot['revision']==1
    restored=client.get(f'/projects/{project}/assembly').json();assert restored==snapshot
    for actual,expected in zip(restored['entries'],layout['entries']):assert actual['matrix']==expected['matrix'] and actual['pose']==expected['pose']
    assert client.put(f'/projects/{project}/assembly',json=body).status_code==409
    body['revision']=1;assert client.put(f'/projects/{project}/assembly',json=body).json()['revision']==1
    body['entries'][1]['label']='D';updated=client.put(f'/projects/{project}/assembly',json=body);assert updated.status_code==200,updated.text
    assert updated.json()['revision']==2
    with Session() as session:assert session.get(ProjectAssembly,project).revision==2
    bad=copy.deepcopy(body);bad['revision']=2;bad['entries'][1]['matrix'][12]+=1
    assert client.put(f'/projects/{project}/assembly',json=bad).status_code==409
    other=client.post('/projects',json={'name':'Other'}).json()['id']
    assert client.put(f'/projects/{other}/assembly',json=body).status_code==422
    assert client.get(f'/projects/{other}/assembly').json()['entries']==[]
    malformed=copy.deepcopy(body);malformed['entries'][1]['targetId']='missing'
    assert client.put(f'/projects/{project}/assembly',json=malformed).status_code==422
    cleared=client.put(f'/projects/{project}/assembly',json={'revision':2,'entries':[]});assert cleared.status_code==200 and cleared.json()['entries']==[]


def test_free_placement_still_rejects_scale_stale_sources_and_invalid_graphs(api,tmp_path):
    client,project=api;pid,_=panel(project,cq.Solid.makeBox(70,80,2),tmp_path)
    rows=freeze(placed(client,project,[entry('a',pid),entry('b',pid,'a')]))
    for mutate,status in [(lambda r:r[1]['pose']['matrix'].__setitem__(0,2),422),(lambda r:r[1]['pose'].__setitem__('sourceSha','0'*64),409),(lambda r:r[1].__setitem__('targetId','missing'),422)]:
        bad=copy.deepcopy(rows);mutate(bad)
        response=client.post(f'/projects/{project}/assembly/place',json={'policy':'free','entries':bad});assert response.status_code==status,response.text


def test_real_folded_fixture_sides_are_not_invented(api,tmp_path):
    client,project=api
    for source in sorted((ROOT/'public/samples').glob('*/panel.step')):
        pid,_=panel(project,cq.importers.importStep(str(source)).val(),tmp_path)
        cat=catalog(client,project,entry('a',pid))
        for side in cat['sides'].values():
            assert side['automatic'] is None or side['automatic'] in {c['faceId'] for c in side['candidates']}
            assert side['candidates'] or side['message']


def test_nonparallel_side_regions_require_visual_clarification(api,tmp_path):
    client,project=api
    body=cq.Workplane('XY').polyline([(0,0),(100,0),(80,40),(100,80),(0,80)]).close().extrude(3).val()
    pid,_=panel(project,body,tmp_path)
    sides=catalog(client,project,entry('a',pid))['sides']
    assert len(sides['right']['candidates'])==2
    assert sides['right']['automatic'] is None
    assert 'highlighted region' in sides['right']['message']
    assert sides['left']['automatic']


def test_ambiguous_main_plane_does_not_invent_sides(api,tmp_path):
    client,project=api
    pid,_=panel(project,cq.Solid.makeBox(10,10,10),tmp_path)
    sides=catalog(client,project,entry('a',pid))['sides']
    assert all(not s['candidates'] and s['automatic'] is None and 'no unique' in s['message'] for s in sides.values())
