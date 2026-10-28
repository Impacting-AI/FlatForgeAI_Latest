"""Planar CAD-face references and rigid assembly placement, in millimetres.

Face IDs are local to an immutable source STEP hash. Picking tessellations are
display aids; planes, anchors, clearance and collisions use original BREP faces.
"""
import math
import cadquery as cq
import numpy as np
from fastapi import HTTPException
from OCP.gp import gp_Trsf

PICK_EPS_MM = .001


def matrix(values):
    return np.asarray(values, dtype=float).reshape((4, 4), order='F')


def values(transform):
    return transform.flatten(order='F').tolist()


def location(transform):
    trsf = gp_Trsf()
    trsf.SetValues(*transform[:3, :].flatten().tolist())
    return cq.Location(trsf)


def face_record(face, index):
    kind = face.geomType()
    record = {'id': f'face-{index + 1}', 'type': kind, 'area': face.Area(),
              'center': list(face.Center().toTuple()), 'supported': kind == 'PLANE'}
    if kind == 'PLANE':
        normal = np.array(face.normalAt().toTuple())
        normal /= np.linalg.norm(normal)
        up = np.array([0., 0., 1.])
        if abs(normal @ up) > .999999:
            up = np.array([0., 1., 0.])
        vertical = up - normal * (up @ normal)
        vertical /= np.linalg.norm(vertical)
        horizontal = np.cross(vertical, normal)
        record.update(normal=normal.tolist(), u=horizontal.tolist(), v=vertical.tolist())
    return record


def face_catalog(shape):
    faces = shape.Faces()
    return [(face, face_record(face, index)) for index, face in enumerate(faces)]


def pick_meshes(catalog):
    output = []
    for face, record in catalog:
        # Do not modify triangulation caches on the solids used for CAD checks.
        vertices, triangles = face.copy(mesh=False).tessellate(.05, .12)
        output.append({**record, 'positions': [c for p in vertices for c in p.toTuple()],
                       'indices': [i for triangle in triangles for i in triangle]})
    return output


def resolve(source, reference):
    if reference.sourceSha != source['sha256']:
        raise HTTPException(409, 'Selected CAD faces belong to an older panel result. Reselect both faces; saved references were not reassigned.')
    match = next(((face, row) for face, row in source['faces'] if row['id'] == reference.faceId), None)
    if match is None:
        raise HTTPException(422, 'Selected CAD face no longer exists. Select its replacement explicitly.')
    face, row = match
    if not row['supported']:
        raise HTTPException(422, f'{row["type"]} faces cannot define this constant-gap connection. Select a planar flange or surface.')
    point, normal = np.array(reference.point), np.array(row['normal'])
    if face.distance(cq.Vertex.makeVertex(*point)) > PICK_EPS_MM:
        raise HTTPException(422, 'The picked anchor is outside the selected CAD face or inside a hole. Pick a point on its surface.')
    # Remove only picking round-off normal to the verified plane.
    point = point - normal * ((point - np.array(row['center'])) @ normal)
    basis = np.column_stack((row['u'], row['v'], row['normal']))
    return face, point, basis


def connection_frame(entry, sources, parent_matrix):
    connection = entry.connection
    face_a, point_a, basis_a = resolve(sources[entry.targetId], connection.reference)
    face_b, point_b, basis_b = resolve(sources[entry.id], connection.moving)
    basis = parent_matrix[:3, :3] @ basis_a
    anchor = parent_matrix[:3, :3] @ point_a + parent_matrix[:3, 3]
    angle = math.radians(connection.twist % 360)
    c, s = math.cos(angle), math.sin(angle)
    turn = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1.]])
    # Opposing normals, aligned V axes at zero twist; proper rotation (det +1).
    desired = basis @ turn @ np.diag([-1., 1., -1.])
    rotation = desired @ basis_b.T
    separation = entry.gap + connection.normalOffset
    displacement = basis @ np.array([connection.offsetU, connection.offsetV, separation])
    result = np.eye(4)
    result[:3, :3] = rotation
    result[:3, 3] = anchor + displacement - rotation @ point_b
    return result, (face_a, face_b, point_b, basis, anchor, separation)


