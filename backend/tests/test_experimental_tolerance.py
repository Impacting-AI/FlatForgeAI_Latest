"""Real experimental exports; retain measured failures and missing-data gates."""
import io
import json
import math
import os
from pathlib import Path
import tempfile
import zipfile

import cadquery as cq
import ezdxf
import numpy as np
import pytest

from flatforge import tolerance_policy
from flatforge.engine import run
from test_complex_geometry import channel
from test_tolerant_review import without_sections


def test_outside_tolerance_channel_exports_with_unchanged_angles(tmp_path):
    assert tolerance_policy.ENFORCE_DRAWING_TOLERANCES is False
    source=tmp_path/'channel.dxf';channel(source)
    doc=ezdxf.readfile(source)
    line=next(iter(doc.modelspace().query('LINE[layer=="KIFOF"]')))
    shift=.65*np.array([math.cos(math.radians(37)),math.sin(math.radians(37)),0.])
    line.dxf.start=np.array(line.dxf.start)+shift;line.dxf.end=np.array(line.dxf.end)+shift
    doc.saveas(source)
    result=run({'source':str(source),'output':str(tmp_path/'out'),'overrides':{'confirm_parameters':True}})
    assert result['status']=='PASS',result['issues']
    assert result['tolerance_policy']['enforced'] is False
    assert any(row.get('tolerance_bypassed') for row in result['section_mapping'])
    assert any(row['chain_status']=='FAIL' for row in result['section_checks'])
    assert .6<max(row['max_length_error_mm'] for row in result['section_checks'])<.8
    assert [abs(b['angle']) for b in result['bends']]==pytest.approx([90,90])
    assert any(row['code']=='VALIDATION' for row in result['tolerance_deviations'])
    solid=cq.importers.importStep(str(tmp_path/'out/panel.step')).val()
    assert solid.isValid() and len(solid.Solids())==1


def test_experiment_still_requires_missing_angles(tmp_path):
    source=tmp_path/'missing.dxf';without_sections(source)
    result=run({'source':str(source),'output':str(tmp_path/'out')})
    assert result['status']=='NEEDS_REVIEW'
    assert len(result['unresolved_bends'])==2
    assert all(b['angle'] is None for b in result['bends'])
    assert not (tmp_path/'out/panel.step').exists()


def test_api_exports_actual_outline_mismatch_as_experimental_step(tmp_path):
    os.environ.setdefault('FLATFORGE_API_KEY','test-only-key-never-use-in-production')
    os.environ.setdefault('FLATFORGE_DATA',tempfile.mkdtemp(prefix='ff-experimental-'))
    from fastapi.testclient import TestClient
    from flatforge.api import app
    from flatforge import worker
    root=Path(__file__).resolve().parents[2]
    with TestClient(app) as client:
        client.headers['X-Flatforge-Key']=os.environ['FLATFORGE_API_KEY']
        assert client.get('/bootstrap').json()['capabilities']['drawing_tolerances_enforced'] is False
        client.put('/settings',json={'thickness':2,'radius':2,'deduction':4})
        project=client.post('/projects',json={'name':'Experimental tolerance export'}).json()
        with (root/'public/samples/1648/flat.dxf').open('rb') as source:
            response=client.post('/projects/'+project['id']+'/upload',files=[('files',('any-name.dxf',source,'application/dxf'))])
        assert response.status_code==202
        url='/panels/'+response.json()['panels'][0]['id']
        worker.process(worker.claim());panel=client.get(url).json()
        assert panel['status']=='PASS',panel['report']
        report=panel['report']
        assert report['tolerance_policy']['enforced'] is False
        assert report['unfold_check']['local_boundary_check']['status']=='FAIL'
        assert report['unfold_check']['local_boundary_check']['sampled_max_mm']>1.9
        assert report['tolerance_deviations'] and report['warnings']
        step=client.get(url+'/files/panel.step');assert step.status_code==200
        path=tmp_path/'experimental.step';path.write_bytes(step.content)
        solid=cq.importers.importStep(str(path)).val()
        assert solid.isValid() and len(solid.Solids())==1
        assert 'EXPERIMENTAL' in client.get(url+'/files/fold_table.csv').text
        archive=client.get('/projects/'+project['id']+'/export')
        assert archive.status_code==200
        with zipfile.ZipFile(io.BytesIO(archive.content)) as bundle:
            assert any(name.endswith('panel.step') for name in bundle.namelist())
            saved=json.loads(bundle.read(next(name for name in bundle.namelist() if name.endswith('report.json'))))
            assert saved['tolerance_policy']['enforced'] is False
        client.delete('/projects/'+project['id'])
