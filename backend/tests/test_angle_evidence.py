"""Native/exploded dimension evidence must identify walls before supplying angles."""
import math
import ezdxf
import numpy as np
import pytest
from flatforge import geometry as g
from flatforge.angle_evidence import annotate_profiles, attach_hinge_dimensions, degree_value
from flatforge.engine import run
from test_complex_geometry import channel


def drawing(tmp_path,angle=60,kind='3p',text='<>'):
    path=tmp_path/'angular.dxf';channel(path,angle)
    doc,origin,_,_,_=g.read_drawing(path)
    profiles=g.profiles(doc,origin,2);p=profiles[0]
    i=next(i for i in range(1,len(p['points'])-1) if abs(abs(g.profile_turns(p)[i-1])-angle)<1e-5)
    q=p['points'][i]+origin;a=p['points'][i-1]+origin;b=p['points'][i+1]+origin
    # Counterclockwise angular dimension of the included angle.
    if g.cross(a-q,b-q)<0:a,b=b,a
    ms=doc.modelspace();base=q+g.unit(g.unit(a-q)+g.unit(b-q))*15
    if kind=='3p':ms.add_angular_dim_3p(tuple(base),tuple(q),tuple(a),tuple(b),text=text)
    elif kind=='2l':ms.add_angular_dim_2l(tuple(base),(tuple(q),tuple(a)),(tuple(q),tuple(b)),text=text)
    elif kind=='exploded':
        start=math.degrees(math.atan2(*(a-q)[::-1]));end=math.degrees(math.atan2(*(b-q)[::-1]))
        ms.add_arc(tuple(q),15,start,end)
        ms.add_text(text,dxfattribs={'insert':tuple(base),'height':2.5})
    return path,doc,origin,profiles


@pytest.mark.parametrize('kind',['3p','2l','exploded'])
@pytest.mark.parametrize('angle',[30.,60.,120.339])
def test_angular_dimension_attaches_to_correct_vertex(tmp_path,kind,angle):
    path,doc,origin,p=drawing(tmp_path,angle,kind,f'{180-angle}%%d')
    rows=annotate_profiles(doc,origin,p,2)
    assert len(rows)==1 and rows[0]['status']=='MATCHED',rows
    assert rows[0]['rotation_magnitude_deg']==pytest.approx(angle)
    assert any(abs(abs(a)-angle)<1e-7 for a in g.profile_turns(p[0]))
    # Reverse profile traversal: association remains by physical wall handles.
    p[0]['points']=p[0]['points'][::-1];p[0]['segments']=p[0]['segments'][::-1];p[0]['main']=len(p[0]['segments'])-1-p[0]['main']
    assert any(abs(abs(a)-angle)<1e-7 for a in g.profile_turns(p[0]))


def test_degree_text_without_geometric_association_does_not_change_fold(tmp_path):
    path,doc,origin,p=drawing(tmp_path)
    doc.modelspace().add_text('30°',dxfattribs={'insert':(1000,1000)})
    rows=annotate_profiles(doc,origin,p,2)
    assert [r['status'] for r in rows]==['MATCHED','UNASSOCIATED']
    assert sorted(abs(g.profile_turns(p[0])))==pytest.approx([60,90])


def test_plan_relief_dimension_is_not_a_bend(tmp_path):
    path,doc,origin,p=drawing(tmp_path)
    doc.modelspace().add_angular_dim_3p((10,10),(0,0),(20,0),(10,17.3205))
    rows=annotate_profiles(doc,origin,p,2)
    assert [r['status'] for r in rows]==['MATCHED','UNASSOCIATED']


def test_conflicting_label_needs_review_and_override_still_works(tmp_path):
    path,doc,origin,p=drawing(tmp_path,angle=110,text='90°') # actual included70
    doc.saveas(path)
    result=run({'source':str(path),'output':str(tmp_path/'out'),'overrides':{'confirm_parameters':True}})
    assert result['status']=='NEEDS_REVIEW'
    assert any(i['code']=='ANGLE_EVIDENCE_CONFLICT' for i in result['issues'])
    assert len(result['unresolved_bends'])==1
    assert not (tmp_path/'out/panel.step').exists()
    key=result['unresolved_bends'][0]['key']
    # Use signed rotation obtained from the original geometric section.
    from flatforge.section_mapping import map_normal_sections
    d,o,outer,blank,lines=g.read_drawing(path);f,e,_,_,_=g.partition(outer,blank,lines,3)
    map_normal_sections(f,outer,e,g.profiles(d,o,2),2,2,4)
    from flatforge.review import bend_key
    angle=next(x['angle'] for x in e if bend_key(x)==key)
    rebuilt=run({'source':str(path),'output':str(tmp_path/'override'),'overrides':{'confirm_parameters':True,'bend_angles':{key:angle},'build_review_model':True}})
    assert all(b['angle'] is not None for b in rebuilt['bends'])
    assert (tmp_path/'override/panel.step').exists()


