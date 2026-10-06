"""Reconcile section hypotheses before assigning any hinge rotations.

Each domain contains alternative mappings of one profile, not alternative
angles invented by the solver. Shared hinges are constraints. Disconnected
components are solved separately. A bounded exhaustive search establishes
support; truncation never counts as proof of uniqueness.
"""
import math

ANGLE_AGREEMENT_DEG = 1e-5
MAX_SEARCH_STATES = 100000


def solve_domains(domains, limit=MAX_SEARCH_STATES):
    """Return supported candidate indexes and component diagnostics.

    A candidate is a mapping {physical_hinge_id: signed_rotation_degrees}.
    No soft score or majority vote resolves a conflict. All solutions have to
    respect all section evidence in their connected component.
    """
    for domain in domains:
        for candidate in domain:
            if any(not math.isfinite(a) or not 0 < abs(a) < 180 for a in candidate.values()):
                raise ValueError('Section hypothesis contains an invalid signed rotation')
    coverage=[set().union(*(set(c) for c in d)) for d in domains]
    unseen={i for i,d in enumerate(domains) if d};supported=[set() for _ in domains];reports=[]
    while unseen:
        component={min(unseen)};queue=list(component)
        for i in queue:
            for j in sorted(unseen-component):
                if coverage[i] & coverage[j]:component.add(j);queue.append(j)
        unseen-=component
        order=sorted(component,key=lambda i:(len(domains[i]),i))
        if len(order)>256:
            for i in component:supported[i]=set(range(len(domains[i])))
            reports.append({'profiles':sorted(component),'status':'SEARCH_LIMIT','solutions':0,'search_states':0,'search_complete':False})
            continue
        visits=0;solutions=0;truncated=False
        def visit(depth, values, selected):
            nonlocal visits,solutions,truncated
            visits+=1
            if visits>limit:truncated=True;return
            if depth==len(order):
                solutions+=1
                for i,k in selected:supported[i].add(k)
                return
            i=order[depth]
            for k,candidate in enumerate(domains[i]):
                if any(h in values and max(values[h][1],a)-min(values[h][0],a)>ANGLE_AGREEMENT_DEG for h,a in candidate.items()):continue
                updated=dict(values)
                for h,a in candidate.items():
                    lo,hi=values.get(h,(a,a));updated[h]=(min(lo,a),max(hi,a))
                visit(depth+1,updated,selected+[(i,k)])
                if truncated:return
        visit(0,{},[])
        if truncated:
            # Partial enumeration cannot prove a candidate is impossible.
            for i in component:supported[i]=set(range(len(domains[i])))
        reports.append({'profiles':sorted(component),'status':'SEARCH_LIMIT' if truncated else 'CONSISTENT' if solutions else 'CONFLICT',
                        'solutions':solutions,'search_states':visits,'search_complete':not truncated})
    return supported,reports


def propagate_source_axes(faces, edges):
    """Transfer only along the same original KIFOF entity, in local frames.

    Collinearity alone does not license copying an angle. The child-side factor
    accounts for reversed parent/child relationships along a split source axis.
    All evidence is collected before assignment, so list order cannot decide it.
    """
    import numpy as np
    from . import geometry as g
    groups={}
    for edge in edges:
        for source in edge['source']:groups.setdefault(source['handle'],[]).append(edge)
    proposals={};conflicts=[];blocked=set()
    for handle,group in sorted(groups.items()):
        known=[e for e in group if 'angle' in e and not e.get('evidence_conflict')]
        for target in group:
            u,n,c=g.support(target)
            side=np.sign(np.asarray(faces[target['child']].representative_point().coords[0])@n-c)
            values=[]
            for donor in known:
                du,dn,dc=g.support(donor)
                if abs(g.cross(u,du))>1e-7:continue
                ds=np.sign(np.asarray(faces[donor['child']].representative_point().coords[0])@dn-dc)
                # ds uses donor normal; both normals reverse with the axis.
                value=float(donor['angle']*ds*side)
                if not side or not ds:continue
                values.append((value,donor))
            if values and max(a for a,_ in values)-min(a for a,_ in values)>ANGLE_AGREEMENT_DEG:
                conflicts.append({'source_handle':handle,'hinges':[e['index'] for e in group],
                                  'reason':'Separated portions of one source axis have conflicting signed rotations'})
                blocked.update(e['index'] for e in group)
            elif values and 'angle' not in target:
                value,donor=min(values,key=lambda x:(x[0],x[1]['index']))
                proposals.setdefault(target['index'],[]).append((value,donor,handle))
    # A contradictory overlapping source invalidates its entire source-linked
    # component. Do this after collection, independently of handle ordering.
    changed=True
    while changed:
        before=len(blocked)
        for group in groups.values():
            if any(e['index'] in blocked for e in group):blocked.update(e['index'] for e in group)
        changed=len(blocked)!=before
    for edge in edges:
        if edge['index'] in blocked:edge['evidence_conflict']=True
    for target in edges:
        values=proposals.get(target['index'],[])
        if not values or target.get('evidence_conflict'):continue
        if max(a for a,_,_ in values)-min(a for a,_,_ in values)>ANGLE_AGREEMENT_DEG:
            target['evidence_conflict']=True
            conflicts.append({'hinges':[target['index']],'reason':'Overlapping source axes disagree'})
            continue
        value,donor,handle=min(values,key=lambda x:(x[0],x[2],x[1]['index']))
        target['angle']=value
        target['evidence']=[dict(v,angle=value,correspondence='same original KIFOF entity; child-side frame transport',
                                 source_hinge=donor['index'],source_handle=handle) for v in donor.get('evidence',[])]
    for target in edges:
        if target.get('evidence_conflict'):target.pop('angle',None)
    return conflicts
