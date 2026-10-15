'use client';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, Settings } from './types';
import { ReviewValues } from './ReviewControls';

export type ImportedReview=ReviewValues & {
 settings:Settings; expected_revision:number;
 confirm_parameters:boolean; accept_partial_sections:boolean; accept_relief_extensions:boolean;
};
type Preview={review:ImportedReview;explicit_angles:number;missing_bend_keys:string[];inherited_settings:string[]};

export default function ReviewFileImport({panelId,disabled,onLoad}:{panelId:string;disabled:boolean;onLoad:(review:ImportedReview)=>void}) {
 const input=useRef<HTMLInputElement>(null);
 const [preview,setPreview]=useState<Preview|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 async function readFile(file:File){
  setPreview(null);setError('');
  if(file.size>1024*1024){setError('Review file must be 1 MB or smaller.');return}
  setLoading(true);
  try{
   const form=new FormData();form.append('file',file);
   setPreview(await api<Preview>(`/panels/${panelId}/review-file`,form));
  }catch(e){setError((e as Error).message)}finally{setLoading(false)}
 }
 const settings=preview?.review.settings;
 return <div className="manual-section-choice">
  <h3>Import reviewed values</h3>
  <p>Load measured settings for this exact drawing. Inspect them below before saving and rebuilding.</p>
  <input ref={input} type="file" accept=".json,application/json" aria-label="Review values JSON" hidden onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void readFile(file)}}/>
  <Button type="button" variant="outline" disabled={disabled||loading} onClick={()=>input.current?.click()}>{loading?'Checking drawing match…':'Choose review file'}</Button>
  {error&&<p role="alert">{error}</p>}
  {preview&&settings&&<div role="status">
   <p><strong>Exact drawing matched.</strong> {preview.explicit_angles} signed bend values · {Object.values(preview.review.relief_radii).filter(v=>v!=null).length} corner-radius corrections.</p>
   <p>Thickness {settings.thickness} mm · inside radius {settings.radius} mm · deduction {settings.deduction} mm · limits {settings.strip_tolerance} mm / {settings.angle_tolerance}°.</p>
   <p>{settings.bend_model==='fixed_deduction'?'Fixed deduction':'Material model'} · {settings.bend_end_mode==='contour'?'Follow cut outline':'Straight bend ends'}.</p>
   {preview.review.manual_bends&&<p>Uses reviewed bend values in place of section drawings. {preview.review.review_note}</p>}
   {preview.missing_bend_keys.length>0&&<p>{preview.missing_bend_keys.length} bend rotations are missing. They stay unresolved until you supply them.</p>}
   {preview.inherited_settings.length>0&&<p>Settings absent from the file keep their current panel values. Inspect all fields before saving.</p>}
   <p>This replaces the form’s bend and corner decisions. Nothing is saved yet.</p>
   <Button type="button" disabled={disabled} onClick={()=>{onLoad(preview.review);setPreview(null)}}>Load values into review</Button>
   <Button type="button" variant="ghost" onClick={()=>setPreview(null)}>Cancel</Button>
  </div>}
 </div>;
}
