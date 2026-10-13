'use client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Settings } from './types';

export default function ParameterFields({value,onChange}:{value:Settings;onChange:(s:Settings)=>void}) {
 const numbers = [
  ['thickness','Material thickness',2,0.001,20,'mm'],
  ['radius','Inside bend radius',2,0.001,100,'mm'],
  ['deduction',value.bend_model==='fixed_deduction'?'Deduction at each bend':'Bend deduction at 90°',4,0,100,'mm'],
  ['strip_tolerance','Allowed length difference',.5,.001,5,'mm'],
  ['angle_tolerance','Allowed angle difference',.1,0,2,'°'],
  ['default_angle','Angle to use when missing',90,.001,179.999,'°'],
 ] as const;
 return <div className="parameter-grid">
  {numbers.map(([key,title,fallback,min,max,unit])=><div className="field" key={key}>
   <Label htmlFor={'param-'+key}>{title}</Label><div className="unit-input">
    <Input id={'param-'+key} type="number" min={min} max={max} step="any" value={value[key]??fallback} onChange={e=>onChange({...value,[key]:Number(e.target.value)})}/><span>{unit}</span>
   </div>
  </div>)}
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
  <p className="parameter-help">The length limit applies to drawing comparisons. The angle limit allows near-90° drawing turns to match 90°. Enter rotation from the flat sheet: a 60° rotation leaves a 120° inside angle. The missing-angle value is used only when you choose a bend direction below.</p>
  {value.bend_model==='fixed_deduction'&&<p className="parameter-help">Fixed deduction is an explicit shape convention. Review the result before using its dimensions for fabrication.</p>}
  {value.bend_end_mode==='contour'&&<p className="parameter-help">Bends follow stepped ends and cut-outs in the drawing. Local checks include material hidden where folded faces meet.</p>}
 </div>;
}
