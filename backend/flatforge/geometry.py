#!/usr/bin/env python3
"""Evidence-driven sheet reconstruction with arbitrary straight hinge axes.
Supported convention: CONTOR blank, single KIFOF axes, double-wall sections,
A-STRS-1 section markers, Zeva triangular paint marks. No panel coordinates or
bend IDs are embedded. Unsupported/ambiguous patterns raise explicit errors.
Dependencies: ezdxf, numpy, shapely, cadquery, trimesh, matplotlib.
"""
import argparse, collections, csv, hashlib, io, json, math, re, sys, subprocess, tempfile, importlib.metadata
from pathlib import Path
import numpy as np
import ezdxf
from ezdxf import path as dxfpath
from shapely import set_precision, union_all
from shapely.geometry import Polygon,LineString,Point,box
from shapely.ops import unary_union,polygonize
from shapely.affinity import translate

GRID=.001
ENDPOINT_SNAP=.05
ORTHOGONAL_TOL=1e-5

def section_layer(doc):
    """Explicit drawing conventions, never guess a layer from similar geometry."""
    populated={e.dxf.layer for e in doc.modelspace() if e.dxftype() in ('LINE','LWPOLYLINE','POLYLINE')}
    candidates=[name for name in ('HAT','חיפוי') if name in populated]
    if len(candidates)>1:
        raise ValueError('Both HAT and חיפוי contain geometry; select one section convention in CAD')
    return candidates[0] if candidates else None

def line_frame(a,b):
    """Canonical unit support: +Y for vertical lines, otherwise positive X."""
    if np.linalg.norm(b-a)<GRID:raise ValueError('Zero-length bend or section line')
    u=unit(b-a)
    if abs(u[0])<ORTHOGONAL_TOL:u=np.array([0.,1.])
    elif abs(u[1])<ORTHOGONAL_TOL:u=np.array([1.,0.])
    elif u[0]<0:u=-u
    n=np.array([-u[1],u[0]])
    c=float(np.dot((a+b)/2,n))
    return u,n,c

def support(e):
    if 'u' in e:return e['u'],e['normal'],e['offset']
    u=np.eye(2)[e['dim']];n=np.array([-u[1],u[0]])
    return u,n,e['c']*n[1-e['dim']]

def hinge_span(e):
    u,n,c=support(e)
    points=np.array(e['geom'].coords) if e['geom'].geom_type=='LineString' else np.vstack([p.coords for p in e['geom'].geoms if p.geom_type=='LineString'])
    values=points@u
    return float(values.min()),float(values.max())

def section_lines(doc):
    """Read explicit HAT walls, including straight polyline segments, with provenance."""
    layer=section_layer(doc)
    for e in doc.modelspace():
        if e.dxf.layer!=layer:continue
        if e.dxftype()=='LINE':yield e
        elif e.dxftype() in ['LWPOLYLINE','POLYLINE']:
            for i,v in enumerate(e.virtual_entities()):
                if v.dxftype()!='LINE':raise ValueError(f'Curved section wall at {e.dxf.handle}; curved-profile interpretation requires review')
                v.dxf.handle=f'{e.dxf.handle}:{i}'
                yield v

def vec(p):return np.array(tuple(p)[:2],dtype=float)
def cross(a,b):return float(a[0]*b[1]-a[1]*b[0])
def unit(a):return a/np.linalg.norm(a)
def read_drawing(filename):
    doc=ezdxf.readfile(filename);ms=doc.modelspace()
    read_drawing.repairs=[]
    read_drawing.annotations=[]
    oblique=any(min(abs(unit(vec(e.dxf.end)-vec(e.dxf.start))))>ORTHOGONAL_TOL for e in ms.query('LINE[layer=="KIFOF"]') if np.linalg.norm(vec(e.dxf.end)-vec(e.dxf.start))>GRID)
    outlines=[(e,Polygon([tuple(p)[:2] for p in dxfpath.make_path(e).flattening(.005)])) for e in ms.query('LWPOLYLINE[layer=="CONTOR"]')]
    if not outlines:raise ValueError('CONTOR must contain a closed LWPOLYLINE outline')
    outer_e,outer=max(outlines,key=lambda ep:ep[1].area)
    origin=np.array(outer.bounds[:2])
    normalized=[]
    for e,p in outlines:
        if not e.closed:raise ValueError(f'CONTOR contains an open outline at {e.dxf.handle}')
        points=np.array(p.exterior.coords)-origin
        if not oblique or not p.is_valid:points=np.round(points,3)
        clean=Polygon(points)
        if not clean.is_valid:raise ValueError(f'CONTOR contains an invalid outline at {e.dxf.handle}, even after {GRID} mm coordinate normalization')
        if not p.is_valid:read_drawing.repairs.append({'kind':'coordinate_precision','handle':e.dxf.handle,'grid_mm':GRID,'reason':'Floating point duplicate/backtracking vertices removed by coordinate rounding'})
        normalized.append((e,clean))
    outlines=normalized;outer=next(p for e,p in outlines if e is outer_e)
    if any(e is not outer_e and not outer.covers(p) for e,p in outlines):raise ValueError('Multiple outer panels or intersecting contours: upload one panel per drawing')
    if not oblique:outer=set_precision(outer,GRID)
    holes=[]
    for e in ms:
        if e.dxf.layer!='CONTOR' or e is outer_e:continue
        if e.dxftype() in ('DIMENSION','TEXT','MTEXT','LEADER','MLEADER'):
            read_drawing.annotations.append({'handle':e.dxf.handle,'type':e.dxftype(),'layer':'CONTOR','role':'annotation; excluded from cutting geometry'})
            continue
        if e.dxftype() not in ['LWPOLYLINE','CIRCLE']:raise ValueError('Unsupported CONTOR entity '+e.dxftype())
        ps=[vec(p)-origin for p in dxfpath.make_path(e).flattening(.005)]
        holes.append(Polygon(ps))
    blank=outer.difference(unary_union(holes))
    if not oblique:blank=set_precision(blank,GRID)
    lines=[]
    for i,e in enumerate(sorted(ms.query('LINE[layer=="KIFOF"]'),key=lambda e:int(e.dxf.handle,16)),1):
        a,b=vec(e.dxf.start)-origin,vec(e.dxf.end)-origin;u=unit(b-a)
        u,n,offset=line_frame(a,b)
        dim=int(abs(u[1])>abs(u[0]));c=float((a[1-dim]+b[1-dim])/2)
        # Keep oblique supports precise; independent endpoint rounding rotates
        # the support and breaks collinear joints on large-coordinate drawings.
        orthogonal=min(abs(u))<ORTHOGONAL_TOL
        if orthogonal:
            a,b=np.round(a,3),np.round(b,3);u,n,offset=line_frame(a,b)
        lines.append(dict(id=f'C{i:02}',handle=e.dxf.handle,a=a,b=b,dim=dim,c=round(c,3),u=u,normal=n,offset=offset,orthogonal=orthogonal))
    # Resolve only sub-tolerance corner mismatch; keep every adjustment auditable.
    coords=np.array(outer.exterior.coords)
    for i,q in enumerate(coords):
        for l in lines:
            u,n,c=support(l);signed=float(q@n-c);dist=abs(signed);v=float(q@u)
            if GRID<dist<=ENDPOINT_SNAP and min(l['a']@u,l['b']@u)-3<=v<=max(l['a']@u,l['b']@u)+3:
                read_drawing.repairs.append({'kind':'contour_to_axis_snap','bend_id':l['id'],'handle':l['handle'],'from':q.tolist(),'distance_mm':float(dist)})
                q-=signed*n
    adjusted=Polygon(coords)
    if not adjusted.is_valid:raise ValueError('Endpoint normalization would invalidate CONTOR; review drawing')
    outer=adjusted if oblique else set_precision(adjusted,GRID)
    blank=outer.difference(unary_union(holes))
    if not oblique:blank=set_precision(blank,GRID)
    return doc,origin,outer,blank,lines

