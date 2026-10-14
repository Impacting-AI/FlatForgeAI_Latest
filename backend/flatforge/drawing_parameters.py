"""Drawing values and explicit fallback rules, kept separate from review edits.

Sharp section corners do not establish a bend radius. Only scoped, labelled
global notes may supply radius/deduction here; hole radii and arbitrary numbers
are deliberately not interpreted as manufacturing settings.
"""
import collections
import math
import re

import numpy as np

from . import geometry as g

FIELDS = ('thickness', 'radius', 'deduction')


def right_angle_deduction(faces, outer, edges, profiles, thickness, strip_tolerance, angle_tolerance):
    """Measure BD90 only where normal, constant-width strips establish it.

    At 90°, the virtual-midline increment is (BD90 - thickness) / 2,
    independent of radius. Sloped lanes and non-square profiles are excluded;
    all admissible measurements must agree instead of selecting a best fit.
    """
    from .section_mapping import directions, trace
    lookup={frozenset(e['faces']):e for e in edges};measurements=[]
    for profile in profiles:
        vectors=np.diff(profile['points'],axis=0)
        if len(vectors)<3:continue
        turns=[abs(math.degrees(math.atan2(g.cross(a,b),a@b))) for a,b in zip(vectors,vectors[1:])]
        if any(abs(turn-90)>angle_tolerance for turn in turns):continue
        lengths=np.linalg.norm(vectors,axis=1)
        adjacency=np.array([1,*([2]*(len(lengths)-2)),1])
        for direction in directions(edges):
            normal=np.array([-direction[1],direction[0]])
            stations=sorted({round(float(np.array(q)@normal),6) for face in faces for q in face.exterior.coords})
            for low,high in zip(stations,stations[1:]):
                if high-low<.02:continue
                cuts=[trace(faces,outer,direction,c) for c in (low+(high-low)*.25,low+(high-low)*.75)]
                if any(len(items)!=len(lengths) for items in cuts):continue
                if [i[2] for i in cuts[0]]!=[i[2] for i in cuts[1]]:continue
                hinges=[lookup.get(frozenset((a[2],b[2]))) for a,b in zip(cuts[0],cuts[0][1:])]
                if any(e is None or abs(g.support(e)[0]@direction)>1e-5 for e in hinges):continue
                actual=np.array([b-a for a,b,_ in cuts[0]])
                other=np.array([b-a for a,b,_ in cuts[1]])
                if max(abs(actual-other))>1e-5:continue
                for drawn in (lengths,lengths[::-1]):
                    gain=float(np.median((drawn-actual)/adjacency))
                    residual=float(max(abs(drawn-actual-gain*adjacency)))
                    value=2*gain+thickness
                    if 0<=value<=100 and residual<=strip_tolerance:
                        measurements.append({'value':value,'max_residual_mm':residual,
                                             'wall_handles':[s['handles'] for s in profile['segments']],
                                             'faces':[i[2] for i in cuts[0]]})
    values=[m['value'] for m in measurements]
    if not values or max(values)-min(values)>.01:
        return {'value':None,'confidence':'unknown','reason':'Normal right-angle strip measurements do not establish a unique deduction.'}
    return {'value':round(float(np.median(values)),6),'confidence':'drawing',
            'source':'Normal right-angle section / flat-strip increments',
            'max_residual_mm':max(m['max_residual_mm'] for m in measurements),'measurements':measurements}


def thickness_evidence(doc):
    lines=[]
    for e in g.section_lines(doc):
        a,b=g.vec(e.dxf.start),g.vec(e.dxf.end)
        if np.linalg.norm(b-a)<8:continue
        u=g.unit(b-a)
        if u[0]<-1e-8 or (abs(u[0])<=1e-8 and u[1]<0):u=-u
        lines.append((e.dxf.handle,a,b,u))
    votes=collections.defaultdict(list)
    for i,(handle,a,b,u) in enumerate(lines):
        n=np.array([-u[1],u[0]]);start,end=sorted((a@u,b@u))
        for other,aa,bb,v in lines[i+1:]:
            if abs(g.cross(u,v))>1e-5:continue
            dist=abs(float((aa-a)@n));lo,hi=sorted((aa@u,bb@u))
            # Mitered ends can extend beyond one thickness at oblique bends.
            if .1<=dist<=20 and min(end,hi)-max(start,lo)>5 and max(abs(start-lo),abs(end-hi))<=4*dist+.1:
                votes[round(dist,2)].append((handle,other,dist))
    supported=[]
    for value,pairs in votes.items():
        counts=collections.Counter(h for pair in pairs for h in pair[:2])
        unique=[pair for pair in pairs if counts[pair[0]]==counts[pair[1]]==1]
        if len(unique)>=3:supported.append((len(unique),value,unique))
    supported.sort(reverse=True)
    if not supported or (len(supported)>1 and supported[1][0]>=supported[0][0]*.8):
        return {'value':None,'confidence':'unknown','reason':'No dominant repeated, uniquely paired section-wall spacing.',
                'candidates':{v:n for n,v,_ in supported}}
    count,_,pairs=supported[0]
    return {'value':round(float(np.median([p[2] for p in pairs])),6),'confidence':'drawing',
            'paired_segments':count,'source':'Repeated parallel section-wall separation',
            'wall_pairs':[{'handles':list(p[:2]),'spacing_mm':p[2]} for p in pairs]}


