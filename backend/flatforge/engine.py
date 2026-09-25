"""One isolated job. Evidence first; explicit review decisions precede solid generation."""
import sys, json, math, io, csv, shutil, traceback, hashlib, collections, html
from pathlib import Path
import numpy as np
import ezdxf
from shapely.geometry import Point,LineString
from . import geometry as g
from . import dwg
from .section_mapping import map_normal_sections
DEFAULTS={'thickness':2.,'radius':2.,'deduction':4.,'input_type':'flat_pattern'}
def dump(path,obj):path.write_text(json.dumps(obj,indent=2,default=lambda x:x.tolist() if isinstance(x,np.ndarray) else float(x)))
def thickness_evidence(doc):
 lines=[]
 for e in g.section_lines(doc):
  a,b=g.vec(e.dxf.start),g.vec(e.dxf.end)
  if np.linalg.norm(b-a)<8:continue
  u=g.unit(b-a);dim=int(abs(u[1])>abs(u[0]))
  if min(abs(u))>1e-5:continue
  lines.append((dim,(a[1-dim]+b[1-dim])/2,min(a[dim],b[dim]),max(a[dim],b[dim])))
 votes=collections.Counter()
 for i,(d,c,a,b) in enumerate(lines):
  for dd,cc,aa,bb in lines[i+1:]:
   dist=abs(c-cc)
   if dd==d and .5<=dist<=10 and min(b,bb)-max(a,aa)>5 and abs(a-aa)<=dist+.1 and abs(b-bb)<=dist+.1:votes[round(dist,2)]+=1
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
   angle=float(overrides[key])
   if not math.isfinite(angle) or not 0<abs(angle)<180:raise ValueError('A signed bend rotation must be between 0 and 180 degrees.')
   e['angle']=angle;e['evidence']=[{'profile':'USER CONFIRMED','vertex':None,'angle':angle}];e['confirmed']=True
  if 'angle' not in e:
   u,n,c=g.support(e)
   unknown.append({'key':key,'bend_ids':[l['id'] for l in e['source']],'handles':[l['handle'] for l in e['source']],'parent':e['parent'],'child':e['child'],'axis':f'({u[0]:.6f}, {u[1]:.6f}, 0)','axis_coordinate':c,'reason':'No unambiguous section establishes this hinge rotation.'})
 return unknown