def partition(outer,blank,lines,relief):
    partition.contacts=[]
    cutters=[LineString([l['a']-l.get('relief_extension',relief)*unit(l['b']-l['a']),l['b']+l.get('relief_extension',relief)*unit(l['b']-l['a'])]) for l in lines]
    # Preserve the proven 90-degree arrangement exactly. Oblique intersections
    # need joint noding; individually clipping them creates false slivers.
    oblique=any(not l.get('orthogonal',True) for l in lines)
    if oblique:arrangement=union_all([outer.boundary,*cutters],grid_size=GRID)
    else:arrangement=unary_union([outer.boundary,*[set_precision(c.intersection(outer),GRID) for c in cutters]])
    faces=[p for p in polygonize(arrangement) if outer.covers(p.representative_point())]
    if oblique:
        # Snap-round only the arrangement topology, then recover its vertices
        # on the original analytic supports for exact BREP mating surfaces.
        boundary=list(outer.exterior.coords)
        segments=[(np.array(a),np.array(b)) for a,b in zip(boundary,boundary[1:])]
        segments += [(np.array(c.coords[0]),np.array(c.coords[-1])) for c in cutters]
        cache={}
        def recover(q):
            key=tuple(q)
            if key in cache:return cache[key]
            q=np.array(q);near=[]
            for a,b in segments:
                if LineString([a,b]).distance(Point(q))>.002:continue
                u,n,c=line_frame(a,b);near.append((u,n,c))
            pairs=[(abs(cross(a[0],b[0])),i,j) for i,a in enumerate(near) for j,b in enumerate(near[i+1:],i+1)]
            if pairs and max(pairs)[0]>1e-5:
                _,i,j=max(pairs);a,b=near[i],near[j]
                restored=np.linalg.solve(np.array([a[1],b[1]]),[a[2],b[2]])
                if np.linalg.norm(restored-q)>.004:raise ValueError('Analytic hinge-junction recovery exceeds the topology tolerance')
                q=restored
            elif near:q=q-near[0][1]*(q@near[0][1]-near[0][2])
            cache[key]=tuple(q);return cache[key]
        faces=[Polygon([recover(q) for q in p.exterior.coords]) for p in faces]
        if any(not p.is_valid for p in faces):raise ValueError('Analytic hinge-junction recovery produced an invalid face')
    faces.sort(key=lambda p:(-p.area,p.bounds)); edges=[]
    for i,p in enumerate(faces):
        for j in range(i+1,len(faces)):
            shared=p.boundary.intersection(faces[j].boundary)
            if shared.length<.1:continue
            source=[l for l in lines if shared.intersection(LineString([l['a'],l['b']]).buffer(.002,cap_style=2)).length>.1]
            if not source:
                partition.contacts.append(dict(faces=[i,j],length_mm=shared.length,geometry=shared.wkt))
                continue
            u,n,c=support(source[0])
            if any(abs(cross(u,support(l)[0]))>1e-7 or abs(c-support(l)[2])>.002 for l in source):raise ValueError('Multiple hinge supports on shared boundary')
            edges.append(dict(faces=(i,j),source=source,geom=shared,dim=source[0]['dim'],c=source[0]['c'],u=u,normal=n,offset=c))
    adj=collections.defaultdict(list)
    for n,e in enumerate(edges):
        for f in e['faces']:adj[f].append(n)
    parent={0:None};order=[0]
    for p in order:
        for en in adj[p]:
            e=edges[en];ch=next(f for f in e['faces'] if f!=p)
            if ch in parent:continue
            parent[ch]=p;e['parent']=p;e['child']=ch;e['index']=en;order.append(ch)
    if len(order)!=len(faces) or len(edges)!=len(faces)-1:raise ValueError('Face adjacency is not a connected fold tree')
    return faces,edges,parent,order,[p.intersection(blank) for p in faces]

