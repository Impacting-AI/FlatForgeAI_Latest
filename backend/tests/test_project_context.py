"""Route context must not permit a panel request to mutate a different project."""
import os
import tempfile

os.environ.setdefault('FLATFORGE_DATA', tempfile.mkdtemp(prefix='ff-project-context-'))
os.environ.setdefault('FLATFORGE_API_KEY', 'test-only-key-never-use-in-production')

from fastapi.testclient import TestClient
from flatforge.api import app


def test_panel_project_context_is_checked_before_reads_and_writes(tmp_path):
    from test_complex_geometry import channel
    source = tmp_path / 'scoped.dxf'
    channel(source)
    with TestClient(app) as client:
        client.headers['X-Flatforge-Key'] = os.environ['FLATFORGE_API_KEY']
        first = client.post('/projects', json={'name': 'Project A'}).json()
        other = client.post('/projects', json={'name': 'Project B'}).json()
        with source.open('rb') as file:
            uploaded = client.post(f"/projects/{first['id']}/upload", files=[('files', ('scoped.dxf', file, 'application/dxf'))])
        assert uploaded.status_code == 202
        panel = uploaded.json()['panels'][0]
        url = '/panels/' + panel['id']
        before = client.get(url).json()
        wrong = {'X-Flatforge-Project-Id': other['id']}
        for suffix in ['', '/log', '/source', '/files/panel.glb']:
            assert client.get(url + suffix, headers=wrong).status_code == 404
        assert client.put(url, json={'filename': 'wrong.dxf'}, headers=wrong).status_code == 404
        assert client.put(url + '/measurement', json={'value': 999, 'axis': 'flat_width'}, headers=wrong).status_code == 404
        assert client.post(url + '/review', json={'expected_revision': panel['revision']}, headers=wrong).status_code == 404
        assert client.delete(url, headers=wrong).status_code == 404
        with source.open('rb') as file:
            assert client.post(url + '/source', files={'file': ('replacement.dxf', file, 'application/dxf')}, headers=wrong).status_code == 404
        assert client.get(url).json() == before
        correct = {'X-Flatforge-Project-Id': first['id']}
        assert client.get(url, headers=correct).status_code == 200
        assert client.put(url + '/measurement', json={'value': 204, 'axis': 'folded_x'}, headers=correct).status_code == 200
        assert client.get(url, headers=correct).json()['manual_value'] == 204
        assert client.get(f"/projects/{other['id']}").json()['panels'] == []
        assert client.delete(f"/projects/{first['id']}").status_code == 200
        assert client.delete(f"/projects/{other['id']}").status_code == 200
