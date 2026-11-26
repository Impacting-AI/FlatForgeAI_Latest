"""Multi-mate placement on real BREP solids, without the HTTP layer."""
import hashlib

import cadquery as cq
import numpy as np
import pytest

from flatforge import assembly, assembly_connections as connections
from flatforge.assembly import AssemblyInput, Entry, bounds, rotation_matrix


def source(shape, key):
    return {'shape': shape, 'sha256': hashlib.sha256(key.encode()).hexdigest(), 'key': key, 'name': key,
            'faces': connections.face_catalog(shape)}


def reference(src, normal):
    """Reference to the outermost planar face looking along the given direction."""
    normal = np.array(normal, float)
    face, row = max(((f, r) for f, r in src['faces'] if r['supported'] and np.dot(r['normal'], normal) > .9999),
                    key=lambda item: np.dot(item[1]['center'], normal))
    return {'faceId': row['id'], 'sourceSha': src['sha256'], 'point': row['center']}


def matrix_at(x, y, z, turn=0):
    c, s = np.cos(np.radians(turn)), np.sin(np.radians(turn))
    m = np.eye(4)
    m[:3, :3] = [[c, -s, 0], [s, c, 0], [0, 0, 1]]
    m[:3, 3] = [x, y, z]
    return connections.values(m)


def make_entry(id, src, target=None, start=(400, 30, 20), turn=0, mates=None):
    row = dict(id=id, panelId=id, revision=1, myFace='-X', targetId=target, targetFace='+X' if target else None, gap=0)
    if target:
        row['pose'] = dict(matrix=matrix_at(*start, turn), sourceSha=src['sha256'], pivot=[0, 0, 0], axis=[0, 0, 1])
        row['planeMates'] = mates
    return row


def mate(id, sources, a, b, target_normal, moving_normal, offset=0, aligned=False, target='a'):
    return dict(id=id, targetId=target, type='distance' if offset else 'coincident', offset=offset, aligned=aligned,
                reference=reference(sources[target], target_normal), moving=reference(sources[b], moving_normal))


@pytest.fixture
def sources():
    return {'a': source(cq.Solid.makeBox(100, 200, 20), 'a'), 'b': source(cq.Solid.makeBox(60, 80, 20), 'b'),
            'c': source(cq.Solid.makeBox(30, 40, 20), 'c')}


def solve(rows, sources):
    body = AssemblyInput(entries=rows, policy='free')
    return connections.solve(body.entries, sources, rotation_matrix, bounds)


def box_of(result, id):
    return np.array(result['bounds'][id]['min']), np.array(result['bounds'][id]['max'])


def three(sources, gap=20):
    # b sits right of a, front faces flush, top edges flush.
    return [mate('side', sources, 'a', 'b', [1, 0, 0], [-1, 0, 0], offset=gap),
            mate('front', sources, 'a', 'b', [0, 0, 1], [0, 0, 1], aligned=True),
            mate('top', sources, 'a', 'b', [0, 1, 0], [0, 1, 0], aligned=True)]


@pytest.mark.parametrize('count,dof,rotation', [(1, 3, 1), (2, 1, 0), (3, 0, 0)])
def test_each_mate_removes_exactly_the_expected_freedom(sources, count, dof, rotation):
    rows = [make_entry('a', sources['a']), make_entry('b', sources['b'], 'a', turn=37, mates=three(sources)[:count])]
    report = solve(rows, sources)['constraints']['b']
    assert (report['dof'], report['rotationDof']) == (dof, rotation), report
    assert report['status'] == ('defined' if dof == 0 else 'under')
    assert all(m['state'] == 'ok' for m in report['mates'])


def test_fully_defined_panel_lands_exactly_from_any_start(sources):
    for start, turn in [((400, 30, 20), 37), ((-900, 500, -70), 190)]:
        rows = [make_entry('a', sources['a']), make_entry('b', sources['b'], 'a', start, turn, three(sources))]
        result = solve(rows, sources)
        a, b = box_of(result, 'a'), box_of(result, 'b')
        assert b[0][0] - a[1][0] == pytest.approx(20, abs=1e-6)
        assert b[1][2] == pytest.approx(a[1][2], abs=1e-6)
        assert b[1][1] == pytest.approx(a[1][1], abs=1e-6)
        assert b[1] - b[0] == pytest.approx([60, 80, 20], abs=1e-6)


def test_free_directions_stay_at_the_starting_pose(sources):
    rows = [make_entry('a', sources['a']), make_entry('b', sources['b'], 'a', (400, 30, 20), 0, three(sources)[:1])]
    result = solve(rows, sources)
    low, edge = box_of(result, 'b')[0], box_of(result, 'a')[1][0]
    assert low == pytest.approx([edge + 20, 30, 20], abs=1e-6)  # only X was constrained
    assert result['constraints']['b']['freeAxes'] == ['Y', 'Z']


def test_conflicting_mate_is_reported_and_earlier_mates_hold(sources):
    mates = three(sources)[:1] + [mate('clash', sources, 'a', 'b', [1, 0, 0], [-1, 0, 0], offset=55)]
    result = solve([make_entry('a', sources['a']), make_entry('b', sources['b'], 'a', mates=mates)], sources)
    report = result['constraints']['b']
    assert report['status'] == 'conflict'
    assert [m['state'] for m in report['mates']] == ['ok', 'conflict']
    assert box_of(result, 'b')[0][0] - box_of(result, 'a')[1][0] == pytest.approx(20, abs=1e-6)


