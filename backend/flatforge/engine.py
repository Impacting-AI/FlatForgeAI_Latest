"""One isolated job. Evidence first; explicit review decisions precede solid generation."""
import sys, json, math, io, csv, shutil, traceback, hashlib, collections, html
from pathlib import Path
import numpy as np
import ezdxf
from shapely.geometry import Point,LineString
from . import geometry as g
from . import dwg
from . import tolerance_policy
from .detail_mapping import map_details, normal_instances, check_local_profiles
from .parameters import Parameters, ParameterOverrides, BendOverride, DEFAULTS, hinge_parameters
from .drawing_parameters import drawing_evidence, resolve_parameters, thickness_evidence, right_angle_deduction
def json_safe(obj):
 if isinstance(obj,np.ndarray):return json_safe(obj.tolist())
 if isinstance(obj,dict):return {k:json_safe(v) for k,v in obj.items()}
 if isinstance(obj,(list,tuple)):return [json_safe(v) for v in obj]
 if isinstance(obj,(float,np.floating)):return float(obj) if math.isfinite(obj) else None
 if isinstance(obj,np.integer):return int(obj)
 return obj
def dump(path,obj):path.write_text(json.dumps(json_safe(obj),indent=2,allow_nan=False))
def infer_deduction(faces,outer,profiles,t,strip_tolerance=.5):
 gains=[];residuals=[]
 for p in profiles:
  pts=p['points'];dim=p['main_dim'];main=p['main']
  if pts[main+1,dim]<pts[main,dim]:pts=pts[::-1]
  lengths=np.linalg.norm(np.diff(pts,axis=0),axis=1);adj=np.array([1 if i in [0,len(lengths)-1] else 2 for i in range(len(lengths))])
  coords=sorted({round(q[1-dim],3) for f in faces for q in f.exterior.coords});candidates=[]
  for a,b in zip(coords,coords[1:]):
   if b-a<.1:continue
   trace=g.section_trace(faces,outer,dim,(a+b)/2)
   if len(trace)!=len(lengths):continue
   offsets=(lengths-np.array([bb-aa for aa,bb,_ in trace]))/adj;gain=float(np.median(offsets));err=float(max(abs(offsets-gain)))
   if -5<gain<10:candidates.append((err,-(b-a),gain))
  if not candidates:continue
  err,_,gain=min(candidates)
  if err<=strip_tolerance:gains.append(gain);residuals.append(err)
 if not gains or max(gains)-min(gains)>strip_tolerance:return {'value':None,'confidence':'unknown','reason':'Sections do not establish a consistent deduction.'}
 return {'value':round(2*float(np.median(gains))+t,3),'confidence':'drawing','source':'Matched flat-strip / HAT virtual-midline increments; 90-degree bends','max_residual_mm':max(residuals)}