def profiles(doc,origin,t):
    ls=[]
    for e in section_lines(doc):
        a,b=vec(e.dxf.start)-origin,vec(e.dxf.end)-origin
        if np.linalg.norm(b-a)<t+0.01:continue # end caps, never bend skeletons
        u,n,c=line_frame(a,b);dim=int(abs(u[1])>abs(u[0]))
        ls.append(dict(a=a,b=b,dim=dim,u=u,normal=n,c=c,lo=min(a@u,b@u),hi=max(a@u,b@u),handle=e.dxf.handle))
    paired=set();sk=[]
    for i,l in enumerate(ls):
        if i in paired:continue
        choices=[]
        for j,m in enumerate(ls):
            if i==j or j in paired or abs(cross(l['u'],m['u']))>1e-4:continue
            overlap=min(l['hi'],m['hi'])-max(l['lo'],m['lo'])
            if abs(abs(l['c']-m['c'])-t)<.05 and overlap>0 and abs(l['lo']-m['lo'])<=t+.05 and abs(l['hi']-m['hi'])<=t+.05:
                choices.append(j)
        if len(choices)!=1:raise ValueError(f'HAT pair ambiguity at {l["handle"]}: {len(choices)} matches')
        j=choices[0];m=ls[j];paired.update([i,j]);dim=l['dim'];c=(l['c']+m['c'])/2
        a=l['normal']*c+l['u']*(l['lo']+m['lo'])/2;b=l['normal']*c+l['u']*(l['hi']+m['hi'])/2
        sk.append(dict(a=a,b=b,dim=dim,c=c,u=l['u'],normal=l['normal'],handles=[l['handle'],m['handle']],wall_spacing_mm=abs(l['c']-m['c']),parallel_error_deg=math.degrees(math.asin(abs(cross(l['u'],m['u']))))))
    links=collections.defaultdict(list);joints={};repairs=[]
    for i,l in enumerate(sk):
        for j,m in enumerate(sk[i+1:],i+1):
            if abs(cross(l['u'],m['u']))<1e-6:continue
            q=np.linalg.solve(np.array([l['normal'],m['normal']]),np.array([l['c'],m['c']]))
            dl=min(np.linalg.norm(q-l[k]) for k in ['a','b']);dm=min(np.linalg.norm(q-m[k]) for k in ['a','b'])
            if max(dl,dm)<=t+.5:
                links[i].append(j);links[j].append(i);joints[i,j]=joints[j,i]=q
    result=[];seen=set()
    for seed in range(len(sk)):
        if seed in seen:continue
        group={seed};queue=[seed]
        for i in queue:
            for j in links[i]:
                if j not in group:group.add(j);queue.append(j)
        seen|=group
        ends=[i for i in group if len(links[i])==1]
        if len(ends)!=2 or any(len(links[i]) not in [1,2] for i in group):raise ValueError('HAT skeleton is not a simple open path')
        seq=[min(ends,key=lambda i:tuple(sk[i]['a']))]
        while True:
            nxt=[i for i in links[seq[-1]] if i not in seq]
            if not nxt:break
            seq.append(nxt[0])
        p0=max([sk[seq[0]]['a'],sk[seq[0]]['b']],key=lambda p:np.linalg.norm(p-joints[seq[0],seq[1]]))
        pn=max([sk[seq[-1]]['a'],sk[seq[-1]]['b']],key=lambda p:np.linalg.norm(p-joints[seq[-1],seq[-2]]))
        pts=np.array([p0,*[joints[i,j] for i,j in zip(seq,seq[1:])],pn])
        main=int(np.argmax(np.linalg.norm(np.diff(pts,axis=0),axis=1)))
        result.append(dict(points=pts,segments=[sk[i] for i in seq],main=main,layer=section_layer(doc)))
    markers=[]
    for e in doc.modelspace().query('INSERT'):
        polys=[v for v in e.virtual_entities() if v.dxftype()=='LWPOLYLINE' and len(v)==3]
        for v in polys:
            # Mirrored INSERTs yield polylines with negative OCS extrusion.
            # Raw get_points() mirrors X a second time; use world vertices.
            ps=np.array([vec(p)-origin for p in v.vertices_in_wcs()]);markers.append((e.dxf.handle,ps))
    labels=[(re.sub(r'%%[uU]','',e.dxf.text),vec(e.dxf.insert)-origin) for e in doc.modelspace().query('TEXT') if re.fullmatch(r'(?:%%[uU])?([A-Za-z])-\1',e.dxf.text)]
    for n,p in enumerate(result):
        pts=p['points'];main=p['main'];seg=LineString(pts[main:main+2])
        if not markers:raise ValueError('No triangular painted-face marker accompanies the section profiles')
        h,triangle=min(markers,key=lambda hp:seg.distance(Polygon(hp[1])))
        if seg.distance(Polygon(triangle))>max(10.,5*t):
            # A folded profile can have a longer flange than its marked parent.
            # The paint marker, not segment length, establishes that reference.
            _,main,h,triangle=min((LineString(pts[k:k+2]).distance(Polygon(tri)),k,handle,tri) for k in range(len(pts)-1) for handle,tri in markers)
            seg=LineString(pts[main:main+2]);p['main']=main
        ds=[seg.distance(Point(q)) for q in triangle];tip=triangle[int(np.argmin(ds))];centroid=triangle.mean(axis=0)
        normal=centroid-tip;normal=normal-unit(pts[main+1]-pts[main])*np.dot(normal,unit(pts[main+1]-pts[main]))
        if np.linalg.norm(normal)<1e-6 or seg.distance(Polygon(triangle))>max(10.,5*t):raise ValueError(f'Section paint marker {h} cannot orient wall {p["segments"][main]["handles"]}: distance {seg.distance(Polygon(triangle)):.3f} mm, normal magnitude {np.linalg.norm(normal):.6f}')
        normal=unit(normal)
        p.update(paint_normal=normal,paint_handle=h,main_dim=int(abs(pts[main+1,1]-pts[main,1])>abs(pts[main+1,0]-pts[main,0])))
        if p['main_dim']==0 and labels:
            name,loc=min(labels,key=lambda lp:LineString(pts).distance(Point(lp[1])))
            p['name']=name
        elif p['main_dim']==0:p['name']='HORIZONTAL_SECTION'
        else:p['name']='SIDE_'+('LEFT' if pts[main,0]<0 else 'RIGHT')
    return result

