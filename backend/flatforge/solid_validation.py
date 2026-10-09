"""Independent checks of the re-imported STEP. No geometry is repaired here."""
import math
import numpy as np
from shapely.geometry import Polygon,LineString
from shapely.ops import unary_union
from . import geometry as g

POSITION_MM=.005
ANGLE_DEG=.01


def closed_wire(wire):
    points=g.sampled_wire(wire)
    # STEP vertices at a closed seam may differ at floating-point precision.
    if len(points)>2 and np.linalg.norm(points[-1]-points[0])<1e-7:points[-1]=points[0]
    return points


def inspect_brep(solid,trimmed,edges,tf,t,r):
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    planes=[];cylinders=[]
    for index,face in enumerate(solid.Faces()):
        if face.geomType()=='PLANE':
            planes.append((index,closed_wire(face.outerWire()),[closed_wire(w) for w in face.innerWires()]))
        elif face.geomType() in ('CYLINDER','EXTRUSION'):
            adaptor=BRepAdaptor_Surface(face.wrapped)
            if face.geomType()=='EXTRUSION':
                from OCP.GeomAbs import GeomAbs_Circle
                if adaptor.BasisCurve().GetType()!=GeomAbs_Circle:continue
                circle=adaptor.BasisCurve().Circle()
                if abs(np.dot(circle.Axis().Direction().Coord(),adaptor.Direction().Coord()))<1-1e-8:continue
                cyl=circle
            else:cyl=adaptor.Cylinder()
            cylinders.append((index,float(cyl.Radius()),np.array(cyl.Location().Coord()),np.array(cyl.Axis().Direction().Coord()),g.sampled_wire(face.outerWire())))
    skin_checks=[]
    for i,expected in enumerate(trimmed):
        R,T=tf[i];skins={-1:[],1:[]};heights={-1:[],1:[]}
        for index,outer,holes in planes:
            q=(outer-T)@R
            for side in (-1,1):
                if max(abs(q[:,2]-side*t/2))>.03:continue
                polygon=Polygon(q[:,:2],[((h-T)@R)[:,:2] for h in holes])
                if not polygon.is_valid:continue
                covered=polygon.intersection(expected)
                if covered.area<=1e-8:continue
                skins[side].append(covered);heights[side].append((float(np.mean(q[:,2])),covered.area))
        errors={};levels={}
        for side in (-1,1):
            observed=unary_union(skins[side])
            errors[side]=float(observed.boundary.hausdorff_distance(expected.boundary)) if not observed.is_empty else None
            levels[side]=sum(z*a for z,a in heights[side])/sum(a for z,a in heights[side]) if heights[side] else None
        thickness=levels[1]-levels[-1] if all(x is not None for x in levels.values()) else None
        passed=thickness is not None and abs(thickness-t)<=POSITION_MM and all(v is not None and math.isfinite(v) and v<=POSITION_MM for v in errors.values())
        skin_checks.append({'face':i,'measured_thickness_mm':thickness,'expected_thickness_mm':t,
                            'skin_boundary_errors_mm':errors,'status':'PASS' if passed else 'FAIL'})
    # Detect additional material on a recognized sheet skin, not just missing
    # material. Clipping patches above is only for per-face association.
    excess=[]
    for index,outer,holes in planes:
        origin=outer[0];u=g.unit(outer[1]-origin)
        normal=None
        for v in outer[2:]:
            n=np.cross(u,v-origin)
            if np.linalg.norm(n)>1e-8:normal=g.unit(n);break
        if normal is None:continue
        v=np.cross(normal,u)
        project=lambda pts:np.column_stack(((pts-origin)@u,(pts-origin)@v))
        actual=Polygon(project(outer),[project(h) for h in holes])
        expected=[]
        for i,flat in enumerate(trimmed):
            R,T=tf[i]
            if abs(normal@R[:,2])<1-1e-8:continue
            for side in (-1,1):
                for poly in g.poly_parts(flat):
                    transform=lambda coords:np.array([g.apply_tf(tf[i],g.lift(q)+[0,0,side*t/2]) for q in coords])
                    pts=transform(poly.exterior.coords)
                    if max(abs((pts-origin)@normal))>POSITION_MM:continue
                    expected.append(Polygon(project(pts),[project(transform(h.coords)) for h in poly.interiors]))
        if expected and actual.is_valid:
            target=unary_union(expected)
            if actual.intersection(target).area>1e-8:
                outside=actual.difference(target.buffer(POSITION_MM)).area
                if outside>POSITION_MM**2:excess.append({'brep_face':index,'excess_area_mm2':float(outside)})
    bends=[]
    for e in edges:
        R,T=tf[e['parent']];axis=R@e['axis'];center=g.apply_tf(tf[e['parent']],e['center']);start=-R@e['w']
        lo,hi=g.hinge_span(e);theta=abs(e['angle']);sign=np.sign(e['angle']);surfaces=[]
        for expected_radius in (r,r+t):
            matches=[]
            for index,radius,loc,direction,points in cylinders:
                if abs(axis@direction)<1-1e-6 or np.linalg.norm(np.cross(loc-center,axis))>POSITION_MM:continue
                if abs(radius-expected_radius)>POSITION_MM:continue
                off=points-center;along=off@axis;radial=off-along[:,None]*axis
                if along.max()<lo-POSITION_MM or along.min()>hi+POSITION_MM:continue
                phi=np.degrees(np.arctan2(np.cross(start,radial)@axis,radial@start))*sign
                matches.append((index,radius,along,phi))
            span=[float(min(m[3].min() for m in matches)),float(max(m[3].max() for m in matches))] if matches else None
            axial=[float(min(m[2].min() for m in matches)),float(max(m[2].max() for m in matches))] if matches else None
            passed=span is not None and max(abs(span[0]),abs(span[1]-theta))<=ANGLE_DEG and max(abs(axial[0]-lo),abs(axial[1]-hi))<=POSITION_MM
            surfaces.append({'expected_radius_mm':expected_radius,'measured_radii_mm':[m[1] for m in matches],
                'brep_faces':[m[0] for m in matches],'sweep_interval_deg':span,'axial_interval_mm':axial,'status':'PASS' if passed else 'FAIL'})
        bends.append({'hinge':e['index'],'parent':e['parent'],'child':e['child'],'signed_rotation_deg':e['angle'],
                      'surfaces':surfaces,'status':'PASS' if all(x['status']=='PASS' for x in surfaces) else 'FAIL'})
    return {'status':'PASS' if solid.isValid() and len(solid.Solids())==1 and not excess and all(x['status']=='PASS' for x in skin_checks+bends) else 'FAIL',
            'method':'Measured planar skins and cylindrical faces of re-imported STEP; compared with documented fold construction',
            'position_tolerance_mm':POSITION_MM,'angle_tolerance_deg':ANGLE_DEG,'skins':skin_checks,'bends':bends,'excess_skin_material':excess}