NOTE_LABELS={
    'thickness':r'MATERIAL\s+THICKNESS',
    'radius':r'ALL\s+BENDS?\s+(?:INSIDE\s+RADIUS|INTERNAL\s+RADIUS)',
    'deduction':r'ALL\s+BENDS?\s+DEDUCTION\s+(?:AT\s+)?90\s*°?',
}


def drawing_evidence(doc):
    result={field:{'value':None,'confidence':'unknown','reason':'No supported global drawing note.'} for field in FIELDS}
    result['thickness']=thickness_evidence(doc)
    for field,label in NOTE_LABELS.items():
        notes=[]
        pattern=re.compile(rf'^{label}\s*[:=]\s*([+-]?\d+(?:\.\d+)?)\s*MM\.?$',re.I)
        for e in doc.modelspace():
            if e.dxftype() not in ('TEXT','MTEXT'):continue
            value=e.dxf.text if e.dxftype()=='TEXT' else e.plain_text()
            for line in value.splitlines():
                match=pattern.fullmatch(line.strip())
                if match:
                    n=float(match[1])
                    notes.append({'handle':e.dxf.handle,'text':line.strip(),'value':n})
        if not notes:continue
        values=[n['value'] for n in notes]
        if result[field]['value'] is not None:values.append(result[field]['value'])
        if max(values)-min(values)>.01:
            result[field]={'value':None,'confidence':'conflict','reason':'Drawing sources disagree. Choose the correct value.',
                           'candidates':sorted(set(values)),'notes':notes}
        else:
            result[field]={**result[field],'value':values[0],'confidence':'drawing',
                           'source':'Explicit global manufacturing note','notes':notes}
            n=values[0]
            if not (0<n<=20 if field=='thickness' else 0<n<=100 if field=='radius' else 0<=n<=100):
                result[field].update(confidence='invalid',reason=f'The drawing value {n:g} mm is outside the supported {field} range. Correct this field before rebuilding.')
    return result


def resolve_parameters(settings, overrides, evidence):
    """Return effective values without promoting displayed defaults to edits."""
    effective=dict(settings);resolved={}
    explicit=overrides.get('parameter_overrides',{})
    for field in FIELDS:
        found=evidence[field];drawn=found.get('value')
        if field in explicit:
            value=explicit[field];source='review';message='Entered or confirmed for this panel.'
        elif found.get('confidence')=='invalid':
            value=drawn;source='unresolved';message=found['reason']
        elif drawn is not None:
            value=drawn;source='drawing';message=found.get('source','Drawing measurement')+'.'
        elif found.get('confidence')=='conflict':
            value=settings[field];source='unresolved';message=found['reason']+' The field shows the proposed fallback.'
        elif settings.get('use_material_defaults'):
            value=settings[field];source='workspace_rule';message='Not established by the DXF; using the enabled material fallback rule.'
        elif overrides.get('confirm_parameters') or overrides.get('manual_bends'):
            value=settings[field];source='review';message='Panel parameters previously confirmed in review.'
        else:
            value=settings[field];source='unresolved';message='Not established by the DXF. Enter a value or confirm this proposed value.'
        effective[field]=value
        resolved[field]={'value':value,'source':source,'drawing_value':drawn,'fallback_value':settings[field],
                         'message':message,'needs_review':source=='unresolved','evidence':found}
        if source=='review' and drawn is not None and abs(value-drawn)>.01:
            resolved[field]['message']+=f' Drawing value: {drawn:g} mm; this correction is recorded.'
    return effective,resolved