def section_trace(faces,outer,dim,coordinate):
    lo=np.array(outer.bounds[:2])-10;hi=np.array(outer.bounds[2:])+10
    a=lo.copy();b=hi.copy();a[1-dim]=b[1-dim]=coordinate
    cut=LineString([a,b]);items=[]
    for i,p in enumerate(faces):
        g=p.intersection(cut)
        if g.is_empty:continue
        gs=list(g.geoms) if hasattr(g,'geoms') else [g]
        for part in gs:
            if part.length>.01:
                bd=part.bounds;items.append((bd[dim],bd[dim+2],i))
    items.sort()
    return items

def map_sections(doc,origin,faces,outer,edges,profs,t,r,bd):
    # Sharp midsurface setback minus half bend allowance. 90-degree rule.
    ba=2*(r+t)-bd;gain=r+t/2-ba/2
    edge_lookup={frozenset(e['faces']):e for e in edges}
    results=[]
    for p in profs:
        pts=p['points'];m=p['main'];dim=p['main_dim']
        if pts[m+1,dim]<pts[m,dim]:
            pts=pts[::-1];p['segments']=p['segments'][::-1];m=len(pts)-2-m
        p['points']=pts;p['main']=m
        lengths=np.linalg.norm(np.diff(pts,axis=0),axis=1)
        flat_target=lengths-np.array([gain if i in [0,len(lengths)-1] else 2*gain for i in range(len(lengths))])
        if dim==0 and '-' in p['name']:
            letter=p['name'].split('-')[0];ts=[e for e in doc.modelspace().query('TEXT[layer=="A-STRS-1"]') if e.dxf.text==letter]
            polys=list(doc.modelspace().query('LWPOLYLINE[layer=="A-STRS-1"]'))
            cuts=[]
            for te in ts:
                marker=min(polys,key=lambda e:LineString([vec(q)-origin for q in e.get_points()]).distance(Point(vec(te.dxf.insert)-origin)))
                pp=[vec(q)-origin for q in marker.get_points()]
                hs=[(a,b) for a,b in zip(pp,pp[1:]) if abs(a[1]-b[1])<.01 and abs(a[0]-b[0])>.01]
                if len(hs)!=1:raise ValueError('Ambiguous section marker geometry')
                cuts.append(float(hs[0][0][1]))
            if len(cuts)!=2 or max(cuts)-min(cuts)>.1:raise ValueError('Section marker pair missing or misaligned')
            choices=[(sum(cuts)/len(cuts),0.)];mapping='paired cutting markers'
        else:
            # Side views have no explicit cutting markers: find all geometrically
            # equivalent lanes, then use the widest lane. Record this distinction.
            xs=sorted({round(q[1-dim],3) for f in faces for q in f.exterior.coords})
            choices=[((a+b)/2,b-a) for a,b in zip(xs,xs[1:]) if b-a>.1];mapping='unlabelled projected profile matched to an equivalent cut lane (no explicit marker)'
        valid=[]
        for c,width in choices:
            trace=section_trace(faces,outer,dim,c)
            if len(trace)!=len(lengths):continue
            err=max(abs((b-a)-target) for (a,b,_),target in zip(trace,flat_target))
            if err<=.5:valid.append((err,-width,c,trace))
        if not valid:raise ValueError(f'{p["name"]}: section vertex count or strip lengths do not match any cut; STOP chain')
        # Prefer widest equivalent lane; otherwise minimum geometric residual.
        err,nw,c,trace=min(valid,key=lambda v:(v[1],v[0],v[2]))
        p.update(cut_coordinate=c,trace=trace,mapping=mapping,max_mapping_error=err)
        vmain=unit(pts[m+1]-pts[m]);hand=cross(vmain,p['paint_normal'])
        if abs(abs(hand)-1)>1e-6:raise ValueError('Paint marker not normal to main section segment')
        checks=[]
        for k in range(len(trace)-1):
            left=trace[k][2];right=trace[k+1][2];key=frozenset([left,right])
            if key not in edge_lookup:raise ValueError('Section crosses an unassigned or non-hinge adjacency')
            e=edge_lookup[key];v0=unit(pts[k+1]-pts[k]);v1=unit(pts[k+2]-pts[k+1]);delta=math.degrees(math.atan2(cross(v0,v1)*hand,np.dot(v0,v1)))
            # Canonical world hinge support points along +X or +Y.
            canonical_factor=1 if dim==1 else -1
            angle=delta*canonical_factor*(1 if e['parent']==left else -1)
            ev=dict(profile=p['name'],vertex=k+1,handles_before=p['segments'][k]['handles'],handles_after=p['segments'][k+1]['handles'],angle=angle)
            if 'angle' in e and abs(e['angle']-angle)>1:raise ValueError(f'Conflicting signed rotations for {e["source"]}: {e["angle"]} versus {angle}')
            e['angle']=angle;e.setdefault('evidence',[]).append(ev)
            checks.append(ev)
        results.append(dict(profile=p['name'],cut_axis='Y' if dim==0 else 'X',cut_coordinate=c,mapping=mapping,segments=len(trace),turns=len(trace)-1,max_strip_error=err,paint_marker=p['paint_handle']))
    # A single documented DXF LINE can hinge several disconnected flange tabs.
    # Carry its section-derived sign only to other portions of that same entity.
    for e in edges:
        if 'angle' in e:continue
        handles={l['handle'] for l in e['source']}
        matches=[v for v in edges if 'angle' in v and handles.intersection(l['handle'] for l in v['source'])]
        signs={round(v['angle'],6) for v in matches}
        if len(signs)==1:
            e['angle']=signs.pop()
            e['evidence']=[dict(ev,correspondence='same original KIFOF LINE, separated flange tab') for v in matches for ev in v['evidence']]
    if any('angle' not in e for e in edges):raise ValueError('Unmapped hinge; no default direction is allowed')
    if any(abs(abs(e['angle'])-90)>.001 for e in edges):raise ValueError('This implementation supports 90-degree bends only; no fallback angle allowed')
    return results