def solve(entries, sources, rotation_matrix, bounds):
    """Authoritative live placements for both saved envelope and face connections."""
    matrices, boxes, result, frames = {}, {}, [], {}
    for entry in entries:
        if entry.pose:
            pose = entry.pose
            if pose.sourceSha != sources[entry.id]['sha256']:
                raise HTTPException(409, 'A positioned panel was rebuilt. Reconnect it using the current drawing before saving or exporting.')
            transform = matrix(pose.matrix).copy()
            axis = np.array(pose.axis)
            angle = math.radians(pose.turn % 360)
            cross = np.array([[0,-axis[2],axis[1]],[axis[2],0,-axis[0]],[-axis[1],axis[0],0]])
            turn = np.eye(3)*math.cos(angle)+(1-math.cos(angle))*np.outer(axis,axis)+math.sin(angle)*cross
            pivot = np.array(pose.pivot)
            transform[:3,3] = pivot + turn @ (transform[:3,3]-pivot) + np.array(pose.offset)
            transform[:3,:3] = turn @ transform[:3,:3]
        elif entry.connection:
            transform, details = connection_frame(entry, sources, matrices[entry.targetId])
            _, _, point_b, basis, _, _ = details
            frames[entry.id] = {'kind': 'face', 'origin': (transform[:3,:3] @ point_b + transform[:3,3]).tolist(),
                                'u': basis[:,0].tolist(), 'v': basis[:,1].tolist(), 'n': basis[:,2].tolist()}
        else:
            transform = matrix(rotation_matrix(entry.rotation))
            box = bounds(sources[entry.id]['shape'].moved(location(transform)))
            half = (np.array(box['max']) - np.array(box['min'])) / 2
            center = np.array([0., 0., half[2]])
            if entry.targetId:
                target = boxes[entry.targetId]
                axis = 'XYZ'.index(entry.targetFace[1])
                own_axis = 'XYZ'.index(entry.myFace[1])
                side = 1 if entry.targetFace[0] == '+' else -1
                own_side = 1 if entry.myFace[0] == '+' else -1
                target_half = (np.array(target['max']) - np.array(target['min'])) / 2
                center = (np.array(target['max']) + np.array(target['min'])) / 2
                center[axis] += side * (target_half[axis] + entry.gap)
                center[own_axis] -= own_side * half[own_axis]
                if axis != 2 and own_axis != 2:
                    center[2] = target['min'][2] + half[2]
                offsets = np.array([entry.offsets.x, entry.offsets.y, entry.offsets.z])
                if offsets[axis] != 0:
                    raise HTTPException(422, 'Use the gap control along the envelope connection direction.')
                center += offsets
                if entry.spacing:
                    if axis != own_axis or side == own_side:
                        raise HTTPException(422, 'Choose opposing envelope faces or select actual CAD faces.')
                    for i, name in enumerate('xyz'):
                        constraint = getattr(entry.spacing, name)
                        if i == axis and (constraint.side != side or constraint.gap != entry.gap):
                            raise HTTPException(422, 'Connection face and directional gap disagree.')
                        if constraint.side == 1:
                            center[i] = target['max'][i] + constraint.gap + half[i]
                        if constraint.side == -1:
                            center[i] = target['min'][i] - constraint.gap - half[i]
            transform[:3, 3] = center - (np.array(box['max']) + np.array(box['min'])) / 2
            if entry.targetId is None and entry.rootOffset is not None:
                transform[:3, 3] += np.array(entry.rootOffset)
        matrices[entry.id] = transform
        boxes[entry.id] = bounds(sources[entry.id]['shape'].moved(location(transform)))
        if entry.pose or not entry.connection:
            frames[entry.id] = {'kind': 'root', 'origin': ((np.array(boxes[entry.id]['min']) + np.array(boxes[entry.id]['max']))/2).tolist(),
                                'u': [1,0,0], 'v': [0,0,1], 'n': [0,-1,0]}
        result.append({**entry.model_dump(), 'matrix': values(transform)})
    return {'units': 'mm', 'entries': result, 'bounds': boxes, 'frames': frames,
            'sourceHashes': {entry.id: sources[entry.id]['sha256'] for entry in entries}}


def measure_connection(entry, sources, matrices, linear_eps):
    expected, details = connection_frame(entry, sources, matrices[entry.targetId])
    face_a, face_b, point_b, basis, anchor, requested = details
    actual_matrix = matrices[entry.id]
    actual_anchor = actual_matrix[:3, :3] @ point_b + actual_matrix[:3, 3]
    delta = basis.T @ (actual_anchor - anchor)
    distance = face_a.moved(location(matrices[entry.targetId])).distance(face_b.moved(location(actual_matrix)))
    rotation_ok = np.max(np.abs(expected[:3, :3] - actual_matrix[:3, :3])) <= 1e-7
    offset_ok = np.max(np.abs(delta - [entry.connection.offsetU, entry.connection.offsetV, requested])) <= linear_eps
    surface_ok = abs(distance - requested) <= linear_eps
    issues = []
    if not rotation_ok:
        issues.append(f'{entry.id}: selected faces are not aligned with opposing normals and the requested in-plane rotation.')
    if not offset_ok:
        issues.append(f'{entry.id}: face gap or tangential offsets do not match the requested connection.')
    if rotation_ok and offset_ok and not surface_ok:
        issues.append(f'{entry.id}: selected faces no longer overlap in projection. Plane gap is {requested:.6g} mm but actual face clearance is {distance:.6g} mm. Reduce offsets or select different faces.')
    return {'entryId': entry.id, 'targetId': entry.targetId, 'axis': 'face-normal', 'side': 1,
            'requested': requested, 'actual': float(delta[2]), 'surfaceDistance': distance,
            'offsetU': float(delta[0]), 'offsetV': float(delta[1]), 'satisfied': not issues}, issues


