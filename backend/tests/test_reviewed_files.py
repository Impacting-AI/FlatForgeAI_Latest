"""Optional private measured files, through the same API and worker as the UI."""
import hashlib
import json
import os
import tempfile
from pathlib import Path

import pytest

REVIEW_FILE=os.getenv('FLATFORGE_REVIEW_FILE')
SOURCE_DIR=os.getenv('FLATFORGE_REVIEW_SOURCE_DIR')
DOCUMENT=json.loads(Path(REVIEW_FILE).read_text()) if REVIEW_FILE else {}


@pytest.mark.parametrize('entry',list(DOCUMENT.get('panels',{}).values()) or [None])
def test_reviewed_drawing_upload_import_worker_export(entry,tmp_path):
    if entry is None or not SOURCE_DIR:pytest.skip('Supply private review JSON and source directory')
    source=Path(SOURCE_DIR)/entry['source_filename']
    assert hashlib.sha256(source.read_bytes()).hexdigest()==entry['source_sha256']
    os.environ.setdefault('FLATFORGE_API_KEY','test-only-key-never-use-in-production')
    os.environ.setdefault('FLATFORGE_DATA',tempfile.mkdtemp(prefix='ff-measured-api-'))
    from fastapi.testclient import TestClient
    from flatforge.api import app
    from flatforge import worker
    with TestClient(app) as c:
        c.headers['X-Flatforge-Key']=os.environ['FLATFORGE_API_KEY']
        c.put('/settings',json={'thickness':2,'radius':2,'deduction':4})
        project=c.post('/projects',json={'name':'Measured review API regression'}).json()
        with source.open('rb') as f:
            response=c.post('/projects/'+project['id']+'/upload',files=[('files',('arbitrary-upload-name.dxf',f,'application/dxf'))])
        assert response.status_code==202,response.text
        url='/panels/'+response.json()['panels'][0]['id']
        worker.process(worker.claim());initial=c.get(url).json()
        assert initial['status']=='NEEDS_REVIEW',initial['report']
        response=c.post(url+'/review-file',files={'file':('any-review-name.json',json.dumps(DOCUMENT).encode(),'application/json')})
        assert response.status_code==200,response.text
        assert not response.json()['missing_bend_keys']
        assert c.get(url).json()['revision']==initial['revision']
        assert c.post(url+'/review',json=response.json()['review']).status_code==202
        worker.process(worker.claim());result=c.get(url).json()
        assert result['status']=='PASS',result['report']
        report=result['report']
        assert report['validation_scope']=='user_confirmed_bends_and_solid_geometry'
        assert report['solid']['self_intersection_check']['status']=='PASS'
        assert report['unfold_check']['local_boundary_check']['upper_bound_mm']<=result['settings']['strip_tolerance']
        assert report['unfold_check']['plate_normal_check']['max_error_deg']<=result['settings']['angle_tolerance']
        for bend in report['bends']:
            values=entry['overrides']['bend_parameters'][bend['key']]
            assert bend['angle']==values['angle'] and bend['radius']==values['radius']
        response=c.get(url+'/files/panel.step');assert response.status_code==200
        output=tmp_path/'panel.step';output.write_bytes(response.content)
        import cadquery as cq
        shape=cq.importers.importStep(str(output)).val()
        assert shape.isValid() and len(shape.Solids())==1
        assert c.get(url+'/files/fold_table.csv').status_code==200
        assert c.get('/projects/'+project['id']+'/export').status_code==200
        c.delete('/projects/'+project['id'])
