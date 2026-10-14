'use client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ParameterKey, ParameterResolution, ParameterValues, Settings } from './types';

export default function ParameterFields({value,onChange,resolution,overrides,onOverride,fallbackValues}:{value:Settings;onChange:(s:Settings)=>void;resolution?:Partial<Record<ParameterKey,ParameterResolution>>;overrides?:ParameterValues;onOverride?:(key:ParameterKey,value:number|null)=>void;fallbackValues?:Settings}) {
 const numbers = [
  ['thickness','Material thickness',2,0.001,20,'mm'],
  ['radius','Inside bend radius',2,0.001,100,'mm'],
  ['deduction',value.bend_model==='fixed_deduction'?'Deduction at each bend':'Bend deduction at 90°',4,0,100,'mm'],
  ['strip_tolerance','Allowed length difference',.5,.001,5,'mm'],
  ['angle_tolerance','Allowed angle difference',.1,0,2,'°'],
  ['default_angle','Angle to use when missing',90,.001,179.999,'°'],
 ] as const;
 return <div className="parameter-grid">
  {numbers.map(([key,title,fallback,min,max,unit])=>{const parameter=key==='thickness'||key==='radius'||key==='deduction'?key:null;const evidence=parameter?resolution?.[parameter]:undefined;const manual=parameter&&overrides?.[parameter]!=null;return <div className="field" key={key}>
   <Label htmlFor={'param-'+key}>{title}</Label><div className="unit-input">
    <Input id={'param-'+key} type="number" min={min} max={max} step="any" value={value[key]??fallback} aria-describedby={evidence?'source-'+key:undefined} onChange={e=>{const next=Number(e.target.value);if(parameter&&onOverride)onOverride(parameter,next);else onChange({...value,[key]:next})}}/><span>{unit}</span>
   </div>
   {evidence&&<small id={'source-'+key}>{manual?'Manual value · saved when you rebuild.':parameter&&overrides?.[parameter]===null?'Automatic detection will run again when you rebuild.':evidence.message}{!manual&&evidence.evidence?.candidates&&` Drawing candidates: ${Array.isArray(evidence.evidence.candidates)?evidence.evidence.candidates.join(', '):Object.keys(evidence.evidence.candidates).join(', ')} mm.`}</small>}
   {parameter&&onOverride&&(manual?<Button type="button" variant="ghost" size="sm" onClick={()=>onOverride(parameter,null)}>Use automatic</Button>:evidence?.needs_review?<Button type="button" variant="outline" size="sm" onClick={()=>onOverride(parameter,value[parameter])}>Confirm {value[parameter]} mm for this panel</Button>:null)}
  </div>})}
  <div className="field"><Label htmlFor="bend-model">Bend calculation</Label>
   <select id="bend-model" value={value.bend_model??'constant_k'} onChange={e=>onChange({...value,bend_model:e.target.value as Settings['bend_model']})}>
    <option value="constant_k">Material model · calibrated at 90°</option>
    <option value="fixed_deduction">Shape model · fixed deduction at each angle</option>
   </select>
  </div>
  <div className="field"><Label htmlFor="bend-ends">Bend ends</Label>
   <select id="bend-ends" value={value.bend_end_mode??'straight'} onChange={e=>onChange({...value,bend_end_mode:e.target.value as Settings['bend_end_mode']})}>
    <option value="straight">Straight ends · constant bend length</option>
    <option value="contour">Follow cut outline · shaped ends</option>
   </select>
  </div>
  <div className="field"><Label htmlFor="input-type">Input type</Label><select id="input-type" value={value.input_type} onChange={e=>onChange({...value,input_type:e.target.value as Settings['input_type']})}><option value="flat_pattern">Developed flat pattern</option><option value="folded_dimensions">Folded dimensions · review required</option></select></div>
  <div className="parameter-help"><label><Checkbox checked={value.use_material_defaults===true} onCheckedChange={checked=>onChange({...value,use_material_defaults:checked===true})}/> Use material defaults when the drawing does not establish a value</label><p>Drawing values take priority. Enable this only when these thickness, radius and deduction defaults are approved for the job. Otherwise, missing values stay editable and require confirmation.</p></div>
  {fallbackValues&&<p className="parameter-help">Fallback defaults: thickness {fallbackValues.thickness} mm · inside radius {fallbackValues.radius} mm · deduction {fallbackValues.deduction} mm. Change defaults in Material defaults for future uploads, or edit a field above for this panel.</p>}
  <p className="parameter-help">The length limit applies to drawing comparisons. The angle limit allows near-90° drawing turns to match 90°. Enter rotation from the flat sheet: a 60° rotation leaves a 120° inside angle. The missing-angle value is used only when you choose a bend direction below.</p>
  {value.bend_model==='fixed_deduction'&&<p className="parameter-help">Fixed deduction is an explicit shape convention. Review the result before using its dimensions for fabrication.</p>}
  {value.bend_end_mode==='contour'&&<p className="parameter-help">Bends follow stepped ends and cut-outs in the drawing. Local checks include material hidden where folded faces meet.</p>}
 </div>;
}
