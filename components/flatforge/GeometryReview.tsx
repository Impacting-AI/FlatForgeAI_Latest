'use client';
import {useState} from 'react';
import {Panel} from './types';

type Point=[number,number];
export type GeometryEvidence={faces:{id:number;outer:Point[];polygons?:{outer:Point[];holes:Point[][]}[]}[];hinges:{key:string;bend_ids:string[];parent:number;child:number;axis:Point;points:Point[]}[]};
export type SectionCandidate={id:string;kind:string;points:Point[];faces:number[];max_strip_error_mm:number;fits_tolerance:boolean;folds:{key:string;bend_ids:string[];angle:number;vertex:number}[];segments:{segment:number;face:number;drawing_mm:number;flat_mm:number;required_flat_mm:number;residual_mm:number}[]};
export type SectionReview={profile:string;status:string;reason?:string;points:Point[];paint_marker:string;selected?:string;candidate_count:number;candidates:SectionCandidate[]};
function Drawing({faces,hinges,selected,onSelect,highlight=[]}:{faces:GeometryEvidence['faces'];hinges:GeometryEvidence['hinges'];selected:string;onSelect:(key:string)=>void;highlight?:number[]}){
 const all=faces.flatMap(f=>f.outer);if(!all.length)return null;
 const xs=all.map(p=>p[0]),ys=all.map(p=>p[1]);const x=Math.min(...xs),y=Math.min(...ys),w=Math.max(...xs)-x,h=Math.max(...ys)-y;const pad=Math.max(w,h)*.035;const textSize=Math.max(w,h)/65;
 return <svg role="img" aria-label="Selectable faces and bend axes" viewBox={`${x-pad} ${y-pad} ${w+2*pad} ${h+2*pad}`} style={{width:'100%',height:430,background:'#f3f7f8',borderRadius:8}}>
  <g transform={`translate(0 ${2*y+h}) scale(1 -1)`}>
   {faces.map(f=><path key={f.id} d={(f.polygons??[{outer:f.outer,holes:[]}]).flatMap(p=>[p.outer,...p.holes]).map(r=>'M '+r.map(p=>p.join(',')).join(' L ')+' Z').join(' ')} fillRule="evenodd" fill={highlight.includes(f.id)?'#a7e4db':'#dce8ec'} stroke="#829ca4" strokeWidth={Math.max(w,h)/1800}/>)}
   {hinges.map(b=><g key={b.key} role="button" tabIndex={0} aria-label={`Select ${b.bend_ids.join('/')} F${b.parent} to F${b.child}`} onClick={()=>onSelect(b.key)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect(b.key)}}} style={{cursor:'pointer'}}>
    <title>{b.bend_ids.join('/')} · F{b.parent} → F{b.child}</title>
    <line x1={b.points[0][0]} y1={b.points[0][1]} x2={b.points[1][0]} y2={b.points[1][1]} stroke="transparent" strokeWidth={textSize}/>
    <line x1={b.points[0][0]} y1={b.points[0][1]} x2={b.points[1][0]} y2={b.points[1][1]} stroke={selected===b.key?'#c95319':'#078977'} strokeWidth={selected===b.key?textSize/4:textSize/10}/>
    <g transform={`translate(${(b.points[0][0]+b.points[1][0])/2} ${(b.points[0][1]+b.points[1][1])/2}) scale(1 -1)`}><text fontSize={textSize} fill="#633812">{b.bend_ids.join('/')}</text></g>
   </g>)}
  </g>
 </svg>
}
function Profile({points}:{points:Point[]}){
 const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);const x=Math.min(...xs),y=Math.min(...ys),w=Math.max(...xs)-x,h=Math.max(...ys)-y,pad=Math.max(w,h)*.07;
 return <svg aria-label="Source section profile with numbered vertices" viewBox={`${x-pad} ${y-pad} ${w+2*pad} ${h+2*pad}`} style={{width:'100%',height:150,background:'#f5f8fa'}}><g transform={`translate(0 ${2*y+h}) scale(1 -1)`}><polyline points={points.map(p=>p.join(',')).join(' ')} fill="none" stroke="#167a71" strokeWidth={Math.max(w,h)/300}/>{points.slice(1,-1).map((p,i)=><g key={i} transform={`translate(${p[0]} ${p[1]}) scale(1 -1)`}><circle r={Math.max(w,h)/220} fill="#c95319"/><text fontSize={Math.max(w,h)/40} y={-Math.max(w,h)/90}>{i+1}</text></g>)}</g></svg>
}

