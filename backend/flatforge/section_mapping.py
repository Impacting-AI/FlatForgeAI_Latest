"""Normal-section correspondence for straight hinges at arbitrary plan angles.

Only a unique, dimensionally consistent chain supplies rotations. Projected
views crossing nonparallel hinges are deliberately reported as unresolved:
their apparent turns are not the true bend angles.
"""
import math
import numpy as np
from shapely.geometry import LineString
from . import geometry as g
from .evidence_constraints import solve_domains


def minimax_station(start, end, expected):
    """Minimise the largest absolute strip residual on one affine cut lane.

    The upper envelope of signed affine residuals is convex and piecewise
    linear. Its minimum occurs at an endpoint or a pairwise intersection.
    Ties select the lowest station, making correspondence deterministic.
    """
    offset=np.asarray(start,dtype=float)-np.asarray(expected,dtype=float)
    slope=np.asarray(end,dtype=float)-np.asarray(start,dtype=float)
    intercept=np.r_[offset,-offset];gradient=np.r_[slope,-slope]
    candidates=[0.,1.]
    for i in range(len(intercept)):
        for j in range(i):
            denominator=gradient[i]-gradient[j]
            if abs(denominator)<1e-12:continue
            x=float((intercept[j]-intercept[i])/denominator)
            if 0<=x<=1:candidates.append(x)
    return min(candidates,key=lambda x:(float(np.max(np.abs(offset+slope*x))),x))


def trace(faces, outer, direction, coordinate):
    normal=np.array([-direction[1],direction[0]])
    origin=normal*coordinate
    radius=max(np.linalg.norm(q) for q in outer.exterior.coords)+10
    cut=LineString([origin-direction*radius,origin+direction*radius])
    items=[]
    for i,face in enumerate(faces):
        part=face.intersection(cut)
        for line in getattr(part,'geoms',[part]):
            if line.geom_type!='LineString' or line.length<=.01:continue
            s=np.array(line.coords)@direction
            items.append((float(s.min()),float(s.max()),i))
    return sorted(items)


def connected_traces(items, lookup):
    """Separate disjoint material intervals; never truncate a connected chain."""
    groups=[]
    for item in items:
        if not groups or abs(groups[-1][-1][1]-item[0])>1e-6:
            groups.append([])
        groups[-1].append(item)
    return groups


def directions(edges):
    result=[]
    for e in edges:
        u,_,_=g.support(e);v=np.array([-u[1],u[0]])
        if (abs(v[0])<1e-8 and v[1]<0) or v[0]<-1e-8:v=-v
        if not any(abs(g.cross(v,x))<1e-7 for x in result):result.append(v)
    return result


