'use client';
import { Checkbox } from '@/components/ui/checkbox';
import { Panel } from './types';
import type { ReviewValues } from './review-state';
import CornerReliefControls from './CornerReliefControls';

// Temporarily hidden in Step 3. Keep the control and saved values for restoration.
const SHOW_CORNER_RELIEF_CONTROLS = false;

export default function ReviewControls({panel,value,onChange}:{panel:Panel;value:ReviewValues;onChange:(v:ReviewValues)=>void}){
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
  {SHOW_CORNER_RELIEF_CONTROLS&&<CornerReliefControls panel={panel} value={value} onChange={onChange}/>}
  {!!panel.report.corner_relief_proposals?.length&&<div className="manual-section-choice"><p>The highlighted corner regions contain {panel.report.corner_relief_proposals.reduce((sum,p)=>sum+p.area_mm2,0).toFixed(4)} mm² of material and have no original bend axis.</p><label><Checkbox checked={value.accept_corner_reliefs} onCheckedChange={c=>onChange({...value,accept_corner_reliefs:c===true})}/>I reviewed and approve removal of these corner regions as bend relief</label></div>}
 </div>;
}
