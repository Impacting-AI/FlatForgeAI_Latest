import copy
import numpy as np
import cadquery as cq
import pytest
from test_assembly_cad import api, panel, entry
from test_free_assembly import placed, freeze, approved, side_mate

OPPOSITE={'left':'right','right':'left','top':'bottom','bottom':'top'}

def insertion(client,project,rows,branch=None):
    return client.post(f'/projects/{project}/assembly/place',json={'policy':'free','entries':rows,'insertId':'d','insertBranchId':branch})

@pytest.mark.parametrize('side',['right','left','top','bottom'])
@pytest.mark.parametrize('rotated',[False,True])
def test_insert_preserves_offsets_rotations_and_unaffected_branches(api,tmp_path,side,rotated):
    client,project=api
    pid,_=panel(project,cq.Solid.makeBox(100,160,3),tmp_path)
    small,_=panel(project,cq.Solid.makeBox(40,80,3),tmp_path)
    rows=[entry('a',pid),entry('b',pid,'a'),entry('c',pid,'b'),entry('e',pid,'a'),entry('f',pid,'c')]
    if rotated:
        angle=np.radians(31)/2;rows[0]['rotation']=[0,0,float(np.sin(angle)),float(np.cos(angle))]
    for index in range(1,len(rows)):
        parent=next(r for r in rows if r['id']==rows[index]['targetId'])
        rows[index]=side_mate(client,project,parent,rows[index],side,OPPOSITE[side])
    rows=freeze(placed(client,project,rows))
    rows[2]['pose']['offset']=[8,-11,50];rows[2]['pose']['turn']=7
    before=placed(client,project,rows)
    d=side_mate(client,project,rows[1],entry('d',small,'b'),side,OPPOSITE[side]);d['gap']=17
    response=insertion(client,project,[*rows,d]);assert response.status_code==200,response.text
    result=response.json();after={r['id']:r for r in result['entries']};original={r['id']:r for r in before['entries']}
    assert result['insertion']['movedIds']==['c','f']
    assert after['d']['targetId']=='b' and after['c']['targetId']=='d'
    delta=np.array(result['insertion']['translationMm'])
    for id in ('a','b','e'):assert after[id]['matrix']==original[id]['matrix']
    for id in ('c','f'):
        assert after[id]['matrix'][:12]==pytest.approx(original[id]['matrix'][:12],abs=1e-9)
        assert np.array(after[id]['matrix'][12:15])-np.array(original[id]['matrix'][12:15])==pytest.approx(delta)
        assert after[id]['pose']['offset']==original[id]['pose']['offset']
        assert after[id]['gap']==original[id]['gap']
    # Exact post-insertion state remains freely movable, persistable and exportable.
    check=approved(client,project,result['entries'])
    payload={'revision':0,'token':check['token'],'entries':[{**r,'label':r['id'].upper()} for r in result['entries']]}
    saved=client.put(f'/projects/{project}/assembly',json=payload);assert saved.status_code==200,saved.text
    assert client.get(f'/projects/{project}/assembly').json()['entries']==saved.json()['entries']
    if not rotated and side=='right':
        response=client.post(f'/projects/{project}/assembly/step',json={'token':check['token']});assert response.status_code==200
        target=tmp_path/'inserted.step';target.write_bytes(response.content)
        solids=cq.importers.importStep(str(target)).val().Solids();assert len(solids)==6
        from flatforge.assembly import bounds
        remaining=list(result['bounds'].values())
        for solid in solids:
            box=bounds(solid)
            index=next(i for i,expected in enumerate(remaining) if np.allclose(box['min'],expected['min'],atol=1e-5,rtol=0) and np.allclose(box['max'],expected['max'],atol=1e-5,rtol=0))
            remaining.pop(index)


