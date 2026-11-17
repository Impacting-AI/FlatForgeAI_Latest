"""A flange lap must not turn a cassette upside down to align its skin."""
import cadquery as cq
import numpy as np
import pytest
from test_assembly_cad import api, entry, panel, bounds
from test_face_connections import catalog, connect
from test_free_assembly import placed
from test_assembly_seams import joint_check

def flange(height):
    # Skin, vertical web, and a narrow horizontal return. Two identical local
    # right returns face each other after the user turns B about world Z.
    return cq.Workplane('XZ').polyline([(0,12),(100,12),(100,2),(110,2),
        (110,0),(98,0),(98,10),(0,10)]).close().extrude(height).val()

def upper_return(cat):
    face=next(f for f in cat['faces'] if f['supported'] and np.allclose(f['normal'],[0,0,1]) and abs(f['center'][2]-2)<1e-7)
    return dict(faceId=face['id'],sourceSha=cat['sourceSha'],point=face['center'])

@pytest.mark.parametrize('gap,tilt,yaw',[(0,0,0),(5,0,0),(3.25,17,0),(0,0,19)])
def test_co_directed_flange_preserves_roll_top_corner_and_solids(api,tmp_path,gap,tilt,yaw):
    client,project=api
    a=entry('a',panel(project,flange(90),tmp_path)[0])
    b=entry('b',panel(project,flange(60),tmp_path)[0],'a',gap=gap)
    ra,rb=[upper_return(catalog(client,project,e)) for e in [a,b]]
    b=connect(b,ra,rb,alignment='top');b['mateState']='active'
    legacy=placed(client,project,[a,b])
    def relative(out):
        ma,mb=[np.array(e['matrix']).reshape(4,4).T for e in out['entries']]
        return np.linalg.inv(ma)@mb
    assert relative(legacy)[2,2]==pytest.approx(-1)  # reproduce original flip
    seed=np.diag([-1.,-1.,1.,1.]);seed[:3,3]=[230,-55,0]
    t=np.radians(tilt)
    seed[:3,:3]=np.array([[np.cos(t),0,np.sin(t)],[0,1,0],[-np.sin(t),0,np.cos(t)]])@seed[:3,:3]
    phi=np.radians(yaw)
    seed[:3,:3]=np.array([[np.cos(phi),-np.sin(phi),0],[np.sin(phi),np.cos(phi),0],[0,0,1]])@seed[:3,:3]
    b['connection']['startPose']=seed.flatten(order='F').tolist()
    corrected=placed(client,project,[a,b]);rel=relative(corrected)
    np.testing.assert_allclose(rel[:3,:3],np.diag([-1.,-1.,1.]),atol=1e-8)
    np.testing.assert_allclose(rel@[110,-60,2,1],[110,0,2+gap,1],atol=1e-6)
    np.testing.assert_allclose(corrected['entries'][0]['matrix'],legacy['entries'][0]['matrix'])
    assert corrected['mates'][0]['surfaceDistance']==pytest.approx(gap,abs=1e-6)
    check=joint_check(client,project,corrected);assert check['valid'],check
    saved=client.put(f'/projects/{project}/assembly',json={'revision':0,'entries':[{**e,'label':e['id'].upper()} for e in corrected['entries']],'token':check['token']})
    assert saved.status_code==200,saved.text
    rows=client.get(f'/projects/{project}/assembly').json()['entries']
    reloaded=placed(client,project,[{k:v for k,v in e.items() if k!='label'} for e in rows])
    np.testing.assert_allclose(relative(reloaded),rel)
    step=client.post(f'/projects/{project}/assembly/step',json={'token':check['token']})
    assert step.status_code==200
    path=tmp_path/'assembly.step';path.write_bytes(step.content)
    solids=cq.importers.importStep(str(path)).val().Solids()
    assert len(solids)==2
    for e in corrected['entries']:
        assert any(np.allclose(list(bounds(s).values()),list(corrected['bounds'][e['id']].values()),atol=1e-6) for s in solids)
    # Explicit picks at both flange centres would overlay their materials.
    b['connection']['alignment']='picked';b['gap']=0
    conflict=joint_check(client,project,placed(client,project,[a,b]))
    assert not conflict['valid'] and not conflict['token']


def test_sample_long_perforated_return_faces(api,tmp_path):
    """Use the long planar flange on the folded 1570 STEP as a screenshot analogue."""
    from test_assembly_cad import ROOT
    client,project=api
    body=cq.importers.importStep(str(ROOT/'public/samples/1570/panel.step')).val()
    pid,_=panel(project,body,tmp_path)
    a,b=entry('a',pid),entry('b',pid,'a',gap=0)
    cat=catalog(client,project,a)
    # Test fixture feature, never an application placement rule.
    f=next(f for f in cat['faces'] if f['id']=='face-520')
    assert f['supported'] and f['area']==pytest.approx(8180)
    tri=np.array(f['positions']).reshape(-1,3)[f['indices'][:3]]
    ref=dict(faceId=f['id'],sourceSha=cat['sourceSha'],point=tri.mean(axis=0).tolist())
    seed=np.diag([-1.,-1.,1.,1.]);seed[:2,3]=2*np.array(f['center'][:2])+[80,10]
    b=connect(b,ref,ref,alignment='top',startPose=seed.flatten(order='F').tolist())
    b['mateState']='active'
    out=placed(client,project,[a,b])
    ma,mb=[np.array(e['matrix']).reshape(4,4).T for e in out['entries']]
    np.testing.assert_allclose((np.linalg.inv(ma)@mb)[:3,:3],seed[:3,:3],atol=1e-8)
    assert out['mates'][0]['surfaceDistance']==pytest.approx(0,abs=1e-6)
    check=joint_check(client,project,out)
    assert check['valid'],check


def test_opposing_normals_keep_preexisting_roll(api,tmp_path):
    from test_face_connections import reference
    client,project=api
    pid,_=panel(project,flange(90),tmp_path)
    a,b=entry('a',pid),entry('b',pid,'a',gap=4)
    cat=catalog(client,project,a)
    # A prior turn about the mating normal changes the top/bottom orientation
    # of the part. Opposing parallel faces must not undo that user rotation.
    seed=np.diag([1.,-1.,-1.,1.])
    b=connect(b,reference(cat,[1,0,0]),reference(cat,[-1,0,0]),
              alignment='top',startPose=seed.flatten(order='F').tolist())
    b['mateState']='active'
    out=placed(client,project,[a,b])
    ma,mb=[np.array(e['matrix']).reshape(4,4).T for e in out['entries']]
    np.testing.assert_allclose((np.linalg.inv(ma)@mb)[:3,:3],seed[:3,:3],atol=1e-8)
    assert out['mates'][0]['actual']==pytest.approx(4)
