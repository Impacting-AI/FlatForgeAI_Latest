"""Detect conflicting flange-continuation interpretations; never infer intent.

Two flange axes meeting a plate hinge in the developed contour can imply a
continuation plane. A different section-derived angle is a review conflict,
not permission to replace the section angle automatically.
"""
import math
import numpy as np
from . import geometry as g
from .review import bend_key


def continuation_candidates(faces,edges,order,t,r,bd):
    if any('angle' not in e for e in edges):return []
    tf=g.transforms(faces,edges,order,t,r,bd)
    result={}
    for seam in edges:
        u,n,c=g.support(seam);lo,hi=g.hinge_span(seam)
        for adjacent in edges:
            if adjacent is seam or adjacent['parent']!=seam['parent']:continue
            ua,na,ca=g.support(adjacent)
            if abs(g.cross(u,ua))<1e-5:continue
            junction=np.linalg.solve(np.array([n,na]),np.array([c,ca]))
            la,ha=g.hinge_span(adjacent)
            if min(abs(junction@u-lo),abs(junction@u-hi))>3:continue
            if min(abs(junction@ua-la),abs(junction@ua-ha))>3:continue
            for target in edges:
                if target['parent']!=seam['child']:continue
                ut,nt,ct=g.support(target);lt,ht=g.hinge_span(target)
                if abs(junction@nt-ct)>3 or min(abs(junction@ut-lt),abs(junction@ut-ht))>3:continue
                frame=tf[target['parent']][0];axis=frame@g.lift(ut)
                normal=frame[:,2];desired=tf[adjacent['child']][0][:,2]
                if abs(axis@desired)>1e-6:continue
                angle=math.degrees(math.atan2(axis@np.cross(normal,desired),normal@desired))
                if not 0<abs(angle)<180 or abs(angle-target['angle'])<=1:continue
                key=(target['index'],adjacent['index'],seam['index'])
                result[key]={'key':bend_key(target),'bend_ids':[s['id'] for s in target['source']],
                    'parent':target['parent'],'child':target['child'],'section_rotation_deg':target['angle'],
                    'candidate_rotation_deg':angle,'candidate_included_angle_deg':180-abs(angle),
                    'adjacent_face':adjacent['child'],'plate_hinge':[s['id'] for s in seam['source']],
                    'junction_flat_mm':junction.tolist(),
                    'requires_confirmation':not any(ev.get('profile')=='USER CONFIRMED' for ev in target.get('evidence',[])),
                    'reason':'Section rotation conflicts with a possible continuation of the adjoining flange. The drawing does not establish whether these faces must continue in the same plane. The measured drawing rotation is retained; change it only if the intended corner requires this alternative.'}
    return [result[k] for k in sorted(result)]