def test_incoming_edge_reroots_without_moving_reference_or_its_other_children(api,tmp_path):
    client,project=api;pid,_=panel(project,cq.Solid.makeBox(100,160,3),tmp_path)
    rows=[entry('a',pid),entry('b',pid,'a'),entry('c',pid,'b'),entry('e',pid,'a')]
    for i in range(1,len(rows)):
        rows[i]=side_mate(client,project,next(r for r in rows if r['id']==rows[i]['targetId']),rows[i])
    rows=freeze(placed(client,project,rows));before=placed(client,project,rows)
    d=side_mate(client,project,rows[1],entry('d',pid,'b'),'left','right')
    response=insertion(client,project,[*rows,d]);assert response.status_code==200,response.text
    result=response.json();after={r['id']:r for r in result['entries']}
    assert result['insertion']['rerooted'] and result['insertion']['movedIds']==['a','e']
    assert after['b']['targetId'] is None and after['a']['targetId']=='d' and after['d']['targetId']=='b'
    for r in before['entries']:
        if r['id'] in ('b','c'):assert after[r['id']]['matrix']==r['matrix']
    assert approved(client,project,result['entries'])['valid']


def test_multiple_occupied_branches_require_choice(api,tmp_path):
    client,project=api;pid,_=panel(project,cq.Solid.makeBox(100,160,3),tmp_path)
    rows=[entry('a',pid),entry('b',pid,'a'),entry('c',pid,'a')]
    for i in (1,2):rows[i]=side_mate(client,project,rows[0],rows[i])
    rows=freeze(placed(client,project,rows));d=side_mate(client,project,rows[0],entry('d',pid,'a'))
    assert insertion(client,project,[*rows,d]).status_code==409
    response=insertion(client,project,[*rows,d],'c');assert response.status_code==200,response.text
    assert response.json()['insertion']['movedIds']==['c']
    assert next(r for r in response.json()['entries'] if r['id']=='b')['matrix']==rows[1]['matrix']


def test_side_annotations_do_not_download_face_meshes(api,tmp_path):
    client,project=api;pid,_=panel(project,cq.Solid.makeBox(70,100,3),tmp_path)
    body={'id':'a','panelId':pid,'revision':1}
    lightweight=client.post(f'/projects/{project}/assembly/sides',json=body)
    full=client.post(f'/projects/{project}/assembly/faces',json=body)
    assert lightweight.status_code==full.status_code==200
    assert not lightweight.json()['faces'] and full.json()['faces']
    assert lightweight.json()['sides']==full.json()['sides']
    assert lightweight.json()['sourceSha']==full.json()['sourceSha']


def test_angled_exit_explains_rotation_conflict_without_mutating_entries(api,tmp_path):
    client,project=api;pid,_=panel(project,cq.Solid.makeBox(100,160,3),tmp_path)
    wedge,_=panel(project,cq.Workplane('XY').polyline([(0,0),(100,0),(140,100),(0,100)]).close().extrude(3).val(),tmp_path)
    rows=[entry('a',pid),entry('b',pid,'a')]
    rows[1]=side_mate(client,project,rows[0],rows[1]);rows=freeze(placed(client,project,rows))
    d=side_mate(client,project,rows[0],entry('d',wedge,'a'));before=copy.deepcopy(rows)
    response=insertion(client,project,[*rows,d]);assert response.status_code==409,response.text
    assert 'change existing rotations' in response.json()['detail'];assert rows==before


def test_legacy_side_is_not_silently_guessed(api,tmp_path):
    client,project=api;pid,_=panel(project,cq.Solid.makeBox(100,160,3),tmp_path)
    rows=freeze(placed(client,project,[entry('a',pid),entry('b',pid,'a')]))
    d=side_mate(client,project,rows[0],entry('d',pid,'a'))
    response=insertion(client,project,[*rows,d]);assert response.status_code==409
    assert 'no reliable named side' in response.json()['detail']
    assert placed(client,project,rows)['entries'][1]['matrix']==rows[1]['matrix']