def test_impossible_angle_is_a_conflict(sources):
    mates = [mate('one', sources, 'a', 'b', [1, 0, 0], [-1, 0, 0]),
             mate('two', sources, 'a', 'b', [0, 1, 0], [-1, 0, 0])]
    report = solve([make_entry('a', sources['a']), make_entry('b', sources['b'], 'a', mates=mates)], sources)['constraints']['b']
    assert report['mates'][1]['state'] == 'conflict'
    assert 'parallel' in report['mates'][1]['message']


def test_repeated_mate_is_redundant_not_conflicting(sources):
    mates = three(sources) + [{**three(sources)[0], 'id': 'again'}]
    report = solve([make_entry('a', sources['a']), make_entry('b', sources['b'], 'a', mates=mates)], sources)['constraints']['b']
    assert report['status'] == 'defined'
    assert report['mates'][-1]['state'] == 'redundant'


def test_dependency_chain_follows_parent_even_when_listed_first(sources):
    def chain(gap):
        child = [mate('c-side', sources, 'b', 'c', [1, 0, 0], [-1, 0, 0], offset=5, target='b'),
                 mate('c-front', sources, 'b', 'c', [0, 0, 1], [0, 0, 1], aligned=True, target='b'),
                 mate('c-top', sources, 'b', 'c', [0, 1, 0], [0, 1, 0], aligned=True, target='b')]
        return [make_entry('a', sources['a']),
                make_entry('c', sources['c'], 'a', (700, 0, 0), mates=child),
                make_entry('b', sources['b'], 'a', mates=three(sources, gap))]
    near, far = solve(chain(20), sources), solve(chain(70), sources)
    assert [e['id'] for e in far['entries']] == ['a', 'c', 'b']
    assert box_of(far, 'c')[0] - box_of(near, 'c')[0] == pytest.approx([50, 0, 0], abs=1e-6)
    assert near['entries'][0]['matrix'] == far['entries'][0]['matrix']


def test_circular_and_missing_targets_are_rejected(sources):
    loop = [make_entry('a', sources['a']),
            make_entry('b', sources['b'], 'a', mates=[mate('x', sources, 'c', 'b', [1, 0, 0], [-1, 0, 0], target='c')]),
            make_entry('c', sources['c'], 'a', mates=[mate('y', sources, 'b', 'c', [1, 0, 0], [-1, 0, 0], target='b')])]
    with pytest.raises(ValueError, match='circular'):
        AssemblyInput(entries=loop, policy='free')
    missing = [make_entry('a', sources['a']), make_entry('b', sources['b'], 'a', mates=[{**three(sources)[0], 'targetId': 'gone'}])]
    with pytest.raises(ValueError, match='not in this assembly'):
        AssemblyInput(entries=missing, policy='free')


def test_base_cannot_be_mated_and_coincident_has_no_distance(sources):
    with pytest.raises(ValueError, match='base panel is fixed'):
        Entry.model_validate({**make_entry('a', sources['a']), 'planeMates': three(sources)})
    bad = {**three(sources)[1], 'offset': 4}
    with pytest.raises(ValueError, match='no distance'):
        AssemblyInput(entries=[make_entry('a', sources['a']), make_entry('b', sources['b'], 'a', mates=[bad])], policy='free')


def test_saved_matrices_reproduce_and_conflicts_block_approval(sources):
    rows = [make_entry('a', sources['a']), make_entry('b', sources['b'], 'a', turn=12, mates=three(sources))]
    first = solve(rows, sources)
    # What the database stores is exactly what the client sends back.
    stored = [Entry.model_validate(row).model_dump(mode='json') for row in first['entries']]
    again = solve(stored, sources)
    assert [e['matrix'] for e in again['entries']] == [e['matrix'] for e in first['entries']]
    checked, _ = assembly.check_placement(AssemblyInput(entries=stored, policy='free').entries, sources, 'free')
    assert checked['valid'] and not checked['issues']
    stored[1]['planeMates'].append({**stored[1]['planeMates'][0], 'id': 'clash', 'offset': 99})
    conflicted = solve(stored, sources)
    checked, _ = assembly.check_placement(AssemblyInput(entries=conflicted['entries'], policy='free').entries, sources, 'free')
    assert not checked['valid'] and 'conflicts' in checked['issues'][0]


def test_line_up_brings_faces_together_without_overriding_mates(sources):
    def face_centre(result, id, normal):
        low, high = box_of(result, id)
        axis = int(np.argmax(np.abs(normal)))
        centre = (low + high) / 2
        centre[axis] = high[axis] if normal[axis] > 0 else low[axis]
        return centre

    first = {**mate('side', sources, 'a', 'b', [1, 0, 0], [-1, 0, 0]), 'lineUp': True}
    result = solve([make_entry('a', sources['a']), make_entry('b', sources['b'], 'a', (400, 900, -70), mates=[first])], sources)
    assert face_centre(result, 'b', [-1, 0, 0]) == pytest.approx(face_centre(result, 'a', [1, 0, 0]), abs=1e-6)
    # Lining up is a preference: the panel is still reported as free to slide and turn.
    assert result['constraints']['b']['dof'] == 3
    flush = mate('front', sources, 'a', 'b', [0, 0, 1], [0, 0, 1], aligned=True)
    both = solve([make_entry('a', sources['a']), make_entry('b', sources['b'], 'a', (400, 900, -70), mates=[first, flush])], sources)
    a, b = box_of(both, 'a'), box_of(both, 'b')
    assert b[1][2] == pytest.approx(a[1][2], abs=1e-6)  # the hard mate wins in Z
    assert (b[0][1] + b[1][1]) / 2 == pytest.approx((a[0][1] + a[1][1]) / 2, abs=1e-6)  # Y stays lined up
    assert b[0][0] == pytest.approx(a[1][0], abs=1e-6)
