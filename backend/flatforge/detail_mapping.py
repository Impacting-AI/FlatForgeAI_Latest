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
from .evidence_constraints import propagate_source_axes, solve_domains


def profile_values(p,t,r,bd):
    vectors=np.diff(p['points'],axis=0)
    angles=g.profile_turns(p)
    gains=np.array([(r+t/2)*math.tan(math.radians(abs(a))/2)-g.bend_allowance(t,r,bd,a)/2 for a in angles])
    return angles,np.linalg.norm(vectors,axis=1)-np.r_[0,gains]-np.r_[gains,0]


def commit(p,hinges,angles,method):
    if len(hinges)!=len(angles) or any(e.get('evidence_conflict') or ('angle' in e and abs(e['angle']-a)>1e-5) for e,a in zip(hinges,angles)):
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


def local_candidates(p,faces,edges,t,r,bd,tolerance=.5):
    lookup={frozenset(e['faces']):e for e in edges};adj={i:[] for i in range(len(faces))}
    for e in edges:
        a,b=e['faces'];adj[a].append(b);adj[b].append(a)
    main=p['main'];count=len(p['segments'])
    if count<2 or not 0<=main<count:return []
    turns,expected=profile_values(p,t,r,bd);found=[]
    # A painted local detail may describe a return on any parent face. Search
    # all roots; independent evidence below decides correspondence, not area.
    for root in sorted(adj):
        for left in root_paths(adj,root,main):
            for right in root_paths(adj,root,count-main-1):
                if set(left[1:])&set(right[1:]):continue
                chain=left[::-1]+right[1:]
                hinges=[lookup[frozenset((a,b))] for a,b in zip(chain,chain[1:])]
                interior_main=0<main<count-1
                # Complete parallel chains belong to the normal cut matcher.
                if interior_main and abs(g.cross(g.support(hinges[main-1])[0],g.support(hinges[main])[0]))<1e-5:continue
                actual=[];valid=True
                for i,f in enumerate(chain):
                    if i==main and interior_main:actual.append(None);continue
                    if i in (0,count-1):
                        e=hinges[0 if i==0 else -1];_,n,c=g.support(e)
                        actual.append(float(max(abs(np.array(q)@n-c) for q in faces[f].exterior.coords)))
                    else:
                        a,b=hinges[i-1:i+1];ua,na,ca=g.support(a);ub,nb,cb=g.support(b)
                        if abs(g.cross(ua,ub))>1e-5:valid=False;break
                        actual.append(float(abs((nb*cb)@na-ca)))
                if not valid:continue
                boundaries=boundary_lengths(faces[root],hinges[main-1],hinges[main]) if interior_main else [(0,None)]
                for length,segment in boundaries:
                    lengths=np.array([length if x is None else x for x in actual]);error=float(max(abs(lengths-expected)))
                    if error>tolerance:continue
                    rotations=[]
                    for e,a,f0,f1 in zip(hinges,turns,chain,chain[1:]):
                        u,n,c=g.support(e)
                        travel=np.array(faces[f1].representative_point().coords[0])-np.array(faces[f0].representative_point().coords[0])
                        direction=n*np.sign(travel@n)
                        rotations.append(float(a*np.sign(g.cross(u,direction))*(1 if e['parent']==f0 else -1)))
                    found.append({'chain':chain,'hinges':hinges,'angles':rotations,'flat_lengths':lengths,
                                  'expected':expected,'error':error,'boundary':segment,'root_face':root,
                                  'scope':'local_edge_profile' if interior_main else 'terminal_return_detail',
                                  'signature':tuple(sorted((e['index'],round(a,6)) for e,a in zip(hinges,rotations)))})
    return found


def local_angle_budgets(profile, candidate):
    """Per-hinge uncertainty from the two adjoining source wall segments.

    The existing wall resolution bounds corroboration, never the strip fit or
    a default rotation. A short return cannot relax a distant long-wall bend.
    """
    from .wall_pairing import WALL_SPACING_TOL_MM
    lengths=np.linalg.norm(np.diff(profile['points'],axis=0),axis=1)
    budgets=[min(1.,math.degrees(math.atan2(WALL_SPACING_TOL_MM,a)+
                               math.atan2(WALL_SPACING_TOL_MM,b)))
             for a,b in zip(lengths,lengths[1:])]
    for i in range(len(budgets)):
        handles=sorted(h for segment in profile.get('segments',[])[i:i+2] for h in segment.get('handles',[]))
        if any(a.get('status')=='MATCHED' and a.get('wall_handles')==handles for a in profile.get('angle_dimensions',[])):
            # An associated numeric dimension is authoritative evidence, not
            # wall-spacing noise that can be reconciled away.
            budgets[i]=min(budgets[i],1e-5)
    return {e['index']:value for e,value in zip(candidate['hinges'],budgets)}


def local_angle_budget(profile, candidate):
    return max(local_angle_budgets(profile,candidate).values(),default=0.)


