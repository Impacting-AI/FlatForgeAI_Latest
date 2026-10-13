'use client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { BendValues, Panel, Settings } from './types';

export type ReviewValues={relief_radii:Record<string,number|null>;bend_parameters:Record<string,BendValues>;section_choices:Record<string,string|null>;manual_bends:boolean;review_note:string;accept_corner_reliefs:boolean};
export const emptyReview:ReviewValues={relief_radii:{},bend_parameters:{},section_choices:{},manual_bends:false,review_note:'',accept_corner_reliefs:false};
export function savedReview(panel:Panel):ReviewValues {
 const saved=panel.overrides;
 const bends={...saved.bend_parameters as Record<string,BendValues>|undefined};
 for(const [key,angle] of Object.entries(saved.bend_angles as Record<string,number>|undefined??{}))bends[key]={angle,...bends[key]};
 return {relief_radii:{...saved.relief_radii as Record<string,number>|undefined},bend_parameters:bends,section_choices:{...saved.section_choices as Record<string,string>|undefined},manual_bends:saved.manual_bends===true,review_note:typeof saved.review_note==='string'?saved.review_note:'',accept_corner_reliefs:saved.accept_corner_reliefs===true};
}
export function reviewError(value:ReviewValues,settings:Settings):string|null {
 const ranges:[number,number,number,string,boolean][]=[
  [settings.thickness,0,20,'Thickness',false],[settings.radius,0,100,'Radius',false],[settings.deduction,0,100,'Deduction',true],
  [settings.strip_tolerance??.5,0,5,'Length tolerance',false],[settings.angle_tolerance??.1,0,2,'Angle tolerance',true],[settings.default_angle??90,0,180,'Missing angle',false],
 ];
 for(const [n,min,max,name,zero] of ranges)if(!Number.isFinite(n)||(zero?n<min:n<=min)||n>max||(name==='Missing angle'&&n===180))return `${name}: enter a value ${zero?'from':'above'} ${min} and ${name==='Missing angle'?'below':'up to'} ${max}.`;
 for(const bend of Object.values(value.bend_parameters)){
  if(bend.angle!=null&&(!Number.isFinite(bend.angle)||bend.angle===0||Math.abs(bend.angle)>=180))return 'Signed bend angles must be greater than −180°, less than 180°, and nonzero.';
  if(bend.radius!=null&&(!Number.isFinite(bend.radius)||bend.radius<=0||bend.radius>100))return 'Each bend radius must be above 0 and at most 100 mm.';
  if(bend.deduction!=null&&(!Number.isFinite(bend.deduction)||bend.deduction<0||bend.deduction>100))return 'Each bend deduction must be from 0 to 100 mm.';
 }
 for(const radius of Object.values(value.relief_radii))if(radius!=null&&(!Number.isFinite(radius)||radius<=0))return 'Corner-relief radii must be positive numbers.';
 return (value.manual_bends||Object.values(value.relief_radii).some(r=>r!=null))&&!value.review_note.trim()?'Add a note stating where your confirmed bend or corner-cut values came from.':null;
}