def rotation(axis,angle):
    a=np.array(axis,dtype=float);a/=np.linalg.norm(a);x,y,z=a;c=math.cos(angle);ss=math.sin(angle)
    K=np.array([[0,-z,y],[z,0,-x],[-y,x,0]])
    return np.eye(3)*c+(1-c)*np.outer(a,a)+ss*K

def lift(p):return np.array([p[0],p[1],0.])
def apply_tf(tf,p):return tf[0]@np.array(p)+tf[1]

def transforms(faces,edges,order,t,r,bd):
    rm=r+t/2;tf={0:(np.eye(3),np.zeros(3))}
    for child in order[1:]:
        e=next(e for e in edges if e['child']==child);parent=e['parent']
        u,n,c=support(e);axis=lift(u);h=lift(n*c)
        d=lift(n)*np.sign(np.array(faces[child].representative_point().coords[0])@n-c)
        angle=math.radians(e['angle']);ba=bend_allowance(t,r,bd,e['angle']);R=rotation(axis,angle)
        tangent=h-d*ba/2;w=np.cross(axis,d)*np.sign(angle);center=tangent+rm*w
        end=center-rm*(R@w);shift=end-R@(h+d*ba/2)
        rp,tp=tf[parent];tf[child]=(rp@R,rp@shift+tp)
        e.update(axis=axis,d=d,hinge=h,tangent=tangent,center=center,w=w,R=R,allowance=ba)
    return tf

def bend_allowance(t,r,bd,angle):
    """BD is the 90-degree calibration; constant K gives BA at other angles."""
    if not 0<abs(angle)<180:raise ValueError('Bend rotation must be between 0 and 180 degrees')
    return (2*(r+t)-bd)*abs(angle)/90.

def bend_strip(e,half_width,extension=0.):
    u,n,c=support(e);lo,hi=hinge_span(e);h=n*c
    return Polygon([h+u*(lo-extension)-n*half_width,h+u*(hi+extension)-n*half_width,h+u*(hi+extension)+n*half_width,h+u*(lo-extension)+n*half_width])

def poly_parts(g):
    if g.is_empty:return []
    if g.geom_type=='Polygon':return [g]
    return [p for p in getattr(g,'geoms',[]) if p.geom_type=='Polygon' and p.area>1e-8]

