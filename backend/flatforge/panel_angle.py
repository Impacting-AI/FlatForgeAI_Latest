"""One included-angle input per panel; drawing angles/directions stay authoritative."""
import math


def recover_directions(edges,catalog):
    """Keep a direction only when all eligible full normal-chain candidates agree.

    This can resolve direction while an ambiguous chain leaves magnitude unknown.
    Truncated catalogs, partial hinge coverage and local apparent turns cannot
    establish a direction for the panel-wide magnitude fallback.
    """
    for e in edges:
        if 'angle' in e:continue
        key=':'.join(sorted(x['handle'] for x in e['source']))+f':F{e["parent"]}:F{e["child"]}'
        signs=set();sources=[];ambiguous=False
        for row in catalog:
            candidates=[c for c in row['candidates'] if c['fits_tolerance']]
            touched=any(any(f['key']==key for f in c['folds']) for c in candidates)
            if not touched:continue
            if row['candidate_count']!=len(row['candidates']):ambiguous=True;break
            for c in candidates:
                folds=[f for f in c['folds'] if f['key']==key]
                if c['kind']!='normal_section' or len(folds)!=1:ambiguous=True;break
                a=folds[0]['angle']
                if not math.isfinite(a) or not 0<abs(a)<180:ambiguous=True;break
                signs.add(1 if a>0 else -1)
                sources.append({'profile':row['profile'],'candidate':c['id'],'vertex':folds[0]['vertex']})
            if ambiguous:break
        if not ambiguous and len(signs)==1:
            e['direction_sign']=signs.pop();e['direction_evidence']=sources


def apply_panel_angle(edges,value):
    if value is None:return []
    value=float(value)
    if not math.isfinite(value) or not 0<value<180:
        raise ValueError('Panel bend angle must be between 0 and 180 degrees (included angle).')
    blocked=[]
    for e in edges:
        if 'angle' in e:continue
        # A fallback magnitude is not permission to resolve contradictory sources.
        if any(a.get('status')=='CONFLICT' for a in e.get('drawing_dimensions',[])):
            blocked.append(e);continue
        # Only an independently established direction can orient a missing
        # magnitude. Never copy a neighbour's sign or assume all axes point up.
        direction=e.get('direction_sign')
        evidence=e.get('direction_evidence')
        if direction not in (-1,1) or not evidence:
            blocked.append(e);continue
        angle=float(direction)*(180-value)
        e['angle']=angle;e['confirmed']=True
        e['evidence']=[{'profile':'PANEL ANGLE','vertex':None,'angle':angle,
                        'included_angle':value,'direction_source':evidence}]
    return blocked


def panel_angle_summary(bends,manual):
    angles=[]
    for b in bends:
        # Saved legacy per-hinge corrections must not be labelled as detected.
        if any(v.get('profile') in ('USER CONFIRMED','PANEL ANGLE') for v in b.get('source',[])):continue
        if b.get('angle') is not None:angles.append(round(180-abs(b['angle']),6))
    values=sorted(set(angles));missing=sum(b.get('angle') is None for b in bends)
    return {'value':values[0] if len(values)==1 else None,'values':values,
            'status':'MULTIPLE' if len(values)>1 else 'DETECTED' if values else 'MISSING',
            'manual_value':manual,'unresolved':missing,'convention':'included',
            'message':'Drawing angles take priority. The panel value fills only missing magnitudes with established fold directions.'}
