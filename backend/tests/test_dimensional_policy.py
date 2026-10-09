"""Dimensional CAD may pass independently; no geometric failure is waived."""
import copy
import pytest
from flatforge.engine import run
from flatforge import geometry as g
from flatforge.solid_validation import export_verification
from test_complex_geometry import channel


def test_positive_allowance_outside_sheet_k_builds_only_dimensional(tmp_path):
    source=tmp_path/'generic.dxf';channel(source,60)
    config={'source':str(source),'settings':{'radius':1.7366},'overrides':{'confirm_parameters':True}}
    dimensional=run({**config,'output':str(tmp_path/'dimensional')})
    assert dimensional['solid']['valid']
    assert any(not p['valid'] and p['constructible'] for p in dimensional['bend_parameters'])
    assert any(w['code']=='PHYSICAL_BEND_PARAMETERS' for w in dimensional['warnings'])
    assert dimensional['verification']['physical_unfolding']=='UNVERIFIED'
    assert not dimensional['validation_policy']['manufacturing_ready']
    physical=run({**config,'output':str(tmp_path/'physical'),'overrides':{**config['overrides'],'validation_mode':'physical'}})
    assert physical['status']=='NEEDS_REVIEW'
    assert any(i['code']=='BEND_PARAMETERS' for i in physical['issues'])
    assert not (tmp_path/'physical/panel.step').exists()


@pytest.mark.parametrize('mode',['dimensional','physical'])
def test_unfold_failure_is_separate_only_in_dimensional_mode(tmp_path,monkeypatch,mode):
    source=tmp_path/'generic.dxf';channel(source)
    original=g.unfold_solid
    def failed(*args,**kwargs):
        return {**original(*args,**kwargs),'status':'FAIL','symmetric_difference_percent':1.2}
    monkeypatch.setattr(g,'unfold_solid',failed)
    out=tmp_path/mode
    report=run({'source':str(source),'output':str(out),'overrides':{'confirm_parameters':True,'validation_mode':mode}})
    assert report['verification']['physical_unfolding']=='UNVERIFIED'
    assert report['status']==('PASS' if mode=='dimensional' else 'NEEDS_REVIEW')
    assert (out/'panel.step').exists()==(mode=='dimensional')
    if mode=='dimensional':
        assert any(w['code']=='UNFOLD_VALIDATION' for w in report['warnings'])
        wrong=copy.deepcopy(report);wrong['section_checks'][0]['chain_status']='FAIL'
        assert export_verification(wrong,'PASS',out)['status']=='REVIEW'


def test_unknown_policy_rejected(tmp_path):
    with pytest.raises(ValueError,match='Unknown validation mode'):
        run({'source':'unused','output':str(tmp_path),'overrides':{'validation_mode':'skip_all'}})
