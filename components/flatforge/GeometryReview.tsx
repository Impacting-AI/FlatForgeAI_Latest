'use client';
import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Panel} from './types';

type Point=[number,number];
export type GeometryEvidence={faces:{id:number;outer:Point[];polygons?:{outer:Point[];holes:Point[][]}[]}[];hinges:{key:string;bend_ids:string[];parent:number;child:number;axis:Point;points:Point[]}[]};
export type SectionCandidate={id:string;kind:string;points:Point[];faces:number[];max_strip_error_mm:number;fits_tolerance:boolean;folds:{key:string;bend_ids:string[];angle:number;vertex:number}[];segments:{segment:number;face:number;drawing_mm:number;flat_mm:number;required_flat_mm:number;residual_mm:number}[]};
export type SectionReview={profile:string;status:string;reason?:string;points:Point[];paint_marker:string;selected?:string;candidate_count:number;candidates:SectionCandidate[]};
const number=(n:number)=>n.toFixed(3);
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

export default function GeometryReview({panel,choices,onChoices,angles,onAngles,disabled,onBuild}:{panel:Panel;choices:Record<string,string>;onChoices:(v:Record<string,string>)=>void;angles:Record<string,number|null>;onAngles:(v:Record<string,number|null>)=>void;disabled:boolean;onBuild:()=>void}){
 const [selected,setSelected]=useState('');const [section,setSection]=useState('');
 const catalog=panel.report.review_catalog??[];const geometry=panel.report.review_geometry;
 if(!geometry)return null;
 const current=catalog.find(s=>s.profile===section)??catalog[0];
 const proposal=current?.candidates.find(c=>c.id===choices[current.profile]);
 const proposedAngles=Object.fromEntries(catalog.flatMap(s=>s.candidates.find(c=>c.id===choices[s.profile])?.folds.map(f=>[f.key,f.angle])??[]));
 const invalid=Object.values(angles).some(a=>a!==null&&(!Number.isFinite(a)||a===0||Math.abs(a)>=180));
 return <section className="review-decisions" aria-label="Geometry rule editor">
  <h2>Geometry & fold rules</h2><p>Select a section correspondence or edit a signed bend angle. Decisions apply only to this drawing revision. Selecting a chain does not waive dimensional checks.</p>
  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(300px,1fr))',gap:20,marginTop:16}}>
   <Drawing {...geometry} selected={selected} onSelect={setSelected} highlight={proposal?.faces}/>
   <div>{current?<>
    <label>Source section <select aria-label="Source section" value={current.profile} onChange={e=>setSection(e.target.value)}>{catalog.map(s=><option key={s.profile}>{s.profile}</option>)}</select></label>
    <Profile points={proposal?.points??current.points}/><small>Paint marker: {current.paint_marker} · {current.status}</small><p>{current.reason}</p>
    <label>Face-chain correspondence <select aria-label="Face-chain correspondence" disabled={disabled} value={choices[current.profile]??''} onChange={e=>{const next={...choices};if(e.target.value)next[current.profile]=e.target.value;else delete next[current.profile];onChoices(next)}} style={{width:'100%'}}>
     <option value="">Automatic interpretation</option>{current.candidates.map(c=><option key={c.id} value={c.id}>{c.kind==='normal_section'?'Normal section':'Local edge detail'} · {c.faces.map(f=>'F'+f).join(' → ')} · error {number(c.max_strip_error_mm)} mm</option>)}
    </select></label>
    {!current.candidates.length&&<p>No eligible chain was derived. Inspect the DXF or set the remaining hinge rotations explicitly for a review model.</p>}
    {proposal&&<><p>{proposal.fits_tolerance?'Strip dimensions fit the 0.5 mm limit. Solid validation still runs.':'This chain exceeds tolerance. A review model may be inspected, but validated export remains blocked.'}</p><div style={{overflowX:'auto'}}><table className="calculation-table"><thead><tr><th>Face</th><th>Flat</th><th>Required flat</th><th>Difference</th></tr></thead><tbody>{proposal.segments.map(s=><tr key={s.segment}><td>F{s.face}</td><td>{number(s.flat_mm)}</td><td>{number(s.required_flat_mm)}</td><td style={{color:Math.abs(s.residual_mm)>.5?'#b44318':undefined}}>{number(s.residual_mm)}</td></tr>)}</tbody></table></div></>}
   </>:<p>Click a numbered hinge to inspect and edit its parent-local rotation.</p>}</div>
  </div>
  {selected&&<p>Positive hinge axis in the parent flat frame: ({geometry.hinges.find(h=>h.key===selected)?.axis.map(number).join(', ')}, 0). Parent and child are fixed by the extracted fold tree.</p>}
  <div style={{overflowX:'auto',maxHeight:360,marginTop:20}}><table className="calculation-table"><thead><tr><th>Hinge</th><th>Parent → child</th><th>Source / proposed angle</th><th>Override (rotation °)</th><th/></tr></thead><tbody>{panel.report.bends?.map(b=><tr key={b.key} style={{background:selected===b.key?'#fff0dc':undefined}} onClick={()=>setSelected(b.key)}>
   <td><button type="button" onClick={()=>setSelected(b.key)}>{b.bend_ids.join('/')}</button></td><td>F{b.parent} → F{b.child}</td><td>{proposedAngles[b.key]??b.angle??'UNKNOWN'}{proposedAngles[b.key]!=null?' · selected section':''}</td>
   <td><Input aria-label={`Signed angle for ${b.bend_ids.join('/')} F${b.parent} to F${b.child}`} disabled={disabled} type="number" min={-179.999} max={179.999} step="any" placeholder="Use source angle" value={angles[b.key]??''} onChange={e=>onAngles({...angles,[b.key]:e.target.value===''?null:Number(e.target.value)})}/></td>
   <td><Button variant="ghost" disabled={disabled} onClick={()=>onAngles({...angles,[b.key]:null})}>Reset</Button></td>
  </tr>)}</tbody></table></div>
  <p>Angles are signed rotations from flat about the displayed parent-local hinge axis. Included angle = 180° − |rotation|; for example, a 120° included corner needs a 60° rotation, with direction established by the drawing. All unresolved hinges need a selected source chain or an explicit angle before a solid can be built.</p>
  {invalid&&<p role="alert">Use finite, non-zero angles between −180° and +180°.</p>}
  <Button disabled={disabled||invalid} onClick={onBuild}>Save rules & build review model</Button>
  <p>A review STEP remains labelled unvalidated until all required checks pass. Global settings are unchanged.</p>
 </section>
}
