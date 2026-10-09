"""One isolated job. Evidence first; explicit review decisions precede solid generation."""
import sys, json, math, copy, io, csv, shutil, traceback, hashlib, collections, html
from pathlib import Path
import numpy as np
import ezdxf
from shapely.geometry import Point,LineString
from . import geometry as g
from . import dwg
from .detail_mapping import map_details, normal_instances, check_local_profiles
from .review import prepare_review, geometry_payload
from .panel_angle import apply_panel_angle, panel_angle_summary, recover_directions
from .corner_review import continuation_candidates
from .angle_evidence import annotate_profiles, attach_hinge_dimensions
from .bend_rules import DEFAULTS, apply_directions, direction_factor, parameter_check
def dump(path,obj):
 def clean(x):
  if isinstance(x,np.ndarray):return clean(x.tolist())
  if isinstance(x,dict):return {k:clean(v) for k,v in x.items()}
  if isinstance(x,(list,tuple)):return [clean(v) for v in x]
  if isinstance(x,(float,np.floating)) and not math.isfinite(x):return None
  if isinstance(x,np.generic):return x.item()
  return x
 path.write_text(json.dumps(clean(obj),indent=2,allow_nan=False))
def thickness_evidence(doc):
 from .wall_pairing import parallel_pair, ends_supported
 lines=[]
 for e in g.section_lines(doc):
  a,b=g.vec(e.dxf.start),g.vec(e.dxf.end)
  if np.linalg.norm(b-a)<8:continue
  u,n,c=g.line_frame(a,b)
  lines.append({'a':a,'b':b,'u':u,'normal':n,'c':c})
 votes=collections.Counter()
 for i,l in enumerate(lines):
  for m in lines[i+1:]:
   pair=parallel_pair(l,m)
   if pair is None:continue
   a,b=pair['rows'];dist=pair['wall_spacing_mm']
   if .5<=dist<=10 and min(a['hi'],b['hi'])-max(a['lo'],b['lo'])>5 and ends_supported(pair,lines,dist):
    votes[round(dist,2)]+=1
 if not votes:return {'value':None,'confidence':'unknown','reason':'No repeated paired section-wall spacing.'}
 best=votes.most_common();v,count=best[0]
 if count<3 or (len(best)>1 and best[1][1]>=count*.8):return {'value':None,'confidence':'unknown','candidates':dict(votes)}
 return {'value':v,'confidence':'drawing','paired_segments':count,'source':'Repeated HAT wall separation'}
def infer_deduction(faces,outer,profiles,t):
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
  if err<=.5:gains.append(gain);residuals.append(err)
 if not gains or max(gains)-min(gains)>.5:return {'value':None,'confidence':'unknown','reason':'Sections do not establish a consistent deduction.'}
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
 for l in lines:
  c=(l['a']+l['b'])/2;fs=max(maxx,maxy)/75
  parts.append(f'<text x="{c[0]+5}" y="{maxy-c[1]-5}" font-family="monospace" font-size="{fs:.2f}" fill="#995519">{l["id"]}</text>')
 for e in doc.modelspace().query('LWPOLYLINE[layer=="צבע"]'):
  q=g.vec(e.get_points()[0])-origin
  parts.append(f'<text x="{q[0]}" y="{maxy-q[1]}" font-family="sans-serif" font-size="{max(maxx,maxy)/65}">PAINT</text>')
 parts.append('</svg>');return ''.join(parts)
def map_review(edges,overrides):
 unknown=[]
 for e in edges:
  key=':'.join(sorted(l['handle'] for l in e['source']))+f':F{e["parent"]}:F{e["child"]}';e['review_key']=key
  if key in overrides:
   if 'angle' in e and not any(ev.get('profile')=='USER CONFIRMED' for ev in e.get('evidence',[])):
    e['source_angle']=e['angle'];e['source_evidence']=copy.deepcopy(e.get('evidence',[]))
   angle=float(overrides[key])
   if not math.isfinite(angle) or not 0<abs(angle)<180:raise ValueError('A signed bend rotation must be between 0 and 180 degrees.')
   e['angle']=angle;e['evidence']=[{'profile':'USER CONFIRMED','vertex':None,'angle':angle}];e['confirmed']=True
  if 'angle' not in e:
   u,n,c=g.support(e)
   unknown.append({'key':key,'bend_ids':[l['id'] for l in e['source']],'handles':[l['handle'] for l in e['source']],'parent':e['parent'],'child':e['child'],'axis':f'({u[0]:.6f}, {u[1]:.6f}, 0)','axis_coordinate':c,'reason':'No unambiguous section establishes this hinge rotation.'})
 return unknown