export default function GeometryReview({panel,directions,onDirection,choices,onChoice,disabled}:{panel:Panel;choices:Record<string,string>;onChoice:(profile:string,candidate:string)=>void;directions:Record<string,'up'|'down'|null>;onDirection:(key:string,value:'up'|'down'|null)=>void;disabled:boolean}){
 const [selected,setSelected]=useState('');const [section,setSection]=useState('');
 const geometry=panel.report.review_geometry;const catalog=panel.report.review_catalog??[];
 if(!geometry)return null;
 const current=catalog.find(s=>s.profile===section)??catalog[0];
 const candidate=current?.candidates.find(c=>c.id===(choices[current.profile]??current.selected));
 return <details className="review-decisions"><summary>Drawing geometry and angle sources</summary>
  <p>Drawing angles take priority. Up/down describes the child flange moving toward/away from the parent face’s local +Z side. Unknown directions must be selected before building.</p>
  <div style={{overflowX:'auto'}}><table className="calculation-table"><thead><tr><th>Bend / faces</th><th>Included angle</th><th>Direction</th><th>Evidence</th></tr></thead><tbody>{panel.report.bends?.map(b=><tr key={b.key}><td>{b.bend_ids.join('/')} · F{b.parent} → F{b.child}</td><td>{b.angle==null?'Missing · panel fallback':`${180-Math.abs(b.angle)}°`}</td><td><select aria-label={`Direction ${b.bend_ids.join('/')} F${b.parent} to F${b.child}`} disabled={disabled} value={directions[b.key]??''} onChange={e=>onDirection(b.key,e.target.value===''?null:e.target.value as 'up'|'down')}><option value="">Drawing: {b.detected_direction??'UNKNOWN — select direction'}</option><option value="up">Up · operator override</option><option value="down">Down · operator override</option></select></td><td>{b.source?.map(x=>x.profile).join(', ')||'not found'}</td></tr>)}</tbody></table></div>
  <Drawing {...geometry} selected={selected} onSelect={setSelected} highlight={candidate?.faces??[]}/>
  {current&&<><label>Source section <select aria-label="Source section" value={current.profile} onChange={e=>setSection(e.target.value)}>{catalog.map(s=><option key={s.profile}>{s.profile}</option>)}</select></label><Profile points={current.points}/><p>{current.status} · {current.reason}</p>
   <label>Section corresponds to <select aria-label="Section correspondence" disabled={disabled||!current.candidates.length} value={choices[current.profile]??''} onChange={e=>onChoice(current.profile,e.target.value)}>
    <option value="">Automatic — keep ambiguous matches unresolved</option>
    {current.candidates.map(c=><option key={c.id} value={c.id}>{c.kind} · {c.faces.map(f=>`F${f}`).join(' → ')} · difference {c.max_strip_error_mm.toFixed(3)} mm{c.fits_tolerance?'':' · outside tolerance'}</option>)}
   </select></label>
   <p>Select only the chain this section actually describes. Highlighted faces show the selected match. This records your interpretation and rebuilds all checks; it does not waive dimensional errors.</p>
   {candidate&&<p>Selected chain: {candidate.folds.map(f=>`${f.bend_ids.join('/')} at vertex ${f.vertex}: signed rotation ${f.angle}°`).join('; ')}</p>}
   {!current.candidates.length&&<p>No supported correspondence was found. A section cut position or clarified profile is needed; an angle alone cannot resolve this.</p>}
  </>}
  {panel.report.section_mapping?.filter(row=>row.status==='NEEDS_REVIEW').map(row=><section key={row.profile} aria-label={`${row.profile} segment diagnostics`}>
   <h3>{row.profile}: section comparison</h3><p>{row.reason}</p>
   {row.nearest_candidate&&<><p>{row.nearest_candidate.normal_to_all_hinges?'Normal section candidate':'Projected/non-normal candidate — these apparent turns cannot directly establish fold rotations.'}</p>
    {row.nearest_candidate.turn_angles_deg&&<p>Measured profile turns: {row.nearest_candidate.turn_angles_deg.map(a=>`${a.toFixed(3)}°`).join(', ')}.</p>}
    <div style={{overflowX:'auto'}}><table className="calculation-table"><thead><tr><th>Segment / face</th><th>Flat drawing (mm)</th><th>Required by section + bend parameters (mm)</th><th>Difference (mm)</th><th>Source handles</th></tr></thead><tbody>{row.nearest_candidate.segment_checks?.map(s=><tr key={s.segment}><td>{s.segment} / F{s.face}</td><td>{s.observed_flat_mm.toFixed(3)}</td><td>{s.required_flat_mm.toFixed(3)}</td><td style={{color:s.within_tolerance?undefined:'#b44318'}}>{s.residual_mm.toFixed(3)}</td><td>{s.source_handles.join(', ')}</td></tr>)}</tbody></table></div>
    {row.nearest_normal_candidate&&<p>Closest normal-chain maximum difference: {row.nearest_normal_candidate.max_strip_error_mm.toFixed(3)} mm.</p>}
    {row.nearest_projected_candidate&&<p>Closest projected-chain difference: {row.nearest_projected_candidate.max_strip_error_mm.toFixed(3)} mm. A smaller length error does not prove a valid fold interpretation.</p>}
   </>}
   <p>These comparisons are diagnostic. Changing the angle or increasing tolerance merely to remove the warning can change the manufactured panel.</p>
  </section>)}
  {!!panel.report.angular_annotations?.length&&<table className="calculation-table"><thead><tr><th>Drawing angle</th><th>Source</th><th>Status</th></tr></thead><tbody>{panel.report.angular_annotations.map((a,i)=><tr key={`${a.handle}-${i}`}><td>{a.value_deg??'Unreadable'}°</td><td>{a.profile?`${a.profile} · vertex ${a.vertex}`:'Not linked to a bend'}</td><td>{a.status}</td></tr>)}</tbody></table>}
 </details>
}
