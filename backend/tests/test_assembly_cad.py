"""Real STEP solids -> shared JS placements -> CAD validation/export/re-import."""
import hashlib
import json
import math
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

import cadquery as cq
import pytest

os.environ.setdefault('FLATFORGE_DATA', tempfile.mkdtemp(prefix='ff-assembly-test-'))
os.environ.setdefault('FLATFORGE_API_KEY', 'test-assembly-key-never-use-in-production')
from fastapi.testclient import TestClient
from flatforge.api import app
from flatforge.db import Session, Panel
from flatforge.storage import store
from flatforge.assembly import bounds, location, rotation_matrix

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def api():
    with TestClient(app) as client:
        client.headers['X-Flatforge-Key'] = os.environ['FLATFORGE_API_KEY']
        project = client.post('/projects', json={'name': 'Assembly CAD regression'}).json()['id']
        yield client, project
        client.delete('/projects/'+project)


def panel(project, shape, directory, name='arbitrary-panel.dxf'):
    id = str(uuid.uuid4())
    path = directory/(id+'.step')
    cq.exporters.export(shape, str(path))
    key = store.put(path, f'panels/{id}/test-job/panel.step')
    with Session.begin() as session:
        session.add(Panel(id=id, project_id=project, filename=name, source_key=key,
                          settings='{}', status='PASS', artifacts=json.dumps({'panel.step': key})))
    return id, path


def entry(id, panel_id, target=None, face='+X', gap=10, rotation=None, gaps=None):
    axis = face[1].lower()
    spacing = {name: {'side': 0, 'gap': 0} for name in 'xyz'}
    if target:
        spacing[axis] = {'side': 1 if face[0] == '+' else -1, 'gap': gap}
    if gaps:
        spacing.update(gaps)
    return dict(id=id, panelId=panel_id, revision=1, targetId=target, targetFace=face if target else None,
                myFace=('-' if face[0] == '+' else '+')+face[1], gap=gap, spacing=spacing,
                rotation=rotation or [0, 0, 0, 1])


def place(client, project, entries):
    geometry = client.post(f'/projects/{project}/assembly/geometry', json={'entries': entries})
    assert geometry.status_code == 200, geometry.text
    proc = subprocess.run(['node', '--experimental-strip-types', 'tests/assembly-placement.mjs'], cwd=ROOT,
                          input=json.dumps({'entries': entries, 'geometry': geometry.json()}), text=True, capture_output=True)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def check(client, project, entries):
    response = client.post(f'/projects/{project}/assembly/validate', json={'entries': entries})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize('face', ['+X', '-X', '+Y', '-Y', '+Z', '-Z'])
def test_actual_cad_extents_six_directions_and_monotonic_gaps(api, tmp_path, face):
    client, project = api
    a = cq.Solid.makeBox(170, 62, 3)
    # An irregular, folded L profile with unequal dimensions and a rotation.
    b = cq.Workplane('XZ').polyline([(0,0),(60,0),(60,2),(2,2),(2,35),(0,35)]).close().extrude(83).val()
    pa, _ = panel(project, a, tmp_path); pb, _ = panel(project, b, tmp_path)
    angle = math.radians(37)/2
    rotation = [0, math.sin(angle), 0, math.cos(angle)]
    measured = []
    for gap in [0, 1, 5, 10, 25, 50, 100]:
        placed = place(client, project, [entry('a', pa), entry('b', pb, 'a', face, gap, rotation)])
        result = check(client, project, placed)
        assert result['valid'], result
        actual = result['clearances'][0]['actual']
        assert actual == pytest.approx(gap, abs=1e-5)
        measured.append(actual)
        moved = b.moved(location(placed[1]['matrix']))
        assert moved.Volume() == pytest.approx(b.Volume(), rel=1e-10)
        assert placed[1]['matrix'][:12] == pytest.approx(rotation_matrix(rotation)[:12], abs=1e-12)
    assert measured == sorted(measured)


def test_combined_directions_contact_and_branch_conflicts(api, tmp_path):
    client, project = api
    pa, _ = panel(project, cq.Solid.makeBox(100, 40, 2), tmp_path)
    pb, _ = panel(project, cq.Solid.makeBox(20, 80, 3), tmp_path)
    entries = [entry('a', pa), entry('b', pb, 'a', gap=20, gaps={'y': {'side': -1, 'gap': 30}, 'z': {'side': 1, 'gap': 50}})]
    result = check(client, project, place(client, project, entries))
    assert result['valid'] and len(result['clearances']) == 3
    assert [r['actual'] for r in result['clearances']] == pytest.approx([20, 30, 50])
    # Contact on the intended parent boundary is allowed; positive volume is not.
    contact = check(client, project, place(client, project, [entry('a', pa), entry('b', pb, 'a', gap=0)]))
    assert contact['valid'] and len(contact['contacts']) == 1 and not contact['collisions']
    branches = [entry('a', pa), entry('b', pb, 'a'), entry('c', pb, 'a')]
    conflict = check(client, project, place(client, project, branches))
    assert not conflict['valid'] and conflict['token'] is None
    assert len(conflict['collisions']) == 1
    assert conflict['collisions'][0]['volume'] == pytest.approx(20*80*3)
    assert all(row['satisfied'] for row in conflict['clearances']), 'Sibling collision must be checked beyond parent gaps'


