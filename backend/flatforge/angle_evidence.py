"""Associate angular annotations with section walls, never by nearest label alone.

Contour/relief angles do not describe folds. Only annotations whose extension
rays match both walls of a painted section can supply a bend magnitude. The
section and its mapped hinge still establish direction and parentage.
"""
import math
import re
import numpy as np
from . import geometry as g


def degree_value(text):
    text=re.sub(r'%%[dD]|\\[uU]\+00[bB]0', '°', text)
    match=re.fullmatch(r'\s*([+]?[0-9]+(?:[.,][0-9]+)?)\s*°\s*', text)
    if not match:return None
    value=float(match[1].replace(',','.'))
    return value if 0<value<180 else None


def _dimension_sector(e, center, rays, origin):
    """Recover the sector selected by the arc point, independent of line order.

    Two-line dimensions measure one of four sectors of two infinite lines.
    get_measurement() alone depends on endpoint ordering and loses that choice.
    """
    if e.dimtype == 5:
        angle = math.degrees(math.atan2(g.cross(*rays), rays[0] @ rays[1])) % 360
        return angle, 'three_point_rays'
    point = e.dxf.get('defpoint5')
    if point is None:
        return None, 'missing_arc_point'
    direction = g.vec(point) - origin - center
    if np.linalg.norm(direction) < 1e-8:
        return None, 'degenerate_arc_point'
    polar = math.degrees(math.atan2(direction[1], direction[0])) % 360
    limits = sorted(math.degrees(math.atan2(v[1], v[0])) % 360
                    for ray in rays for v in (ray, -ray))
    for start, end in zip(limits, limits[1:] + [limits[0] + 360]):
        offset = (polar - start) % 360
        if 1e-7 < offset < end - start - 1e-7:
            return end - start, 'two_line_arc_point'
    return None, 'arc_point_on_extension_ray'


def _rendered_labels(doc, e):
    block = doc.blocks.get(e.dxf.get('geometry', ''))
    if block is None:
        return []
    labels = []
    for entity in block:
        if entity.dxftype() not in ('TEXT', 'MTEXT'):
            continue
        text = entity.plain_text() if entity.dxftype() == 'MTEXT' else entity.dxf.text
        value = degree_value(text)
        if value is not None:
            normalized = re.sub(r'%%[dD]|\\[uU]\+00[bB]0', '°', text)
            number = normalized.strip().rstrip('°').strip().replace(',', '.')
            places = len(number.split('.')[1]) if '.' in number else 0
            labels.append(dict(text=text, value_deg=value,
                               rounding_tolerance_deg=.5 * 10 ** -places))
    return labels


def _annotations(doc,origin):
    records=[]
    for e in doc.modelspace():
        kind=e.dxftype()
        if kind=='DIMENSION' and e.dimtype in (2,5):
            try:
                d=e.dxf
                if e.dimtype==5:
                    center=g.vec(d.defpoint4)-origin
                    rays=[g.vec(d.defpoint2)-origin-center,g.vec(d.defpoint3)-origin-center]
                else:
                    a,b,c,z=[g.vec(v)-origin for v in (d.defpoint2,d.defpoint3,d.defpoint4,d.defpoint)]
                    u,v=g.unit(b-a),g.unit(z-c)
                    if abs(g.cross(u,v))<1e-8:continue
                    center=a+u*np.linalg.solve(np.column_stack((u,-v)),c-a)[0]
                    rays=[u,v]
                rays=[g.unit(v) for v in rays]
                api_measurement=float(e.get_measurement()) % 360
                measured, sector_source = _dimension_sector(e, center, rays, origin)
                raw=d.get('text','<>')
                explicit=raw.strip() not in ('','<>')
                value=degree_value(raw)
                if value is None and explicit:value=degree_value(raw+'°')
                if not explicit:value=measured
                labels=_rendered_labels(doc,e)
                conflicts=[]
                if measured is None or not 0 < measured < 180:
                    conflicts.append('Dimension sector is missing, ambiguous or outside (0, 180).')
                if explicit and value is None:
                    conflicts.append('Dimension override cannot be interpreted as an included angle.')
                if measured is not None and value is not None and abs(value-measured)>1:
                    conflicts.append('Explicit dimension value disagrees with its geometric sector.')
                # Cached measurements are evidence, never the sole angle authority.
                stored=d.get('actual_measurement')
                stored_deg=math.degrees(float(stored)) if stored is not None else None
                if stored_deg is not None and measured is not None and abs(stored_deg-measured)>.01:
                    conflicts.append('Stored angular measurement disagrees with the geometric sector.')
                for label in labels:
                    expected=value if explicit else measured
                    if expected is not None and abs(label['value_deg']-expected)>label['rounding_tolerance_deg']+1e-5:
                        conflicts.append('Rendered dimension label disagrees beyond its displayed precision.')
                records.append(dict(handle=d.handle,kind='DIMENSION',center=center,rays=rays,
                                    measured_deg=measured,value_deg=value,text=raw,
                                    api_measurement_deg=api_measurement,sector_source=sector_source,
                                    stored_measurement_raw=stored,stored_measurement_deg=stored_deg,
                                    rendered_labels=labels,evidence_conflicts=conflicts))
            except (ValueError,TypeError,AttributeError,ZeroDivisionError):continue
    # Exploded CAD dimensions: require a unique degree label on a same-layer
    # arc and both arc rays on the section walls. Bare degree text is not enough.
    arcs=list(doc.modelspace().query('ARC'))
    for e in doc.modelspace().query('TEXT MTEXT'):
        raw=e.plain_text() if e.dxftype()=='MTEXT' else e.dxf.text
        value=degree_value(raw)
        if value is None:continue
        pos=g.vec(e.dxf.insert)-origin;height=float(e.dxf.get('height' if e.dxftype()=='TEXT' else 'char_height',2.5))
        candidates=[]
        for arc in arcs:
            if arc.dxf.layer!=e.dxf.layer:continue
            center=g.vec(arc.dxf.center)-origin;radius=arc.dxf.radius
            sweep=(arc.dxf.end_angle-arc.dxf.start_angle)%360
            polar=math.degrees(math.atan2(*(pos-center)[::-1]))%360
            if not 0<sweep<180 or (polar-arc.dxf.start_angle)%360>sweep+2:continue
            if abs(np.linalg.norm(pos-center)-radius)>max(2.,2*height):continue
            rays=[np.array([math.cos(math.radians(a)),math.sin(math.radians(a))]) for a in (arc.dxf.start_angle,arc.dxf.end_angle)]
            candidates.append(dict(handle=e.dxf.handle,arc_handle=arc.dxf.handle,kind='DEGREE_TEXT_ARC',
                                   center=center,rays=rays,measured_deg=sweep,value_deg=value,text=raw))
        if len(candidates)==1:records.extend(candidates)
        else:records.append(dict(handle=e.dxf.handle,kind='DEGREE_TEXT',value_deg=value,text=raw))
    return records


