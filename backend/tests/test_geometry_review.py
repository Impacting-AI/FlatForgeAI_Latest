"""Review creates an inspectable solid without laundering failed validation."""
import json
import numpy as np
import pytest
import ezdxf
from flatforge.engine import run
from pydantic import ValidationError
from test_complex_geometry import channel


def conflicting_channel(path):
    channel(path,60)
    doc=ezdxf.readfile(path)
    line=list(doc.modelspace().query('LINE[layer=="KIFOF"]'))[0]
    direction=np.array([np.cos(np.radians(37)),np.sin(np.radians(37)),0])
    line.dxf.start=np.array(line.dxf.start)+5*direction
    line.dxf.end=np.array(line.dxf.end)+5*direction
    doc.saveas(path)


def test_arbitrary_signed_angles_and_reset():
    from flatforge.api import ReviewInput
    body=ReviewInput(bend_angles={'a':-30.466,'b':60,'c':None})
    assert body.bend_angles=={'a':-30.466,'b':60.,'c':None}
    for angle in (0,180,-180,float('nan'),float('inf')):
        with pytest.raises(ValidationError):ReviewInput(bend_angles={'a':angle})


def test_explicit_section_selection_builds_review_but_not_validated_step(tmp_path):
    source=tmp_path/'source.dxf';conflicting_channel(source)
    initial=run({'source':str(source),'output':str(tmp_path/'initial')})
    assert initial['status']=='NEEDS_REVIEW'
    row=initial['review_catalog'][0]
    assert row['candidates'] and not row['candidates'][0]['fits_tolerance']
    choices={row['profile']:row['candidates'][0]['id']}
    out=tmp_path/'review'
    result=run({'source':str(source),'output':str(out),'overrides':{'section_choices':choices,'build_review_model':True,'confirm_parameters':True}})
    assert result['status']=='NEEDS_REVIEW'
    assert result['review_model']['status']=='UNVALIDATED'
    assert any(c['chain_status']=='FAIL' for c in result['section_checks'])
    import cadquery as cq
    shape=cq.importers.importStep(str(out/'review_model.step')).val()
    assert shape.isValid() and len(shape.Solids())==1
    assert (out/'viewer.json').exists() and (out/'panel.glb').exists()
    saved=json.loads((out/'report.json').read_text())
    assert saved['review_decisions']['section_choices']==choices


def test_unknown_selection_stays_in_review(tmp_path):
    source=tmp_path/'source.dxf';conflicting_channel(source)
    result=run({'source':str(source),'output':str(tmp_path/'out'),
                'overrides':{'section_choices':{'SECTION_01':'stale-id'},'build_review_model':True}})
    assert result['status']=='NEEDS_REVIEW'
    assert any(i['code']=='REVIEW_CONFLICT' for i in result['issues'])
    assert not (tmp_path/'out/review_model.step').exists()
