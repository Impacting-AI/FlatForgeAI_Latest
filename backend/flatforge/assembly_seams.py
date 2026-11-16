"""Joint references on original trimmed topology. All coordinates in source mm."""
import cadquery as cq
import numpy as np
from fastapi import HTTPException

EPS = 1e-7
PICK_EPS_MM = .001


def straight_edges(face):
    """IDs are local to the owning face and immutable source STEP digest."""
    for index, edge in enumerate(face.Edges(), 1):
        if edge.geomType() != 'LINE':
            continue
        a, b = [np.asarray(p.toTuple()) for p in (edge.startPoint(), edge.endPoint())]
        if np.linalg.norm(b-a) > EPS:
            yield f'edge-{index}', edge, a, b


def panel_up(source):
    planes = [r for _, r in source['faces'] if r['supported']]
    main = max(planes, key=lambda r: r['area'])
    n = np.array(main['normal'])
    if any(abs(r['area']-main['area']) <= EPS and abs(n @ r['normal']) < 1-EPS for r in planes):
        raise HTTPException(422, 'No unique main panel plane. Use picked-point alignment or choose a different reference.')
    if n[np.argmax(abs(n))] < 0:
        n = -n
    right = np.array([1., 0., 0.]) if abs(n[0]) < .999 else np.array([0., 1., 0.])
    up = np.cross(n, right)
    return up / np.linalg.norm(up)


def seam_reference(source, face, ref, basis, moving, connection):
    """Orient the support plane by panel-local top; select corresponding outer vertices."""
    up = panel_up(source)
    n = basis[:, 2]
    v = up - n*(up@n)
    if np.linalg.norm(v) < EPS:
        v = basis[:, 1]  # top/bottom support: preserve its in-plane orientation
    v = v / np.linalg.norm(v)
    u = np.cross(v, n)
    if connection.type == 'straight-edge':
        selected = next((row for row in straight_edges(face) if row[0] == ref.edgeId), None)
        if not selected:
            raise HTTPException(422, 'Select a straight CAD edge belonging to the chosen planar face.')
        _, edge, a, b = selected
        if edge.distance(cq.Vertex.makeVertex(*ref.point)) > PICK_EPS_MM:
            raise HTTPException(422, 'The picked point does not lie on the selected CAD edge.')
        along = (b-a)/np.linalg.norm(b-a)
        # Top first; on a horizontal edge use a common in-plane ordering.
        along_score = along @ v
        if abs(along_score) < EPS:
            along_score = along @ u * (-1 if moving else 1)
        if (along_score < 0) != (moving and connection.flip):
            a,b,along = b,a,-along
        return edge,b,np.column_stack((np.cross(along,n),along,n))
    pts = [np.array(p.toTuple()) for p in face.outerWire().Vertices()]
    if not pts or not any(True for _ in straight_edges(face.outerWire())):
        raise HTTPException(422, 'No straight outer corner reference. Choose picked-point alignment.')
    height = max(p@v for p in pts)
    top = [p for p in pts if height-p@v < EPS]
    point = max(top, key=lambda p: (1 if moving else -1)*(p@u))
    return face,point,np.column_stack((u,v,n))


def active_branch(entries, moving_id):
    changed = {moving_id}
    if not any(e.id == moving_id and e.mateState == 'active' for e in entries):
        raise HTTPException(422, 'Joint validation requires an active moving mate.')
    while True:
        downstream = {e.id for e in entries if e.targetId in changed and e.mateState == 'active'}
        if downstream <= changed:
            break
        changed |= downstream
    return changed


def joint_conflicts(entries, changed, shapes, boxes, volume_eps):
    """Validate moved branch against stationary bodies. Never police Free Move."""
    issues = []
    for a in entries:
        if a.id not in changed:
            continue
        for b in entries:
            if b.id in changed:
                continue
            x,y = boxes[a.id], boxes[b.id]
            if any(min(i,j) <= max(k,l) for i,j,k,l in zip(x['max'],y['max'],x['min'],y['min'])):
                continue
            common = shapes[a.id].intersect(shapes[b.id])
            if not common.isValid():
                raise HTTPException(422, 'Could not verify solid intersection. Mate was not approved.')
            volume = sum(abs(s.Volume()) for s in common.Solids())
            if volume > volume_eps:
                issues.append((a.id,b.id,volume))
    return issues