export default function ReviewControls({panel,settings,value,onChange}:{panel:Panel;settings:Settings;value:ReviewValues;onChange:(v:ReviewValues)=>void}){
 const setBend=(key:string,field:keyof BendValues,input:string|number)=>{
  const values={...value.bend_parameters[key]};
  if(input==='')delete values[field];else values[field]=Number(input);
  onChange({...value,bend_parameters:{...value.bend_parameters,[key]:values}});
 };
 const unresolved=panel.report.unresolved_bends??[];
 const candidates=panel.report.section_mapping?.filter(s=>s.review_candidates?.length||value.section_choices[s.profile]);
 function manualMode(checked:boolean){
  const bends={...value.bend_parameters};
  if(checked)for(const bend of panel.report.bends??[])if(bend.angle!=null&&bends[bend.key]?.angle==null)bends[bend.key]={...bends[bend.key],angle:bend.angle};
  onChange({...value,manual_bends:checked,bend_parameters:bends,section_choices:checked?Object.fromEntries(Object.keys(value.section_choices).map(key=>[key,null])):value.section_choices});
 }
 return <div className="review-controls">
  {!value.manual_bends&&candidates?.map(s=><div className="review-chain" key={s.profile}>
   <label htmlFor={'chain-'+s.profile}>{s.profile.replaceAll('_',' ')} · choose the matching bend chain</label>
   <select id={'chain-'+s.profile} value={value.section_choices[s.profile]??''} onChange={e=>onChange({...value,section_choices:{...value.section_choices,[s.profile]:e.target.value||null}})}>
    <option value="">Automatic matching</option>
    {value.section_choices[s.profile]&&!s.review_candidates?.some(c=>c.id===value.section_choices[s.profile])&&<option value={value.section_choices[s.profile]??''} disabled>Saved chain no longer fits · choose automatic matching or another chain</option>}
    {s.review_candidates?.map(c=><option key={c.id} value={c.id}>{c.kind==='local'?'Local edge detail':'Straight section'} · {c.bend_ids.map(ids=>ids.join('/')).join(' → ')} · {c.max_strip_error_mm.toFixed(3)} mm difference</option>)}
   </select>
   <small>Use the numbered bends in the drawing to confirm the chain. Selection confirms its correspondence; the solid still undergoes validation.</small>
  </div>)}
  {unresolved.length>0&&<p><strong>{unresolved.length} bend rotations need values.</strong> Use the shared angle ({settings.default_angle??90}°) with a direction, or enter a different value in the table. You can also change settings and rebuild before choosing.</p>}
  {unresolved.map(b=><div className="bend-decision" key={b.key}>
   <div><strong>{b.bend_ids.join(' / ')} · F{b.parent} → F{b.child}</strong><p>{b.reason}</p><small>Positive axis: {b.axis}. Signed rotation uses the right-hand rule.</small></div>
   <div className="bend-quick-values"><Button type="button" variant="outline" size="sm" onClick={()=>setBend(b.key,'angle',settings.default_angle??90)}>+{settings.default_angle??90}°</Button><Button type="button" variant="outline" size="sm" onClick={()=>setBend(b.key,'angle',-(settings.default_angle??90))}>−{settings.default_angle??90}°</Button><input aria-label={'Signed angle for '+b.bend_ids.join('/')} type="number" step="any" min="-179.999" max="179.999" placeholder="Angle °" value={value.bend_parameters[b.key]?.angle??''} onChange={e=>setBend(b.key,'angle',e.target.value)}/></div>
  </div>)}
  {!!panel.report.bends?.length&&<details className="bend-overrides"><summary>Correct individual bends · angle, radius or deduction</summary>
   <p>Blank fields use the drawing or panel settings. Clear an entered value to return to automatic calculation.</p>
   <div className="table-wrap"><table className="calculation-table"><thead><tr><th>Bend</th><th>Signed rotation °</th><th>Inside radius mm</th><th>Deduction mm</th></tr></thead><tbody>{panel.report.bends.map(b=><tr key={b.key}><td>{b.bend_ids.join(' / ')}<small>F{b.parent} → F{b.child}{b.angle!=null?` · detected / current ${b.angle.toFixed(3)}°`:''}</small></td>{(['angle','radius','deduction'] as const).map(field=><td key={field}><input type="number" step="any" aria-label={`${field} for ${b.bend_ids.join('/')}`} placeholder={field==='angle'?(b.angle?.toString()??'Required'):settings[field].toString()} value={value.bend_parameters[b.key]?.[field]??''} onChange={e=>setBend(b.key,field,e.target.value)}/></td>)}</tr>)}</tbody></table></div>
  </details>}
  {!!panel.report.relief_circles?.length&&<details className="bend-overrides"><summary>Adjust corner-relief cuts</summary>
   <p>Enter the radius required by the approved shape. Blank restores the original DXF cut. These changes are recorded and included in the exported flat drawing.</p>
   <div className="table-wrap"><table className="calculation-table"><thead><tr><th>Corner / drawing position</th><th>Original radius mm</th><th>Approved radius mm</th></tr></thead><tbody>{panel.report.relief_circles.map(c=><tr key={c.handle}><td>{c.handle}<small>X {c.center_dxf_mm[0].toFixed(2)}, Y {c.center_dxf_mm[1].toFixed(2)}</small></td><td>{c.original_radius_mm}</td><td><input type="number" step="any" min={c.original_radius_mm} max={c.max_radius_mm} aria-label={'Corner radius '+c.handle} placeholder={c.original_radius_mm.toString()} value={value.relief_radii[c.handle]??''} onChange={e=>onChange({...value,relief_radii:{...value.relief_radii,[c.handle]:e.target.value===''?null:Number(e.target.value)}})}/></td></tr>)}</tbody></table></div>
  </details>}
  <div className="manual-section-choice"><label><Checkbox checked={value.manual_bends} onCheckedChange={c=>manualMode(c===true)}/>Use reviewed bend values instead of missing or unreliable section drawings</label>
   {value.manual_bends&&<p>Current detected angles are copied into the review values. Check them and fill every remaining rotation. The result records that section dimensions and paint orientation were not independently checked.</p>}
   {(value.manual_bends||Object.values(value.relief_radii).some(r=>r!=null))&&<><label htmlFor="review-note">Source of confirmed values / reason for this decision</label><textarea id="review-note" maxLength={2000} value={value.review_note} onChange={e=>onChange({...value,review_note:e.target.value})} placeholder="For example: measured from the approved client STEP."/></>}
  </div>
  {!!panel.report.corner_relief_proposals?.length&&<div className="manual-section-choice"><p>The highlighted corner regions contain {panel.report.corner_relief_proposals.reduce((sum,p)=>sum+p.area_mm2,0).toFixed(4)} mm² of material and have no original bend axis.</p><label><Checkbox checked={value.accept_corner_reliefs} onCheckedChange={c=>onChange({...value,accept_corner_reliefs:c===true})}/>I reviewed and approve removal of these corner regions as bend relief</label></div>}
  {panel.report.warnings?.map((warning,i)=><p className="review-warning" key={i}>{warning}</p>)}
 </div>;
}