@pytest.mark.parametrize('label,rotation',[('70°',110.),('70',110.),('70.2°',109.8)])
def test_dimension_value_reaches_solid_without_manual_input(tmp_path,label,rotation):
    path,doc,origin,p=drawing(tmp_path,110,'3p',label);doc.saveas(path)
    r=run({'source':str(path),'output':str(tmp_path/'out'),'overrides':{'confirm_parameters':True}})
    assert r['status']=='PASS',r
    bends=[b for b in r['bends'] if b['drawing_dimensions']]
    assert len(bends)==1 and abs(bends[0]['angle'])==pytest.approx(rotation)
    assert not bends[0]['confirmed']
    assert (tmp_path/'out/panel.step').exists()


@pytest.mark.parametrize('text',['120°','120%%d',r'120\U+00B0','120,0°'])
def test_cad_degree_encodings(text):assert degree_value(text)==120


@pytest.mark.parametrize('angle',[30.,60.,90.,120.339])
@pytest.mark.parametrize('reverse',[False,True])
def test_two_line_sector_survives_endpoint_order_and_transform(tmp_path,angle,reverse):
    from ezdxf.math import Matrix44
    from flatforge.angle_evidence import _annotations
    _,doc,origin,profiles=drawing(tmp_path,angle,'2l')
    dim=next(e for e in doc.modelspace().query('DIMENSION') if e.dimtype in (2,5))
    if reverse:
        a,b=dim.dxf.defpoint2,dim.dxf.defpoint3
        dim.dxf.defpoint2=b;dim.dxf.defpoint3=a
    dim.transform(Matrix44.chain(Matrix44.z_rotate(.713),Matrix44.translate(12345,-87654,0)))
    row=_annotations(doc,np.zeros(2))[0]
    assert row['value_deg']==pytest.approx(180-angle)
    assert row['sector_source']=='two_line_arc_point'
    assert not row['evidence_conflicts']


def test_rounded_rendered_label_does_not_replace_precise_sector(tmp_path):
    _,doc,origin,profiles=drawing(tmp_path,60.410632589858,'2l')
    dim=next(e for e in doc.modelspace().query('DIMENSION') if e.dimtype in (2,5))
    block=doc.blocks.new('*DTEST');block.add_text('120%%d')
    dim.dxf.geometry=block.name
    dim.dxf.actual_measurement=math.radians(119.589367410142)
    row=annotate_profiles(doc,origin,profiles,2)[0]
    assert row['status']=='MATCHED'
    assert row['rotation_magnitude_deg']==pytest.approx(60.410632589858)
    assert row['rendered_labels'][0]['value_deg']==120


@pytest.mark.parametrize('source',['cache','rendered'])
def test_stale_dimension_evidence_is_a_conflict(tmp_path,source):
    _,doc,origin,profiles=drawing(tmp_path,60,'2l')
    dim=next(e for e in doc.modelspace().query('DIMENSION') if e.dimtype in (2,5))
    if source=='cache':dim.dxf.actual_measurement=math.radians(90)
    else:
        block=doc.blocks.new('*DTEST');block.add_text('90%%d');dim.dxf.geometry=block.name
    row=annotate_profiles(doc,origin,profiles,2)[0]
    assert row['status']=='CONFLICT'
    assert row['evidence_conflicts']
    assert row['value_deg']==pytest.approx(120)


def test_missing_arc_sector_is_review_not_default(tmp_path):
    _,doc,origin,profiles=drawing(tmp_path,60,'2l')
    dim=next(e for e in doc.modelspace().query('DIMENSION') if e.dimtype==2)
    dim.dxf.discard('defpoint5')
    row=annotate_profiles(doc,origin,profiles,2)[0]
    assert row['status']=='CONFLICT'
    assert row['rotation_magnitude_deg'] is None
    assert row['sector_source']=='missing_arc_point'
