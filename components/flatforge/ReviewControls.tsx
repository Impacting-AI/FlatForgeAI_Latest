'use client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { BendValues, Panel, Settings } from './types';
import type { BendChange } from './bend-review';
import type { ReviewValues } from './review-state';
import CornerReliefControls from './CornerReliefControls';

// Temporarily hidden in Step 3. Keep the control and saved values for restoration.
const SHOW_CORNER_RELIEF_CONTROLS = false;

export default function ReviewControls({panel,settings,value,onChange,onBendChange}:{panel:Panel;settings:Settings;value:ReviewValues;onChange:(v:ReviewValues)=>void;onBendChange:BendChange}){
 const setBend=(key:string,field:keyof BendValues,input:string|number)=>{
  onBendChange(key,{[field]:input===''?null:Number(input)});
 };
 const unresolved=panel.report.unresolved_bends??[];
 const candidates=panel.report.section_mapping?.filter(s=>(s.status!=='PASS'&&s.review_candidates?.length)||value.section_choices[s.profile]);
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
  {unresolved.length>0&&<p><strong>{unresolved.length} bend rotations need values.</strong> Use the shared angle ({settings.default_angle??90}°) with a direction, or select a bend in the viewer to enter a different value. You can also change settings and rebuild before choosing.</p>}
  {unresolved.map(b=><div className="bend-decision" key={b.key}>
   <div><strong>{b.bend_ids.join(' / ')} · F{b.parent} → F{b.child}</strong><p>{b.reason}</p><small>Positive axis: {b.axis}. Signed rotation uses the right-hand rule.</small></div>
   <div className="bend-quick-values"><Button type="button" variant="outline" size="sm" onClick={()=>setBend(b.key,'angle',settings.default_angle??90)}>+{settings.default_angle??90}°</Button><Button type="button" variant="outline" size="sm" onClick={()=>setBend(b.key,'angle',-(settings.default_angle??90))}>−{settings.default_angle??90}°</Button><input aria-label={'Signed angle for '+b.bend_ids.join('/')} type="number" step="any" min="-179.999" max="179.999" placeholder="Angle °" value={value.bend_parameters[b.key]?.angle??''} onChange={e=>setBend(b.key,'angle',e.target.value)}/></div>
  </div>)}
  {SHOW_CORNER_RELIEF_CONTROLS&&<CornerReliefControls panel={panel} value={value} onChange={onChange}/>}
  {!!panel.report.corner_relief_proposals?.length&&<div className="manual-section-choice"><p>The highlighted corner regions contain {panel.report.corner_relief_proposals.reduce((sum,p)=>sum+p.area_mm2,0).toFixed(4)} mm² of material and have no original bend axis.</p><label><Checkbox checked={value.accept_corner_reliefs} onCheckedChange={c=>onChange({...value,accept_corner_reliefs:c===true})}/>I reviewed and approve removal of these corner regions as bend relief</label></div>}
 </div>;
}
