"""Explicit occupied-side insertion. No collision enforcement or geometry edits."""
import copy
import math
import numpy as np
from fastapi import HTTPException
from . import assembly_connections as cad

OPPOSITE = {'left':'right','right':'left','top':'bottom','bottom':'top'}


def insert(entries, sources, moving_id, branch_id, rotation_matrix, bounds):
    from .assembly import Entry, PanelPose, AssemblyInput
    rows = {e.id:e.model_copy(deep=True) for e in entries}
    new = rows.get(moving_id)
    if not new or not new.connection or not new.sides or new.pose:
        raise HTTPException(422, 'Insertion needs a new side connection preview.')
    if any(e.targetId == moving_id for e in entries):
        raise HTTPException(422, 'Only a newly added panel can be inserted.')
    fixed_id = new.targetId
    fixed = rows[fixed_id]
    incident = [e for e in entries if e.id != moving_id and (e.targetId == fixed_id or e.id == fixed_id and e.targetId)]
    if any(not e.connection or not e.sides for e in incident):
        raise HTTPException(409, 'An existing envelope connection has no reliable named side. Reconnect it using named sides before automatic insertion; manual movement remains available.')
    occupied = []
    for e in entries:
        if e.id == moving_id:
            continue
        if e.targetId == fixed_id and (e.sides and e.sides.reference == new.sides.reference or e.connection and e.connection.reference.faceId == new.connection.reference.faceId):
            occupied.append((e.id,e,False))
    if fixed.targetId and (fixed.sides and fixed.sides.moving == new.sides.reference or fixed.connection and fixed.connection.moving.faceId == new.connection.reference.faceId):
        occupied.append((fixed.targetId,fixed,True))
    if not occupied:
        if branch_id:
            raise HTTPException(409, 'That occupied connection changed. Choose the connection again.')
        return cad.solve(entries,sources,rotation_matrix,bounds)
    if branch_id:
        occupied = [o for o in occupied if o[0] == branch_id]
        if not occupied:
            raise HTTPException(409, 'The selected branch does not occupy this side.')
    if len(occupied) != 1:
        raise HTTPException(409, 'Several connections occupy this side. Choose which branch to insert before.')
    displaced_id, old_edge, incoming = occupied[0]
    if not old_edge.connection or not old_edge.sides:
        raise HTTPException(409, 'Reconnect this legacy layout using named sides before inserting into it.')
    initial = cad.solve(entries,sources,rotation_matrix,bounds)
    matrices = {e['id']:cad.matrix(e['matrix']) for e in initial['entries']}
    # Exit is identified from actual source-local geometry, never global X/Y.
    exit_side = OPPOSITE[new.sides.moving]
    region = cad.connection_sides(sources[moving_id],bounds)[exit_side]
    candidate = next((c for c in region['candidates'] if c['faceId']==region['automatic']),None)
    if not candidate:
        raise HTTPException(409, f'The new panel has no unique {exit_side} exit region. Choose another connection side; no existing panels were moved.')
    ref_type = type(new.connection.reference)
    exit_ref = ref_type(faceId=candidate['faceId'],sourceSha=sources[moving_id]['sha256'],point=candidate['point'])
    old_ref = old_edge.connection.moving if incoming else old_edge.connection.reference
    old_moving = old_edge.connection.reference if incoming else old_edge.connection.moving
    _, old_point, old_basis = cad.resolve(sources[fixed_id],old_ref)
    _, exit_point, exit_basis = cad.resolve(sources[moving_id],exit_ref)
    fixed_matrix, new_matrix = matrices[fixed_id], matrices[moving_id]
    normal = fixed_matrix[:3,:3] @ old_basis[:,2]
    exit_normal = new_matrix[:3,:3] @ exit_basis[:,2]
    if np.dot(normal,exit_normal) < 1-1e-6:
        raise HTTPException(409, 'The exit face is angled relative to the occupied connection. Inserting here would change existing rotations. Choose a parallel exit arrangement or position the panels manually.')
    delta = new_matrix[:3,:3] @ exit_point + new_matrix[:3,3] - (fixed_matrix[:3,:3] @ old_point + fixed_matrix[:3,3])
    # Remove this edge, then traverse exactly its disconnected component.
    edges=[]
    for e in entries:
        if e.targetId and e.id not in (moving_id,old_edge.id):
            edges.append((e.targetId,e.id,e))
    adjacency={id:[] for id in rows}
    for a,b,e in edges:
        adjacency[a].append(b);adjacency[b].append(a)
    affected=set();todo=[displaced_id]
    while todo:
        id=todo.pop()
        if id in affected:continue
        affected.add(id);todo.extend(adjacency[id])
    if fixed_id in affected or moving_id in affected:
        raise HTTPException(409,'Insertion would create a conflicting connection cycle.')
    for id,row in rows.items():
        if not row.pose:
            frame=initial['frames'][id]
            row.pose=PanelPose(matrix=cad.values(matrices[id]),sourceSha=sources[id]['sha256'],pivot=frame['origin'],axis=frame['n'])
        if id in affected:
            base=cad.matrix(row.pose.matrix);base[:3,3]+=delta
            row.pose.matrix=cad.values(base)
            row.pose.pivot=tuple(np.array(row.pose.pivot)+delta)
            matrices[id][:3,3]+=delta
        row.matrix=cad.values(matrices[id])
    new_edge=new.model_copy(deep=True)
    tail=old_edge.model_copy(deep=True)
    tail.connection=tail.connection.model_copy(update={'reference':exit_ref,'moving':old_moving})
    tail.sides=tail.sides.model_copy(update={'reference':exit_side,'moving':old_edge.sides.reference if incoming else old_edge.sides.moving})
    edges.extend([(fixed_id,moving_id,new_edge),(moving_id,displaced_id,tail)])
    # Re-root only when the inserted edge leads towards the old root. Labels and
    # panel identities are independent of this traversal order.
    root=fixed_id if incoming else entries[0].id
    links={id:[] for id in rows}
    for a,b,e in edges:
        links[a].append((b,e,False));links[b].append((a,e,True))
    ordered=[];seen=set();queue=[(root,None,None,False)]
    while queue:
        id,parent,edge,reverse=queue.pop(0)
        if id in seen:raise HTTPException(409,'Insertion would duplicate a connection.')
        seen.add(id);row=rows[id]
        row.targetId=parent
        if parent is None:
            row.targetFace=None;row.connection=None;row.sides=None
        else:
            row.rootOffset=None;row.targetFace='+X';row.myFace='-X'
            row.gap=edge.gap
            if reverse:
                if not edge.connection or not edge.sides:
                    raise HTTPException(409,'An upstream legacy connection must be converted to named sides before insertion.')
                row.connection=edge.connection.model_copy(deep=True)
                row.connection.reference=copy.deepcopy(edge.connection.moving)
                row.connection.moving=copy.deepcopy(edge.connection.reference)
                row.sides=edge.sides.model_copy(update={'reference':edge.sides.moving,'moving':edge.sides.reference})
                # Record the real relative displacement when reversing a link.
                _,pa,ba=cad.resolve(sources[parent],row.connection.reference)
                _,pb,bb=cad.resolve(sources[id],row.connection.moving)
                pmat,mmat=matrices[parent],matrices[id]
                basis=pmat[:3,:3] @ ba
                offset=basis.T @ (mmat[:3,:3] @ pb+mmat[:3,3]-(pmat[:3,:3] @ pa+pmat[:3,3]))
                row.connection.offsetU=float(offset[0]);row.connection.offsetV=float(offset[1]);row.connection.normalOffset=float(offset[2]-row.gap)
                twist=basis.T @ mmat[:3,:3] @ bb @ np.diag([-1.,1.,-1.])
                row.connection.twist=math.degrees(math.atan2(twist[1,0],twist[0,0]))
            else:
                row.connection=copy.deepcopy(edge.connection);row.sides=copy.deepcopy(edge.sides)
        ordered.append(Entry.model_validate(row.model_dump()))
        queue.extend((other,id,e,rev) for other,e,rev in links[id] if other != parent)
    AssemblyInput(entries=ordered,policy='free')
    result=cad.solve(ordered,sources,rotation_matrix,bounds)
    result['insertion']={'panelId':moving_id,'referenceId':fixed_id,'displacedId':displaced_id,'movedIds':sorted(affected),'translationMm':delta.tolist(),'rerooted':incoming}
    return result