def build_cad(faces,material,edges,tf,t,r,bd,relief,out):
    import cadquery as cq
    parts=[];flat_trimmed=[];bend_records=[]
    for i,p in enumerate(material):
        adjacent=[e for e in edges if i in e['faces']]
        # Keep topology on GRID, but do not snap analytic oblique tangent
        # cuts back to that grid: doing so tilts the plate/bend mating edge.
        if any(min(abs(support(e)[0]))>ORTHOGONAL_TOL for e in adjacent):p=set_precision(p,0)
        # Finite tangent-zone removal, not an infinite half-plane: a face may
        # have a re-entrant wing beyond another face's hinge support.
        strips=[]
        for e in adjacent:
            strips.append(bend_strip(e,e['allowance']/2,relief))
        trimmed=p.difference(unary_union(strips));flat_trimmed.append(trimmed)
        for poly in poly_parts(trimmed):
            def wire(coords):
                return cq.Wire.makePolygon([cq.Vector(*apply_tf(tf[i],lift(q)+np.array([0,0,-t/2]))) for q in list(coords)[:-1]],close=True)
            outer=wire(poly.exterior.coords);inner=[wire(ring.coords) for ring in poly.interiors]
            solid=cq.Solid.extrudeLinear(outer,inner,cq.Vector(*(tf[i][0]@np.array([0,0,t]))))
            if not solid.isValid():raise ValueError('Invalid planar plate BREP')
            parts.append(solid)
    for e in edges:
        lo,hi=hinge_span(e);ba=e['allowance'];axis=e['axis'];w=e['w'];center=e['center']+axis*lo;angle=math.radians(e['angle'])
        parenttf=tf[e['parent']]
        def pt(rad,a):return cq.Vector(*apply_tf(parenttf,center-rad*(rotation(axis,a)@w)))
        edges_wire=[cq.Edge.makeThreePointArc(pt(r,0),pt(r,angle/2),pt(r,angle)),cq.Edge.makeLine(pt(r,angle),pt(r+t,angle)),cq.Edge.makeThreePointArc(pt(r+t,angle),pt(r+t,angle/2),pt(r+t,0)),cq.Edge.makeLine(pt(r+t,0),pt(r,0))]
        wi=cq.Wire.assembleEdges(edges_wire);solid=cq.Solid.extrudeLinear(wi,[],cq.Vector(*(parenttf[0]@axis*(hi-lo))))
        if not solid.isValid():raise ValueError('Invalid cylindrical bend BREP')
        parts.append(solid);bend_records.append(dict(edge=e['index'],length=hi-lo,developed_area=(hi-lo)*ba))
    print('CAD parts',len(parts),flush=True)
    # Fusing reports volume losses explicitly; it does not justify unmodelled
    # stretching at relief corners. Such residuals are reported in validation.
    raw_volume=sum(s.Volume() for s in parts)
    fused=parts[0].fuse(*parts[1:],tol=1e-6).clean()
    print('CAD valid',fused.isValid(),'solids',len(fused.Solids()),flush=True)
    cq.exporters.export(fused,str(out/'panel.step'))
    steppath=out/'panel.step';steptext=steppath.read_text();steptext=re.sub(r"'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'","'1970-01-01T00:00:00'",steptext)
    # OpenCascade increments the default product label within a process.
    # Normalize only that generated label; geometry and entity IDs stay intact.
    steptext=re.sub(r"'Open CASCADE STEP translator [0-9.]+ \d+'","'FlatForge panel'",steptext);steppath.write_text(steptext)
    import trimesh
    vertices,triangles=fused.tessellate(.08,.1)
    mesh=trimesh.Trimesh(vertices=np.array([v.toTuple() for v in vertices]),faces=np.array(triangles),process=False)
    # glTF metres; STEP and all reports use millimetres. Z remains CAD up.
    mesh.apply_scale(.001);scene=trimesh.Scene();scene.add_geometry(mesh,node_name='panel',geom_name='panel');scene.metadata={'units':'metres','source_units':'mm','status':'engineering reconstruction; see validation report'}
    (out/'panel.glb').write_bytes(scene.export(file_type='glb'))
    # Tessellation updates OCC triangulation caches and can invalidate a
    # subsequent in-memory check despite a valid saved BREP. Validate and use
    # the actual exported STEP for all downstream section/unfold operations.
    fused=cq.importers.importStep(str(out/'panel.step')).val()
    from OCP.BRepBndLib import BRepBndLib
    from OCP.Bnd import Bnd_Box
    ob=Bnd_Box();BRepBndLib.AddOptimal_s(fused.wrapped,ob,False,False);bounds=ob.Get();bmin=list(bounds[:3]);bmax=list(bounds[3:]);bsize=[v-u for u,v in zip(bmin,bmax)]
    return fused,flat_trimmed,dict(valid=fused.isValid(),solid_count=len(fused.Solids()),volume_mm3=fused.Volume(),pre_fuse_volume_mm3=raw_volume,fusion_volume_removed_mm3=raw_volume-fused.Volume(),bbox_mm=bsize,bbox_min_mm=bmin,bbox_max_mm=bmax,plate_flat_area=sum(p.area for p in flat_trimmed),bend_developed_area=sum(b['developed_area'] for b in bend_records))

