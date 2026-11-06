"""Persistent planar relationships in the overlap-permitting STEP 6 workflow."""
import copy
import cadquery as cq
import numpy as np
import pytest
from test_assembly_cad import api, panel, entry, ROOT
from test_face_connections import box_pair, catalog, reference, connect
from test_free_assembly import placed, approved, freeze
from flatforge.assembly import bounds, location


def chain(client, project, tmp_path):
    rows = box_pair(client, project, tmp_path)
    a, b = rows
    c = entry('c', b['panelId'], 'b', gap=7.25)
    c = connect(c, reference(catalog(client,project,b),[1,0,0]), reference(catalog(client,project,c),[-1,0,0]))
    rows += [c, entry('unrelated', a['panelId'], 'a', face='-X', gap=80)]
    rows[1]['mateState'] = rows[2]['mateState'] = 'active'
    return rows


def test_active_edit_propagates_and_save_export_share_placements(api,tmp_path):
    client, project = api
    rows = chain(client,project,tmp_path)
    before = placed(client,project,rows)
    rows[1]['connection'].update(offsetU=-17.5,offsetV=50,twist=23,normalOffset=2.5)
    after = placed(client,project,rows)
    assert after['entries'][0]['matrix'] == before['entries'][0]['matrix']
    assert next(e for e in after['entries'] if e['id']=='unrelated')['matrix'] == next(e for e in before['entries'] if e['id']=='unrelated')['matrix']
    assert next(e for e in after['entries'] if e['id']=='c')['matrix'] != next(e for e in before['entries'] if e['id']=='c')['matrix']
    assert [m['actual'] for m in after['mates']] == pytest.approx([22.5,7.25])
    assert all(m['satisfied'] for m in after['mates'])
    token = approved(client,project,after['entries'])['token']
    saved = client.put(f'/projects/{project}/assembly',json={'revision':0,'entries':[{**e,'label':e['id'][0].upper()} for e in after['entries']],'token':token})
    assert saved.status_code == 200, saved.text
    restored = client.get(f'/projects/{project}/assembly').json()['entries']
    reloaded = placed(client,project,[{k:v for k,v in e.items() if k!='label'} for e in restored])
    assert [e['matrix'] for e in reloaded['entries']] == [e['matrix'] for e in after['entries']]
    assert {e['id']:e.get('mateState') for e in restored} == {'a':None,'b':'active','c':'active','unrelated':None}
    response=client.post(f'/projects/{project}/assembly/step',json={'token':token})
    assert response.status_code==200
    path=tmp_path/'mates.step';path.write_bytes(response.content)
    solids=cq.importers.importStep(str(path)).val().Solids()
    assert len(solids)==4
    for row in after['entries']:
        expected=after['bounds'][row['id']]
        assert any(np.max(np.abs(np.array(list(bounds(s).values()))-np.array(list(expected.values()))))<1e-5 for s in solids)


def test_free_move_suspends_incident_mates_without_moving_other_panels(api,tmp_path):
    client, project = api
    initial=placed(client,project,chain(client,project,tmp_path))
    initial['entries'].sort(key=lambda e:['a','b','c','unrelated'].index(e['id']))
    rows=freeze(initial)
    rows[1]['mateState']=rows[2]['mateState']='suspended'
    rows[1]['pose']['offset']=[-250,50,17]
    rows[1]['pose']['turn']=31
    moved=placed(client,project,rows)
    moved['entries'].sort(key=lambda e:['a','b','c','unrelated'].index(e['id']))
    assert moved['entries'][1]['matrix']!=initial['entries'][1]['matrix']
    for i in (0,2,3): assert moved['entries'][i]['matrix']==initial['entries'][i]['matrix']
    assert all(m['state']=='suspended' and not m['satisfied'] for m in moved['mates'])
    assert approved(client,project,moved['entries'])['valid']
    # Resume is explicit and again positions B/C from their saved relationships.
    for row in rows[1:3]:row['mateState']='active';del row['pose']
    resumed=placed(client,project,rows)
    resumed['entries'].sort(key=lambda e:['a','b','c','unrelated'].index(e['id']))
    for i in (1,2):assert resumed['entries'][i]['matrix']==pytest.approx(initial['entries'][i]['matrix'])


