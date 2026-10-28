import numpy as np
import cadquery as cq
import pytest
from test_assembly_cad import api, panel, entry
from test_free_assembly import placed, freeze, side_mate, approved
from flatforge.assembly_connections import matrix,location
from flatforge.assembly import bounds

@pytest.mark.parametrize('side,other',[('left','right'),('right','left')])
@pytest.mark.parametrize('height',[160,65])
@pytest.mark.parametrize('rotated',[False,True])
def test_initial_top_alignment_preserves_gap_and_later_manual_pose(api,tmp_path,side,other,height,rotated):
    client,project=api
    shape_a=cq.Solid.makeBox(100,160,3)
    # Different origins, unequal sizes, with a folded return in the solid.
    shape_b=cq.Solid.makeBox(45,height,3).fuse(cq.Solid.makeBox(3,height,18)).translate((23,-41,9))
    pa,_=panel(project,shape_a,tmp_path);pb,_=panel(project,shape_b,tmp_path)
    a=entry('a',pa)
    if rotated:
        half=np.radians(33)/2;axis=np.array([1.,2.,3.]);axis/=np.linalg.norm(axis);a['rotation']=[*(axis*np.sin(half)).tolist(),float(np.cos(half))]
    a=freeze(placed(client,project,[a]))[0]
    b=side_mate(client,project,a,entry('b',pb,'a'),side,other)
    result=client.post(f'/projects/{project}/assembly/place',json={'policy':'free','entries':[a,b],'insertId':'b','alignTop':True})
    assert result.status_code==200,result.text
    result=result.json();ma,mb=[matrix(e['matrix']) for e in result['entries']]
    # Measure original solids in the reference's rotated local frame.
    inverse=np.linalg.inv(ma)
    aa=bounds(shape_a.moved(location(inverse@ma)));bb=bounds(shape_b.moved(location(inverse@mb)))
    assert aa['max'][1]==pytest.approx(bb['max'][1],abs=1e-6)
    gap=aa['min'][0]-bb['max'][0] if side=='left' else bb['min'][0]-aa['max'][0]
    assert gap==pytest.approx(b['gap'],abs=1e-6)
    rows=freeze(result);rows[1]['pose']['offset']=[0,0,50]
    moved=placed(client,project,rows)
    assert np.array(moved['entries'][1]['matrix'][12:15])-np.array(result['entries'][1]['matrix'][12:15])==pytest.approx([0,0,50])
    check=approved(client,project,moved['entries']);assert check['valid']
    saved=client.put(f'/projects/{project}/assembly',json={'revision':0,'token':check['token'],'entries':[{**r,'label':r['id'].upper()} for r in moved['entries']]});assert saved.status_code==200,saved.text
    loaded=client.get(f'/projects/{project}/assembly').json()['entries']
    assert loaded==saved.json()['entries']

@pytest.mark.parametrize('side,other',[('top','bottom'),('bottom','top')])
def test_vertical_connections_and_legacy_placements_are_not_realigned(api,tmp_path,side,other):
    client,project=api
    pa,_=panel(project,cq.Solid.makeBox(100,160,3),tmp_path);pb,_=panel(project,cq.Solid.makeBox(40,70,3),tmp_path)
    a=freeze(placed(client,project,[entry('a',pa)]))[0]
    b=side_mate(client,project,a,entry('b',pb,'a'),side,other)
    old=placed(client,project,[a,b])
    new=client.post(f'/projects/{project}/assembly/place',json={'policy':'free','entries':[a,b],'insertId':'b','alignTop':True})
    assert new.status_code==200,new.text
    assert new.json()['entries'][1]['matrix']==old['entries'][1]['matrix']
