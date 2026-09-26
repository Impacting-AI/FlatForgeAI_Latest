"""Drawing-derived repeated transverse details and corroborated edge profiles.

Convention confirmed against the customer-approved folded model: a transverse
detail shared by continuous flank axes describes each intervening plate row;
opposite side drawings describe local edge lengths at nonparallel hinges.
No filenames, coordinates, source handles or fixed face IDs encode a panel.
Unmatched dimensions and conflicting rotations remain review conditions.
"""
import copy
import math
import numpy as np
from . import geometry as g
from .section_mapping import map_normal_sections


def profile_values(p,t,r,bd):
    vectors=np.diff(p['points'],axis=0)
    hand=g.cross(g.unit(vectors[p['main']]),p['paint_normal'])
    angles=np.array([math.degrees(math.atan2(g.cross(a,b)*hand,a@b)) for a,b in zip(vectors,vectors[1:])])
    gains=np.array([(r+t/2)*math.tan(math.radians(abs(a))/2)-g.bend_allowance(t,r,bd,a)/2 for a in angles])
    return angles,np.linalg.norm(vectors,axis=1)-np.r_[0,gains]-np.r_[gains,0]


def commit(p,hinges,angles,method):
    if any('angle' in e and abs(e['angle']-a)>1e-5 for e,a in zip(hinges,angles)):
        return False
    for i,(e,a) in enumerate(zip(hinges,angles)):
        e['angle']=float(a)
        e.setdefault('evidence',[]).append({'profile':p['name'],'vertex':i+1,'angle':float(a),
            'handles_before':p['segments'][i]['handles'],'handles_after':p['segments'][i+1]['handles'],
            'paint_marker':p['paint_handle'],'layer':p.get('layer'),'method':method})
    return True


def repeated_candidates(p,edges):
    grouped={}
    for c in p.get('_normal_candidates',[]):
        old=grouped.get(c['signature'])
        if old is None or (-c['width'],c['error'],c['c'])<(-old['width'],old['error'],old['c']):grouped[c['signature']]=c
    choices=list(grouped.values())
    if len(choices)<2:return []
    keys=[];mainfaces=set();used=set()
    for c in choices:
        main=c['main']
        if not 0<main<len(c['trace'])-1:return []
        # Same continuous original axes delimit the repeated main segments.
        keys.append(tuple(tuple(sorted(s['handle'] for s in c['hinges'][i]['source'])) for i in (main-1,main)))
        ids={e['index'] for e in c['hinges']}
        if used&ids:return []
        used|=ids;mainfaces.add(c['trace'][main][2])
    if len(set(keys))!=1 or len(mainfaces)!=len(choices):return []
    reached={min(mainfaces)}
    for _ in mainfaces:
        for e in edges:
            if set(e['faces'])<=mainfaces and reached.intersection(e['faces']):reached.update(e['faces'])
    return sorted(choices,key=lambda c:c['trace'][c['main']][2]) if reached==mainfaces else []


def root_paths(adj,root,depth):
    paths=[[root]]
    for _ in range(depth):
        paths=[p+[n] for p in paths for n in adj[p[-1]] if n not in p]
        if len(paths)>10000:raise ValueError('Local profile path search exceeds 10,000 candidates')
    return [p for p in paths if depth==0 or len(adj[p[-1]])==1]


def boundary_lengths(face,a,b):
    """Unfolded boundary segments directly connecting two hinge supports."""
    options=[]
    _,na,ca=g.support(a);_,nb,cb=g.support(b)
    coords=list(face.simplify(.002,preserve_topology=True).exterior.coords)
    for p,q in zip(coords,coords[1:]):
        p,q=np.array(p),np.array(q)
        if (abs(p@na-ca)<.01 and abs(q@nb-cb)<.01) or (abs(q@na-ca)<.01 and abs(p@nb-cb)<.01):
            options.append((float(np.linalg.norm(q-p)),[p.tolist(),q.tolist()]))
    return options


def local_candidates(p,faces,edges,t,r,bd):
    lookup={frozenset(e['faces']):e for e in edges};adj={i:[] for i in range(len(faces))}
    for e in edges:
        a,b=e['faces'];adj[a].append(b);adj[b].append(a)
    # Base is the root selected by the geometry/paint convention, not a named ID.
    root=next(i for i in adj if not any(e['child']==i for e in edges))
    main=p['main'];count=len(p['segments'])
    if not 0<main<count-1:return []
    turns,expected=profile_values(p,t,r,bd);found=[]
    for left in root_paths(adj,root,main):
        for right in root_paths(adj,root,count-main-1):
            if set(left[1:])&set(right[1:]):continue
            chain=left[::-1]+right[1:]
            hinges=[lookup[frozenset((a,b))] for a,b in zip(chain,chain[1:])]
            # Parallel chains already have a true normal-section interpretation.
            if abs(g.cross(g.support(hinges[main-1])[0],g.support(hinges[main])[0]))<1e-5:continue
            actual=[];valid=True
            for i,f in enumerate(chain):
                if i==main:actual.append(None);continue
                if i in (0,count-1):
                    e=hinges[0 if i==0 else -1];_,n,c=g.support(e)
                    actual.append(float(max(abs(np.array(q)@n-c) for q in faces[f].exterior.coords)))
                else:
                    a,b=hinges[i-1:i+1];ua,na,ca=g.support(a);ub,nb,cb=g.support(b)
                    if abs(g.cross(ua,ub))>1e-5:valid=False;break
                    actual.append(float(abs((nb*cb)@na-ca)))
            if not valid:continue
            for length,segment in boundary_lengths(faces[root],hinges[main-1],hinges[main]):
                lengths=np.array([length if x is None else x for x in actual]);error=float(max(abs(lengths-expected)))
                if error>.5:continue
                rotations=[]
                for e,a,f0,f1 in zip(hinges,turns,chain,chain[1:]):
                    u,n,c=g.support(e)
                    travel=np.array(faces[f1].representative_point().coords[0])-np.array(faces[f0].representative_point().coords[0])
                    direction=n*np.sign(travel@n)
                    rotations.append(float(a*np.sign(g.cross(u,direction))*(1 if e['parent']==f0 else -1)))
                found.append({'chain':chain,'hinges':hinges,'angles':rotations,'flat_lengths':lengths,
                              'expected':expected,'error':error,'boundary':segment,
                              'signature':tuple(sorted((e['index'],round(a,6)) for e,a in zip(hinges,rotations)))})
    return found


