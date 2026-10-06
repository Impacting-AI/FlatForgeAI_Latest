"""Rigid-motion invariant comparison of nearly parallel section walls."""
import math
import numpy as np

PARALLEL_SINE_TOL = 1e-4
WALL_SPACING_TOL_MM = .05


def parallel_pair(left,right,thickness=None):
    """Return a shared local frame only when spacing fits across the overlap.

    Offsets from different normals are not comparable. Measure each support on
    the same normal at both ends of its overlap instead. No origin-dependent
    intercept subtraction and no increased drafting tolerance are involved.
    """
    ua=left['u'];ub=right['u']
    sine=abs(float(ua[0]*ub[1]-ua[1]*ub[0]))
    if sine>PARALLEL_SINE_TOL:return None
    if ua@ub<0:ub=-ub
    u=ua+ub;u=u/np.linalg.norm(u);n=np.array([-u[1],u[0]])
    origin=(left['a']+left['b']+right['a']+right['b'])/4
    rows=[]
    for wall in (left,right):
        ends=sorted((wall['a'],wall['b']),key=lambda p:float((p-origin)@u))
        rows.append(dict(wall,lo=float((ends[0]-origin)@u),hi=float((ends[1]-origin)@u),endpoints=ends))
    lo=max(row['lo'] for row in rows);hi=min(row['hi'] for row in rows)
    if hi<=lo:return None
    def offset(wall,station):
        return float(((wall['a']-origin)@wall['normal']-station*(u@wall['normal']))/(n@wall['normal']))
    spacing=[offset(right,s)-offset(left,s) for s in (lo,hi)]
    if thickness is None:thickness=sum(abs(d) for d in spacing)/2
    if spacing[0]*spacing[1]<=0 or any(abs(abs(d)-thickness)>WALL_SPACING_TOL_MM for d in spacing):return None
    mid=(lo+hi)/2
    center=(offset(left,mid)+offset(right,mid))/2
    anchor=origin+u*mid+n*center
    a=anchor+u*((rows[0]['lo']+rows[1]['lo'])/2-mid)
    b=anchor+u*((rows[0]['hi']+rows[1]['hi'])/2-mid)
    return {'rows':rows,'a':a,'b':b,'u':u,'normal':n,'c':float(anchor@n),
            'wall_spacing_mm':abs(offset(right,mid)-offset(left,mid)),
            'spacing_range_mm':sorted(abs(d) for d in spacing),'parallel_error_deg':math.degrees(math.asin(sine))}


def ends_supported(pair,walls,thickness):
    """Validate end correspondence, including wide-angle miter offsets."""
    left,right=pair['rows']
    def cross(a,b):return float(a[0]*b[1]-a[1]*b[0])
    for position,end in enumerate(('lo','hi')):
        if abs(left[end]-right[end])<=thickness+WALL_SPACING_TOL_MM:continue
        a=left['endpoints'][position];b=right['endpoints'][position]
        adjacent_left=[v for v in walls if abs(cross(left['u'],v['u']))>PARALLEL_SINE_TOL and min(np.linalg.norm(a-v[q]) for q in ('a','b'))<=WALL_SPACING_TOL_MM]
        adjacent_right=[v for v in walls if abs(cross(right['u'],v['u']))>PARALLEL_SINE_TOL and min(np.linalg.norm(b-v[q]) for q in ('a','b'))<=WALL_SPACING_TOL_MM]
        if not any(parallel_pair(v,w,thickness) is not None for v in adjacent_left for w in adjacent_right):return False
    return True