def check_sections(solid,profs,faces,tf,t,r,out,material=None):
    import cadquery as cq
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Section
    from OCP.gp import gp_Pln,gp_Pnt,gp_Dir
    summaries=[];details=[];plots=[]
    for p in profs:
        trace=p['trace'];dim=p['main_dim'];cut=p['cut_coordinate'];main=p['main'];mainface=trace[main][2]
        direction=np.asarray(p.get('cut_direction',np.eye(2)[dim]));cutnormal=np.array([-direction[1],direction[0]]) if 'cut_direction' in p else np.eye(2)[1-dim]
        q=lift(cutnormal*cut+direction*(trace[main][0]+trace[main][1])/2)
        origin=apply_tf(tf[mainface],q);normal=tf[mainface][0]@lift(cutnormal)
        plane=gp_Pln(gp_Pnt(*origin),gp_Dir(*normal));op=BRepAlgoAPI_Section(solid.wrapped,plane,False);op.Build()
        section=cq.Shape.cast(op.Shape());se=section.Edges();linear=[e for e in se if e.geomType()=='LINE']
        dirs=[];mids=[];tangent_ends=[];misses=[];openings={}
        for index,(a,b,face) in enumerate(trace):
            R,T=tf[face];di=R@lift(direction);nn=R[:,2];q=lift(cutnormal*cut+direction*(a+b)/2);mid=apply_tf(tf[face],q)
            spans=[]
            for side in [-1,1]:
                lineorigin=mid+side*t/2*nn;matches=[]
                for edge in linear:
                    ev=[np.array(edge.startPoint().toTuple()),np.array(edge.endPoint().toTuple())]
                    if max(np.linalg.norm(np.cross(v-lineorigin,di)) for v in ev)<.03:
                        ab=sorted(float(np.dot(v-mid,di)) for v in ev)
                        if ab[1]-ab[0]>.05 and ab[1]>-(b-a)/2-.03 and ab[0]<(b-a)/2+.03:matches.append(ab)
                if not matches:
                    misses.append(f'segment {index+1}, wall {side}');spans.append((float('nan'),float('nan')))
                else:
                    matches.sort();lo,hi=matches[0]
                    for aa,bb in matches[1:]:
                        if aa-hi>.03:
                            # A hole crossing is legitimate only when the input
                            # CONTOR independently predicts the same missing span.
                            qa=q[:2]+direction*hi;qb=q[:2]+direction*aa
                            gap=LineString([qa,qb]);void=faces[face].difference(material[face]) if material is not None else Polygon()
                            if gap.difference(void.buffer(.03)).length<=.001:
                                openings[(index,round(hi,3),round(aa,3))]={'segment':index+1,'width_mm':aa-hi,'source':'CONTOR opening intersected by section plane'}
                            else:misses.append(f'segment {index+1}: interrupted wall not explained by CONTOR')
                        hi=max(hi,bb)
                    if material is not None:
                        def flat_interval(aa,bb):
                            qa=q[:2]+direction*aa;qb=q[:2]+direction*bb
                            return LineString([qa,qb])
                        observed=unary_union([flat_interval(aa,bb) for aa,bb in matches])
                        required=flat_interval(lo,hi).intersection(material[face])
                        # Check both ways: an invented gap and a filled-in hole
                        # must both fail even if the global area residual is small.
                        if observed.difference(required.buffer(.03)).length>.001 or required.difference(observed.buffer(.03)).length>.001:
                            misses.append(f'segment {index+1}, wall {side}: material span differs from CONTOR')
                    spans.append((lo,hi))
            lo,hi=np.mean(spans,axis=0);dirs.append(di);mids.append(mid);tangent_ends.append((mid+di*lo,mid+di*hi))
        verts=[tangent_ends[0][0]];intersection_gaps=[]
        for i in range(len(trace)-1):
            A=np.column_stack([dirs[i],-dirs[i+1]]);v=np.linalg.lstsq(A,mids[i+1]-mids[i],rcond=None)[0]
            v0=mids[i]+v[0]*dirs[i];v1=mids[i+1]+v[1]*dirs[i+1];intersection_gaps.append(float(np.linalg.norm(v1-v0)));verts.append((v0+v1)/2)
        verts.append(tangent_ends[-1][1]);verts=np.array(verts)
        actual=np.linalg.norm(np.diff(verts,axis=0),axis=1);expected=np.linalg.norm(np.diff(p['points'],axis=0),axis=1)
        actual_main=dirs[main];paint=tf[mainface][0][:,2];plane_turn_normal=np.cross(actual_main,paint)
        expected_hand=cross(unit(p['points'][main+1]-p['points'][main]),p['paint_normal'])
        angle_errors=[];paint_errors=[]
        for i in range(len(trace)):
            if i<len(trace)-1:
                observed=math.degrees(math.atan2(np.dot(np.cross(dirs[i],dirs[i+1]),plane_turn_normal),np.dot(dirs[i],dirs[i+1])))
                e0=unit(p['points'][i+1]-p['points'][i]);e1=unit(p['points'][i+2]-p['points'][i+1]);target=math.degrees(math.atan2(cross(e0,e1)*expected_hand,np.dot(e0,e1)))
                angle_errors.append(abs(observed-target))
            # Transport the marker normal along the HAT tangent, independently
            # of the fold tree, and compare to each face's actual finish normal.
            dv=unit(p['points'][i+1]-p['points'][i]);dm=unit(p['points'][main+1]-p['points'][main]);theta=math.atan2(cross(dm,dv)*expected_hand,np.dot(dm,dv))
            predicted=rotation(plane_turn_normal,theta)@paint
            actualpaint=tf[trace[i][2]][0][:,2]
            paint_errors.append(math.degrees(math.acos(float(np.clip(np.dot(predicted,actualpaint),-1,1)))))
            details.append(dict(profile=p['name'],segment=i+1,face=f'F{trace[i][2]}',hat_virtual_midline_length_mm=float(expected[i]),solid_section_virtual_midline_length_mm=float(actual[i]),length_error_mm=float(abs(actual[i]-expected[i])),turn_error_deg=angle_errors[-1] if i<len(trace)-1 else '',paint_normal_error_deg=paint_errors[-1],status='PASS' if abs(actual[i]-expected[i])<=.5 and paint_errors[-1]<=1 and (i==len(trace)-1 or angle_errors[-1]<=1) else 'FAIL'))
        radii=[e.radius() for e in se if e.geomType()=='CIRCLE'];radius_error=max([min(abs(v-r),abs(v-(r+t))) for v in radii],default=float('inf'))
        status='PASS' if not misses and np.max(abs(actual-expected))<=.5 and max(angle_errors)<=1 and max(paint_errors)<=1 and radius_error<.001 else 'FAIL'
        summaries.append(dict(profile=p['name'],segments=len(trace),section_edges=len(se),max_length_error_mm=float(np.max(abs(actual-expected))),max_turn_error_deg=max(angle_errors),max_paint_normal_error_deg=max(paint_errors),circular_edges=len(radii),expected_circular_edges=2*(len(trace)-1),max_radius_error_mm=radius_error,missing_or_interrupted=misses,contour_openings=list(openings.values()),chain_status=status,full_plane_status='PASS' if status=='PASS' and len(radii)==2*(len(trace)-1) and len(se)==4*len(trace)+4*len(openings) else 'FAIL'))
        # Evidence image: real BREP section, registered to HAT by main-segment
        # midpoint/orientation only. No scaling or non-rigid fit is performed.
        ref=(verts[main]+verts[main+1])/2;uv=[]
        for e in se:
            pts3=np.array([e.positionAt(float(v)).toTuple() for v in np.linspace(0,1,30 if e.geomType()=='CIRCLE' else 2)])
            uv.append(np.column_stack([(pts3-ref)@actual_main,(pts3-ref)@paint]))
        hp=p['points'];hmid=(hp[main]+hp[main+1])/2;hd=unit(hp[main+1]-hp[main]);hat=np.column_stack([(hp-hmid)@hd,(hp-hmid)@p['paint_normal']])
        plots.append((p['name'],uv,hat))
    def savecsv(name,rows):
        with (out/name).open('w',newline='') as f:w=csv.DictWriter(f,fieldnames=rows[0].keys());w.writeheader();w.writerows(rows)
    savecsv('section_checks.csv',summaries);savecsv('section_segment_checks.csv',details)
    import matplotlib;matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig,axes=plt.subplots(len(plots),1,figsize=(15,15));axes=np.atleast_1d(axes)
    for ax,(name,uv,hat) in zip(axes,plots):
        for pp in uv:ax.plot(pp[:,0],pp[:,1],color='#1278ad',lw=1)
        ax.plot(hat[:,0],hat[:,1],'--',color='#e77b21',lw=.8,label='HAT sharp midsurface reference')
        ax.set_title(name+' — actual solid cut (blue), HAT reference (orange)');ax.set_aspect('equal');ax.grid(alpha=.2)
    fig.tight_layout();buf=io.BytesIO();fig.savefig(buf,format='png',dpi=120);(out/'section_comparison.png').write_bytes(buf.getvalue());plt.close(fig)
    return summaries,details