def viewer_data(faces,material,edges,tf,t,r,bd):
 ba=2*(r+t)-bd
 return {'units':'mm','thickness':t,'radius':r,'deduction':bd,'allowance':ba,'k_factor':(ba/(math.pi/2)-r)/t,
  'faces':[{'id':i,'polygons':[{'outer':list(p.exterior.coords),'holes':[list(h.coords) for h in p.interiors]} for p in g.poly_parts(material[i])],'rotation':tf[i][0],'translation':tf[i][1]} for i in range(len(faces))],
  'bends':[{'id':e['index'],'name':' / '.join(l['id'] for l in e['source']),'parent':e['parent'],'child':e['child'],'axis':e['axis'],'d':e['d'],'hinge':e['hinge'],'allowance':e['allowance'],'coordinate':e['c'],'dim':e['dim'],'low':g.hinge_span(e)[0],'high':g.hinge_span(e)[1],'angle':e['angle'],'source':e['evidence']} for e in edges]}
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
 settings={**DEFAULTS,**config.get('settings',{})};overrides=config.get('overrides',{});issues=[];report={'settings':settings,'issues':issues,'status':'FAILED'}
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
 section_layer=g.section_layer(doc)
 report['section_convention']={'layer':section_layer,'canonical_role':'HAT','alias_used':section_layer not in (None,'HAT')}
 missing=[l for l in ['CONTOR','KIFOF'] if not layers.get(l)]
 if section_layer is None:missing.append('HAT')
 if 'CONTOR' in missing:issue('LAYERS','Missing or empty required layer: CONTOR');return finish('NEEDS_REVIEW')
 d,origin,outer,blank,lines=g.read_drawing(source);faces,edges,parents,order,material=g.partition(outer,blank,lines,3.)
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
 (out/'extraction.svg').write_text(extract_svg(outer,blank,lines,doc,origin));shutil.copyfile(source,out/'flat.dxf')
 extract={'bounds':list(outer.bounds),'lines':[{'id':l['id'],'handle':l['handle'],'start':l['a'],'end':l['b']} for l in lines],'faces':[{'id':i,'bounds':list(f.bounds)} for i,f in enumerate(faces)]};dump(out/'extraction.json',extract)
 checkpoint('EXTRACTING','Rendered numbered bend axes and contour. Checking drawing parameters…')
 if missing:issue('LAYERS','Missing or empty required layers: '+', '.join(missing)+'. The contour preview is available, but a folded model cannot be inferred without bend and section evidence.');return finish('NEEDS_REVIEW')
 if unassigned:
  issue('UNASSIGNED_AXES','These bend entities do not bound a hinge after the 3 mm relief extension: '+', '.join(unassigned)+'. Check endpoint gaps and contour alignment; this alone does not prove an interior rib.');return finish('NEEDS_REVIEW')
 evidence=thickness_evidence(doc);report['thickness_evidence']=evidence
 if evidence['value'] is not None and abs(evidence['value']-settings['thickness'])>.1:
  issue('THICKNESS',f"Drawing wall spacing is {evidence['value']:g} mm; panel thickness is {settings['thickness']:g} mm.",field='thickness',suggested=evidence['value']);return finish('NEEDS_REVIEW')
 if doc.units not in [0,4]:issue('UNITS',f'DXF unit code {doc.units} is not millimetres. Convert units in CAD before upload.');return finish('NEEDS_REVIEW')
 report['units_evidence']='DXF millimetres' if doc.units==4 else 'Unitless DXF; interpreted in millimetres under workspace convention'
 if settings['input_type']!='flat_pattern':issue('INPUT_TYPE','This engine requires a developed flat pattern. Folded-dimension drawings need an explicit developed-pattern export.');return finish('NEEDS_REVIEW')
 t,r,bd=settings['thickness'],settings['radius'],settings['deduction'];ba=2*(r+t)-bd;k=(ba/(math.pi/2)-r)/t
 if not 0<k<1:
  issue('BEND_PARAMETERS',f'Panel settings t={t:g} mm, r={r:g} mm, BD90={bd:g} mm imply K={k:.6g}; this model requires 0 < K < 1. Check the saved panel settings.',
        thickness_mm=t,inside_radius_mm=r,deduction_90_mm=bd,calculated_k=k,
        deduction_range_exclusive_mm=[2*(r+t)-(math.pi/2)*(r+t),2*(r+t)-(math.pi/2)*r])
  return finish('NEEDS_REVIEW')
 try:profs=g.profiles(doc,origin,t)
 except ValueError as exc:
  issue('SECTION_EVIDENCE',str(exc));return finish('NEEDS_REVIEW')
 report['section_profiles']=[{'name':p['name'],'layer':p['layer'],'paint_marker':p['paint_handle'],'points':p['points'],'main_segment':p['main'],'wall_pairs':[{'handles':s['handles'],'spacing_mm':s['wall_spacing_mm'],'parallel_error_deg':s['parallel_error_deg']} for s in p['segments']]} for p in profs]
 general=section_layer!='HAT' or any(not l['orthogonal'] for l in lines) or any(abs(g.unit(a)@g.unit(b))>math.sin(math.radians(.01)) for p in profs for a,b in zip(np.diff(p['points'],axis=0),np.diff(p['points'],axis=0)[1:]))
 if general:
  mapped=map_normal_sections(faces,outer,edges,profs,t,r,bd)
  report['section_mapping']=mapped
  report['unresolved_bends']=map_review(edges,{})
  report['bends']=[{'id':e['index'],'bend_ids':[l['id'] for l in e['source']],'parent':e['parent'],'child':e['child'],'angle':e.get('angle'),'key':e['review_key'],'source':e.get('evidence',[]),'confirmed':False} for e in edges]
  report['bend_parameter_model']={'deduction_reference_angle_deg':90,'k_factor':k,'other_angles':'constant K derived from the 90-degree calibration'}
  unresolved=[m for m in mapped if m['status']!='PASS']
  if unresolved:
   report['unmapped_hinges']=report.pop('unresolved_bends')
   reasons='; '.join(f"{m['profile']}: {m['reason']}" for m in unresolved)
   issue('SECTION_CORRESPONDENCE',f'{len(unresolved)} section profiles need review. {reasons}',profiles=[m['profile'] for m in unresolved])
   return finish('NEEDS_REVIEW')
 deduction=infer_deduction(faces,outer,profs,t) if not general else {'value':bd,'confidence':'settings_validated_against_sections','source':'Every normal section matched using the panel bend parameters; no independent deduction measurement'}
 report['deduction_evidence']=deduction
 report['input_evidence']={'classification':'flat_pattern_supported' if deduction['value'] is not None else 'not_proven','reason':'Matched section / flat-strip dimensions' if deduction['value'] is not None else 'Input interpretation requires user confirmation'}
 if deduction['value'] is not None and abs(deduction['value']-bd)>.5:
  issue('DEDUCTION',f"Section dimensions support {deduction['value']:g} mm deduction; panel setting is {bd:g} mm.",field='deduction',suggested=deduction['value']);return finish('NEEDS_REVIEW')
 if (evidence['value'] is None or deduction['value'] is None) and not overrides.get('confirm_parameters'):
  issue('EVIDENCE','Drawing does not establish thickness or deduction reliably. Confirm the panel parameters before conversion.');return finish('NEEDS_REVIEW')
 try:
  if not general:mapped=g.map_sections(doc,origin,faces,outer,edges,profs,t,r,bd)
 except ValueError as e:
  if str(e)!='Unmapped hinge; no default direction is allowed':raise
  mapped=[]
 unknown=map_review(edges,overrides.get('bend_angles',{}));report['unresolved_bends']=unknown
 if not general:report['section_mapping']=[{'profile':p['name'],'cut_axis':'Y' if p['main_dim']==0 else 'X','coordinate':p.get('cut_coordinate'),'method':p.get('mapping')} for p in profs]
 report['bends']=[{'id':e['index'],'bend_ids':[l['id'] for l in e['source']],'parent':e['parent'],'child':e['child'],'angle':e.get('angle'),'key':e['review_key'],'source':e.get('evidence',[]),'confirmed':e.get('confirmed',False)} for e in edges]
 if unknown:
  issue('DIRECTIONS',f'{len(unknown)} hinge directions need explicit review.');return finish('NEEDS_REVIEW')
 paint_points=[g.vec(p)-origin for e in doc.modelspace().query('LWPOLYLINE[layer=="צבע"]') for p in e.get_points()]
 if not general and (not paint_points or not all(faces[0].buffer(.01).covers(Point(p)) for p in paint_points)):issue('PAINT','Paint marker does not identify the selected main face unambiguously.');return finish('NEEDS_REVIEW')
 if general:report['paint_evidence']={'source':'World-coordinate Zeva section markers; global base +Z is the finish reference','markers':[p['paint_handle'] for p in profs]}
 checkpoint('BUILDING','Section mapping complete. Building and validating the folded solid…')
 tf=g.transforms(faces,edges,order,t,r,bd);solid,trimmed,stats=g.build_cad(faces,material,edges,tf,t,r,bd,3.,out)
 if not stats['valid'] or stats['solid_count']!=1:raise ValueError('CAD validation failed: expected one valid connected solid.')
 checks,details=g.check_sections(solid,profs,faces,tf,t,r,out,material);unfold=g.unfold_solid(solid,tf,trimmed,edges,blank,t,r,bd,out)
 report.update(solid=stats,bbox=stats['bbox_mm'],section_checks=checks,unfold_check=unfold,k_factor=k,allowance=ba,corner_contacts=g.partition.contacts)
 if any(c['chain_status']!='PASS' for c in checks) or unfold['status']!='PASS':issue('VALIDATION','Solid generated but section or unfolding tolerances failed. Inspect validation results.')
 for c in checks:
  if c['chain_status']=='PASS' and c['full_plane_status']!='PASS' and not overrides.get('accept_partial_sections'):issue('PARTIAL_SECTION',f"{c['profile']} matches its documented chain, but the complete plane includes additional sheet regions. Confirm this is a partial detail.")
 if extensions and not overrides.get('accept_relief_extensions'):
  issue('RELIEF_EXTENSION','Draft reconstruction extends '+', '.join(f"{e['bend_id']} across a {max(e['endpoint_gaps_mm']):g} mm endpoint gap" for e in extensions)+'. This exceeds the standard 3 mm rule. Inspect the drawing and explicitly approve these endpoint extensions before final export.')
 dump(out/'viewer.json',viewer_data(faces,trimmed,edges,tf,t,r,bd));paint_glb(solid,tf,edges,t,r,out/'panel.glb')
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
  report.update(status='FAILED',error=message);report.setdefault('issues',[]).append({'code':'GEOMETRY','message':message});dump(out/'report.json',report)
  dump(out/'result.json',{'status':'FAILED','report':report,'artifacts':{p.name:p.name for p in out.iterdir() if p.is_file() and p.name not in ['result.json','progress.json','progress.tmp']}})
  traceback.print_exc();sys.exit(1)
