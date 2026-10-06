import copy
import pytest
from flatforge.panel_angle import apply_panel_angle,panel_angle_summary,recover_directions
from flatforge.engine import run
from test_complex_geometry import channel


def test_panel_angle_preserves_known_angles_and_uses_each_established_direction():
    edges=[{'angle':90},{'angle':-60},{'direction_sign':1,'direction_evidence':'painted section'},
           {'direction_sign':-1,'direction_evidence':'opposite painted section'},{}]
    assert apply_panel_angle(edges,120)==[edges[-1]]
    assert [e.get('angle') for e in edges]==[90,-60,60,-60,None]
    assert edges[2]['evidence'][0]['profile']=='PANEL ANGLE'


def test_conflict_cannot_be_silently_overridden_by_panel_value():
    e={'direction_sign':1,'direction_evidence':'section','drawing_dimensions':[{'status':'CONFLICT'}]}
    assert apply_panel_angle([e],90)==[e] and 'angle' not in e


def test_consensus_direction_requires_full_coverage_and_agreement():
    e={'source':[{'handle':'A'}],'parent':0,'child':1};key='A:F0:F1'
    def candidate(angle):return {'id':str(angle),'kind':'normal_section','fits_tolerance':True,'folds':[{'key':key,'angle':angle,'vertex':1}]}
    catalog=[{'profile':'A-A','candidate_count':2,'candidates':[candidate(60),candidate(70)]}]
    recover_directions([e],catalog);assert e['direction_sign']==1
    apply_panel_angle([e],120);assert e['angle']==60
    for change in ('opposite','truncated','partial'):
        e={'source':[{'handle':'A'}],'parent':0,'child':1};rows=copy.deepcopy(catalog)
        if change=='opposite':rows[0]['candidates'][1]['folds'][0]['angle']=-60
        if change=='truncated':rows[0]['candidate_count']=30
        if change=='partial':rows[0]['candidates'][1]['folds']=[]
        recover_directions([e],rows);apply_panel_angle([e],120)
        assert 'angle' not in e


def test_summary_reports_multiple_actual_included_angles():
    r=panel_angle_summary([{'angle':90,'source':[]},{'angle':-60,'source':[]}],None)
    assert r['status']=='MULTIPLE' and r['value'] is None and r['values']==[90,120]


def test_known_nonstandard_panel_is_not_changed_by_fallback(tmp_path):
    path=tmp_path/'source.dxf';channel(path,110)
    r=run({'source':str(path),'output':str(tmp_path/'out'),
           'overrides':{'confirm_parameters':True,'panel_bend_angle_deg':45}})
    assert r['status']=='PASS',r
    assert sorted(abs(b['angle']) for b in r['bends'])==pytest.approx([90,110])
    assert r['panel_bend_angle']['values']==[70,90]


def test_single_angle_api_persistence_reset_and_legacy_migration(tmp_path):
    from test_workflow import app,worker
    from fastapi.testclient import TestClient
    import os
    source=tmp_path/'source.dxf';channel(source,60)
    with TestClient(app) as c:
        c.headers['X-Flatforge-Key']=os.environ['FLATFORGE_API_KEY']
        defaults={'thickness':2,'radius':2,'deduction':4,'input_type':'flat_pattern'}
        c.put('/settings',json=defaults)
        project=c.post('/projects',json={'name':'Single angle','client':'QA'}).json()
        with source.open('rb') as f:
            p=c.post('/projects/'+project['id']+'/upload',files=[('files',('source.dxf',f,'application/dxf'))]).json()['panels'][0]
        url='/panels/'+p['id'];worker.process(worker.claim());p=c.get(url).json()
        assert c.post(url+'/review',json={'panel_bend_angle_deg':120}).status_code==422
        for value in [0,180,-90]:
            assert c.post(url+'/review',json={'panel_bend_angle_deg':value,'expected_revision':p['revision']}).status_code==422
        key=p['report']['bends'][0]['key']
        c.post(url+'/review',json={'bend_angles':{key:p['report']['bends'][0]['angle']},'confirm_parameters':True})
        worker.process(worker.claim());p=c.get(url).json()
        old=p['revision']
        saved=c.post(url+'/review',json={'panel_bend_angle_deg':120,'expected_revision':old})
        assert saved.status_code==202
        assert saved.json()['overrides']['bend_angles']=={}
        worker.process(worker.claim());p=c.get(url).json()
        assert p['overrides']['panel_bend_angle_deg']==120
        assert c.get('/bootstrap').json()['settings']==defaults
        assert c.post(url+'/review',json={'panel_bend_angle_deg':90,'expected_revision':old}).status_code==409
        reset=c.post(url+'/review',json={'panel_bend_angle_deg':None,'expected_revision':p['revision']})
        assert reset.status_code==202 and 'panel_bend_angle_deg' not in reset.json()['overrides']
        worker.process(worker.claim())


def test_panel_value_reaches_brep_for_missing_magnitude_with_consensus_direction(tmp_path,monkeypatch):
    from flatforge import engine
    original=engine.prepare_review
    def omit_one_magnitude(faces,outer,edges,*args,**kwargs):
        catalog,errors=original(faces,outer,edges,*args,**kwargs)
        target=next(e for e in edges if abs(abs(e.get('angle',0))-110)<.01)
        target.pop('angle');target.pop('evidence',None)
        return catalog,errors
    monkeypatch.setattr(engine,'prepare_review',omit_one_magnitude)
    path=tmp_path/'source.dxf';channel(path,110)
    r=run({'source':str(path),'output':str(tmp_path/'out'),
           'overrides':{'confirm_parameters':True,'panel_bend_angle_deg':70}})
    assert r['status']=='PASS',r
    chosen=[b for b in r['bends'] if any(v['profile']=='PANEL ANGLE' for v in b['source'])]
    assert len(chosen)==1 and abs(chosen[0]['angle'])==pytest.approx(110)
    assert (tmp_path/'out/panel.step').exists()


def test_panel_value_does_not_invent_missing_direction(tmp_path):
    import ezdxf
    path=tmp_path/'missing.dxf';channel(path,60)
    d=ezdxf.readfile(path)
    for entity in list(d.modelspace()):
        if entity.dxf.layer=='חיפוי':d.modelspace().delete_entity(entity)
    d.saveas(path)
    r=run({'source':str(path),'output':str(tmp_path/'out'),
           'overrides':{'confirm_parameters':True,'panel_bend_angle_deg':120}})
    assert r['status']=='NEEDS_REVIEW'
    assert any(i['code']=='PANEL_ANGLE_DIRECTION' for i in r['issues'])
    assert not (tmp_path/'out/panel.step').exists()