def reconcile_local_candidates(entries):
    """Resolve only the hinge set and rotations agreed by every surviving choice.

    A second independent paint marker must establish the same complete hinge
    group. No residual-based choice between different hinge groups is allowed.
    """
    resolved=[]
    def values(c):return {e['index']:a for e,a in zip(c['hinges'],c['angles'])}
    def compatible(p,c,q,d):
        a,b=values(c),values(d)
        if a.keys()!=b.keys():return False
        pa,pb=local_angle_budgets(p,c),local_angle_budgets(q,d)
        return all(a[k]*b[k]>0 and abs(a[k]-b[k])<=pa[k]+pb[k] for k in a)
    for p,row,candidates in entries:
        supported=[]
        for c in candidates:
            peers=[(q,d) for q,_,choices in entries if q['paint_handle']!=p['paint_handle']
                   for d in choices if compatible(p,c,q,d)]
            if peers:supported.append((c,peers))
        if not supported:continue
        sets={tuple(sorted(values(c))) for c,_ in supported}
        if len(sets)!=1:continue
        # Independent peers must support all surviving variants, not merely
        # a selected low-residual hypothesis.
        pool=[(p,c) for c,_ in supported]+[(q,d) for _,peers in supported for q,d in peers]
        if not all(compatible(q,c,z,d) for q,c in pool for z,d in pool):continue
        # Preserve an actual measured profile; do not average or round angles.
        # Better-defined wall geometry has priority over strip residuals.
        def quality(item):
            q,c=item
            return (max(s.get('parallel_error_deg',0.) for s in q['segments']),
                    local_angle_budget(q,c),c['error'],q['paint_handle'],c['signature'])
        authority,chosen=min(pool,key=quality);angles=values(chosen)
        candidate=min((c for c,_ in supported),key=lambda c:(c['error'],c['signature']))
        adjusted=dict(candidate,angles=[angles[e['index']] for e in candidate['hinges']])
        evidence={'authority_profile':authority['name'],'authority_paint_marker':authority['paint_handle'],
                  'max_adjustment_deg':max(abs(a-b) for a,b in zip(candidate['angles'],adjusted['angles'])),
                  'original_angles_deg':list(candidate['angles']),
                  'agreement_budgets_by_hinge_deg':{k:local_angle_budgets(p,candidate)[k]+local_angle_budgets(authority,chosen)[k] for k in angles},
                  'agreement_budget_deg':local_angle_budget(p,candidate)+local_angle_budget(authority,chosen),
                  'candidate_count':len(supported),
                  'corroborating_profiles':sorted({q['name'] for _,peers in supported for q,_ in peers})}
        resolved.append((p,row,adjusted,evidence))
    return resolved

def anchored_local_candidate(profile,candidates):
    """A unique complete local chain can be oriented by an independent hinge.

    The anchor establishes consistency with an already mapped normal section;
    every other rotation still comes from this profile's measured turns. User
    overrides and this profile's own evidence cannot bootstrap an anchor.
    """
    candidates=[c for c in candidates if not any(e.get('evidence_conflict') or
                ('angle' in e and abs(e['angle']-a)>1e-5) for e,a in zip(c['hinges'],c['angles']))]
    if len({c['signature'] for c in candidates})!=1:return None
    if not candidates:return None
    c=min(candidates,key=lambda c:(c['error'],c['chain'],str(c['boundary'])))
    anchors=[]
    for e,a in zip(c['hinges'],c['angles']):
        if e.get('evidence_conflict'):return None
        if 'angle' not in e:continue
        if abs(e['angle']-a)>1e-5:return None
        sources=[ev for ev in e.get('evidence',[]) if ev.get('paint_marker')
                 and ev['paint_marker']!=profile['paint_handle']
                 and ev.get('profile') not in ('USER CONFIRMED','USER DIRECTION','PANEL ANGLE')]
        if sources:anchors.append({'hinge':e['index'],'angle':e['angle'],'sources':sources.copy()})
    return (c,anchors) if anchors else None

def constrain_local_candidates(entries, edges):
    """Whole-drawing consistency before a local hypothesis can be committed.

    Domains retain every dimensionally fitting interpretation. Independent
    already-mapped rotations are fixed anchors; local uncertainty is attached
    to its source vertex. No result is selected using a residual or a solid.
    """
    groups=[];domains=[];budgets=[]
    for p,row,choices in entries:
        grouped={}
        for c in choices:grouped.setdefault(c['signature'],[]).append(c)
        groups.append([grouped[k] for k in sorted(grouped)])
        domains.append([{e['index']:a for e,a in zip(group[0]['hinges'],group[0]['angles'])} for group in groups[-1]])
        budgets.append([local_angle_budgets(p,group[0]) for group in groups[-1]])
    fixed={e['index']:e['angle'] for e in edges if 'angle' in e and not e.get('evidence_conflict')}
    domains.extend([[{h:a}] for h,a in sorted(fixed.items())]);budgets.extend([[{}] for _ in fixed])
    supported,components=solve_domains(domains,angle_budgets=budgets)
    result=[]
    names=[p['name'] for p,_,_ in entries]+[f'independent hinge {h}' for h in sorted(fixed)]
    for i,(p,row,choices) in enumerate(entries):
        component=next((c for c in components if i in c['profiles']),None)
        if component:
            coverage=set().union(*(set(c) for k in component['profiles'] for c in domains[k]))
            row['local_constraint_resolution']={**component,'profiles':[names[k] for k in component['profiles']],
                'fixed_hinge_angles_deg':{h:a for h,a in fixed.items() if h in coverage},
                'angular_budgets_deg':budgets[i]}
        if component and component['status'] in ('CONFLICT','SEARCH_LIMIT'):
            row.update(status='NEEDS_REVIEW',reason_code='LOCAL_SECTION_CONFLICT' if component['status']=='CONFLICT' else 'SEARCH_LIMIT',
                       reason='Local section candidates contradict shared-hinge evidence.' if component['status']=='CONFLICT' else 'Local section constraint search is incomplete; uniqueness is not established.')
            p['_local_candidates']=choices
            continue
        survivors=[c for k in sorted(supported[i]) for c in groups[i][k]]
        p['_local_candidates']=survivors
        row['supported_local_candidate_chains']=len(supported[i])
        result.append((p,row,survivors))
    return result


