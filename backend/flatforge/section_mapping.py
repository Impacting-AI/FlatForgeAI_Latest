"""Normal-section correspondence for straight hinges at arbitrary plan angles.

Only a unique, dimensionally consistent chain supplies rotations. Projected
views crossing nonparallel hinges are deliberately reported as unresolved:
their apparent turns are not the true bend angles.
"""
import math
import numpy as np
from shapely.geometry import LineString
from . import geometry as g


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


def directions(edges):
    result=[]
    for e in edges:
        u,_,_=g.support(e);v=np.array([-u[1],u[0]])
        if (abs(v[0])<1e-8 and v[1]<0) or v[0]<-1e-8:v=-v
        if not any(abs(g.cross(v,x))<1e-7 for x in result):result.append(v)
    return result


def map_normal_sections(faces,outer,edges,profiles,t,r,bd):
    lookup={frozenset(e['faces']):e for e in edges}
    reports=[]
    for number,p in enumerate(profiles,1):
        p['name']=f'SECTION_{number:02}'
        candidates=[];nearest=None
        for reverse in (False,True):
            pts=p['points'][::-1] if reverse else p['points']
            segs=p['segments'][::-1] if reverse else p['segments']
            main=len(pts)-2-p['main'] if reverse else p['main']
            vectors=np.diff(pts,axis=0);lengths=np.linalg.norm(vectors,axis=1)
            hand=g.cross(g.unit(vectors[main]),p['paint_normal'])
            turns=np.array([math.degrees(math.atan2(g.cross(a,b)*hand,a@b)) for a,b in zip(vectors,vectors[1:])])
            # Only remove measured sub-0.01-degree drafting noise at 90 deg.
            angles=np.where(abs(abs(turns)-90)<.01,np.sign(turns)*90,turns)
            if any(abs(a)<.1 or abs(a)>=179.9 for a in angles):continue
            gain=np.array([(r+t/2)*math.tan(math.radians(abs(a))/2)-g.bend_allowance(t,r,bd,a)/2 for a in angles])
            expected=lengths-np.r_[0,gain]-np.r_[gain,0]
            for direction in directions(edges):
                normal=np.array([-direction[1],direction[0]])
                stations=sorted({round(float(np.array(q)@normal),6) for face in faces for q in face.exterior.coords})
                for low,high in zip(stations,stations[1:]):
                    if high-low<.02:continue
                    # Trace length varies affinely inside a vertex-free lane.
                    c=(low+high)/2;items=trace(faces,outer,direction,c)
                    if len(items)!=len(lengths):continue
                    eps=min(.001,(high-low)/10)
                    ends=[trace(faces,outer,direction,x) for x in (low+eps,high-eps)]
                    ids=[x[2] for x in items]
                    if all([x[2] for x in rows]==ids for rows in ends):
                        start=np.array([b-a for a,b,_ in ends[0]]);end=np.array([b-a for a,b,_ in ends[1]])
                        slope=end-start
                        if slope@slope>1e-12:
                            ratio=minimax_station(start,end,expected)
                            c=low+eps+ratio*(high-low-2*eps);items=trace(faces,outer,direction,c)
                    hinges=[lookup.get(frozenset((a[2],b[2]))) for a,b in zip(items,items[1:])]
                    if any(e is None for e in hinges):continue
                    actual=np.array([b-a for a,b,_ in items]);error=float(max(abs(actual-expected)))
                    normal_cut=all(abs(g.support(e)[0]@direction)<1e-5 for e in hinges)
                    record={'max_strip_error_mm':error,'faces':[i[2] for i in items],
                            'hinges':[e['index'] for e in hinges], 'normal_to_all_hinges':normal_cut,
                            'observed_flat_lengths_mm':actual.tolist(),'required_flat_lengths_mm':expected.tolist(),
                            'profile_lengths_mm':lengths.tolist(),'turn_angles_deg':angles.tolist(),
                            'cut_direction':direction.tolist(),'cut_coordinate':c}
                    record['segment_checks']=[{
                        'segment':i+1,'face':items[i][2],
                        'source_handles':segs[i]['handles'],
                        'observed_flat_mm':float(a),'required_flat_mm':float(b),
                        'residual_mm':float(a-b),'within_tolerance':bool(abs(a-b)<=.5)
                    } for i,(a,b) in enumerate(zip(actual,expected))]
                    if nearest is None or error<nearest['max_strip_error_mm']:nearest=record
                    if not normal_cut or error>.5:continue
                    rotations=[float(a*g.cross(g.support(e)[0],direction)*(1 if e['parent']==left[2] else -1)) for a,e,left in zip(angles,hinges,items)]
                    signature=tuple(sorted((e['index'],round(a,3)) for e,a in zip(hinges,rotations)))
                    candidates.append(dict(signature=signature,width=high-low,c=c,trace=items,direction=direction,pts=pts,segs=segs,main=main,hinges=hinges,rotations=rotations,error=error))
        signatures={c['signature'] for c in candidates}
        row={'profile':p['name'],'section_layer':p.get('layer'),'paint_marker':p['paint_handle'],
             'source_handles':[s['handles'] for s in p['segments']], 'candidate_chains':len(signatures),'nearest_candidate':nearest}
        if len(signatures)!=1:
            if signatures:
                code='AMBIGUOUS_CHAIN'
                reason='More than one distinct hinge chain matches this profile; a section cut marker is required.'
            elif nearest is None:
                code='NO_CHAIN'
                reason='No contiguous face chain matches the profile segment count.'
            elif not nearest['normal_to_all_hinges']:
                code='NON_NORMAL_CHAIN'
                reason='The closest chain crosses nonparallel hinges; its apparent section turns cannot be used as bend rotations.'
            else:
                code='STRIP_LENGTH_MISMATCH'
                reason=f"Closest normal chain exceeds the 0.5 mm strip tolerance (maximum {nearest['max_strip_error_mm']:.3f} mm). Check its segment diagnostics and bend parameters."
            row.update(status='NEEDS_REVIEW',reason_code=code,reason=reason)
            reports.append(row);continue
        candidate=min(candidates,key=lambda c:(-c['width'],c['error'],c['c'],c['signature']))
        conflicts=[e['index'] for e,a in zip(candidate['hinges'],candidate['rotations']) if 'angle' in e and abs(e['angle']-a)>1]
        if conflicts:
            row.update(status='NEEDS_REVIEW',reason='Profile rotations conflict with another section.',conflicting_hinges=conflicts)
            reports.append(row);continue
        p.update(points=candidate['pts'],segments=candidate['segs'],main=candidate['main'],trace=candidate['trace'],
                 cut_direction=candidate['direction'],cut_coordinate=candidate['c'],
                 mapping='unique normal section matched by full chain dimensions and paint marker')
        for vertex,(e,angle) in enumerate(zip(candidate['hinges'],candidate['rotations']),1):
            e['angle']=angle
            e.setdefault('evidence',[]).append({'profile':p['name'],'vertex':vertex,'angle':angle,
                'handles_before':p['segments'][vertex-1]['handles'],'handles_after':p['segments'][vertex]['handles'],
                'paint_marker':p['paint_handle'],'layer':p.get('layer')})
        row.update(status='PASS',max_strip_error_mm=candidate['error'],cut_direction=candidate['direction'].tolist(),cut_coordinate=candidate['c'])
        reports.append(row)
    return reports
