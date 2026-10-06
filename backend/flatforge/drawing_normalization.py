"""Lossless adapters for equivalent straight-line drawing representations.

No coordinate snapping, gap filling, layer guessing or angle assignment occurs
here. Original handles are retained in the normalization audit.
"""
from shapely.geometry import LineString
from shapely.ops import polygonize_full, unary_union


def normalize(doc):
    ms = doc.modelspace()
    audit = []
    for entity in sorted(list(ms), key=lambda e: int(e.dxf.handle, 16)):
        kind, layer = entity.dxftype(), entity.dxf.layer
        if kind == 'POLYLINE' and layer == 'CONTOR' and entity.is_2d_polyline:
            # Preserve OCS elevation/extrusion and bulges, including curved edges.
            points = [(v.dxf.location.x, v.dxf.location.y, v.dxf.get('bulge', 0)) for v in entity.vertices]
            new = ms.add_lwpolyline(points, format='xyb', close=entity.is_closed,
                dxfattribs={'layer': layer, 'elevation': entity.dxf.elevation.z,
                            'extrusion': entity.dxf.extrusion})
            audit.append({'kind': 'polyline_representation', 'source_handles': [entity.dxf.handle],
                          'generated_handles': [new.dxf.handle]})
            ms.delete_entity(entity)
        elif layer == 'KIFOF' and kind in ('LWPOLYLINE', 'POLYLINE'):
            if kind == 'POLYLINE' and not entity.is_2d_polyline:
                raise ValueError('KIFOF requires planar straight axes; 3D polylines need review')
            parts = list(entity.virtual_entities())
            if not parts or any(p.dxftype() != 'LINE' for p in parts):
                raise ValueError('Curved KIFOF axis requires a curved-bend model; it cannot be replaced by a straight hinge')
            if any(abs(p.dxf.start.z) > 1e-8 or abs(p.dxf.end.z) > 1e-8 for p in parts):
                raise ValueError('KIFOF axes must lie in the drawing XY plane')
            handles = []
            for part in parts:
                part.dxf.layer = layer
                ms.add_entity(part)
                handles.append(part.dxf.handle)
            audit.append({'kind': 'straight_polyline_axes', 'source_handles': [entity.dxf.handle],
                          'generated_handles': handles})
            ms.delete_entity(entity)

    # A contour drawn with individual LINE entities is equivalent only when
    # those lines form closed, nonbranching rings. Never heal an open contour.
    lines = list(ms.query('LINE[layer=="CONTOR"]'))
    if lines:
        segments = []
        degrees = {}
        for e in lines:
            a, b = tuple(e.dxf.start), tuple(e.dxf.end)
            if abs(a[2]) > 1e-8 or abs(b[2]) > 1e-8 or a == b:
                raise ValueError('CONTOR line rings contain a nonplanar or zero-length segment')
            a, b = a[:2], b[:2]
            for q in (a, b): degrees[q] = degrees.get(q, 0) + 1
            segments.append(LineString([a, b]))
        if any(n != 2 for n in degrees.values()):
            raise ValueError('CONTOR LINE entities must form closed rings without gaps or branches')
        polygons, cuts, dangles, invalid = polygonize_full(unary_union(segments))
        if not cuts.is_empty or not dangles.is_empty or not invalid.is_empty or polygons.is_empty:
            raise ValueError('CONTOR LINE entities do not define unambiguous closed rings')
        rings, keys = [], set()
        for p in polygons.geoms:
            for ring in (p.exterior, *p.interiors):
                key = frozenset(tuple(q) for q in ring.coords)
                if key not in keys: keys.add(key); rings.append(ring)
        # Intersections must not invent vertices absent from the original lines.
        if any(tuple(q) not in degrees for ring in rings for q in ring.coords):
            raise ValueError('Crossing CONTOR lines require explicit outline correction')
        generated = [ms.add_lwpolyline(list(r.coords)[:-1], close=True,
                     dxfattribs={'layer': 'CONTOR'}).dxf.handle for r in rings]
        audit.append({'kind': 'closed_line_rings', 'source_handles': [e.dxf.handle for e in lines],
                      'generated_handles': generated})
        for e in lines: ms.delete_entity(e)
    return audit