def inspect_overlays(solid,viewer):
    import cadquery as cq
    rows=[]
    for bend in viewer['bends']:
        distances=[]
        for line in bend.get('folded_lines',[]):
            a,b=np.array(line['points'])
            distances.extend(float(solid.distance(cq.Vertex.makeVertex(*(a+(b-a)*x)))) for x in (0,.25,.5,.75,1))
        error=max(distances) if distances else None
        rows.append({'hinge':bend['id'],'max_surface_distance_mm':error,'status':'PASS' if error is not None and error<=POSITION_MM else 'FAIL'})
    return {'status':'PASS' if rows and all(x['status']=='PASS' for x in rows) else 'FAIL','hinges':rows,'tolerance_mm':POSITION_MM}


def inspect_corners(solid,blank,trimmed,edges,tf,t):
    """Measure candidate free-edge pairs. Proximity does not establish intent."""
    import cadquery as cq
    actual=solid.Edges();free=[]
    boxes=[e.BoundingBox() for e in actual]
    def nearby(a,b):
        aa,bb=boxes[a],boxes[b]
        lower=sum(max(0.,getattr(aa,k+'min')-getattr(bb,k+'max'),getattr(bb,k+'min')-getattr(aa,k+'max'))**2 for k in ('x','y','z'))
        return lower<=9. and actual[a].distance(actual[b])<=3.

    for i,shape in enumerate(trimmed):
        for poly in g.poly_parts(shape):
            coords=list(poly.exterior.coords)
            for a,b in zip(coords,coords[1:]):
                segment=LineString([a,b])
                if segment.length<=.1 or segment.difference(blank.boundary.buffer(.002)).length>.01:continue
                pa,pb=[g.apply_tf(tf[i],g.lift(q)+[0,0,t/2]) for q in (a,b)]
                di=g.unit(pb-pa);mid=(pa+pb)/2
                matches=[]
                for k,edge in enumerate(actual):
                    if edge.geomType()!='LINE':continue
                    ea,eb=np.array(edge.startPoint().toTuple()),np.array(edge.endPoint().toTuple())
                    if np.linalg.norm(eb-ea)<.1 or abs(g.unit(eb-ea)@di)<1-1e-7:continue
                    if np.linalg.norm(np.cross(mid-ea,di))>POSITION_MM:continue
                    spans=sorted([(ea-pa)@di,(eb-pa)@di])
                    if min(spans[1],np.linalg.norm(pb-pa))-max(spans[0],0)>.1:matches.append(k)
                free.append((i,segment,matches))
    adjacent={frozenset(e['faces']) for e in edges};groups={}
    for i,(fa,sa,ma) in enumerate(free):
        for fb,sb,mb in free[i+1:]:
            if fa==fb or frozenset((fa,fb)) in adjacent:continue
            flat_gap=sa.distance(sb)
            if flat_gap>3 and not any(nearby(a,b) for a in ma for b in mb if a!=b):continue
            key=tuple(sorted((fa,fb)))
            choices=[]
            for a in ma:
                for b in mb:
                    if a==b:continue
                    ea,eb=actual[a],actual[b]
                    gap=float(ea.distance(eb))
                    end_gap=max([float(eb.distance(cq.Vertex.makeVertex(*p.toTuple()))) for p in (ea.startPoint(),ea.endPoint())]+[float(ea.distance(cq.Vertex.makeVertex(*p.toTuple()))) for p in (eb.startPoint(),eb.endPoint())])
                    choices.append({'brep_edges':[a,b],'minimum_gap_mm':gap,'endpoint_to_edge_max_mm':end_gap})
            groups.setdefault(key,[]).append({'flat_boundary_gap_mm':float(flat_gap),'flat_edges':[list(sa.coords),list(sb.coords)],'measurements':choices,
                'contour_evidence':'separated cutting edges / relief retained' if flat_gap>g.GRID else 'cutting edges meet in the developed blank'})
    return {'status':'NEEDS_REVIEW' if groups else 'PASS','method':'Distances between actual STEP free edges associated with CONTOR; no corner geometry altered',
            'corners':[{'faces':list(key),'status':'NEEDS_REVIEW','intended_continuity':'UNKNOWN',
                        'reason':'A closed seam or a permitted gap is not established by proximity. Confirm against a linked corner detail; reliefs are not closed automatically.',
                        'edge_pairs':rows} for key,rows in sorted(groups.items())]}