def annotate_profiles(doc,origin,profiles,thickness):
    report=[]
    for annotation in _annotations(doc,origin):
        row={k:v for k,v in annotation.items() if k not in ('center','rays')}
        row.update(status='UNASSOCIATED',reason='No unique painted section wall pair matches this annotation.')
        matches=[]
        if 'rays' in annotation:
            for p in profiles:
                for i in range(1,len(p['points'])-1):
                    q=p['points'][i]
                    rays=[g.unit(p['points'][j]-q) for j in (i-1,i+1)]
                    if np.linalg.norm(annotation['center']-q)>thickness+.5:continue
                    if not any(all(abs(a@b)>math.cos(math.radians(1)) for a,b in zip(annotation['rays'],order)) for order in (rays,rays[::-1])):continue
                    included=math.degrees(math.acos(np.clip(rays[0]@rays[1],-1,1)))
                    measured=annotation['measured_deg']
                    convention='included'
                    value=annotation['value_deg']
                    rotation=180-value if value is not None else None
                    handles=sorted(h for s in p['segments'][i-1:i+1] for h in s['handles'])
                    matches.append((p,i,handles,rotation,included,convention))
        if len(matches)==1:
            p,i,handles,rotation,included,convention=matches[0]
            row.update(profile=p['name'],vertex=i,wall_handles=handles,rotation_magnitude_deg=rotation,convention=convention,
                       status='MATCHED' if rotation is not None and abs(rotation-(180-included))<=1 and not annotation.get('evidence_conflicts') else 'CONFLICT',
                       reason='; '.join(annotation.get('evidence_conflicts', [])) or (
                           'Included angle disagrees with the matched HAT profile.'
                           if rotation is None or abs(rotation-(180-included))>1 else
                           'Extension rays identify this section vertex; direction comes from the painted profile.'),
                       profile_included_deg=included)
            p.setdefault('angle_dimensions',[]).append(row)
        report.append(row)
    # Multiple numeric labels on the same wall pair must agree.
    for p in profiles:
        for a in p.get('angle_dimensions',[]):
            peers=[b for b in p['angle_dimensions'] if b['wall_handles']==a['wall_handles']]
            values=[b['rotation_magnitude_deg'] for b in peers if b['rotation_magnitude_deg'] is not None]
            if values and max(values)-min(values)>.01:
                for b in peers:b.update(status='CONFLICT',reason='Angular annotations disagree at this section vertex.')
    return report


def attach_hinge_dimensions(edges,profiles):
    """Transfer provenance via wall handles even if the profile was reversed."""
    annotations=[a for p in profiles for a in p.get('angle_dimensions',[])]
    conflicts=[]
    for e in edges:
        matches=[]
        for ev in e.get('source_evidence',e.get('evidence',[])):
            handles=sorted(ev.get('handles_before',[])+ev.get('handles_after',[]))
            matches.extend(a for a in annotations if handles and handles==a['wall_handles'])
        if matches:
            e['drawing_dimensions']=matches
            if any(a['status']=='CONFLICT' for a in matches):
                e['detected_angle']=e.get('angle');e.pop('angle',None);conflicts.append(e)
    return conflicts
