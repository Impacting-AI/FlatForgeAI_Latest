"""Missing geometry never silently uses the displayed 90-degree proposal."""
import ezdxf
import pytest
from flatforge.engine import run
from test_complex_geometry import channel

@pytest.mark.parametrize('magnitude',[90.,60.])
def test_missing_section_requires_explicit_signed_choices(tmp_path,magnitude):
    path=tmp_path/'no-section.dxf';channel(path,90)
    d=ezdxf.readfile(path)
    for entity in list(d.modelspace()):
        if entity.dxf.layer=='חיפוי':d.modelspace().delete_entity(entity)
    d.saveas(path)
    initial=run({'source':str(path),'output':str(tmp_path/'initial')})
    assert initial['status']=='NEEDS_REVIEW'
    assert initial['angle_review']['unresolved']==2
    assert initial['angle_review']['fallback_magnitude_deg']==90
    assert all(b['angle'] is None for b in initial['bends'])
    assert not (tmp_path/'initial/panel.step').exists()
    # Operator chooses a signed rotation separately for each parent-local axis.
    choices={b['key']:magnitude for b in initial['bends']}
    result=run({'source':str(path),'output':str(tmp_path/'review'),
                'overrides':{'bend_angles':choices,'confirm_parameters':True,'build_review_model':True}})
    assert result['angle_review']['manual']==2
    assert result['angle_review']['unresolved']==0
    assert all(b['angle']==magnitude for b in result['bends'])
    assert result['status']=='NEEDS_REVIEW' # Missing section checks remain missing.
    assert (tmp_path/'review/review_model.step').exists()

def test_section_angle_needs_no_fallback_confirmation(tmp_path):
    path=tmp_path/'measured.dxf';channel(path,60)
    r=run({'source':str(path),'output':str(tmp_path/'out'),'overrides':{'confirm_parameters':True}})
    assert r['status']=='PASS'
    assert r['angle_review']['detected']==2
    assert r['angle_review']['manual']==r['angle_review']['unresolved']==0
    assert sorted(abs(b['angle']) for b in r['bends'])==pytest.approx([60,90])

def test_parameter_failure_does_not_claim_angle_detection_complete(tmp_path):
    path=tmp_path/'parameters.dxf';channel(path,60)
    r=run({'source':str(path),'output':str(tmp_path/'out'),'settings':{'deduction':50}})
    assert r['status']=='NEEDS_REVIEW'
    assert not r['angle_review']['evidence_checked']
    assert not (tmp_path/'out/panel.step').exists()