def viewer_data(faces,material,edges,tf,t,r,bd):
 ba=2*(r+t)-bd
 bends=[]
 for e in edges:
  u,n,c=g.support(e);axis=g.lift(u);h=g.lift(n*c)
  d=g.lift(n)*np.sign(np.array(faces[e['child']].representative_point().coords[0])@n-c)
  angle=e.get('angle');allowance=g.bend_allowance(t,r,bd,angle) if angle is not None else 0.
  if tf is None and angle is not None and not parameter_check(t,r,bd,angle)['constructible']:allowance=0.
  lo,hi=g.hinge_span(e)
  bend={'id':e['index'],'name':' / '.join(l['id'] for l in e['source']),'parent':e['parent'],'child':e['child'],
    'axis':axis,'d':d,'hinge':h,'allowance':allowance,'k_factor':parameter_check(t,r,bd,angle)['k_factor'] if angle is not None else None,'coordinate':e['c'],'dim':e['dim'],'low':lo,'high':hi,
    'angle':angle,'included_angle':180-abs(angle) if angle is not None else None,
    'status':'KNOWN' if angle is not None else 'NEEDS_REVIEW','source':e.get('evidence',[])}
  # Both surfaces at each tangent to the bend, in the final solid's mm frame.
  # These are graphics only; they are never added to the manufacturing BREP.
  if tf is not None:
   bend['folded_lines']=[{'face':face,'surface':side,'points':[g.apply_tf(tf[face],h+d*offset+axis*x+np.array([0,0,side*t/2])) for x in (lo,hi)]}
     for face,offset in ((e['parent'],-allowance/2),(e['child'],allowance/2)) for side in (-1,1)]
  bends.append(bend)
 return {'units':'mm','mode':'folded' if tf is not None else 'flat_review','angle_convention':'signed rotation from flat; included angle = 180 - abs(rotation)',
  'thickness':t,'radius':r,'deduction':bd,'allowance':ba,'k_factor':(ba/(math.pi/2)-r)/t,'deduction_mode':'fixed_per_bend',
  'faces':[{'id':i,'polygons':[{'outer':list(p.exterior.coords),'holes':[list(h.coords) for h in p.interiors]} for p in g.poly_parts(material[i])],
            **({'rotation':tf[i][0],'translation':tf[i][1]} if tf is not None else {})} for i in range(len(faces))],
  'bends':bends}
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
     paint=abs(c.Radius()-(r+t/2-t/2*e['w'][2]))<.005;name=f'Bend {e["index"]}';key=f'bend_{e["index"]}';break
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
 for name in ('panel.step','panel.stl','panel.glb','review_model.step','review_model.stl','viewer.json','verification.json','report.json','result.json','fold_table.csv','bend_traceability.json','section_checks.csv','section_segment_checks.csv','local_profile_checks.json','section_comparison.png'):
  target=out/name
  if target.exists() and target.resolve()!=source.resolve():target.unlink()
 settings={**DEFAULTS,**config.get('settings',{})};overrides=config.get('overrides',{});issues=[];report={'settings':settings,'issues':issues,'status':'FAILED'}
 mode=overrides.get('validation_mode','dimensional')
 if mode not in ('dimensional','physical'):raise ValueError('Unknown validation mode')
 report['validation_mode']=mode
 report['warnings']=[]
 tolerance=float(overrides.get('strip_tolerance_mm',.5))
 if not math.isfinite(tolerance) or tolerance<=0:raise ValueError('Strip tolerance must be a finite positive value in mm')
 report['strip_tolerance_mm']=tolerance
 report['original_source_sha256']=hashlib.sha256(source.read_bytes()).hexdigest()
 code_digest=hashlib.sha256()
 for code_file in sorted(Path(__file__).parent.glob('*.py')):
  code_digest.update(code_file.name.encode());code_digest.update(code_file.read_bytes())
 report['engine_fingerprint']=code_digest.hexdigest()
 panel_angle=overrides.get('panel_bend_angle_deg')
 apply_panel_angle([],panel_angle) # validate direct engine callers too
 preview_requested=bool(overrides.get('build_review_model') or panel_angle is not None or overrides.get('bend_directions'));edges=None;profs=[];mapped=[]
 def checkpoint(phase,message):
  report['phase_message']=message
  print(message,flush=True)
  dump(out/'report.json',report)
  dump(out/'progress.tmp',{'phase':phase,'report':report});(out/'progress.tmp').replace(out/'progress.json')
 def issue(code,message,**extra):issues.append({'code':code,'message':message,**extra})
 def finish(status):
  if edges:
   from .section_diagnostics import bend_traceability
   trace=bend_traceability(faces,edges,profs,mapped)
   if not profs:
    upstream=[{'code':i['code'],'message':i['message']} for i in issues if i['code'] in ('SECTION_EVIDENCE','LAYERS')]
    for row in trace:
     if row['status']=='NEEDS_REVIEW':row['reasons'].extend(upstream)
   report['bend_traceability']=trace
   report['traceability_summary']={name:sum(b['status']==name for b in trace) for name in ('RESOLVED_FROM_DRAWING','OPERATOR_OVERRIDE','NEEDS_REVIEW')}
   dump(out/'bend_traceability.json',trace)
   by_key={b['key']:b for b in trace}
   for unknown_bend in report.get('unresolved_bends',[]):
    evidence=by_key.get(unknown_bend.get('key'))
    if evidence:
     unknown_bend['reasons']=evidence['reasons']
     unknown_bend['reason']='; '.join(r['message'] for r in evidence['reasons'])
  if status=='NEEDS_REVIEW' and edges and not (out/'viewer.json').exists():
   dump(out/'viewer.json',viewer_data(faces,material,edges,None,settings['thickness'],settings['radius'],settings['deduction']))
  bends=report.get('bends',[])
  for b in bends:
   e=next((e for e in (edges or []) if e['index']==b['id']),None)
   if e is not None:
    b.update(parent=e['parent'],child=e['child'],angle=e.get('angle'),source=e.get('evidence',[]))
    provenance=next(row for row in report['bend_traceability'] if row['hinge']==e['index'])
    b['traceability_status']=provenance['status'];b['unresolved_reasons']=provenance['reasons']
    b['direction']=('up' if b['angle']*direction_factor(e,faces)>0 else 'down') if b.get('angle') is not None else overrides.get('bend_directions',{}).get(b.get('key'))
    detected=e.get('source_angle',e.get('angle') if not any(v.get('profile') in ('PANEL ANGLE','USER DIRECTION','USER CONFIRMED') for v in e.get('evidence',[])) else None)
    b['detected_direction']=('up' if detected*direction_factor(e,faces)>0 else 'down') if detected is not None else None
  report['panel_bend_angle']=panel_angle_summary(bends,panel_angle)
  report['angle_review']={
   'policy':'drawing_first_explicit_fallback',
   'evidence_checked':report.get('angle_evidence_checked',False),
   'detected':sum(b['angle'] is not None and not any(v.get('profile') in ('USER CONFIRMED','PANEL ANGLE') for v in b['source']) for b in bends),
   'manual':sum(any(v.get('profile') in ('USER CONFIRMED','PANEL ANGLE') for v in b['source']) for b in bends),
   'unresolved':sum(b['angle'] is None for b in bends),
   'fallback_magnitude_deg':90,
   'fallback_requires_confirmation':True,
   'message':'Drawing angles take priority. One panel included-angle field fills missing magnitudes; missing direction or conflicting evidence stays under review.'}
  from .solid_validation import export_verification
  verification=export_verification(report,status,out)
  if status=='PASS' and verification['status']!='VERIFIED':
   status='NEEDS_REVIEW'
   issue('VERIFICATION_INCOMPLETE','Required validation checks are missing or failed: '+', '.join(k for k,v in verification['checks'].items() if not v))
  report['verification']=verification
  report['status']=status;report['review_decisions']=overrides
  report['validation_policy']={'strip_tolerance_mm':tolerance,'default_strip_tolerance_mm':.5,
   'partial_sections_accepted':bool(overrides.get('accept_partial_sections')),
   'relief_extensions_accepted':bool(overrides.get('accept_relief_extensions')),
   'review_model_requested':preview_requested,
   'validation_mode':mode,
   'dimensional_verified':verification['status']=='VERIFIED',
   'physical_unfolding':verification['physical_unfolding'],
   'manufacturing_ready':False,
   'limitations':['Checks validate the supplied drawing and selected parameters; PASS does not prove equivalence to a client reference STEP.']}
  dump(out/'report.json',report)
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
 doc=ezdxf.readfile(source)
 if len(doc.modelspace())>100000:raise ValueError('Drawing exceeds the 100,000-entity processing limit.')
 from .drawing_normalization import normalize
 report['entity_normalization']=normalize(doc)
 layers={l.dxf.name:sum(1 for e in doc.modelspace() if e.dxf.layer==l.dxf.name) for l in doc.layers};report['layers']=layers
 if len(doc.modelspace())>100000:raise ValueError('Drawing exceeds the 100,000-entity processing limit.')
 section_layer=g.section_layer(doc)
 report['section_convention']={'layer':section_layer,'canonical_role':'HAT','alias_used':section_layer not in (None,'HAT')}
 missing=[l for l in ['CONTOR','KIFOF'] if not layers.get(l)]
 if section_layer is None:missing.append('HAT')
 if 'CONTOR' in missing:issue('LAYERS','Missing or empty required layer: CONTOR');return finish('NEEDS_REVIEW')
 d,origin,outer,blank,lines=g.read_drawing(source,doc)
 if not lines and 'KIFOF' not in missing:missing.append('KIFOF')
 faces,edges,parents,order,material=g.partition(outer,blank,lines,3.)
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
 report['geometry_normalization']=g.read_drawing.repairs
 report['contour_annotations']=g.read_drawing.annotations
 report.update(flat_width=outer.bounds[2],flat_height=outer.bounds[3],flat_area=blank.area,bend_lines=len(lines),physical_bends=len(edges),faces=len(faces),source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),origin=origin.tolist())
 report['angular_annotations']=annotate_profiles(doc,origin,[],settings['thickness'])
 report['hinge_extensions']=g.partition.extensions
 report['review_geometry']=geometry_payload(faces,edges,material)
 report['unresolved_bends']=map_review(edges,overrides.get('bend_angles',{}))
 report['bends']=[{'id':e['index'],'bend_ids':[l['id'] for l in e['source']],'parent':e['parent'],'child':e['child'],'angle':e.get('angle'),'key':e['review_key'],'source':e.get('evidence',[]),'source_angle':e.get('source_angle',None if any(v.get('profile')=='USER CONFIRMED' for v in e.get('evidence',[])) else e.get('angle')),'drawing_dimensions':e.get('drawing_dimensions',[]),'detected_angle':e.get('detected_angle'),'confirmed':e.get('confirmed',False)} for e in edges]
 (out/'extraction.svg').write_text(extract_svg(outer,blank,lines,doc,origin));shutil.copyfile(source,out/'flat.dxf')
 extract={'bounds':list(outer.bounds),'lines':[{'id':l['id'],'handle':l['handle'],'start':l['a'],'end':l['b']} for l in lines],'faces':[{'id':i,'bounds':list(f.bounds)} for i,f in enumerate(faces)]};dump(out/'extraction.json',extract)
 checkpoint('EXTRACTING','Rendered numbered bend axes and contour. Checking drawing parameters…')
 if missing:
  report['angle_evidence_checked']=section_layer is None
  issue('LAYERS','Missing or empty required layers: '+', '.join(missing)+'. A folded model cannot be inferred without bend and section evidence; explicit rotations can create an unvalidated review model.')
  if not preview_requested or 'KIFOF' in missing:return finish('NEEDS_REVIEW')
 if unassigned:
  issue('UNASSIGNED_AXES','These bend entities do not bound a hinge after the 3 mm relief extension: '+', '.join(unassigned)+'. Check endpoint gaps and contour alignment; this alone does not prove an interior rib.');return finish('NEEDS_REVIEW')
 evidence=thickness_evidence(doc);report['thickness_evidence']=evidence
 if evidence['value'] is not None and abs(evidence['value']-settings['thickness'])>.1:
  issue('THICKNESS',f"Drawing wall spacing is {evidence['value']:g} mm; panel thickness is {settings['thickness']:g} mm.",field='thickness',suggested=evidence['value']);return finish('NEEDS_REVIEW')
 if doc.units not in [0,4]:issue('UNITS',f'DXF unit code {doc.units} is not millimetres. Convert units in CAD before upload.');return finish('NEEDS_REVIEW')
 report['units_evidence']='DXF millimetres' if doc.units==4 else 'Unitless DXF; interpreted in millimetres under workspace convention'
 if settings['input_type']!='flat_pattern':issue('INPUT_TYPE','This engine requires a developed flat pattern. Folded-dimension drawings need an explicit developed-pattern export.');return finish('NEEDS_REVIEW')
 t,r,bd=settings['thickness'],settings['radius'],settings['deduction'];ba=2*(r+t)-bd;k=(ba/(math.pi/2)-r)/t
 report['bend_parameter_model']={'deduction_mode':'fixed_per_bend','deduction_mm':bd,'inside_radius_mm':r,'k_factor':'calculated per bend; not a global constant'}
 for e in edges:
  for field in ('angle','evidence','confirmed'):e.pop(field,None)
 report['angle_evidence_checked']=True
 try:profs=g.profiles(doc,origin,t)
 except ValueError as exc:
  issue('SECTION_EVIDENCE',str(exc))
  if not preview_requested:return finish('NEEDS_REVIEW')
  profs=[]
 report['angular_annotations']=annotate_profiles(doc,origin,profs,t)
 report['section_profiles']=[{'name':p['name'],'layer':p['layer'],'paint_marker':p['paint_handle'],'points':p['points'],'main_segment':p['main'],'wall_pairs':[{'handles':s['handles'],'spacing_mm':s['wall_spacing_mm'],'spacing_range_mm':s.get('spacing_range_mm'),'parallel_error_deg':s['parallel_error_deg'],'endpoint_recovery':s.get('endpoint_recovery',[])} for s in p['segments']]} for p in profs]
 general=not profs or section_layer!='HAT' or any(not l['orthogonal'] for l in lines) or any(abs(g.unit(a)@g.unit(b))>math.sin(math.radians(.01)) for p in profs for a,b in zip(np.diff(p['points'],axis=0),np.diff(p['points'],axis=0)[1:]))
 report['review_geometry']=geometry_payload(faces,edges,material)
 if not general:
  trial=copy.deepcopy(profs)
  try:
   mapped=g.map_sections(doc,origin,faces,outer,edges,trial,t,r,bd,tolerance);profs=trial
  except ValueError as exc:
   # Keep explicit section-marker mapping when it succeeds; otherwise expose
   # generic correspondence and overrides instead of a terminal legacy error.
   report['legacy_mapping_review']=str(exc)
   if str(exc)=='Unmapped hinge; no default direction is allowed':
    # Matched documented chains remain valid; remaining tabs may have saved
    # explicit rotations. Do not discard those chains during generic fallback.
    profs=trial;mapped=[]
   else:
    general=True
    for e in edges:e.pop('angle',None);e.pop('evidence',None)
 if general:
  mapped=map_details(faces,outer,edges,profs,t,r,bd,tolerance)
  catalog,review_errors=prepare_review(faces,outer,edges,profs,mapped,t,r,bd,overrides.get('section_choices',{}),tolerance)
  report['review_catalog']=catalog
  report['review_geometry']=geometry_payload(faces,edges,material)
  for message in review_errors:issue('REVIEW_CONFLICT',message)
  report['section_mapping']=mapped
  from .section_diagnostics import explain_unmapped_hinges
  report['unmapped_hinge_evidence']=explain_unmapped_hinges(edges,profs,mapped)
  report['unresolved_bends']=map_review(edges,overrides.get('bend_angles',{}))
  report['bends']=[{'id':e['index'],'bend_ids':[l['id'] for l in e['source']],'parent':e['parent'],'child':e['child'],'angle':e.get('angle'),'key':e['review_key'],'source':e.get('evidence',[]),'source_angle':e.get('source_angle',None if any(v.get('profile')=='USER CONFIRMED' for v in e.get('evidence',[])) else e.get('angle')),'drawing_dimensions':e.get('drawing_dimensions',[]),'detected_angle':e.get('detected_angle'),'confirmed':e.get('confirmed',False)} for e in edges]
  if review_errors:return finish('NEEDS_REVIEW')
  unresolved=[m for m in mapped if m['status']!='PASS']
  if unresolved:
   reasons='; '.join(f"{m['profile']}: {m['reason']}" for m in unresolved)
   issue('SECTION_CORRESPONDENCE',f'{len(unresolved)} section profiles need review. {reasons}',profiles=[m['profile'] for m in unresolved])
   if not preview_requested:return finish('NEEDS_REVIEW')
 deduction=infer_deduction(faces,outer,profs,t) if not general else {'value':bd,'confidence':'settings_validated_against_sections','source':'Section and local-detail strip dimensions matched using the panel bend parameters; no independent deduction measurement'}
 if general and (unresolved or not profs):
  deduction.update(confidence='settings_pending_review',source='Saved panel parameter; unresolved sections do not validate this deduction.')
 report['deduction_evidence']=deduction
 report['input_evidence']={'classification':'flat_pattern_supported' if deduction['value'] is not None else 'not_proven','reason':'Matched section / flat-strip dimensions' if deduction['value'] is not None else 'Input interpretation requires user confirmation'}
 if general and (unresolved or not profs):report['input_evidence']={'classification':'not_proven','reason':'Review reconstruction uses the selected flat-pattern setting; section correspondence is unresolved.'}
 if deduction['value'] is not None and abs(deduction['value']-bd)>.5:
  issue('DEDUCTION',f"Section dimensions support {deduction['value']:g} mm deduction; panel setting is {bd:g} mm.",field='deduction',suggested=deduction['value']);return finish('NEEDS_REVIEW')
 if (evidence['value'] is None or deduction['value'] is None) and not overrides.get('confirm_parameters'):
  issue('EVIDENCE','Drawing does not establish thickness or deduction reliably. Confirm the panel parameters before conversion.');return finish('NEEDS_REVIEW')
 dimension_conflicts=attach_hinge_dimensions(edges,profs)
 recover_directions(edges,report.get('review_catalog',[]))
 apply_directions(edges,faces,overrides.get('bend_directions',{}))
 blocked_panel_angles=apply_panel_angle(edges,panel_angle)
 if blocked_panel_angles:
  issue('PANEL_ANGLE_DIRECTION','The panel angle is saved, but the drawing does not establish a reliable fold direction or has conflicting angle evidence. Correct the drawing evidence before rebuilding; no directions were guessed.')
 unknown=map_review(edges,overrides.get('bend_angles',{}))
 report['unresolved_bends']=unknown
 if unknown:issue('DIRECTIONS',f'{len(unknown)} hinge directions need explicit review.')
 apply_directions(edges,faces,overrides.get('bend_directions',{}))
 if dimension_conflicts:
  issue('ANGLE_EVIDENCE_CONFLICT','Angular dimensions disagree with section geometry. Inspect the drawing and explicitly resolve the affected signed rotations.')
 checks=[dict(parameter_check(t,r,bd,e['angle']),bend_ids=[l['id'] for l in e['source']]) for e in edges if 'angle' in e]
 report['bend_parameters']=checks
 invalid=[c for c in checks if not c['valid' if mode=='physical' else 'constructible']]
 physical_conflicts=[c for c in checks if not c['valid']]
 if physical_conflicts and mode=='dimensional':
  report['warnings'].append({'code':'PHYSICAL_BEND_PARAMETERS','message':'Fixed deduction and selected radius/angle do not establish a physical neutral axis inside the sheet. Folded dimensions remain subject to independent validation; physical unfolding is unverified.','bends':physical_conflicts})
 if invalid:
  issue('BEND_PARAMETERS','Fixed deduction, radius and angle imply non-positive allowance or a neutral axis outside the sheet. No solid was generated. '+ '; '.join(f"{','.join(c['bend_ids'])}: included {c['included_angle_deg']:g}°, allowance {c['allowance_mm']:.6g} mm, K {c['k_factor']:.6g}" for c in invalid)+'',bends=invalid)
  report['bends']=[{'id':e['index'],'key':e['review_key'],'bend_ids':[l['id'] for l in e['source']],'parent':e['parent'],'child':e['child'],'angle':e.get('angle'),'source':e.get('evidence',[])} for e in edges]
  return finish('NEEDS_REVIEW')
 corners=continuation_candidates(faces,edges,order,t,r,bd,validation_mode=mode)
 report['corner_angle_candidates']=corners
 # A hypothetical coplanar continuation is not contradictory drawing evidence.
 # Preserve measured angles and show the alternative without demanding re-entry.
 if any(c['requires_confirmation'] for c in corners):
  issue('CORNER_CONTINUATION_CHECK','Drawing angles are retained and the model can be inspected. An alternative adjoining-flange continuation exists; inspect the corner before accepting manufacturing output. No angle re-entry is required.')
 report['unresolved_bends']=unknown
 if not general:report['section_mapping']=[{'profile':p['name'],'cut_axis':'Y' if p['main_dim']==0 else 'X','coordinate':p.get('cut_coordinate'),'method':p.get('mapping')} for p in profs]
 report['bends']=[{'id':e['index'],'bend_ids':[l['id'] for l in e['source']],'parent':e['parent'],'child':e['child'],'angle':e.get('angle'),'key':e['review_key'],'source':e.get('evidence',[]),'source_angle':e.get('source_angle',None if any(v.get('profile')=='USER CONFIRMED' for v in e.get('evidence',[])) else e.get('angle')),'drawing_dimensions':e.get('drawing_dimensions',[]),'detected_angle':e.get('detected_angle'),'confirmed':e.get('confirmed',False)} for e in edges]
 if unknown:
  return finish('NEEDS_REVIEW')
 paint_points=[g.vec(p)-origin for e in doc.modelspace().query('LWPOLYLINE[layer=="צבע"]') for p in e.get_points()]
 if not general and (not paint_points or not all(faces[0].buffer(.01).covers(Point(p)) for p in paint_points)):issue('PAINT','Paint marker does not identify the selected main face unambiguously.');return finish('NEEDS_REVIEW')
 if general:report['paint_evidence']={'source':'World-coordinate Zeva section markers; global base +Z is the finish reference','markers':[p['paint_handle'] for p in profs]}
 from .section_diagnostics import bend_traceability
 incomplete=[row for row in bend_traceability(faces,edges,profs,mapped) if row['status']=='NEEDS_REVIEW']
 if incomplete:
  issue('BEND_TRACEABILITY','Resolved angles lack complete or consistent source evidence; no solid was generated.',hinges=incomplete)
  return finish('NEEDS_REVIEW')
 checkpoint('BUILDING','Section mapping complete. Building and validating the folded solid…')
 tf=g.transforms(faces,edges,order,t,r,bd,validation_mode=mode);solid,trimmed,stats=g.build_cad(faces,material,edges,tf,t,r,bd,3.,out)
 if not stats['valid'] or stats['solid_count']!=1:raise ValueError('CAD validation failed: expected one valid connected solid.')
 normal_profs=[p for p in normal_instances(profs) if 'trace' in p] if general else profs
 checks,details=g.check_sections(solid,normal_profs,faces,tf,t,r,out,material,tolerance) if normal_profs else ([],[])
 local_checks=check_local_profiles(profs,edges,tf,t,r,bd,tolerance) if general else []
 checks.extend(local_checks)
 if general:
  checks.extend({'profile':p['name'],'chain_status':'NOT_CHECKED','full_plane_status':'NOT_CHECKED',
                 'max_length_error_mm':None,'max_turn_error_deg':None,'validation_scope':'unresolved'}
                for p in profs if 'trace' not in p and 'instances' not in p and 'local_chain' not in p)
 if local_checks:
  report['drawing_convention']={'name':'repeated transverse details and corroborated local edge profiles',
    'validation_scope':'Transverse documented chains are checked against actual BREP cuts. Side profiles use local edge lengths and relative rotations, not full plane cuts.',
    'reference':'Convention confirmed by the customer against the reconstructed folded panel.'}
  dump(out/'local_profile_checks.json',local_checks)
 unfold=g.unfold_solid(solid,tf,trimmed,edges,blank,t,r,bd,out)
 report.update(solid=stats,bbox=stats['bbox_mm'],section_checks=checks,unfold_check=unfold,k_factor=None,allowance=None,corner_contacts=g.partition.contacts)
 if any(c['chain_status']!='PASS' for c in checks):issue('VALIDATION','Solid generated but documented section tolerances failed. Inspect validation results.')
 if unfold['status']!='PASS':
  if mode=='physical':issue('UNFOLD_VALIDATION','Solid generated but unfolding tolerances failed. Inspect validation results.')
  else:report['warnings'].append({'code':'UNFOLD_VALIDATION','message':'Folded dimensions are checked separately. Exact unfolding to CONTOR has not been verified; inspect unfolding diagnostics.'})
 for c in checks:
  if c['chain_status']=='PASS' and c['full_plane_status'] not in ('PASS','NOT_APPLICABLE') and c.get('validation_scope')!='local_edge_profile' and not overrides.get('accept_partial_sections'):issue('PARTIAL_SECTION',f"{c['profile']} matches its documented chain, but the complete plane includes additional sheet regions. Confirm this is a partial detail.")
 if extensions and not overrides.get('accept_relief_extensions'):
  issue('RELIEF_EXTENSION','Draft reconstruction extends '+', '.join(f"{e['bend_id']} across a {max(e['endpoint_gaps_mm']):g} mm endpoint gap" for e in extensions)+'. This exceeds the standard 3 mm rule. Inspect the drawing and explicitly approve these endpoint extensions before final export.')
 from .solid_validation import inspect_brep,inspect_corners,inspect_overlays
 view=viewer_data(faces,trimmed,edges,tf,t,r,bd)
 report['brep_check']=inspect_brep(solid,trimmed,edges,tf,t,r)
 report['corner_check']=inspect_corners(solid,blank,trimmed,edges,tf,t)
 report['overlay_check']=inspect_overlays(solid,view)
 removed=stats['fusion_volume_removed_mm3']
 report['overlap_check']={'status':'PASS' if abs(removed)<=.001 else 'FAIL','fusion_volume_removed_mm3':removed,'tolerance_mm3':.001}
 for key in ('brep_check','corner_check','overlay_check','overlap_check'):
  if report[key]['status']!='PASS':issue(key.upper(),f'{key}: independent solid validation requires review. See measured diagnostics.')
 dump(out/'viewer.json',view);paint_glb(solid,tf,edges,t,r,out/'panel.glb')
 rows=[]
 for e in edges:
  rows.append({'bend_id':' / '.join(l['id'] for l in e['source']),'parent':e['parent'],'child':e['child'],'angle':abs(e['angle']),'signed_angle':e['angle'],'axis':str(e['axis'].tolist()),'source':'; '.join(f"{v['profile']} vertex {v.get('vertex','—')}" for v in e['evidence']),'confidence':'user confirmed' if e.get('confirmed') else 'drawing','status':'NEEDS_REVIEW' if issues else 'PASS'})
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
  if hasattr(e,'diagnostics'):report['geometry_diagnostic']=e.diagnostics
  from .solid_validation import export_verification
  report['verification']=export_verification(report,'FAILED',out)
  report.update(status='FAILED',error=message);report.setdefault('issues',[]).append({'code':'GEOMETRY','message':message});dump(out/'report.json',report)
  dump(out/'result.json',{'status':'FAILED','report':report,'artifacts':{p.name:p.name for p in out.iterdir() if p.is_file() and p.name not in ['result.json','progress.json','progress.tmp']}})
  traceback.print_exc();sys.exit(1)
