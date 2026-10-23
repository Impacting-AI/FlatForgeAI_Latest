"""The viewer/table's existing bend_parameters payload survives save/import and CAD."""
import csv
import io
import json
import os
import tempfile

import cadquery as cq
import pytest
from OCP.BRepAdaptor import BRepAdaptor_Surface


@pytest.mark.parametrize('review_note', ['', 'Previously saved review note.'])
def test_bend_overrides_persist_import_and_drive_real_step(tmp_path, review_note):
    os.environ.setdefault('FLATFORGE_API_KEY', 'test-only-key-never-use-in-production')
    os.environ.setdefault('FLATFORGE_DATA', tempfile.mkdtemp(prefix='ff-bend-editor-'))
    from fastapi.testclient import TestClient
    from flatforge.api import app
    from flatforge import worker
    from test_tolerant_review import without_sections

    source = tmp_path/'any-panel.dxf'
    without_sections(source)
    with TestClient(app) as client:
        client.headers['X-Flatforge-Key'] = os.environ['FLATFORGE_API_KEY']
        client.put('/settings', json={'thickness': 2, 'radius': 2, 'deduction': 4})
        defaults = client.get('/bootstrap').json()['settings']
        project = client.post('/projects', json={'name': 'Bend editor regression'}).json()
        with source.open('rb') as stream:
            uploaded = client.post('/projects/'+project['id']+'/upload', files=[('files', ('renamed.dxf', stream, 'application/dxf'))])
        assert uploaded.status_code == 202
        url = '/panels/'+uploaded.json()['panels'][0]['id']
        worker.process(worker.claim())
        panel = client.get(url).json()
        first, second = [bend['key'] for bend in panel['report']['bends']]
        for invalid in ({'angle': 0}, {'angle': 180}, {'radius': 0}, {'radius': -1}, {'deduction': -1}, {'deduction': 101}):
            assert client.post(url+'/review', json={'bend_parameters': {first: invalid}}).status_code == 422
        assert client.post(url+'/review', json={'bend_parameters': {'unknown': {'angle': 60}}}).status_code == 422
        values = {first: {'angle': 60, 'radius': 3, 'deduction': 5}, second: {'angle': -90}}
        # No checkbox or note entry is needed. Incomplete angles still cannot build.
        assert client.post(url+'/review', json={'manual_bends': True, 'review_note': review_note,
                           'bend_parameters': {first: values[first]}}).status_code == 202
        worker.process(worker.claim())
        panel = client.get(url).json()
        assert panel['status'] == 'NEEDS_REVIEW'
        assert [bend['key'] for bend in panel['report']['unresolved_bends']] == [second]
        assert 'panel.step' not in panel['artifacts']
        body = {'expected_revision': panel['revision'], 'bend_parameters': values,
                'manual_bends': True, 'review_note': review_note}
        assert client.post(url+'/review', json=body).status_code == 202
        assert client.post(url+'/review', json=body).status_code == 409
        worker.process(worker.claim())
        built = client.get(url).json()
        assert built['status'] == 'PASS', built['report']['issues']
        assert built['overrides']['bend_parameters'] == values
        assert built['overrides']['review_note'] == review_note
        assert built['report']['validation_scope'] == 'user_confirmed_bends_and_solid_geometry'
        rows = {bend['key']: bend for bend in built['report']['bends']}
        assert {field: rows[first][field] for field in ('angle', 'radius', 'deduction')} == values[first]
        assert rows[second]['angle'] == -90 and rows[second]['radius'] == 2 and rows[second]['deduction'] == 4
        assert rows[first]['confirmed'] and rows[first]['source'][0]['profile'] == 'USER CONFIRMED'
        table = list(csv.DictReader(io.StringIO(client.get(url+'/files/fold_table.csv').text)))
        edited = next(row for row in table if float(row['signed_angle']) == 60)
        assert float(edited['inside_radius_mm']) == 3
        assert float(edited['deduction_mm']) == 5
        assert float(edited['bend_allowance_mm']) == pytest.approx(5*60/90)
        response = client.get(url+'/files/panel.step')
        assert response.status_code == 200
        step = tmp_path/'reviewed.step'; step.write_bytes(response.content)
        solid = cq.importers.importStep(str(step)).val()
        assert solid.isValid() and len(solid.Solids()) == 1
        radii = {round(BRepAdaptor_Surface(face.wrapped).Cylinder().Radius(), 6) for face in solid.Faces() if face.geomType() == 'CYLINDER'}
        assert radii == {2, 3, 4, 5}
        document = {'panels': {'arbitrary-label': {'source_sha256': built['report']['source_sha256'],
                     'settings': built['settings'], 'overrides': built['overrides']}}}
        imported = client.post(url+'/review-file', files={'file': ('review.json', json.dumps(document).encode(), 'application/json')})
        assert imported.status_code == 200, imported.text
        assert {key: {field: value for field, value in row.items() if value is not None}
                for key, row in imported.json()['review']['bend_parameters'].items()} == values
        # Clearing one bend must neither clear its neighbour nor invent an angle.
        assert client.post(url+'/review', json={'expected_revision': built['revision'], 'bend_parameters': {first: {}}, 'manual_bends': False}).status_code == 202
        worker.process(worker.claim())
        cleared = client.get(url).json()
        assert cleared['overrides']['bend_parameters'] == {second: {'angle': -90}}
        assert cleared['overrides']['manual_bends'] is False
        assert any(b['key'] == first for b in cleared['report']['unresolved_bends'])
        assert client.get('/bootstrap').json()['settings'] == defaults
        client.delete('/projects/'+project['id'])
