"""New planar mates use their pre-pick pose in reference-panel coordinates."""
import numpy as np
from fastapi import HTTPException

from .assembly_seams import EPS, straight_edges


def _corner(points, up, right):
    heights = points @ up
    top = points[heights >= heights.max() - EPS]
    return top[(top @ right).argmin()]


def _rims(face, rotation):
    """Straight supporting edges of the trimmed outer wire, with inward direction."""
    wire = face.outerWire()
    points = np.array([v.toTuple() for v in wire.Vertices()]) @ rotation.T
    normal = rotation @ face.normalAt().toTuple()
    for _, _, a, b in straight_edges(wire):
        ends = np.array([a,b]) @ rotation.T
        along = ends[1] - ends[0]
        inward = np.cross(normal, along / np.linalg.norm(along))
        depths = (points - ends[0]) @ inward
        if depths.min() >= -EPS and depths.max() > EPS:
            yield ends, inward
        elif depths.max() <= EPS and depths.min() < -EPS:
            yield ends, -inward


def preserve_pose(connection, face_a, face_b, point_a, point_b, basis, normal_b, turn):
    start = np.array(connection.startPose).reshape(4,4).T
    initial = start[:3,:3]
    n = basis[:,2]
    current = initial @ normal_b
    same_side = current @ n > EPS
    target = n if same_side else -n
    # Shortest arc onto the nearest parallel plane. No implicit roll about its normal.
    x,y,z = np.cross(current, target)
    k = np.array([[0,-z,y],[z,0,-x],[-y,x,0]])
    swing = np.eye(3) + k + k@k/(1+current@target)
    rotation = swing @ initial
    final_rotation = basis @ turn @ basis.T @ rotation
    if connection.alignment == 'picked':
        return final_rotation, point_a, point_b

    u,v = basis[:,0],basis[:,1]
    if not same_side:
        points = np.array([p.toTuple() for p in face_b.outerWire().Vertices()])
        # Common reference axes even if the moving panel was rolled before selection.
        return final_rotation, point_a, _corner(points, rotation.T@v, rotation.T@u)

    # Co-directed flange skins cannot be overlaid to form a butt joint. Match
    # facing supporting rims. Rank placements by travel of the selected face,
    # so CAD origin, edge enumeration and click height do not decide the seam.
    pivot = np.array(face_b.Center().toTuple())
    before = initial@pivot + start[:3,3]
    candidates = []
    moving_rims = list(_rims(face_b, rotation))
    for ends_a, inward_a in _rims(face_a, np.eye(3)):
        for ends_b, inward_b in moving_rims:
            # For skewed straight rims a second, in-plane turn may be necessary.
            # Prefer the least turn, then the least travel. Never invert panel up
            # merely to attach the far rim; explicit edge mating remains available.
            dot = np.clip(inward_b @ -inward_a, -1., 1.)
            if dot < -EPS:
                continue
            angle = np.arctan2(n @ np.cross(inward_b, -inward_a), dot)
            c,s = np.cos(angle),np.sin(angle)
            roll = basis @ np.array([[c,-s,0],[s,c,0],[0,0,1.]]) @ basis.T
            aligned = roll @ rotation
            if np.trace(aligned @ initial.T) < 1-EPS:
                continue  # a default mate must not turn the panel over
            a = _corner(ends_a,v,u)
            b = aligned.T @ _corner(ends_b @ roll.T,v,u)
            delta = a + aligned@(pivot-b) - before
            travel = np.linalg.norm(delta-n*(delta@n))
            candidates.append((abs(angle), travel, a, b, aligned))
    if not candidates:
        raise HTTPException(422,'No matching straight flange boundaries in this orientation. Select opposing faces or mate the intended edges.')
    best_angle = min(row[0] for row in candidates)
    closest = sorted((r for r in candidates if r[0]-best_angle < EPS),key=lambda r:r[1])
    _,score,a,b,aligned = closest[0]
    for _,other,p,q,other_alignment in closest[1:]:
        if other-score > .001:
            break
        if not np.allclose(aligned,other_alignment,atol=EPS,rtol=0) or np.linalg.norm((p-a)-aligned@(q-b)) > .001:
            raise HTTPException(422,'Multiple flange seams are equally close. Select the intended edges or use picked points.')
    return basis @ turn @ basis.T @ aligned, a, b
