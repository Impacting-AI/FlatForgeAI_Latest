"""Confirmed client material defaults and direction review; no drawing identities."""
import math
import numpy as np
DEFAULTS={'thickness':2.,'radius':.7366,'deduction':4.,'input_type':'flat_pattern'}

def direction_factor(edge,faces):
    from . import geometry as g
    u,n,c=g.support(edge)
    side=np.sign(np.asarray(faces[edge['child']].representative_point().coords[0])@n-c)
    value=float(g.cross(u,n*side))
    if not math.isclose(abs(value),1.,abs_tol=1e-8):raise ValueError('Cannot establish the child side of this hinge.')
    return 1. if value>0 else -1.

def apply_directions(edges,faces,choices):
    for e in edges:
        key=':'.join(sorted(l['handle'] for l in e['source']))+f':F{e["parent"]}:F{e["child"]}'
        choice=choices.get(key)
        if choice is None:continue
        if choice not in ('up','down'):raise ValueError('Direction must be up or down.')
        sign=(1 if choice=='up' else -1)*direction_factor(e,faces)
        if abs(sign)!=1:raise ValueError('Cannot establish the child side of this hinge.')
        e['direction_sign']=sign
        e['direction_evidence']=[{'profile':'USER DIRECTION','direction':choice}]
        if 'angle' in e:
            if any(v.get('profile') not in ('PANEL ANGLE','USER DIRECTION','USER CONFIRMED') for v in e.get('evidence',[])):
                e.setdefault('source_angle',e['angle'])
            e['angle']=sign*abs(e['angle']);e['confirmed']=True
            e['evidence']=[v for v in e.get('evidence',[]) if v.get('profile')!='USER DIRECTION']
            e['evidence'].append({'profile':'USER DIRECTION','direction':choice,'angle':e['angle']})

def parameter_check(t,r,bd,angle):
    from .geometry import bend_allowance
    ba=bend_allowance(t,r,bd,angle);theta=math.radians(abs(angle));k=(ba/theta-r)/t
    return {'rotation_deg':angle,'included_angle_deg':180-abs(angle),'allowance_mm':ba,
            'deduction_mm':bd,'inside_radius_mm':r,'thickness_mm':t,'k_factor':k,
            'constructible':ba>0 and math.isfinite(ba),
            'valid':ba>0 and 0<=k<=1,
            'deduction_range_mm':[2*(r+t)*math.tan(theta/2)-theta*(r+t),2*(r+t)*math.tan(theta/2)-theta*r]}