def map_details(faces,outer,edges,profiles,t,r,bd,tolerance=.5):
    reports=map_normal_sections(faces,outer,edges,profiles,t,r,bd,tolerance)
    pending=[]
    for p,row in zip(profiles,reports):
        if row['status']=='PASS' or row.get('reason_code') in ('SECTION_CONFLICT','SEARCH_LIMIT','ANGLE_EVIDENCE_CONFLICT'):continue
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
        candidates=local_candidates(p,faces,edges,t,r,bd,tolerance)
        p['_local_candidates']=candidates
        if candidates:pending.append((p,row,candidates))
    pending=constrain_local_candidates(pending,edges)
    # Prefer complete corroboration by independent opposite-side profiles.
    # A unique independently anchored chain is considered separately below.
    for p,row,c,reconciliation in reconcile_local_candidates(pending):
        if not commit(p,c['hinges'],c['angles'],'corroborated local edge profile'):continue
        p['local_chain']=c
        p['angle_reconciliation']=reconciliation
        for edge in c['hinges']:
            edge['evidence'][-1]['reconciliation']=reconciliation
        row.update(status='PASS',method='corroborated_local_edge_profile',reason='Independent painted profiles agree within section-derived angular uncertainty.',
                   matched_faces=c['chain'],max_strip_error_mm=c['error'],**reconciliation)
        row.pop('reason_code',None)
    # Process against a snapshot of pre-existing evidence: one newly accepted
    # local profile must not cascade into a chain of self-justifying anchors.
    prior_conflicts=propagate_source_axes(faces,edges)
    anchored=[]
    for p,row,candidates in pending:
        if 'local_chain' in p:continue
        match=anchored_local_candidate(p,candidates)
        if match:anchored.append((p,row,*match))
    for p,row,c,anchors in anchored:
        if not commit(p,c['hinges'],c['angles'],'unique local edge profile with independent hinge anchor'):continue
        p['local_chain']=c;p['anchor_evidence']=anchors
        for edge in c['hinges']:edge['evidence'][-1]['anchor_evidence']=anchors
        row.update(status='PASS',method='anchored_local_edge_profile',
                   reason='Unique strip chain agrees with an independently mapped hinge; remaining signed turns are measured from this painted profile.',
                   matched_faces=c['chain'],max_strip_error_mm=c['error'],anchor_evidence=anchors)
        row.pop('reason_code',None)
    conflicts=prior_conflicts+propagate_source_axes(faces,edges)
    if conflicts:
        for profile,row in zip(profiles,reports):
            names={profile['name']}|{p['name'] for p in profile.get('instances',[])}
            affected={e['index'] for e in edges if any(v.get('profile') in names for v in e.get('evidence',[]))}
            relevant=[conflict for conflict in conflicts if affected.intersection(conflict.get('hinges',[]))]
            if relevant:
                row.update(status='NEEDS_REVIEW',reason_code='SOURCE_AXIS_CONFLICT',
                           reason='Sections disagree on a continuous source bend axis.',source_axis_conflicts=relevant)
    from .section_diagnostics import explain_mapping
    for profile,row in zip(profiles,reports):
        explain_mapping(profile,row,profile.get('_local_candidates',[]))
    return reports


def normal_instances(profiles):
    return [q for p in profiles if 'local_chain' not in p for q in p.get('instances',[p])]


def check_local_profiles(profiles,edges,tf,t,r,bd,tolerance=.5):
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
        rows.append({'profile':p['name'],'validation_scope':'local_edge_profile','chain_status':'PASS' if error<=tolerance and max(errors)<=1 else 'FAIL',
                     'full_plane_status':'NOT_APPLICABLE','max_length_error_mm':error,'max_turn_error_deg':max(errors),
                     'source_boundary':c['boundary'],'faces':c['chain'],
                     'method':'Local edge dimensions and fold-tree relative rotations; not a full BREP plane section'})
    return rows
