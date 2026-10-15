"""Recognise redundant unmarked details without inventing a paint direction."""
import numpy as np
from shapely.geometry import LineString, Polygon


def remove_unmarked_duplicates(profiles, markers, thickness, precision=.002):
    def marked(p):
        return bool(markers) and min(LineString(p['points']).distance(Polygon(tri))
                                    for _,tri in markers)<=max(10.,5*thickness)
    marked_profiles=[p for p in profiles if marked(p)]
    kept=[];duplicates=[]
    for p in profiles:
        if marked(p):kept.append(p);continue
        a=p['points'];matches=[]
        for donor in marked_profiles:
            points=donor['points']
            for first in range(len(points)-len(a)+1):
                for reverse in (False,True):
                    b=points[first:first+len(a)]
                    if reverse:b=b[::-1]
                    aa=a-a.mean(axis=0);bb=b-b.mean(axis=0)
                    u,_,v=np.linalg.svd(aa.T@bb)
                    # Rotation and translation only: never silently reflect a
                    # section or infer a painted side from an unmarked copy.
                    rotation=u@np.diag([1.,np.linalg.det(u@v)])@v
                    error=float(np.max(np.linalg.norm(aa@rotation-bb,axis=1)))
                    if error<=precision:
                        matches.append({'marked_wall_handles':[s['handles'] for s in donor['segments']],
                                        'first_segment':first,'reversed':reverse,'max_vertex_error_mm':error})
        if matches:
            duplicates.append({'wall_handles':[s['handles'] for s in p['segments']],
                               'reason':'Unmarked rigid copy of a contiguous part of a marked section; no independent bend direction inferred.',
                               'matches':matches})
        else:kept.append(p)
    return kept,duplicates
