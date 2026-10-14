"""Review import exercises the real API, queue and CAD export with renamed data."""
import copy
import hashlib
import json
import os
import tempfile

import pytest

from flatforge.review_files import select_review


def test_review_file_rejects_duplicate_keys_nonfinite_and_ambiguous_identity():
    digest='a'*64
    entry={'source_sha256':digest,'settings':{},'overrides':{}}
    document={'panels':{'arbitrary-label':entry}}
    assert select_review(json.dumps(document).encode(),digest)==entry
    for raw in (b'{"panels":{},"panels":{}}', b'{"panels":NaN}',
                json.dumps({'panels':{'one':entry,'two':entry}}).encode(),
                json.dumps(document).encode()):
        with pytest.raises(ValueError):
            select_review(raw,'b'*64 if raw==json.dumps(document).encode() else digest)


def test_review_import_preview_rebuild_missing_values_and_stale_revision(tmp_path):
    os.environ.setdefault('FLATFORGE_API_KEY','test-only-key-never-use-in-production')
    os.environ.setdefault('FLATFORGE_DATA',tempfile.mkdtemp(prefix='ff-review-import-'))
    from fastapi.testclient import TestClient
    from flatforge.api import app
    from flatforge import worker
    from test_tolerant_review import without_sections

    source=tmp_path/'unrelated-drawing-name.dxf';without_sections(source)
    with TestClient(app) as c:
        c.headers['X-Flatforge-Key']=os.environ['FLATFORGE_API_KEY']
        c.put('/settings',json={'thickness':2,'radius':2,'deduction':4})
        defaults=c.get('/bootstrap').json()['settings']
        project=c.post('/projects',json={'name':'Review file regression'}).json()
        with source.open('rb') as f:
            uploaded=c.post('/projects/'+project['id']+'/upload',files=[('files',('renamed.dxf',f,'application/dxf'))])
        assert uploaded.status_code==202
        url='/panels/'+uploaded.json()['panels'][0]['id']
        worker.process(worker.claim());panel=c.get(url).json()
        assert panel['status']=='NEEDS_REVIEW'
        keys=[b['key'] for b in panel['report']['bends']]
        entry={'source_filename':'ignored.dxf','source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),
               'settings':{'thickness':2,'radius':2,'deduction':4,'bend_end_mode':'contour'},
               'overrides':{'manual_bends':True,'review_note':'Measured synthetic channel rotations.',
                            'bend_parameters':{keys[0]:{'angle':60},keys[1]:{'angle':-120}}}}
        document={'panels':{'any-label':entry}}
        def preview(data):
            return c.post(url+'/review-file',files={'file':('values.json',json.dumps(data).encode(),'application/json')})
        bad=copy.deepcopy(document);bad['panels']['any-label']['source_sha256']='0'*64
        assert preview(bad).status_code==422
        bad=copy.deepcopy(document);bad['panels']['duplicate']=entry
        assert preview(bad).status_code==422
        bad=copy.deepcopy(document);bad['panels']['any-label']['overrides']['bend_parameters']['unknown']={'angle':90}
        assert preview(bad).status_code==422
        bad=copy.deepcopy(document);bad['panels']['any-label']['overrides']['bend_angles']={keys[0]:90}
        assert preview(bad).status_code==422
        bad=copy.deepcopy(document);bad['panels']['any-label']['settings']['radius']=float('nan')
        assert preview(bad).status_code==422
        assert c.post(url+'/review-file',files={'file':('large.json',b' '*1048577)}).status_code==413
        result=preview(document);assert result.status_code==200,result.text
        body=result.json()['review']
        assert not result.json()['missing_bend_keys']
        assert result.json()['explicit_angles']==2
        assert c.get(url).json()==panel,'Preview must not save, queue or clear artifacts'
        assert c.post(url+'/review',json=body).status_code==202
        assert c.post(url+'/review',json=body).status_code==409
        worker.process(worker.claim());built=c.get(url).json()
        assert built['status']=='PASS',built['report']
        assert {b['angle'] for b in built['report']['bends']}=={60,-120}
        assert built['report']['solid']['self_intersection_check']['status']=='PASS'
        response=c.get(url+'/files/panel.step');assert response.status_code==200
        output=tmp_path/'rebuilt.step';output.write_bytes(response.content)
        import cadquery as cq
        solid=cq.importers.importStep(str(output)).val()
        assert solid.isValid() and len(solid.Solids())==1
        assert c.get('/bootstrap').json()['settings']==defaults

        # A partial new schedule must clear a previously confirmed angle. It
        # cannot inherit that old value or fill it from the shared 90° field.
        partial=copy.deepcopy(document);del partial['panels']['any-label']['overrides']['bend_parameters'][keys[1]]
        result=preview(partial);assert result.status_code==200,result.text
        assert result.json()['missing_bend_keys']==[keys[1]]
        assert result.json()['review']['bend_parameters'][keys[1]]=={}
        assert c.post(url+'/review',json=result.json()['review']).status_code==202
        worker.process(worker.claim());unresolved=c.get(url).json()
        assert unresolved['status']=='NEEDS_REVIEW'
        assert any(b['key']==keys[1] for b in unresolved['report']['unresolved_bends'])
        assert c.get(url+'/files/panel.step').status_code!=200
        c.delete('/projects/'+project['id'])