def test_brep_collision_catches_crossing_thin_solids_and_incorrect_gaps(api, tmp_path):
    client, project = api
    pa, _ = panel(project, cq.Solid.makeBox(100, 4, 4), tmp_path)
    pb, _ = panel(project, cq.Solid.makeBox(4, 100, 4), tmp_path)
    entries = [entry('a', pa), entry('b', pb, 'a', gap=20)]
    entries[0]['matrix'] = rotation_matrix([0,0,0,1])
    entries[1]['matrix'] = rotation_matrix([0,0,0,1])
    entries[1]['matrix'][12:15] = [48, -48, 0]
    result = check(client, project, entries)
    assert not result['valid'] and result['issues'] and result['token'] is None
    assert result['collisions'][0]['volume'] == pytest.approx(64)


def test_step_reuses_three_folded_breps_exact_matrices_and_repeated_parts(api, tmp_path):
    client, project = api
    fixtures = sorted((ROOT/'public/samples').glob('*/panel.step'))
    assert len(fixtures) >= 3
    shapes = [cq.importers.importStep(str(path)).val() for path in fixtures[:3]]
    saved = [panel(project, shape, tmp_path, name=f'folded-{index}.dxf') for index, shape in enumerate(shapes)]
    originals = [hashlib.sha256(path.read_bytes()).hexdigest() for _, path in saved]
    angle = math.radians(23)/2
    entries = [entry('root', saved[0][0], rotation=[math.sin(angle),0,0,math.cos(angle)]),
               entry('rotated', saved[1][0], 'root', '+Z', 30, [0,0,math.sin(angle),math.cos(angle)]),
               entry('third', saved[2][0], 'rotated', '-Y', 50),
               entry('repeated', saved[2][0], 'third', '+X', 20)]
    placed = place(client, project, entries)
    result = check(client, project, placed)
    assert result['valid'], result
    response = client.post(f'/projects/{project}/assembly/step', json={'token': result['token']})
    assert response.status_code == 200, response.text[:500]
    path = tmp_path/'assembly.step'; path.write_bytes(response.content)
    assembly = cq.importers.importStep(str(path)).val()
    assert assembly.isValid() and len(assembly.Solids()) == 4
    remaining = assembly.Solids()
    for original, row in zip([*shapes, shapes[2]], placed):
        expected = original.moved(location(row['matrix']))
        target = bounds(expected)
        matches = [candidate for candidate in remaining if max(abs(x-y) for key in ('min','max') for x,y in zip(bounds(candidate)[key],target[key])) < 1e-5]
        assert len(matches) == 1
        actual = matches[0]; remaining.remove(actual)
        assert actual.Volume() == pytest.approx(original.Volume(), rel=1e-7)
        assert sorted(f.geomType() for f in actual.Faces()) == sorted(f.geomType() for f in original.Faces())
    assert b'FlatForge Assembly' in response.content and b'folded-' in response.content
    for (id, source), digest in zip(saved, originals):
        assert hashlib.sha256(source.read_bytes()).hexdigest() == digest
        assert hashlib.sha256(client.get(f'/panels/{id}/files/panel.step').content).hexdigest() == digest
    # The same snapshot cannot export a newer revision or a different project.
    other = client.post('/projects', json={'name':'Other'}).json()['id']
    assert client.post(f'/projects/{other}/assembly/step', json={'token':result['token']}).status_code == 422
    assert client.post(f'/projects/{other}/assembly/geometry', json={'entries':entries}).status_code == 404
    assert client.post(f'/projects/{project}/assembly/step', json={'token':result['token']+'0'}).status_code == 422
    with Session.begin() as session:
        session.get(Panel,saved[0][0]).revision += 1
    assert client.post(f'/projects/{project}/assembly/step', json={'token':result['token']}).status_code == 409
    client.delete('/projects/'+other)


def test_invalid_transform_missing_sources_and_legacy_alignment(api, tmp_path):
    client, project = api
    pa, _ = panel(project, cq.Solid.makeBox(100, 40, 2), tmp_path)
    entries = [entry('a',pa), entry('b',pa,'a')]
    # A saved offset layout is preserved; it is never silently reinterpreted.
    for row in entries:
        row.pop('spacing')
    entries[1]['offsets'] = {'x':0,'y':-12,'z':8}
    placed = place(client,project,entries)
    result = check(client,project,placed)
    assert result['valid'] and result['clearances'][0]['actual'] == pytest.approx(10)
    assert result['bounds']['b']['min'][2] == pytest.approx(8)
    placed[1]['matrix'][0] = 2
    assert client.post(f'/projects/{project}/assembly/validate',json={'entries':placed}).status_code == 422
    entries[1]['panelId'] = 'missing'
    assert client.post(f'/projects/{project}/assembly/geometry',json={'entries':entries}).status_code == 404
    entries[1]['panelId'] = pa
    entries[1]['rotation'] = [0,0,0,2]
    assert client.post(f'/projects/{project}/assembly/geometry',json={'entries':entries}).status_code == 422
    with Session.begin() as session:
        session.get(Panel,pa).status = 'NEEDS_REVIEW'
    entries[1]['rotation'] = [0,0,0,1]
    assert client.post(f'/projects/{project}/assembly/geometry',json={'entries':entries}).status_code == 409