def sampled_wire(wire):
    # Order connected BREP edge samples; curved edges receive finite chord error.
    pending=[]
    for e in wire.Edges():
        n=2 if e.geomType()=='LINE' else max(8,min(256,int(e.Length()/.25)+1))
        pending.append(np.array([e.positionAt(float(v)).toTuple() for v in np.linspace(0,1,n)]))
    if not pending:return np.zeros((0,3))
    pts=list(pending.pop(0))
    while pending:
        choices=[(np.linalg.norm(pts[-1]-a[k]),i,k) for i,a in enumerate(pending) for k in [0,-1]]
        dist,i,k=min(choices)
        if dist>.02:raise ValueError('Cannot order BREP wire for unfolding')
        arr=pending.pop(i)
        if k==-1:arr=arr[::-1]
        pts.extend(arr[1:])
    return np.array(pts)

def unfold_solid(solid,tf,trimmed,edges,blank,t,r,bd,out):
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    pieces=[];counts=collections.Counter()
    for face in solid.Faces():
        typ=face.geomType()
        if typ not in ['PLANE','CYLINDER']:continue
        outer3=sampled_wire(face.outerWire());holes3=[sampled_wire(w) for w in face.innerWires()]
        if typ=='PLANE':
            for i,(R,T) in tf.items():
                q=(outer3-T)@R
                if max(abs(q[:,2]-t/2))>.005:continue
                po=Polygon(q[:,:2],[((h-T)@R)[:,:2] for h in holes3])
                if not po.is_valid:po=po.buffer(0)
                po=po.intersection(trimmed[i])
                if po.area>1e-6:pieces.append(po);counts['planar_patches']+=1
        else:
            cyl=BRepAdaptor_Surface(face.wrapped).Cylinder();radius=cyl.Radius();loc=np.array(cyl.Location().Coord());axis=np.array(cyl.Axis().Direction().Coord())
            for e in edges:
                R,T=tf[e['parent']];ga=R@e['axis'];gc=R@e['center']+T
                desired=r+t/2-t/2*e['w'][2]
                if abs(radius-desired)>.005 or abs(np.dot(axis,ga))<1-1e-6 or np.linalg.norm(np.cross(loc-gc,ga))>.005:continue
                angle=math.radians(e['angle']);start=-R@e['w'];ba=e['allowance']
                def unwrap(pts):
                    off=pts-gc;long=off@ga;radial=off-long[:,None]*ga
                    ph=np.arctan2(np.cross(np.tile(start,(len(pts),1)),radial)@ga,radial@start)
                    q=e['hinge'][:2]+long[:,None]*e['axis'][:2]+(ba*ph/angle-ba/2)[:,None]*e['d'][:2]
                    return q
                po=Polygon(unwrap(outer3),[unwrap(h) for h in holes3])
                if not po.is_valid:po=po.buffer(0)
                pieces.append(po);counts['cylindrical_patches']+=1
    unfolded=unary_union(pieces);delta=unfolded.symmetric_difference(blank)
    result=dict(method='inverse fold-tree mapping of actual fused BREP painted planar/cylindrical faces; cylindrical angle mapped by derived K',flat_input_area_mm2=blank.area,unfolded_area_mm2=unfolded.area,symmetric_difference_mm2=delta.area,symmetric_difference_percent=100*delta.area/blank.area,net_area_difference_percent=100*(unfolded.area-blank.area)/blank.area,missing_area_mm2=blank.difference(unfolded).area,excess_area_mm2=unfolded.difference(blank).area,surface_patch_counts=dict(counts),status='PASS' if delta.area/blank.area<=.005 else 'FAIL')
    import matplotlib;matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig,ax=plt.subplots(figsize=(13,8))
    for poly in poly_parts(blank):ax.plot(*poly.exterior.xy,color='black',lw=.8)
    for poly in poly_parts(unfolded):ax.plot(*poly.exterior.xy,color='#087ead',lw=.55)
    for poly in poly_parts(delta):ax.fill(*poly.exterior.xy,color='#dc541e',alpha=.9)
    ax.set_aspect('equal');ax.set_title('Actual BREP unfolded to neutral flat: black input, blue reconstruction, orange differences');ax.set_xlabel('mm');ax.set_ylabel('mm');fig.tight_layout()
    buf=io.BytesIO();fig.savefig(buf,format='png',dpi=120);(out/'unfold_comparison.png').write_bytes(buf.getvalue());plt.close(fig)
    return result
