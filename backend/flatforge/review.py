"""Drawing-derived review proposals. Selection is not dimensional validation."""
import hashlib
import json
import numpy as np
from . import geometry as g
from .detail_mapping import local_candidates
from .section_mapping import trace


def bend_key(e):
    return ':'.join(sorted(s['handle'] for s in e['source']))+f':F{e["parent"]}:F{e["child"]}'


def prepare_review(faces,outer,edges,profiles,rows,t,r,bd,choices):
    """Return reproducible proposals and apply only explicit selected IDs.

    Normal candidates can establish a physical cut. Local candidates explicitly
    use edge-profile semantics. Nearest non-normal straight cuts are excluded:
    their apparent angles are not a safe source of actual bend rotations.
    """
    lookup={e['index']:e for e in edges};catalog=[];applied={};errors=[]
    for p,row in zip(profiles,rows):
        candidates=[]
        for c in p.get('_normal_candidates',[]):
            candidates.append(dict(kind='normal_section',chain=[x[2] for x in c['trace']],
                hinges=c['hinges'],angles=c['rotations'],error=c['error'],
                points=c['pts'],segments=c['segs'],main=c['main'],trace=c['trace'],
                direction=c['direction'],coordinate=c['c'],width=c['width']))
        nearest=row.get('nearest_candidate')
        if nearest and nearest['normal_to_all_hinges']:
            reverse=nearest.get('reversed',False)
            points=p['points'][::-1] if reverse else p['points']
            segments=p['segments'][::-1] if reverse else p['segments']
            # Already-mapped profiles may have been reoriented by the normal
            # matcher; only use nearest diagnostics for unresolved profiles.
            if row['status']!='PASS':
                direction=np.array(nearest['cut_direction']);coordinate=nearest['cut_coordinate']
                items=trace(faces,outer,direction,coordinate);hinges=[lookup[i] for i in nearest['hinges']]
                angles=[float(a*np.sign(g.cross(g.support(e)[0],direction))*(1 if e['parent']==left[2] else -1))
                        for a,e,left in zip(nearest['turn_angles_deg'],hinges,items)]
                candidates.append(dict(kind='normal_section',chain=nearest['faces'],hinges=hinges,angles=angles,
                    error=nearest['max_strip_error_mm'],points=points,segments=segments,
                    main=len(points)-2-p['main'] if reverse else p['main'],trace=items,
                    direction=direction,coordinate=coordinate,width=0))
        if row['status']!='PASS':
            for c in local_candidates(p,faces,edges,t,r,bd,tolerance=float('inf')):
                candidates.append(dict(kind='local_edge_profile',chain=c['chain'],hinges=c['hinges'],angles=c['angles'],
                    error=c['error'],points=p['points'],segments=p['segments'],main=p['main'],local=c,width=0))
        unique={}
        for c in candidates:
            identity=[c['kind'],c['chain'],[(bend_key(e),round(a,6)) for e,a in zip(c['hinges'],c['angles'])]]
            key=hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()[:20]
            old=unique.get(key)
            if old is None or (c['error'],-c['width'])<(old['error'],-old['width']):unique[key]=c
        ordered=sorted(unique.items(),key=lambda kv:(kv[1]['error'],kv[0]))
        # Bound browser payload without silently hiding a previously selected ID.
        selected=choices.get(p['name'])
        visible=ordered[:24]
        if selected in unique and selected not in {x[0] for x in visible}:visible.append((selected,unique[selected]))
        public=[]
        for key,c in visible:
            vectors=np.diff(c['points'],axis=0);lengths=np.linalg.norm(vectors,axis=1)
            gains=np.array([(r+t/2)*np.tan(np.radians(abs(a))/2)-g.bend_allowance(t,r,bd,a)/2 for a in c['angles']])
            expected=lengths-np.r_[0,gains]-np.r_[gains,0]
            actual=np.array([b-a for a,b,_ in c['trace']]) if c['kind']=='normal_section' else c['local']['flat_lengths']
            public.append({'id':key,'kind':c['kind'],'faces':c['chain'],'max_strip_error_mm':c['error'],
                'fits_tolerance':c['error']<=.5,'points':c['points'],'direction':c.get('direction'),'coordinate':c.get('coordinate'),
                'folds':[{'key':bend_key(e),'bend_ids':[s['id'] for s in e['source']],
                          'angle':float(a),'vertex':i+1} for i,(e,a) in enumerate(zip(c['hinges'],c['angles']))],
                'segments':[{'segment':i+1,'face':c['chain'][i],'drawing_mm':float(lengths[i]),
                             'flat_mm':float(actual[i]),'required_flat_mm':float(expected[i]),
                             'residual_mm':float(actual[i]-expected[i])} for i in range(len(actual))]})
        catalog.append({'profile':p['name'],'status':row['status'],'reason':row.get('reason'),
                        'points':p['points'],'paint_marker':p['paint_handle'],'selected':selected,
                        'candidate_count':len(ordered),'candidates':public})
        if not selected:continue
        if selected not in unique:
            errors.append(f"{p['name']}: selected chain no longer exists; review the current geometry.");continue
        c=unique[selected]
        conflict=[bend_key(e) for e,a in zip(c['hinges'],c['angles']) if bend_key(e) in applied and abs(applied[bend_key(e)]-a)>1e-5]
        if conflict:
            errors.append(f"{p['name']}: selected profiles assign contradictory rotations to {', '.join(conflict)}");continue
        for i,(e,a) in enumerate(zip(c['hinges'],c['angles'])):
            applied[bend_key(e)]=a;e['angle']=float(a);e['confirmed']=True
            e.setdefault('evidence',[]).append({'profile':p['name'],'vertex':i+1,'angle':float(a),
                'method':'user-selected '+c['kind'],'candidate_id':selected,'paint_marker':p['paint_handle'],
                'handles_before':c['segments'][i]['handles'],'handles_after':c['segments'][i+1]['handles']})
        for field in ('instances','local_chain','trace','cut_direction','cut_coordinate'):p.pop(field,None)
        p.update(points=c['points'],segments=c['segments'],main=c['main'])
        if c['kind']=='normal_section':p.update(trace=c['trace'],cut_direction=c['direction'],cut_coordinate=c['coordinate'])
        else:p['local_chain']=c['local']
        p['review_mapping']=True
        row.update(status='PASS' if c['error']<=.5 else 'NEEDS_REVIEW',method='user_selected_'+c['kind'],
                   max_strip_error_mm=c['error'],reason='User-selected correspondence; geometry checks remain mandatory.')
    for name in set(choices)-{p['name'] for p in profiles}:errors.append(f'Unknown profile: {name}')
    return catalog,errors


def geometry_payload(faces,edges,material):
    return {'faces':[{'id':i,'outer':list(p.exterior.coords),
                     'polygons':[{'outer':list(q.exterior.coords),'holes':[list(h.coords) for h in q.interiors]} for q in g.poly_parts(material[i])]} for i,p in enumerate(faces)],
            'hinges':[{'key':bend_key(e),'bend_ids':[s['id'] for s in e['source']],
                       'parent':e['parent'],'child':e['child'],
                       'axis':g.support(e)[0],
                       'points':[g.support(e)[1]*g.support(e)[2]+g.support(e)[0]*x for x in g.hinge_span(e)]} for e in edges]}
