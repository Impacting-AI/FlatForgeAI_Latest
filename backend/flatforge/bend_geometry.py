"""Analytic cylindrical bends trimmed by their developed material outline.

The flat polygon becomes a polygon in cylinder parameters (angle, axial
distance). Both skins remain cylinders, including stepped ends and holes.
Diagonal cut edges become helices, with ruled cut faces through the thickness.
"""
import math
import numpy as np
from shapely.geometry import Polygon
from shapely.geometry.polygon import orient


def bend_regions(material, edges):
    from . import geometry as g
    regions=[]
    for e in edges:
        # Use the complete adjacent material, not the shared hinge span. A
        # re-entrant wing can continue beyond either end on just one side.
        from shapely import set_precision
        adjacent=set_precision(material[e['parent']].union(material[e['child']]),0)
        # Intersecting the two plates with CONTOR can put their common seam
        # on opposite floating-point sides of the same line. Join only that
        # sub-micron crack; physical holes and reliefs remain in the polygon.
        adjacent=adjacent.buffer(1e-7,join_style=2).buffer(-1e-7,join_style=2)
        u,n,c=g.support(e)
        points=np.array([q for p in g.poly_parts(adjacent) for q in p.exterior.coords])
        lo,hi=float(min(points@u))-1,float(max(points@u))+1
        h=n*c;half=e['allowance']/2
        strip=Polygon([h+lo*u-half*n,h+hi*u-half*n,h+hi*u+half*n,h+lo*u+half*n])
        regions.append(adjacent.intersection(strip))
    return regions


def cylindrical_solid(poly, edge, parent_tf, thickness):
    import cadquery as cq
    from OCP.gp import gp_Ax3, gp_Pnt, gp_Dir, gp_Pnt2d
    from OCP.Geom import Geom_CylindricalSurface
    from OCP.GCE2d import GCE2d_MakeSegment
    from OCP.BRepBuilderAPI import (BRepBuilderAPI_MakeEdge,
        BRepBuilderAPI_MakeWire, BRepBuilderAPI_MakeFace,
        BRepBuilderAPI_Sewing, BRepBuilderAPI_MakeSolid)
    from OCP.BRepLib import BRepLib
    from OCP.BRepFill import BRepFill
    from OCP.ShapeFix import ShapeFix_Solid
    from OCP.TopoDS import TopoDS

    R,T=parent_tf
    angle=math.radians(edge['angle'])
    axis=R@edge['axis'];start=-R@edge['w'];center=R@edge['center']+T
    frame=gp_Ax3(gp_Pnt(*center),gp_Dir(*axis),gp_Dir(*start))
    def uv_ring(coords):
        q=np.asarray(coords)
        a=((q-edge['hinge'][:2])@edge['d'][:2]/edge['allowance']+.5)*angle
        return np.column_stack([a,q@edge['axis'][:2]])
    # Overlay operations can leave coincident sub-micron nodes on the seam.
    poly=poly.simplify(1e-7,preserve_topology=True)
    uv=orient(Polygon(uv_ring(poly.exterior.coords),[uv_ring(h.coords) for h in poly.interiors]),sign=1.)
    from shapely.geometry import box
    if not uv.interiors and uv.symmetric_difference(box(*uv.bounds)).area<1e-8:
        # Rectangular bands remain exact annular extrusions, without seams.
        from .geometry import rotation
        a,b,c,d=uv.bounds
        def point(radius,phase):return cq.Vector(*(center+axis*b+radius*(rotation(axis,phase)@start)))
        radius=edge['radius']
        wire=cq.Wire.assembleEdges([
            cq.Edge.makeThreePointArc(point(radius,a),point(radius,(a+c)/2),point(radius,c)),
            cq.Edge.makeLine(point(radius,c),point(radius+thickness,c)),
            cq.Edge.makeThreePointArc(point(radius+thickness,c),point(radius+thickness,(a+c)/2),point(radius+thickness,a)),
            cq.Edge.makeLine(point(radius+thickness,a),point(radius,a))])
        result=cq.Solid.extrudeLinear(wire,[],cq.Vector(*(axis*(d-b))))
        if not result.isValid():raise ValueError('Invalid rectangular bend solid')
        return result
    skins=[];boundaries=[]
    for radius in (edge['radius'],edge['radius']+thickness):
        surface=Geom_CylindricalSurface(frame,radius)
        rings=[];ring_edges=[]
        for ring in [uv.exterior,*uv.interiors]:
            wire=BRepBuilderAPI_MakeWire();edges=[]
            coords=list(ring.coords)
            for a,b in zip(coords,coords[1:]):
                if np.linalg.norm(np.asarray(a)-b)<1e-10:continue
                curve=GCE2d_MakeSegment(gp_Pnt2d(*a),gp_Pnt2d(*b)).Value()
                e=BRepBuilderAPI_MakeEdge(curve,surface).Edge()
                if not BRepLib.BuildCurves3d_s(e,1e-7):
                    raise ValueError(f'Cannot construct shaped bend {edge.get("index")} boundary {a} to {b}')
                wire.Add(e);edges.append(e)
            rings.append(wire.Wire());ring_edges.extend(edges)
        maker=BRepBuilderAPI_MakeFace(surface,rings[0],True)
        for hole in rings[1:]:maker.Add(hole)
        skins.append(maker.Face());boundaries.append(ring_edges)
    sewing=BRepBuilderAPI_Sewing(1e-6)
    for skin in skins:sewing.Add(skin)
    for inner,outer in zip(*boundaries):
        a,b=cq.Edge(inner),cq.Edge(outer)
        wire=cq.Wire.assembleEdges([a,b,cq.Edge.makeLine(a.startPoint(),b.startPoint()),
                                   cq.Edge.makeLine(a.endPoint(),b.endPoint())])
        plane=BRepBuilderAPI_MakeFace(wire.wrapped,True)
        sewing.Add(plane.Face() if plane.IsDone() else BRepFill.Face_s(inner,outer))
    sewing.Perform()
    sewn=cq.Shape.cast(sewing.SewedShape())
    if len(sewn.Shells())!=1:
        raise ValueError('Shaped bend boundary does not close to one shell')
    solid=BRepBuilderAPI_MakeSolid(TopoDS.Shell_s(sewn.Shells()[0].wrapped)).Solid()
    fix=ShapeFix_Solid(solid);fix.Perform()
    result=cq.Shape.cast(fix.Solid())
    expected=poly.area*abs(angle)/edge['allowance']*thickness*(edge['radius']+thickness/2)
    if not result.isValid() or len(result.Solids())!=1 or abs(result.Volume()-expected)>max(1e-5,expected*1e-6):
        raise ValueError('Shaped bend failed solid validity or volume conservation')
    return result