def extract_svg(outer,blank,lines,doc,origin):
 minx,miny,maxx,maxy=outer.bounds;pad=max(maxx,maxy)*.04
 parts=[f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{-pad} {-pad} {maxx+2*pad} {maxy+2*pad}" role="img" aria-label="Extracted panel outline and numbered bends"><g transform="translate(0 {maxy}) scale(1 -1)">']
 for p in g.poly_parts(blank):
  rings=[p.exterior,*p.interiors];d=' '.join('M '+' L '.join(f'{x:.3f},{y:.3f}' for x,y in r.coords)+' Z' for r in rings)
  parts.append(f'<path d="{d}" fill="#dcebe8" fill-rule="evenodd" stroke="#617d7a" stroke-width="1.7"/>')
 for l in lines:
  a,b=l['a'],l['b'];parts.append(f'<path d="M {a[0]} {a[1]} L {b[0]} {b[1]}" stroke="#059b87" stroke-dasharray="10 6" stroke-width="2"/>')
 parts.append('</g>')
 for region in getattr(g.partition,'corner_reliefs',[]):
  coords=' '.join(f'{x},{maxy-y}' for x,y in region['outline'])
  parts.append(f'<polygon points="{coords}" fill="#ed8a36" stroke="#a94313" stroke-width="1"><title>Proposed corner relief: {region["area_mm2"]:.4f} mm² of material. Review required.</title></polygon>')
 for l in lines:
  c=(l['a']+l['b'])/2;fs=max(maxx,maxy)/75
  parts.append(f'<text x="{c[0]+5}" y="{maxy-c[1]-5}" font-family="monospace" font-size="{fs:.2f}" fill="#995519">{l["id"]}</text>')
 for e in doc.modelspace().query('LWPOLYLINE[layer=="צבע"]'):
  q=g.vec(e.get_points()[0])-origin
  parts.append(f'<text x="{q[0]}" y="{maxy-q[1]}" font-family="sans-serif" font-size="{max(maxx,maxy)/65}">PAINT</text>')
 parts.append('</svg>');return ''.join(parts)
def map_review(edges,overrides,bend_parameters=None):
 unknown=[]
 for e in edges:
  key=':'.join(sorted(l['handle'] for l in e['source']))+f':F{e["parent"]}:F{e["child"]}';e['review_key']=key
  values=BendOverride(**(bend_parameters or {}).get(key,{})).model_dump(exclude_none=True)
  for field in ('radius','deduction'):
   if field in values:e[field]=values[field]
  manual_angle=values.get('angle',overrides.get(key))
  if manual_angle is not None:
   angle=float(manual_angle)
   if not math.isfinite(angle) or not 0<abs(angle)<180:raise ValueError('A signed bend rotation must be between 0 and 180 degrees.')
   e['angle']=angle;e['evidence']=[{'profile':'USER CONFIRMED','vertex':None,'angle':angle}];e['confirmed']=True
  if 'angle' not in e:
   u,n,c=g.support(e)
   unknown.append({'key':key,'bend_ids':[l['id'] for l in e['source']],'handles':[l['handle'] for l in e['source']],'parent':e['parent'],'child':e['child'],'axis':f'({u[0]:.6f}, {u[1]:.6f}, 0)','axis_coordinate':c,'reason':'No unambiguous section establishes this hinge rotation.'})
 return unknown

def bend_rows(edges):
 return [{'id':e['index'],'bend_ids':[l['id'] for l in e['source']],'parent':e['parent'],'child':e['child'],'angle':e.get('angle'),'key':e['review_key'],'source':e.get('evidence',[]),'confirmed':e.get('confirmed',False),'radius':e.get('radius'),'deduction':e.get('deduction')} for e in edges]

def extraction_data(outer,blank,lines,faces,material,edges,doc,origin):
 """Flat review geometry, available even when bend values cannot be resolved.

 A source DXF line can belong to several hinges. Export each actual shared
 boundary with its review key; never infer its location from a face bounding box.
 """
 def polygons(shape):
  return [{'outer':list(p.exterior.coords),'holes':[list(h.coords) for h in p.interiors]} for p in g.poly_parts(shape)]
 def segments(shape):
  if shape.geom_type=='LineString':return [list(shape.coords)]
  return [line for part in getattr(shape,'geoms',[]) for line in segments(part)]
 return {'version':2,'units':'mm','bounds':list(outer.bounds),'outline':polygons(blank),
  'lines':[{'id':l['id'],'handle':l['handle'],'start':l['a'],'end':l['b']} for l in lines],
  'faces':[{'id':i,'name':f'F{i}','bounds':list(f.bounds),'polygons':polygons(material[i]),
            'label_point':list(material[i].representative_point().coords[0]) if not material[i].is_empty else None} for i,f in enumerate(faces)],
  'bends':[{'key':e['review_key'],'id':e['index'],'bend_ids':[l['id'] for l in e['source']],
            'parent':e['parent'],'child':e['child'],'segments':segments(e['geom'])} for e in edges],
  'paint_labels':[g.vec(e.get_points()[0])-origin for e in doc.modelspace().query('LWPOLYLINE[layer=="צבע"]')],
  'corner_reliefs':getattr(g.partition,'corner_reliefs',[])}

def propagate_continuous_bends(faces,edges,angle_tolerance):
 """One original straight axis can bound separate tabs; preserve fold sense."""
 for e in edges:
  if 'angle' in e:continue
  handles={s['handle'] for s in e['source']}
  matches=[v for v in edges if 'angle' in v and handles.intersection(s['handle'] for s in v['source'])]
  def side(v):
   _,n,c=g.support(v)
   return np.sign(np.array(faces[v['child']].representative_point().coords[0])@n-c)
  angles=[v['angle']*side(v)*side(e) for v in matches]
  if angles and max(angles)-min(angles)<=max(angle_tolerance,1e-5):
   e['angle']=float(angles[0]);e['evidence']=[dict(ev,correspondence='same continuous original bend axis; fold sense preserved') for v in matches for ev in v.get('evidence',[])]

def viewer_data(faces,material,edges,tf,t,r,bd):
 ba=2*(r+t)-bd
 return {'units':'mm','thickness':t,'radius':r,'deduction':bd,'allowance':ba,'k_factor':(ba/(math.pi/2)-r)/t,
  'faces':[{'id':i,'polygons':[{'outer':list(p.exterior.coords),'holes':[list(h.coords) for h in p.interiors]} for p in g.poly_parts(material[i])],'rotation':tf[i][0],'translation':tf[i][1]} for i in range(len(faces))],
  'bends':[{'id':e['index'],'name':' / '.join(l['id'] for l in e['source']),'parent':e['parent'],'child':e['child'],'axis':e['axis'],'d':e['d'],'hinge':e['hinge'],'allowance':e['allowance'],'radius':e.get('radius',r),'k_factor':e.get('k_factor'),'coordinate':e['c'],'dim':e['dim'],'low':g.hinge_span(e)[0],'high':g.hinge_span(e)[1],'angle':e['angle'],'source':e['evidence']} for e in edges]}
def paint_glb(solid,tf,edges,t,r,path):
 import trimesh
 from OCP.BRepAdaptor import BRepAdaptor_Surface
 groups=collections.defaultdict(lambda:[[],[]]);counts=collections.Counter()
 for face in solid.Faces():
  typ=face.geomType();paint=False;name='Aluminium';key='metal'
  if typ=='PLANE':
   center=np.array(face.Center().toTuple());normal=np.array(face.normalAt().toTuple())
   for i,(R,T) in tf.items():
    q=R.T@(center-T)
    if abs(q[2]-t/2)<.005 and np.dot(normal,R[:,2])>.99:paint=True;name=f'Face F{i} · painted';key=f'face_{i}';break
  elif typ=='CYLINDER':
   c=BRepAdaptor_Surface(face.wrapped).Cylinder();loc=np.array(c.Location().Coord());ax=np.array(c.Axis().Direction().Coord())
   for e in edges:
    R,T=tf[e['parent']];ga=R@e['axis'];gc=R@e['center']+T
    if abs(np.dot(ax,ga))>.99999 and np.linalg.norm(np.cross(loc-gc,ga))<.005:
     paint=abs(c.Radius()-(e.get('radius',r)+t/2-t/2*e['w'][2]))<.005;name=f'Bend {e["index"]}';key=f'bend_{e["index"]}';break
  vs,ts=face.tessellate(.12,.12)
  if not ts:continue
  bucket=groups[(key,paint,name)];offset=len(bucket[0]);bucket[0].extend([v.toTuple() for v in vs]);bucket[1].extend([[a+offset,b+offset,c+offset] for a,b,c in ts])
 scene=trimesh.Scene()
 for (key,paint,name),(vs,ts) in sorted(groups.items()):
  mesh=trimesh.Trimesh(vertices=np.array(vs)*.001,faces=np.array(ts),process=False)
  color=[42,150,130,255] if paint else [179,191,193,255]
  mesh.visual=trimesh.visual.TextureVisuals(material=trimesh.visual.material.PBRMaterial(baseColorFactor=color,metallicFactor=.18 if paint else .75,roughnessFactor=.55, doubleSided=True))
  mesh.metadata={'name':name,'bend_id':int(key.split('_')[1]) if key.startswith('bend_') else None,'painted':paint}
  scene.add_geometry(mesh,node_name=key+('_paint' if paint else '_metal'),geom_name=key+('_paint' if paint else '_metal'))
 path.write_bytes(scene.export(file_type='glb'))

def run(config):
 source=Path(config['source']);out=Path(config['output']);out.mkdir(parents=True,exist_ok=True)
 configured=Parameters(**config.get('settings',{})).model_dump();settings=dict(configured);overrides=dict(config.get('overrides',{}));issues=[];report={'settings':settings,'configured_settings':configured,'issues':issues,'status':'FAILED','warnings':[]}
 overrides['parameter_overrides']=ParameterOverrides(**overrides.get('parameter_overrides',{})).model_dump(exclude_none=True)
 manual=bool(overrides.get('manual_bends'));t,r,bd=settings['thickness'],settings['radius'],settings['deduction']
 strip_tol=settings['strip_tolerance'];angle_tol=settings['angle_tolerance'];bend_model=settings['bend_model']
 enforce=tolerance_policy.ENFORCE_DRAWING_TOLERANCES
 report['tolerance_policy']={'enforced':enforce,'linear_reference_mm':strip_tol,'angular_reference_deg':angle_tol,
                             'mode':'standard' if enforce else 'experimental_no_tolerance_gates'}
 report['tolerance_deviations']=[]
 if not enforce:report['warnings'].append('Experimental build: drawing tolerance limits do not block matching or export. Inspect the measured deviations before accepting the model.')
 def checkpoint(phase,message):
  report['phase_message']=message
  print(message,flush=True)
  dump(out/'report.json',report)
  dump(out/'progress.tmp',{'phase':phase,'report':report});(out/'progress.tmp').replace(out/'progress.json')
 def issue(code,message,**extra):issues.append({'code':code,'message':message,**extra})
 def finish(status):
  report['status']=status;report['review_decisions']=overrides;dump(out/'report.json',report)
  artifacts={p.name:p.name for p in out.iterdir() if p.is_file() and p.name not in ['result.json','progress.json','progress.tmp']}
  dump(out/'result.json',{'status':status,'report':report,'artifacts':artifacts});return report
 report['conversion']={'input_format':source.suffix.lower()[1:],'status':'RUNNING' if source.suffix.lower()=='.dwg' else 'NOT_REQUIRED','engine':'ODA' if source.suffix.lower()=='.dwg' else 'Native DXF'}
 if source.suffix.lower()=='.dwg':
  checkpoint('CONVERTING','Converting DWG to DXF with ODA…')
  try:
   source=dwg.convert(source,out/'dwg');report['conversion']['status']='DONE'
  except dwg.ConverterUnavailable as e:report['conversion']['status']='UNAVAILABLE';issue('DWG_CONVERTER',str(e));return finish('NEEDS_REVIEW')
 shutil.copyfile(source,out/'flat.dxf')
 checkpoint('EXTRACTING','DXF ready. Reading contour, bends and section evidence…')
 doc=ezdxf.readfile(source);layers={l.dxf.name:sum(1 for e in doc.modelspace() if e.dxf.layer==l.dxf.name) for l in doc.layers};report['layers']=layers
 if len(doc.modelspace())>100000:raise ValueError('Drawing exceeds the 100,000-entity processing limit.')
 parameter_evidence=drawing_evidence(doc)
 if bend_model=='fixed_deduction' and parameter_evidence['deduction'].get('value') is not None:
  parameter_evidence['deduction']={'value':None,'confidence':'unknown','reason':'A 90° deduction note does not define deduction at every bend angle.'}
 settings,resolved=resolve_parameters(configured,overrides,parameter_evidence)
 report.update(settings=settings,parameter_resolution=resolved,thickness_evidence=parameter_evidence['thickness'])
 t,r,bd=settings['thickness'],settings['radius'],settings['deduction']
 section_layer=g.section_layer(doc)
 report['section_convention']={'layer':section_layer,'canonical_role':'HAT','alias_used':section_layer not in (None,'HAT')}
 missing=[l for l in ['CONTOR','KIFOF'] if not layers.get(l)]
 if section_layer is None:missing.append('HAT')
 if 'CONTOR' in missing:issue('LAYERS','Missing or empty required layer: CONTOR');return finish('NEEDS_REVIEW')
 if overrides.get('relief_radii') and not str(overrides.get('review_note','')).strip():
  issue('CORNER_RELIEF','Add a review note identifying the approved shape or dimensions for changed corner cuts.');return finish('NEEDS_REVIEW')
 try:
  d,origin,outer,blank,lines=g.read_drawing(source,overrides.get('relief_radii'));doc=d
  faces,edges,parents,order,material=g.partition(outer,blank,lines,3.)
 except ValueError as exc:
  issue('DRAWING_GEOMETRY',str(exc)+'. Correct the outline or bend positions in CAD and replace the drawing. Numeric bend values cannot supply missing geometry.')
  return finish('NEEDS_REVIEW')
 report['relief_circles']=g.read_drawing.relief_circles
 report['relief_cut_area_removed_mm2']=g.read_drawing.relief_removed_area
 used={l['handle'] for e in edges for l in e['source']}
 unassigned=[l['id'] for l in lines if l['handle'] not in used]
 # A narrowly bounded proposal, never automatic manufacturing approval:
 # both ends must reach the outline along the same axis within two thicknesses.
 extensions=[];limit=max(3.,2*settings['thickness'])
 for l in lines:
  if l['id'] not in unassigned:continue
  gaps=[];u=g.unit(l['b']-l['a'])
  for q,sign in [(l['a'],-1),(l['b'],1)]:
   ray=LineString([q,q+sign*limit*u]);hit=ray.intersection(outer.boundary)
   gaps.append(float(Point(q).distance(hit)) if not hit.is_empty else float('inf'))
  if 3.<max(gaps)<=limit and min(gaps)<=3.:
   extension=max(gaps)+g.GRID;l['relief_extension']=extension
   extensions.append({'bend_id':l['id'],'handle':l['handle'],'endpoint_gaps_mm':gaps,'proposed_extension_mm':extension,'standard_limit_mm':3.})
 if extensions:
  faces,edges,parents,order,material=g.partition(outer,blank,lines,3.)
  used={l['handle'] for e in edges for l in e['source']};unassigned=[l['id'] for l in lines if l['handle'] not in used]
 report['relief_extension_proposals']=extensions
 report['unassigned_axes']=unassigned
 report['corner_relief_proposals']=g.partition.corner_reliefs
 report['geometry_normalization']=g.read_drawing.repairs
 report['contour_annotations']=g.read_drawing.annotations
 report.update(flat_width=outer.bounds[2],flat_height=outer.bounds[3],flat_area=blank.area,bend_lines=len(lines),physical_bends=len(edges),faces=len(faces),source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),origin=origin.tolist())
 report['unresolved_bends']=map_review(edges,overrides.get('bend_angles',{}),overrides.get('bend_parameters',{}))
 report['bends']=bend_rows(edges)
 (out/'extraction.svg').write_text(extract_svg(outer,blank,lines,doc,origin))
 if any(c['changed'] for c in g.read_drawing.relief_circles):
  shutil.copyfile(source,out/'original_flat.dxf');doc.saveas(out/'flat.dxf')
 else:shutil.copyfile(source,out/'flat.dxf')
 dump(out/'extraction.json',extraction_data(outer,blank,lines,faces,material,edges,doc,origin))
 checkpoint('EXTRACTING','Rendered numbered bend axes and contour. Checking drawing parameters…')
 for field,record in resolved.items():
  if record['needs_review'] and record['evidence'].get('confidence')=='invalid':
   issue('PARAMETER_INVALID',record['message'],field=field)
 if issues:return finish('NEEDS_REVIEW')
 if 'KIFOF' in missing:
  issue('LAYERS','No bend axes were found. Add KIFOF bend positions in CAD and replace the drawing; a numeric angle cannot supply a missing axis.');return finish('NEEDS_REVIEW')
 if 'HAT' in missing and not manual:
  issue('SECTION_EVIDENCE','Section drawings are missing. Enter or confirm the bend angles in the flat-pattern viewer and save to rebuild, or add the sections in CAD. No separate data file is required.');return finish('NEEDS_REVIEW')
 if unassigned:
  issue('UNASSIGNED_AXES','These bend entities do not bound a hinge after the 3 mm relief extension: '+', '.join(unassigned)+'. Check endpoint gaps and contour alignment; this alone does not prove an interior rib.');return finish('NEEDS_REVIEW')
 evidence=parameter_evidence['thickness']
 if doc.units not in [0,4]:issue('UNITS',f'DXF unit code {doc.units} is not millimetres. Convert units in CAD before upload.');return finish('NEEDS_REVIEW')
 report['units_evidence']='DXF millimetres' if doc.units==4 else 'Unitless DXF; interpreted in millimetres under workspace convention'
 if settings['input_type']!='flat_pattern':issue('INPUT_TYPE','This engine requires a developed flat pattern. Folded-dimension drawings need an explicit developed-pattern export.');return finish('NEEDS_REVIEW')
 profs=[]
 if not manual:
  try:profs=g.profiles(doc,origin,t)
  except ValueError as exc:
   issue('SECTION_EVIDENCE',str(exc)+'. Correct the drawing or use confirmed manual bend values.');return finish('NEEDS_REVIEW')
  report['duplicate_section_details']=g.profiles.duplicates
  if not profs:
   issue('SECTION_EVIDENCE','No usable section profiles were found. Supply confirmed bend values or repair the sections in CAD.');return finish('NEEDS_REVIEW')
 if not manual:
  measured=right_angle_deduction(faces,outer,edges,profs,t,strip_tol,angle_tol)
  if measured['value'] is not None:
   previous=parameter_evidence['deduction']
   if previous.get('confidence') not in ('conflict','invalid'):
    if previous.get('value') is not None and abs(previous['value']-measured['value'])>.01:
     parameter_evidence['deduction']={'value':None,'confidence':'conflict','reason':'The deduction note and section dimensions disagree.', 'candidates':[previous['value'],measured['value']],'note_evidence':previous,'geometry_evidence':measured}
    else:parameter_evidence['deduction']=measured
   settings,resolved=resolve_parameters(configured,overrides,parameter_evidence)
   report.update(settings=settings,parameter_resolution=resolved)
   t,r,bd=settings['thickness'],settings['radius'],settings['deduction']
 ba=2*(r+t)-bd;k=(ba/(math.pi/2)-r)/t
 if bend_model=='constant_k' and not 0<k<1 and not overrides.get('bend_parameters'):
  issue('BEND_PARAMETERS',f'Panel settings t={t:g} mm, r={r:g} mm, BD90={bd:g} mm imply K={k:.6g}; constant-K mode requires 0 < K < 1. Correct the values or choose the fixed-deduction shape model.',thickness_mm=t,inside_radius_mm=r,deduction_90_mm=bd,calculated_k=k,deduction_range_exclusive_mm=[2*(r+t)-(math.pi/2)*(r+t),2*(r+t)-(math.pi/2)*r])
  return finish('NEEDS_REVIEW')
 report['validation_scope']='user_confirmed_bends_and_solid_geometry' if manual else 'drawing_sections_and_solid_geometry'
 if manual:report['warnings'].append('Section matching was replaced by user-confirmed bend values. Section dimensions and paint orientation are not independently verified.')
 report['section_profiles']=[{'name':p['name'],'layer':p['layer'],'paint_marker':p['paint_handle'],'points':p['points'],'main_segment':p['main'],'wall_pairs':[{'handles':s['handles'],'spacing_mm':s['wall_spacing_mm'],'parallel_error_deg':s['parallel_error_deg']} for s in p['segments']]} for p in profs]
 general=manual or bool(overrides.get('bend_angles') or overrides.get('bend_parameters') or overrides.get('section_choices')) or section_layer!='HAT' or any(not l['orthogonal'] for l in lines) or any(abs(g.unit(a)@g.unit(b))>math.sin(math.radians(.01)) for p in profs for a,b in zip(np.diff(p['points'],axis=0),np.diff(p['points'],axis=0)[1:]))
 report['bend_parameter_model']={'method':bend_model,'deduction_reference_angle_deg':90 if bend_model=='constant_k' else None,'k_factor_90':k,'other_angles':'constant K derived from the 90-degree calibration' if bend_model=='constant_k' else 'Explicit fixed deduction at each bend angle; geometric shape model'}
 report['matching_tolerances']={'strip_mm':strip_tol,'angle_deg':angle_tol,'topology_grid_mm':g.GRID}
 mapped=[]
 if not manual:
  if general:mapped=map_details(faces,outer,edges,profs,t,r,bd,strip_tol,angle_tol,bend_model,overrides.get('section_choices'),enforce)
  else:
   try:mapped=g.map_sections(doc,origin,faces,outer,edges,profs,t,r,bd,strip_tol,enforce)
   except ValueError as exc:
    if str(exc)!='Unmapped hinge; no default direction is allowed':
     issue('SECTION_CORRESPONDENCE',str(exc)+'. Adjust the matching tolerance or supply confirmed values.')
   mapped=[{'profile':p['name'],'status':'PASS' if 'trace' in p else 'NEEDS_REVIEW','cut_axis':'Y' if p['main_dim']==0 else 'X','coordinate':p.get('cut_coordinate'),'method':p.get('mapping'),'reason':'Section needs review.' if 'trace' not in p else '', 'tolerance_bypassed':p.get('tolerance_bypassed',False),'max_strip_error_mm':p.get('max_mapping_error')} for p in profs]
 report['section_mapping']=mapped
 for row in mapped:
  if row.get('tolerance_bypassed'):report['tolerance_deviations'].append({'code':'SECTION_MATCH','profile':row['profile'],'message':row.get('matching_policy','Section matched without the dimensional cutoff.')})
 propagate_continuous_bends(faces,edges,angle_tol)
 # Do not overwrite selected values after mapping; they participated in conflict
 # checks above. Keep every unresolved hinge visible even when a section fails.
 unknown=map_review(edges,{})
 report['unresolved_bends']=unknown;report['bends']=bend_rows(edges)
 unresolved=[m for m in mapped if m['status']!='PASS']
 if unresolved:
  reasons='; '.join(f"{m['profile']}: {m.get('reason','Review required')}" for m in unresolved)
  issue('SECTION_CORRESPONDENCE',f'{len(unresolved)} section profiles need review. {reasons}',profiles=[m['profile'] for m in unresolved])
 if unknown:issue('DIRECTIONS',f'{len(unknown)} bend rotations are missing. Choose their signed angles in drawing review; the default angle alone does not establish direction.')
 for e in edges:
  if 'angle' not in e:continue
  try:
   radius,deduction,developed,implied_k=hinge_parameters(e,t,r,bd,bend_model)
   if bend_model=='fixed_deduction' and not 0<implied_k<1:
    report['warnings'].append(f"{' / '.join(s['id'] for s in e['source'])}: fixed deduction defines a geometric shape outside the constant-K material model (K={implied_k:.3f}).")
  except ValueError as exc:issue('BEND_PARAMETERS',str(exc),bend_key=e['review_key'])
 deduction=infer_deduction(faces,outer,profs,t,strip_tol) if not general else {'value':bd if manual or not (unresolved or unknown) else None,'confidence':'user_confirmed' if manual else 'unknown' if unresolved or unknown else 'settings_matched_to_sections','source':'User-confirmed shape parameters' if manual else 'Section correspondence is incomplete; deduction is not independently established.' if unresolved or unknown else 'Section and local-detail dimensions matched; no independent deduction measurement'}
 report['deduction_evidence']=deduction
 report['input_evidence']={'classification':'user_confirmed_flat_pattern' if manual else 'flat_pattern_supported' if deduction['value'] is not None else 'not_proven','reason':'User-confirmed flat pattern and bend values' if manual else 'Matched section / flat-strip dimensions' if deduction['value'] is not None else 'Input interpretation requires user confirmation'}
 if deduction['value'] is not None and abs(deduction['value']-bd)>strip_tol:
  message=f"Section dimensions support {deduction['value']:g} mm deduction; panel setting is {bd:g} mm."
  if enforce:
   issue('DEDUCTION',message,field='deduction',suggested=deduction['value']);return finish('NEEDS_REVIEW')
  report['tolerance_deviations'].append({'code':'DEDUCTION','message':message,'drawing_value':deduction['value'],'used_value':bd})
 # Report missing values as editable review fields. Section matching is allowed
 # to run first so one pass exposes all unresolved geometry and parameters.
 if not (unresolved or unknown) and deduction.get('confidence')=='drawing' and resolved['deduction']['source']=='unresolved' and parameter_evidence['deduction'].get('confidence') not in ('conflict','invalid') and abs(deduction['value']-bd)<=strip_tol:
  resolved['deduction'].update(source='drawing',drawing_value=deduction['value'],needs_review=False,message=deduction['source']+'.',evidence=deduction)
 for field,record in resolved.items():
  if field in ('radius','deduction') and edges and all(field in e for e in edges):
   record.update(source='per_bend',needs_review=False,message='Each bend has an explicit value; this fallback is unused.')
  if record['needs_review']:
   issue('PARAMETER_REQUIRED',f'{field.capitalize()}: '+record['message'],field=field,suggested=record['value'])
 if issues:return finish('NEEDS_REVIEW')
 paint_points=[g.vec(p)-origin for e in doc.modelspace().query('LWPOLYLINE[layer=="צבע"]') for p in e.get_points()]
 if not general and (not paint_points or not all(faces[0].buffer(.01).covers(Point(p)) for p in paint_points)):issue('PAINT','Paint marker does not identify the selected main face unambiguously.');return finish('NEEDS_REVIEW')
 if general:report['paint_evidence']={'source':'User review: root +Z is the finish reference' if manual else 'World-coordinate Zeva section markers; global base +Z is the finish reference','markers':[p['paint_handle'] for p in profs]}
 checkpoint('BUILDING','Section mapping complete. Building and validating the folded solid…')
 tf=g.transforms(faces,edges,order,t,r,bd,bend_model);solid,trimmed,stats=g.build_cad(faces,material,edges,tf,t,r,bd,3.,out,settings['bend_end_mode'])
 if not stats['valid'] or stats['solid_count']!=1:raise ValueError('CAD validation failed: expected one valid connected solid.')
 if stats['self_intersection_check']['status']!='PASS':issue('SELF_INTERSECTION','Folded faces intersect each other. Review the reported corner contacts and relief cuts before final export.')
 normal_profs=normal_instances(profs) if general else profs
 checks,details=g.check_sections(solid,normal_profs,faces,tf,t,r,out,material,strip_tol,max(angle_tol,.001),edges)
 local_checks=check_local_profiles(profs,edges,tf,t,r,bd,strip_tol,angle_tol,bend_model) if general else []
 checks.extend(local_checks)
 if local_checks:
  report['drawing_convention']={'name':'repeated transverse details and corroborated local edge profiles',
    'validation_scope':'Transverse documented chains are checked against actual BREP cuts. Side profiles use local edge lengths and relative rotations, not full plane cuts.',
    'reference':'Convention confirmed by the customer against the reconstructed folded panel.'}
  dump(out/'local_profile_checks.json',local_checks)
 unfold=g.unfold_solid(solid,tf,trimmed,edges,blank,t,r,bd,out,strip_tol,angle_tol)
 report.update(solid=stats,bbox=stats['bbox_mm'],section_checks=checks,unfold_check=unfold,k_factor=k,allowance=ba,corner_contacts=g.partition.contacts)
 report['bends']=bend_rows(edges)
 if any(c['chain_status']!='PASS' for c in checks) or unfold['status']!='PASS':
  if enforce or tolerance_policy.structural_validation_failed(checks,unfold):
   issue('VALIDATION','Solid generated but section or local outline checks failed. Inspect validation results.')
  else:
   report['tolerance_deviations'].append({'code':'VALIDATION','message':'Section/outline/angle differences are retained in the report but do not block this experimental export.'})
 for c in checks:
  if c['chain_status']=='PASS' and c['full_plane_status']!='PASS' and not local_checks and not overrides.get('accept_partial_sections'):issue('PARTIAL_SECTION',f"{c['profile']} matches its documented chain, but the complete plane includes additional sheet regions. Confirm this is a partial detail.")
 if extensions and not overrides.get('accept_relief_extensions'):
  issue('RELIEF_EXTENSION','Draft reconstruction extends '+', '.join(f"{e['bend_id']} across a {max(e['endpoint_gaps_mm']):g} mm endpoint gap" for e in extensions)+'. This exceeds the standard 3 mm rule. Inspect the drawing and explicitly approve these endpoint extensions before final export.')
 if g.partition.corner_reliefs and not overrides.get('accept_corner_reliefs'):
  issue('CORNER_RELIEF',f"Draft omits {sum(p['area_mm2'] for p in g.partition.corner_reliefs):.4f} mm² of small corner regions with no original bend axis. Review the highlighted regions and confirm their removal, or repair CONTOR in CAD.")
 dump(out/'viewer.json',viewer_data(faces,trimmed,edges,tf,t,r,bd));paint_glb(solid,tf,edges,t,r,out/'panel.glb')
 rows=[]
 for e in edges:
  rows.append({'bend_id':' / '.join(l['id'] for l in e['source']),'parent':e['parent'],'child':e['child'],'angle':abs(e['angle']),'signed_angle':e['angle'],'inside_radius_mm':e['radius'],'deduction_mm':e['deduction'],'bend_allowance_mm':e['allowance'],'bend_model':bend_model,'axis':str(e['axis'].tolist()),'source':'; '.join(f"{v['profile']} vertex {v.get('vertex','—')}" for v in e['evidence']),'confidence':'user confirmed' if e.get('confirmed') else 'drawing','status':'NEEDS_REVIEW' if issues else 'PASS' if enforce else 'EXPERIMENTAL'})
 with (out/'fold_table.csv').open('w',newline='') as f:w=csv.DictWriter(f,fieldnames=rows[0]);w.writeheader();w.writerows(rows)
 import cadquery as cq
 cq.exporters.export(solid,str(out/'panel.stl'))
 if dwg.available():
  try:shutil.copyfile(dwg.convert(out/'flat.dxf',out/'dwg-export','DWG'),out/'flat.dwg')
  except Exception as e:report['dwg_export_warning']=str(e)
 return finish('NEEDS_REVIEW' if issues else 'PASS')
if __name__=='__main__':
 config=json.loads(Path(sys.argv[1]).read_text())
 try:run(config)
 except Exception as e:
  out=Path(config['output']);out.mkdir(parents=True,exist_ok=True)
  message=f'{type(e).__name__}: {str(e)}'
  report=json.loads((out/'report.json').read_text()) if (out/'report.json').exists() else {}

  if report.get('conversion',{}).get('status')=='RUNNING':report['conversion']['status']='FAILED'
  report.update(status='FAILED',error=message);report.setdefault('issues',[]).append({'code':'GEOMETRY','message':message});dump(out/'report.json',report)
  dump(out/'result.json',{'status':'FAILED','report':report,'artifacts':{p.name:p.name for p in out.iterdir() if p.is_file() and p.name not in ['result.json','progress.json','progress.tmp']}})
  traceback.print_exc();sys.exit(1)
