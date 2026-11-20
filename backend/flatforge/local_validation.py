"""Local boundary checks; a small area percentage cannot hide a bad corner."""
import numpy as np
import shapely


def contact_coverage(solid, visible, blank, trimmed, edges, transforms, thickness, tolerance):
    """Recover hidden contact material only after checking it in the final solid.

    Fusing touching returns removes their internal skins. Their absence from a
    surface-only unfold is not proof that material is missing. Triangulate each
    missing patch and check a bounded 3D grid through its full thickness.
    Unproven patches remain missing; no expected outline is blindly copied.
    """
    import math
    import cadquery as cq
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_IN,TopAbs_ON
    from OCP.BRepBndLib import BRepBndLib
    from OCP.Bnd import Bnd_Box
    from shapely.ops import unary_union
    from . import geometry as g
    classifier=BRepClass3d_SolidClassifier(solid.wrapped)
    target_faces=solid.Faces();boxes=[]
    for face in target_faces:
        box=Bnd_Box();BRepBndLib.AddOptimal_s(face.wrapped,box,False,False);boxes.append(box.Get())
    boxes=np.asarray(boxes)
    missing=blank.difference(visible);verified=[];records=[];tested=0
    target_edge=tolerance/2
    levels=np.linspace(-thickness/2,thickness/2,max(2,math.ceil(thickness/tolerance)+1))
    bound=math.hypot(target_edge,(levels[1]-levels[0])/2)
    owners=[]
    for i,region in enumerate(trimmed):
        R,T=transforms[i]
        owners.append((f'plate_{i}',region,1.,lambda q,z,R=R,T=T:R@np.array([q[0],q[1],z])+T))
    for e in edges:
        if 'developed_region' not in e:continue
        R,T=transforms[e['parent']];angle=math.radians(e['angle'])
        scale=max(1.,(e['radius']+thickness)*abs(angle)/e['allowance'])
        def bend_point(q,z,e=e,R=R,T=T,angle=angle):
            phase=(((q-e['hinge'][:2])@e['d'][:2])/e['allowance']+.5)*angle
            radial=e['radius']+thickness/2-z*e['w'][2]
            p=e['center']+(q@e['axis'][:2])*e['axis']-radial*(g.rotation(e['axis'],phase)@e['w'])
            return R@p+T
        owners.append((f'bend_{e["index"]}',e['developed_region'],scale,bend_point))
    pending=[(patch.area,name,patch,scale,point_at) for name,region,scale,point_at in owners
             for patch in g.poly_parts(missing.intersection(region)) if patch.area>=1e-8]
    for _,name,patch,scale,point_at in sorted(pending,key=lambda x:-x[0]):
        if patch.area<1e-8:continue
        triangles=[np.array(p.exterior.coords)[:3] for p in shapely.constrained_delaunay_triangles(patch).geoms]
        points={};limit=False
        while triangles:
            q=triangles.pop();lengths=[np.linalg.norm(q[i]-q[(i+1)%3]) for i in range(3)];i=int(np.argmax(lengths));j=(i+1)%3;k=(i+2)%3
            if lengths[i]*scale>target_edge:
                mid=(q[i]+q[j])/2;triangles.extend([np.array([q[i],mid,q[k]]),np.array([mid,q[j],q[k]])])
            else:
                for p in q:points[tuple(np.round(p,8))]=p
            if (len(points)+len(triangles))*len(levels)+tested>25000:limit=True;break
        maximum=0.;passed=not limit and bool(points)
        if passed:
            for q in points.values():
                for z in levels:
                    p=point_at(q,z);classifier.Perform(gp_Pnt(*p),1e-7);tested+=1
                    if classifier.State() in (TopAbs_IN,TopAbs_ON):continue
                    vertex=cq.Vertex.makeVertex(*p)
                    lower=np.linalg.norm(np.maximum(np.maximum(boxes[:,:3]-p,p-boxes[:,3:]),0),axis=1)
                    nearest=float('inf');budget=tolerance-bound
                    for index in np.argsort(lower):
                        if lower[index]>min(nearest,budget)+1e-6:break
                        distance=BRepExtrema_DistShapeShape(vertex.wrapped,target_faces[int(index)].wrapped);distance.Perform()
                        if not distance.IsDone():continue
                        nearest=min(nearest,distance.Value())
                        if nearest<=budget:break
                    if not math.isfinite(nearest):passed=False;break
                    maximum=max(maximum,nearest)
                    if nearest>budget:passed=False;break
                if not passed:break
        records.append({'owner':name,'area_mm2':patch.area,'verified':passed,
                        'sampled_max_mm':maximum,'between_sample_bound_mm':bound,
                        'sample_limit_reached':limit})
        if passed:
            verified.append(patch)
            candidate=shapely.union_all([visible,*verified],grid_size=g.GRID).buffer(.005,join_style=2).buffer(-.005,join_style=2)
            if compare_boundaries(blank,candidate,tolerance)['status']=='PASS':break
    restored=unary_union([visible,*verified]) if verified else visible
    return restored,{'method':'Missing visible skins checked through full thickness against actual exported solid; bounded triangle grid, not assumed material.',
                     'tested_points':tested,'verified_area_mm2':unary_union(verified).area if verified else 0.,
                     'patches':records}


def compare_boundaries(expected, actual, tolerance=.5, curve_error=.02):
    """Bound the Hausdorff distance between polygon boundaries, including holes.

    Distance to a fixed set is 1-Lipschitz. With samples at most `step` apart,
    the true maximum on each straight segment is at most sampled_max+step/2.
    curve_error reserves the documented input/BREP curve sampling accuracy.
    This is a developed-outline check, not a 3D surface comparison to a STEP.
    """
    if expected.is_empty or actual.is_empty:
        return {'status':'FAIL','reason':'An input or reconstructed outline is empty.',
                'tolerance_mm':tolerance}
    rows=[]
    for name,source,target in [('input_to_solid',expected,actual),('solid_to_input',actual,expected)]:
        step=min(.1,tolerance/5)
        while True:
            points=shapely.get_coordinates(shapely.segmentize(source.boundary,step))
            distances=shapely.distance(shapely.points(points),target.boundary)
            worst=int(np.argmax(distances));maximum=float(distances[worst])
            upper=maximum+step/2+curve_error
            if upper<=tolerance or maximum>tolerance or step<=.01:break
            step/=5
        rows.append({'direction':name,'sampled_max_mm':maximum,'upper_bound_mm':upper,
                     'worst_point_mm':points[worst].tolist(),'sample_count':len(points),
                     'max_sample_spacing_mm':step})
    maximum=max(x['sampled_max_mm'] for x in rows)
    upper=max(x['upper_bound_mm'] for x in rows)
    return {'status':'PASS' if upper<=tolerance else 'FAIL' if maximum>tolerance else 'NEEDS_REVIEW',
            'method':'Bidirectional developed boundary distance, including hole boundaries; Lipschitz bound between samples.',
            'scope':'Actual exported solid unfolded against the DXF; not a reference STEP surface comparison.',
            'tolerance_mm':tolerance,'sampled_max_mm':maximum,'upper_bound_mm':upper,
            'curve_sampling_allowance_mm':curve_error,'directions':rows}