def export_verification(report,status,out):
    """Fail closed. A successful Boolean is not drawing verification."""
    import json
    mode=report.get('validation_mode','physical') # Legacy reports retain strict gating.
    if mode not in ('dimensional','physical'):raise ValueError('Unknown validation mode')
    parameters=report.get('bend_parameters',[])
    physical=bool(parameters) and all(c.get('valid') is True for c in parameters) and report.get('unfold_check',{}).get('status')=='PASS'
    checks={key:report.get(key,{}).get('status')=='PASS' for key in
            ('brep_check','corner_check','overlay_check','overlap_check')}
    if mode=='physical':checks['physical_unfolding']=physical
    sections=report.get('section_checks',[])
    checks['documented_sections']=bool(sections) and all(c.get('chain_status')=='PASS' for c in sections)
    trace=report.get('bend_traceability',[])
    checks['bend_evidence']=bool(trace) and all(b.get('status') in ('RESOLVED_FROM_DRAWING','OPERATOR_OVERRIDE') for b in trace)
    checks['step_available']=(out/'panel.step').is_file()
    bbox=report.get('bbox',[])
    checks['finite_bounding_box']=len(bbox)==3 and all(isinstance(v,(int,float)) and math.isfinite(v) and v>0 for v in bbox)
    checks['no_outstanding_issues']=status=='PASS' and not report.get('issues')
    verified=all(checks.values())
    if not verified:
        for suffix in ('step','stl'):
            source=out/f'panel.{suffix}'
            if source.exists():source.replace(out/f'review_model.{suffix}')
    result={'status':'VERIFIED' if verified else 'REVIEW','checks':checks,
            'validation_mode':mode,
            'physical_unfolding':'VERIFIED' if physical else 'UNVERIFIED',
            'scope':'Folded dimensions against drawing and selected parameters; not client-reference equivalence or manufacturing certification. Physical unfolding is reported separately.',
            'files':{p.name:('VERIFIED' if verified else 'REVIEW') for p in out.iterdir()
                     if p.suffix.lower() in ('.step','.stl','.glb')}}
    if (out/'review_model.step').exists():
        report['review_model']={'status':'UNVALIDATED','file':'review_model.step','message':'Review only. Failed or missing checks are listed in verification.json.'}
    (out/'verification.json').write_text(json.dumps(result,indent=2))
    return result