def map_normal_sections(faces,outer,edges,profiles,t,r,bd,tolerance=.5):
    lookup={frozenset(e['faces']):e for e in edges}
    reports=[]
    for number,p in enumerate(profiles,1):
        p.setdefault('drawing_name',p.get('name'))
        p['name']=f'SECTION_{number:02}'
        contradictions=[a for a in p.get('angle_dimensions',[]) if a.get('status')=='CONFLICT']
        if contradictions:
            p['_normal_candidates']=[]
            reports.append({'profile':p['name'],'drawing_label':p['drawing_name'],'status':'NEEDS_REVIEW',
                            'section_layer':p.get('layer'),'paint_marker':p['paint_handle'],
                            'source_handles':[s['handles'] for s in p['segments']],
                            'reason_code':'ANGLE_EVIDENCE_CONFLICT',
                            'reason':'Angular annotation and HAT geometry disagree; resolve the recorded source contradiction.',
                            'angle_conflicts':contradictions,'candidate_chains':0})
            continue
        candidates=[];nearest=None;nearest_normal=None;nearest_projected=None;observed_counts=set()
        for reverse in (False,True):
            pts=p['points'][::-1] if reverse else p['points']
            segs=p['segments'][::-1] if reverse else p['segments']
            main=len(pts)-2-p['main'] if reverse else p['main']
            vectors=np.diff(pts,axis=0);lengths=np.linalg.norm(vectors,axis=1)
            angles=g.profile_turns(dict(p,points=pts,segments=segs,main=main))
            if any(not 0<abs(a)<180 for a in angles):continue
            gain=np.array([(r+t/2)*math.tan(math.radians(abs(a))/2)-g.bend_allowance(t,r,bd,a)/2 for a in angles])
            expected=lengths-np.r_[0,gain]-np.r_[gain,0]
            for direction in directions(edges):
                normal=np.array([-direction[1],direction[0]])
                stations=sorted({round(float(np.array(q)@normal),6) for face in faces for q in face.exterior.coords})
                for low,high in zip(stations,stations[1:]):
                    if high-low<.02:continue
                    # Trace length varies affinely inside a vertex-free lane.
                    mid=(low+high)/2
                    groups=connected_traces(trace(faces,outer,direction,mid),lookup)
                    for group_index,items in enumerate(groups):
                        c=mid
                        observed_counts.add(len(items))
                        if len(items)!=len(lengths):continue
                        eps=min(.001,(high-low)/10)
                        ends=[connected_traces(trace(faces,outer,direction,x),lookup) for x in (low+eps,high-eps)]
                        if any(len(rows)!=len(groups) for rows in ends):continue
                        ends=[rows[group_index] for rows in ends]
                        ids=[x[2] for x in items]
                        if all([x[2] for x in rows]==ids for rows in ends):
                            start=np.array([b-a for a,b,_ in ends[0]]);end=np.array([b-a for a,b,_ in ends[1]])
                            slope=end-start
                            if slope@slope>1e-12:
                                ratio=minimax_station(start,end,expected)
                                c=low+eps+ratio*(high-low-2*eps)
                                fitted=connected_traces(trace(faces,outer,direction,c),lookup)
                                if len(fitted)!=len(groups):continue
                                items=fitted[group_index]
                        hinges=[lookup.get(frozenset((a[2],b[2]))) for a,b in zip(items,items[1:])]
                        if any(e is None for e in hinges):continue
                        actual=np.array([b-a for a,b,_ in items]);error=float(max(abs(actual-expected)))
                        normal_cut=all(abs(g.support(e)[0]@direction)<1e-5 for e in hinges)
                        record={'max_strip_error_mm':error,'faces':[i[2] for i in items],
                                'reversed':reverse,'scope':'disconnected_region' if len(groups)>1 else 'full_chain',
                                'hinges':[e['index'] for e in hinges], 'normal_to_all_hinges':normal_cut,
                                'observed_flat_lengths_mm':actual.tolist(),'required_flat_lengths_mm':expected.tolist(),
                                'profile_lengths_mm':lengths.tolist(),'turn_angles_deg':angles.tolist(),
                                'cut_direction':direction.tolist(),'cut_coordinate':c}
                        record['segment_checks']=[{
                            'segment':i+1,'face':items[i][2],
                            'source_handles':segs[i]['handles'],
                            'observed_flat_mm':float(a),'required_flat_mm':float(b),
                            'residual_mm':float(a-b),'within_tolerance':bool(abs(a-b)<=tolerance)
                        } for i,(a,b) in enumerate(zip(actual,expected))]
                        if nearest is None or error<nearest['max_strip_error_mm']:nearest=record
                        if normal_cut and (nearest_normal is None or error<nearest_normal['max_strip_error_mm']):nearest_normal=record
                        if not normal_cut and (nearest_projected is None or error<nearest_projected['max_strip_error_mm']):nearest_projected=record
                        if not normal_cut or error>tolerance:continue
                        rotations=[float(a*g.cross(g.support(e)[0],direction)*(1 if e['parent']==left[2] else -1)) for a,e,left in zip(angles,hinges,items)]
                        signature=tuple(sorted((e['index'],round(a,8)) for e,a in zip(hinges,rotations)))
                        candidates.append(dict(signature=signature,width=high-low,c=c,trace=items,direction=direction,pts=pts,segs=segs,main=main,hinges=hinges,rotations=rotations,error=error,scope=record['scope']))
        signatures={c['signature'] for c in candidates}
        # Keep full candidates for the repeated-detail convention resolver.
        # Internal geometry arrays are never copied into the public report.
        p['_normal_candidates']=candidates
        row={'profile':p['name'],'drawing_label':p['drawing_name'],'section_layer':p.get('layer'),'paint_marker':p['paint_handle'],
             'source_handles':[s['handles'] for s in p['segments']], 'candidate_chains':len(signatures),'nearest_candidate':nearest,
             'nearest_normal_candidate':nearest_normal,'nearest_projected_candidate':nearest_projected,
             'required_segment_count':len(p['segments']),'observed_chain_segment_counts':sorted(observed_counts)}
        if len(signatures)!=1:
            if signatures:
                code='AMBIGUOUS_CHAIN'
                reason='More than one distinct hinge chain matches this profile; a section cut marker is required.'
            elif nearest is None:
                code='NO_CHAIN'
                reason=f"No contiguous face chain matches the profile's {len(p['segments'])} segments; observed chain counts: {sorted(observed_counts)}. Check whether this is a partial detail or a different edge configuration."
            elif not nearest['normal_to_all_hinges']:
                code='NON_NORMAL_CHAIN'
                reason='The closest chain crosses nonparallel hinges; its apparent section turns cannot be used as bend rotations.'
            else:
                code='STRIP_LENGTH_MISMATCH'
                reason=f"Closest normal chain exceeds the {tolerance:g} mm strip tolerance (maximum {nearest['max_strip_error_mm']:.3f} mm). Check its segment diagnostics and bend parameters."
            row.update(status='NEEDS_REVIEW',reason_code=code,reason=reason)

        reports.append(row)
    # Candidate generation is complete before any profile can affect another.
    # Enumerate only distinct signed hinge assignments; lane duplicates are not
    # independent interpretations.
    grouped=[]
    for p in profiles:
        groups={}
        for c in p['_normal_candidates']:groups.setdefault(c['signature'],[]).append(c)
        grouped.append([groups[k] for k in sorted(groups)])
    domains=[[{e['index']:a for e,a in zip(group[0]['hinges'],group[0]['rotations'])} for group in groups] for groups in grouped]
    supported,components=solve_domains(domains)
    for number,(p,row,groups) in enumerate(zip(profiles,reports,grouped)):
        component=next((c for c in components if number in c['profiles']),None)
        if component:
            row['constraint_resolution']={**component,'profiles':[profiles[i]['name'] for i in component['profiles']]}
            if component['status'] in ('CONFLICT','SEARCH_LIMIT'):
                row.update(status='NEEDS_REVIEW',reason_code='SECTION_CONFLICT' if component['status']=='CONFLICT' else 'SEARCH_LIMIT',
                           reason='Section hypotheses conflict on shared hinges.' if component['status']=='CONFLICT' else 'Section constraint search limit reached; no unique interpretation was established.')
                if component['status']=='CONFLICT':
                    affected=set().union(*(set(c) for i in component['profiles'] for c in domains[i]))
                    for edge in edges:
                        if edge['index'] in affected:edge['evidence_conflict']=True;edge.pop('angle',None)
                p['_normal_candidates']=[]
                continue
        survivors=[c for k in sorted(supported[number]) for c in groups[k]]
        p['_normal_candidates']=survivors
        row['supported_candidate_chains']=len(supported[number])
        if len(supported[number])!=1:continue
        candidates=survivors
        candidate=min(candidates,key=lambda c:(-c['width'],c['error'],c['c'],c['signature']))
        conflicts=[e['index'] for e,a in zip(candidate['hinges'],candidate['rotations']) if 'angle' in e and abs(e['angle']-a)>1]
        if conflicts:
            row.update(status='NEEDS_REVIEW',reason='Profile rotations conflict with another section.',conflicting_hinges=conflicts)
            continue
        p.update(points=candidate['pts'],segments=candidate['segs'],main=candidate['main'],trace=candidate['trace'],
                 cut_direction=candidate['direction'],cut_coordinate=candidate['c'],
                 mapping='unique normal section matched by connected region dimensions and paint marker',
                 section_scope=candidate['scope'])
        for vertex,(e,angle) in enumerate(zip(candidate['hinges'],candidate['rotations']),1):
            e['angle']=angle
            e.setdefault('evidence',[]).append({'profile':p['name'],'vertex':vertex,'angle':angle,
                'handles_before':p['segments'][vertex-1]['handles'],'handles_after':p['segments'][vertex]['handles'],
                'paint_marker':p['paint_handle'],'layer':p.get('layer')})
        row.pop('reason_code',None);row.pop('reason',None)
        row.update(status='PASS',scope=candidate['scope'],max_strip_error_mm=candidate['error'],cut_direction=candidate['direction'].tolist(),cut_coordinate=candidate['c'])
    return reports
