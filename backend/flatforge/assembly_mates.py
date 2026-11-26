"""Several face-pair mates on one panel, solved as one rigid placement (mm).

A mate keeps the moving face parallel to a face of an earlier panel, facing it
(default) or facing the same way, with the picked point at a signed distance
from that face's plane. Mates are accepted in order: one that contradicts the
earlier ones is reported and ignored, never averaged in. Any freedom the
accepted mates leave stays where the panel's starting pose put it.
"""
import numpy as np

ANGLE_EPS = 1e-6
LINEAR_EPS = 1e-5
RANK_EPS = 1e-6
AXES = ('X', 'Y', 'Z')


def rank(vectors):
    if not len(vectors):
        return 0
    return int(np.sum(np.linalg.svd(np.asarray(vectors), compute_uv=False) > RANK_EPS))


def minimal_rotation(a, b):
    """Smallest rotation taking unit vector a onto unit vector b."""
    cross, cos = np.cross(a, b), float(np.clip(a @ b, -1, 1))
    sin = np.linalg.norm(cross)
    if sin < 1e-12:
        if cos > 0:
            return np.eye(3)
        # Half turn about a deterministic perpendicular.
        helper = np.eye(3)[int(np.argmin(np.abs(a)))]
        axis = np.cross(a, helper)
        axis /= np.linalg.norm(axis)
        return 2 * np.outer(axis, axis) - np.eye(3)
    axis = cross / sin
    skew = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + sin * skew + (1 - cos) * (skew @ skew)


def rotation_for(rows, seed_rotation):
    if not rows:
        return seed_rotation
    targets = [r['direction'] for r in rows]
    if rank(targets) == 1:
        current = seed_rotation @ rows[0]['normal']
        return minimal_rotation(current / np.linalg.norm(current), targets[0]) @ seed_rotation
    h = sum(np.outer(r['normal'], r['direction']) for r in rows)
    u, _, vt = np.linalg.svd(h)
    d = np.sign(np.linalg.det(vt.T @ u.T))
    return vt.T @ np.diag([1, 1, d]) @ u.T


def fit(rows, seed, center):
    """Placement nearest the seed that satisfies rows, plus its worst errors."""
    rotation = rotation_for(rows, seed[:3, :3])
    angle = max((float(np.linalg.norm(rotation @ r['normal'] - r['direction'])) for r in rows), default=0.)
    # Keep the panel's centre where the starting pose had it before correcting.
    start = seed[:3, :3] @ center + seed[:3, 3] - rotation @ center
    translation, distance = start, 0.
    if rows:
        planes = np.array([r['plane_normal'] for r in rows])
        wanted = np.array([r['offset'] + r['plane_normal'] @ (r['plane_point'] - rotation @ r['point']) for r in rows])
        translation = start + np.linalg.pinv(planes, rcond=RANK_EPS) @ (wanted - planes @ start)
        distance = float(np.max(np.abs(planes @ translation - wanted)))
    result = np.eye(4)
    result[:3, :3], result[:3, 3] = rotation, translation
    return result, angle, distance


def free_motion(planes, rows):
    """Describe what is still free, in world axes where that is exact."""
    translations = 3 - rank(planes)
    along = [AXES[i] for i in range(3) if all(abs(n[i]) <= RANK_EPS for n in planes)]
    rotation_axis = None
    if not rows:
        rotations = 3
    elif rank([r['direction'] for r in rows]) == 1:
        rotations, rotation_axis = 1, rows[0]['direction'].tolist()
    else:
        rotations = 0
    return {'dof': translations + rotations, 'translationDof': translations, 'rotationDof': rotations,
            'freeAxes': along if len(along) == translations else [], 'rotationAxis': rotation_axis}


def line_up(transform, rows):
    """Slide, only along unconstrained directions, so chosen face centres meet."""
    wanted = [r for r in rows if r.get('centers')]
    if not wanted:
        return transform
    _, values, vt = np.linalg.svd(np.asarray([r['plane_normal'] for r in rows]))
    free = vt[int(np.sum(values > RANK_EPS)):]
    if not len(free):
        return transform
    gaps = [target - (transform[:3, :3] @ own + transform[:3, 3]) for own, target in (r['centers'] for r in wanted)]
    result = transform.copy()
    result[:3, 3] += free.T @ (free @ np.mean(gaps, axis=0))
    return result


def solve_mates(rows, seed, center):
    """rows: ordered dicts with id, normal/point (panel-local), plane_normal,
    plane_point (world), direction (required world normal), signed offset and
    optionally centers (local moving, world target face centres) to line up."""
    accepted, report = [], []
    result = fit([], seed, center)[0]
    for row in rows:
        trial, angle, distance = fit(accepted + [row], seed, center)
        if angle > ANGLE_EPS or distance > LINEAR_EPS:
            reason = ('Its faces cannot be made parallel while keeping the earlier mates.' if angle > ANGLE_EPS
                      else f'It asks for a position {distance:.6g} mm away from what the earlier mates allow.')
            report.append({'id': row['id'], 'state': 'conflict', 'message': reason})
            continue
        before = [r['plane_normal'] for r in accepted]
        adds = rank(before + [row['plane_normal']]) > rank(before)
        accepted.append(row)
        result = trial
        report.append({'id': row['id'], 'state': 'ok' if adds else 'redundant',
                       'message': '' if adds else 'Consistent, but it removes no further movement.'})
    result = line_up(result, accepted)
    motion = free_motion([r['plane_normal'] for r in accepted], accepted)
    conflict = any(m['state'] == 'conflict' for m in report)
    status = 'conflict' if conflict else 'defined' if motion['dof'] == 0 else 'under'
    return result, {'status': status, 'mates': report, **motion}
