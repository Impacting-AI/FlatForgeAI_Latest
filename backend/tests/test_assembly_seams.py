"""Actual topology picks, endpoint placement, solid interference and persistence."""
import copy

import cadquery as cq
import numpy as np
import pytest

from test_assembly_cad import api, entry, panel, bounds
from test_face_connections import catalog, connect, reference
from test_free_assembly import placed, approved


def joint_check(client, project, result):
    response = client.post(f'/projects/{project}/assembly/validate', json={
        'entries': result['entries'], 'policy': 'free', 'mateCheckId': 'b'})
    assert response.status_code == 200, response.text
    return response.json()


def edge_reference(cat, direction, along):
    ref = reference(cat, direction)
    face = next(f for f in cat['faces'] if f['id'] == ref['faceId'])
    candidates = []
    for e in face['edges']:
        a, b = np.array(e['a']), np.array(e['b'])
        if abs((b-a) @ along) > .99999 * np.linalg.norm(b-a):
            candidates.append((a[2]+b[2], e, a, b))
    _, edge, a, b = max(candidates, key=lambda c: c[0])
    return {**ref, 'edgeId': edge['id'], 'point': ((a+b)/2).tolist()}, max([a,b],key=lambda p:p@along)


@pytest.mark.parametrize('edge,gap,angle', [(False,0,0),(True,0,0),(True,7.125,31)])
def test_joint_unequal_translated_solids_with_known_top_endpoints(api,tmp_path,edge,gap,angle):
    client,project = api
    def shape(w,h):
        return cq.Solid.makeBox(w,h,3).translate((17,-12,4))
    p,_ = panel(project,shape(130,200),tmp_path)
    q,_ = panel(project,shape(110,160).rotate((0,0,0),(0,0,1),angle),tmp_path)
    a,b = entry('a',p),entry('b',q,'a',gap=gap)
    ca,cb = catalog(client,project,a),catalog(client,project,b)
    t = np.deg2rad(angle)
    ra,va=edge_reference(ca,[1,0,0],[0,1,0])
    rb,vb=edge_reference(cb,[-np.cos(t),-np.sin(t),0],[-np.sin(t),np.cos(t),0])
    if not edge:
        for r in [ra,rb]: del r['edgeId']
    b = connect(b,ra,rb,type='straight-edge' if edge else 'planar',alignment='top')
    b['mateState']='active'
    out=placed(client,project,[a,b])
    ma,mb=[np.array(e['matrix']).reshape(4,4).T for e in out['entries']]
    assert ((mb@[*vb,1])-(ma@[*va,1]))[:3]==pytest.approx([gap,0,0],abs=1e-6)
    approval=joint_check(client,project,out)
    assert approval['valid'],approval
    token=approval['token']
    saved=client.put(f'/projects/{project}/assembly',json={'revision':0,'entries':[{**e,'label':e['id'].upper()} for e in out['entries']],'token':token})
    assert saved.status_code==200,saved.text
    stored=client.get(f'/projects/{project}/assembly').json()['entries']
    assert [e['matrix'] for e in stored]==[e['matrix'] for e in out['entries']]
    exp=client.post(f'/projects/{project}/assembly/step',json={'token':token})
    assert exp.status_code==200
    path=tmp_path/'joint.step';path.write_bytes(exp.content)
    solids=cq.importers.importStep(str(path)).val().Solids()
    assert sorted(s.Volume() for s in solids)==pytest.approx(sorted([130*200*3,110*160*3]))
    for box in out['bounds'].values():
        assert any(np.allclose(list(bounds(s).values()),list(box.values()),atol=1e-6) for s in solids)
    if edge:
        bad=copy.deepcopy(b);bad['connection']['moving']['edgeId']='edge-9999'
        assert client.post(f'/projects/{project}/assembly/place',json={'entries':[a,bad],'policy':'free'}).status_code==422


def test_joint_blocked_by_third_panel_but_free_move_remains_valid(api,tmp_path):
    client,project=api
    p,_=panel(project,cq.Solid.makeBox(70,90,2),tmp_path)
    a,b,c=entry('a',p),entry('b',p,'a',gap=0),entry('c',p,'a',gap=0)
    b=connect(b,reference(catalog(client,project,a),[1,0,0]),reference(catalog(client,project,b),[-1,0,0]),alignment='top')
    b['mateState']='active'
    out=placed(client,project,[a,b,c])
    check=joint_check(client,project,out)
    assert not check['valid'] and not check['token'] and 'intersect' in check['issues'][0]
    assert approved(client,project,out['entries'])['valid']


def test_folded_flange_edges_rotated_source_and_endpoint_flip(api,tmp_path):
    from test_assembly_cad import ROOT
    client,project=api
    sample=next((ROOT/'public/samples').glob('*/panel.step'))
    body=cq.importers.importStep(str(sample)).val()
    tilted=body.rotate((0,0,0),(1,0,0),23).translate((37,53,-24))
    pa,_=panel(project,body,tmp_path);pb,_=panel(project,tilted,tmp_path)
    a,b=entry('a',pa),entry('b',pb,'a',gap=8.25)
    refs=[]
    for row,side in [(a,'right'),(b,'left')]:
        cat=catalog(client,project,row)
        side_id=cat['sides'][side]['automatic']
        face=next(f for f in cat['faces'] if f['id']==side_id)
        edge=max(face['edges'],key=lambda e:np.linalg.norm(np.subtract(e['b'],e['a'])))
        refs.append(dict(faceId=face['id'],sourceSha=cat['sourceSha'],edgeId=edge['id'],
                         point=np.mean([edge['a'],edge['b']],axis=0).tolist()))
    b=connect(b,*refs,type='straight-edge',alignment='top');b['mateState']='active'
    for flip in (False,True):
        b['connection']['flip']=flip
        result=placed(client,project,[a,b])
        assert result['mates'][0]['surfaceDistance']==pytest.approx(8.25,abs=1e-5)
        assert result['mates'][0]['actual']==pytest.approx(8.25,abs=1e-5)
        assert joint_check(client,project,result)['valid']
        rotation=np.array(result['entries'][1]['matrix']).reshape(4,4).T[:3,:3]
        if not flip: initial=rotation
        else: assert not np.allclose(rotation,initial)


def test_mate_reports_stationary_side_child_constraint(api,tmp_path):
    from test_free_assembly import freeze, side_mate
    client,project=api
    p,_=panel(project,cq.Solid.makeBox(145,95,3),tmp_path)
    a,b,c=entry('a',p),entry('b',p,'a'),entry('c',p,'b')
    b=connect(b,reference(catalog(client,project,a),[1,0,0]),reference(catalog(client,project,b),[-1,0,0]),alignment='top')
    b['mateState']='active'
    c=side_mate(client,project,b,c)
    initial=placed(client,project,[a,b,c])
    c=freeze(initial)[2]
    assert joint_check(client,project,placed(client,project,[a,b,c]))['valid']
    b['connection']['offsetV']=45
    changed=placed(client,project,[a,b,c])
    assert changed['entries'][2]['matrix']==initial['entries'][2]['matrix']
    check=joint_check(client,project,changed)
    assert not check['valid'] and any('fixed side connection' in issue for issue in check['issues'])
