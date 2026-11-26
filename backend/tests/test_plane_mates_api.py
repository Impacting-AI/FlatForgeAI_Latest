"""Multi-mate assemblies through the real API: validate, save, reload, export."""
import cadquery as cq
import numpy as np

from test_assembly_cad import api, entry, panel
from test_face_connections import catalog, reference


def test_three_mates_save_reload_edit_and_export(api, tmp_path):
    client, project = api
    pa, _ = panel(project, cq.Solid.makeBox(100, 200, 20), tmp_path)
    pb, _ = panel(project, cq.Solid.makeBox(60, 80, 20), tmp_path)
    a, b = entry('a', pa), entry('b', pb, 'a')
    url = f'/projects/{project}/assembly'
    ca, cb = catalog(client, project, a), catalog(client, project, b)

    def pair(id, target_normal, moving_normal, offset=0, aligned=False):
        def outer(cat, normal):
            face = max((f for f in cat['faces'] if f['supported'] and np.dot(f['normal'], normal) > .9999),
                       key=lambda f: np.dot(f['center'], normal))
            return dict(faceId=face['id'], sourceSha=cat['sourceSha'], point=face['center'])
        return dict(id=id, targetId='a', type='distance' if offset else 'coincident', offset=offset, aligned=aligned,
                    reference=outer(ca, target_normal), moving=outer(cb, moving_normal))

    start = np.eye(4)
    start[:3, 3] = [400, 30, 20]
    b['pose'] = dict(matrix=start.flatten(order='F').tolist(), sourceSha=cb['sourceSha'], pivot=[0, 0, 0], axis=[0, 0, 1])
    b['planeMates'] = [pair('side', [1, 0, 0], [-1, 0, 0], 20), pair('front', [0, 0, 1], [0, 0, 1], aligned=True),
                       pair('top', [0, 1, 0], [0, 1, 0], aligned=True)]

    def approve(rows):
        placed = client.post(url + '/place', json={'entries': rows, 'policy': 'free'})
        assert placed.status_code == 200, placed.text
        placed = placed.json()
        checked = client.post(url + '/validate', json={'entries': placed['entries'], 'policy': 'free', 'mateCheckId': 'b'})
        assert checked.status_code == 200, checked.text
        return placed, checked.json()

    placed, checked = approve([a, b])
    assert placed['constraints']['b']['status'] == 'defined'
    assert checked['valid'] and not checked.get('warnings'), checked
    saved = client.put(url, json={'revision': 0, 'token': checked['token'],
                                  'entries': [{**e, 'label': e['id'].upper()} for e in placed['entries']]})
    assert saved.status_code == 200, saved.text
    stored = client.get(url).json()['entries']
    def present(value):
        if isinstance(value, dict):
            return {k: present(v) for k, v in value.items() if v is not None}
        return [present(v) for v in value] if isinstance(value, list) else value

    assert stored[1]['planeMates'] == present(placed['entries'][1]['planeMates'])
    assert stored[1]['matrix'] == placed['entries'][1]['matrix']
    # Status is recalculated from the stored mates, not stored.
    reloaded = [{k: v for k, v in e.items() if k != 'label'} for e in stored]
    again, _ = approve(reloaded)
    assert again['constraints']['b']['status'] == 'defined'
    assert [e['matrix'] for e in again['entries']] == [e['matrix'] for e in placed['entries']]
    assert client.post(url + '/step', json={'token': checked['token']}).status_code == 200

    # Editing one distance moves only the mated panel.
    reloaded[1]['planeMates'][0]['offset'] = 55
    edited, _ = approve(reloaded)
    assert edited['entries'][0]['matrix'] == placed['entries'][0]['matrix']
    shift = np.array(edited['bounds']['b']['min']) - np.array(placed['bounds']['b']['min'])
    assert np.allclose(shift, [35, 0, 0], atol=1e-6)

    # Overlap is a warning; a contradiction blocks approval.
    reloaded[1]['planeMates'][0]['offset'] = -10
    _, overlapping = approve(reloaded)
    assert overlapping['valid'] and 'overlap' in overlapping['warnings'][0]
    reloaded[1]['planeMates'].append({**reloaded[1]['planeMates'][0], 'id': 'clash', 'offset': 80})
    _, conflicted = approve(reloaded)
    assert not conflicted['valid'] and conflicted['token'] is None