def map_details(faces,outer,edges,profiles,t,r,bd):
    reports=map_normal_sections(faces,outer,edges,profiles,t,r,bd)
    pending=[]
    for p,row in zip(profiles,reports):
        if row['status']=='PASS':continue
        repeated=repeated_candidates(p,edges)
        if repeated:
            instances=[]
            for c in repeated:
                instance={k:copy.deepcopy(v) for k,v in p.items() if not k.startswith('_')}
                instance.update(points=c['pts'],segments=c['segs'],main=c['main'],trace=c['trace'],
                    cut_direction=c['direction'],cut_coordinate=c['c'],
                    name=p['name']+'_F'+str(c['trace'][c['main']][2]),mapping='repeated transverse detail')
                instances.append((instance,c))
            if all(not any('angle' in e and abs(e['angle']-a)>1e-5 for e,a in zip(c['hinges'],c['rotations'])) for _,c in instances):
                for instance,c in instances:commit(instance,c['hinges'],c['rotations'],'continuous flank axes / repeated plate rows')
                p['instances']=[x for x,_ in instances]
                row.update(status='PASS',method='repeated_transverse_detail',reason='Continuous flank axes and matching strip chains establish repeated plate rows.',
                           matched_faces=[c['trace'][c['main']][2] for c in repeated],max_strip_error_mm=max(c['error'] for c in repeated))
                row.pop('reason_code',None)
                continue
        candidates=local_candidates(p,faces,edges,t,r,bd)
        signatures={c['signature'] for c in candidates}
        if len(signatures)==1:
            candidate=min(candidates,key=lambda c:(c['error'],c['chain'],c['boundary']))
            pending.append((p,row,candidate))
    # A second independently painted opposite-side drawing must corroborate
    # every local rotation. One apparent view never supplies an unverified sign.
    for p,row,c in pending:
        peers=[other for other in pending if other[0]['paint_handle']!=p['paint_handle'] and other[2]['signature']==c['signature']]
        if not peers:continue
        if not commit(p,c['hinges'],c['angles'],'corroborated local edge profile'):continue
        p['local_chain']=c
        row.update(status='PASS',method='corroborated_local_edge_profile',reason='Opposite painted profiles agree on the same hinge chain and rotations.',
                   matched_faces=c['chain'],max_strip_error_mm=c['error'],corroborating_profiles=[x[0]['name'] for x in peers])
        row.pop('reason_code',None)
    return reports


def normal_instances(profiles):
    return [q for p in profiles if 'local_chain' not in p for q in p.get('instances',[p])]


def check_local_profiles(profiles,edges,tf,t,r,bd):
    """Check signed relative rotations and local edge lengths, not plane cuts.

    Normal BREP cuts and actual fused-solid unfolding run independently. These
    checks explicitly retain their local-detail scope in the validation report.
    """
    rows=[]
    for p in profiles:
        if 'local_chain' not in p:continue
        c=p['local_chain'];errors=[]
        for e,a in zip(c['hinges'],c['angles']):
            observed=tf[e['parent']][0].T@tf[e['child']][0]
            target=g.rotation(g.lift(g.support(e)[0]),math.radians(a))
            errors.append(math.degrees(math.acos(float(np.clip((np.trace(target.T@observed)-1)/2,-1,1)))))
        angles,_=profile_values(p,t,r,bd)
        gains=np.array([(r+t/2)*math.tan(math.radians(abs(a))/2)-g.bend_allowance(t,r,bd,a)/2 for a in angles])
        actual=c['flat_lengths']+np.r_[0,gains]+np.r_[gains,0]
        error=float(max(abs(actual-np.linalg.norm(np.diff(p['points'],axis=0),axis=1))))
        rows.append({'profile':p['name'],'validation_scope':'local_edge_profile','chain_status':'PASS' if error<=.5 and max(errors)<=1 else 'FAIL',
                     'full_plane_status':'NOT_APPLICABLE','max_length_error_mm':error,'max_turn_error_deg':max(errors),
                     'source_boundary':c['boundary'],'faces':c['chain'],
                     'method':'Local edge dimensions and fold-tree relative rotations; not a full BREP plane section'})
    return rows