def test_plane_gap_distinct_from_finite_face_clearance(api,tmp_path):
    client,project=api;rows=box_pair(client,project,tmp_path)
    rows[1]['mateState']='active';rows[1]['connection']['offsetV']=1000
    result=placed(client,project,rows);mate=result['mates'][0]
    assert mate['actual']==pytest.approx(20)
    assert mate['surfaceDistance']>20 and not mate['projectionOverlap']
    assert mate['satisfied'] and approved(client,project,result['entries'])['valid']


def test_active_constraints_reject_ambiguity_cycles_stale_refs_and_tampering(api,tmp_path):
    client,project=api;rows=chain(client,project,tmp_path)
    initial=placed(client,project,rows)
    for mutation in ('cycle','missing','duplicate','pose','negative','stale'):
        bad=copy.deepcopy(rows)
        if mutation=='cycle':bad[1]['targetId']='c'
        if mutation=='missing':bad[1]['targetId']='missing'
        if mutation=='duplicate':bad.append(copy.deepcopy(bad[1]))
        if mutation=='pose':bad[1]['pose']=freeze(initial)[1]['pose']
        if mutation=='negative':bad[1]['connection']['normalOffset']=-21
        if mutation=='stale':bad[1]['connection']['reference']['sourceSha']='0'*64
        response=client.post(f'/projects/{project}/assembly/place',json={'policy':'free','entries':bad})
        assert response.status_code==(409 if mutation=='stale' else 422),response.text
    bad=copy.deepcopy(initial['entries']);bad[1]['matrix'][12]+=1
    assert client.post(f'/projects/{project}/assembly/validate',json={'policy':'free','entries':bad}).status_code==422
    # Later-parent reconnect is sorted, preserving identities and no cycle.
    reordered=placed(client,project,[rows[0],rows[2],rows[1],rows[3]])
    assert [e['id'] for e in reordered['entries']].index('b') < [e['id'] for e in reordered['entries']].index('c')


@pytest.mark.parametrize('gap',[0,1,5,10,25,50,100])
def test_folded_and_angled_source_faces_have_exact_active_plane_gap(api,tmp_path,gap):
    client,project=api
    source=next((ROOT/'public/samples').glob('*/panel.step'))
    shape=cq.importers.importStep(str(source)).val()
    rotated=shape.rotate((0,0,0),(1,2,3),37)
    pa,_=panel(project,shape,tmp_path);pb,_=panel(project,rotated,tmp_path)
    a,b=entry('a',pa),entry('b',pb,'a',gap=gap)
    ca,cb=catalog(client,project,a),catalog(client,project,b)
    fa=max((f for f in ca['faces'] if f['supported']),key=lambda f:f['area'])
    fb=max((f for f in cb['faces'] if f['supported']),key=lambda f:f['area'])
    b=connect(b,reference(ca,fa['normal']),reference(cb,fb['normal']),offsetU=-12.25,offsetV=50,twist=-29)
    b['mateState']='active'
    result=placed(client,project,[a,b])
    assert result['mates'][0]['actual']==pytest.approx(gap,abs=1e-5)
    assert result['mates'][0]['satisfied']
    assert approved(client,project,result['entries'])['valid']


def test_side_insertion_keeps_downstream_active_mate_relationship(api,tmp_path):
    from test_free_assembly import side_mate
    client,project=api
    pid,_=panel(project,cq.Solid.makeBox(100,150,3),tmp_path)
    a,b=entry('a',pid),entry('b',pid,'a',gap=12)
    b=side_mate(client,project,a,b)
    c=entry('c',pid,'b',gap=5)
    cb,cc=catalog(client,project,b),catalog(client,project,c)
    c=connect(c,reference(cb,[0,0,1]),reference(cc,[0,0,-1]),offsetU=15,offsetV=30)
    c['mateState']='active'
    original=placed(client,project,[a,b,c]);rows=freeze(original)
    rows[2].pop('pose')
    d=side_mate(client,project,a,entry('d',pid,'a',gap=8))
    response=client.post(f'/projects/{project}/assembly/place',json={'policy':'free','entries':rows+[d],'insertId':'d'})
    assert response.status_code==200,response.text
    result=response.json();moved={e['id']:e for e in result['entries']}
    assert moved['b']['targetId']=='d' and moved['c']['targetId']=='b'
    assert moved['c']['mateState']=='active' and not moved['c']['pose']
    assert result['mates'][0]['actual']==pytest.approx(5)
    assert approved(client,project,result['entries'])['valid']