def top_align(entry, rows, sources, rotation_matrix, bounds):
    """Initial side mate only. Use the same source-local up as side naming.

    Measure the original BREP in a frame whose Y is that transformed up.
    Tangential translation preserves the selected face-normal gap and rotation.
    Existing poses never pass through this operation.
    """
    parent = sources[entry.targetId]
    planar = [row for _,row in parent['faces'] if row['supported']]
    if not planar:
        raise HTTPException(409, 'No reliable panel plane is available for top alignment.')
    main = max(planar, key=lambda row: row['area'])
    n = np.array(main['normal'])
    if n[np.argmax(np.abs(n))] < 0: n = -n
    right = np.array([1.,0.,0.])
    if abs(right @ n) > .999: right = np.array([0.,1.,0.])
    right -= n*(right @ n); right /= np.linalg.norm(right)
    up = np.cross(n,right)
    preview = solve(list(rows.values()), sources, rotation_matrix, bounds)
    matrices = {row['id']:matrix(row['matrix']) for row in preview['entries']}
    a,b = matrices[entry.targetId],matrices[entry.id]
    _,details = connection_frame(entry,sources,a)
    basis = details[3]
    up = a[:3,:3] @ up
    # An angled side may have a vertical normal component. Align in its tangent
    # plane; never change the normal clearance to force a world-coordinate top.
    up -= basis[:,2]*(up @ basis[:,2])
    if np.linalg.norm(up) < 1e-8:
        raise HTTPException(409, 'This connection has no independent tangential top direction.')
    up /= np.linalg.norm(up)
    frame=np.eye(4);frame[:3,:3]=np.column_stack((np.cross(up,basis[:,2]),up,basis[:,2])).T
    top_a=bounds(parent['shape'].moved(location(frame @ a)))['max'][1]
    top_b=bounds(sources[entry.id]['shape'].moved(location(frame @ b)))['max'][1]
    delta=basis.T @ (up*(top_a-top_b))
    entry.connection.offsetU += float(delta[0])
    entry.connection.offsetV += float(delta[1])


def connection_sides(source, bounds):
    """Classify *source-local* outer planar regions, not screen/world AABBs.

    The largest panel plane establishes a repeatable drawing frame. Side regions
    must face outward and meet the extreme BREP support plane. Split coplanar
    patches share a placement plane; nonparallel alternatives require a click.
    """
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    planar = [(face, row) for face, row in source['faces'] if row['supported']]
    if not planar:
        return {s: {'candidates': [], 'automatic': None, 'message': 'No planar connection region is available.'} for s in ('left','right','top','bottom')}
    main = max(planar, key=lambda item: item[1]['area'])[1]
    if any(abs(row['area']-main['area']) <= max(1e-6,main['area']*1e-8) and abs(np.dot(row['normal'],main['normal'])) < .999999 for _,row in planar):
        return {s: {'candidates': [], 'automatic': None, 'message': 'This solid has no unique main panel plane for side identification.'} for s in ('left','right','top','bottom')}
    n = np.array(main['normal'])
    if n[np.argmax(np.abs(n))] < 0:
        n = -n
    right = np.array([1.,0.,0.])
    if abs(right @ n) > .999:
        right = np.array([0.,1.,0.])
    right -= n*(right @ n); right /= np.linalg.norm(right)
    up = np.cross(n, right)
    frame = np.eye(4); frame[:3,:3] = np.column_stack((right, up, n)).T
    body = bounds(source['shape'].moved(location(frame)))
    scale = max(np.array(body['max'])-np.array(body['min']))
    tolerance = max(.001, scale*1e-7)
    result = {}
    for side, axis, sign in [('left',0,-1),('right',0,1),('top',1,1),('bottom',1,-1)]:
        direction = (right if axis == 0 else up)*sign
        support = body['max' if sign>0 else 'min'][axis]*sign
        candidates = []
        for face, row in planar:
            if np.dot(row['normal'], direction) < .5:
                continue
            box = bounds(face.moved(location(frame)))
            if abs(box['max' if sign>0 else 'min'][axis]*sign-support)>tolerance:
                continue
            # Closest point on trimmed CAD face also handles centroids in holes.
            anchor = BRepExtrema_DistShapeShape(cq.Vertex.makeVertex(*row['center']).wrapped, face.wrapped)
            if not anchor.IsDone() or not anchor.NbSolution():
                continue
            point = anchor.PointOnShape2(1)
            candidates.append({'faceId': row['id'], 'point': [point.X(),point.Y(),point.Z()], 'normal': row['normal'], 'area': row['area'],
                               'labelPoints': [list(edge.positionAt(.5).toTuple()) for edge in sorted(face.Edges(),key=lambda edge:edge.Length(),reverse=True)[:8]]})
        candidates.sort(key=lambda c: (-c['area'], c['faceId']))
        automatic = None
        if candidates:
            first = candidates[0]; normal = np.array(first['normal']); origin = np.array(first['point'])
            if all(np.dot(c['normal'],normal)>.999999 and abs((np.array(c['point'])-origin) @ normal)<=tolerance for c in candidates):
                automatic = first['faceId']
        result[side] = {'candidates': candidates, 'automatic': automatic,
                        'message': '' if automatic else 'Choose a highlighted region on this side.' if candidates else 'No reliable planar connection region on this side.'}
    return result
