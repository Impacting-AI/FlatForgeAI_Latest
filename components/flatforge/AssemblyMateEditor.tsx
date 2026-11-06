'use client';
import type {AssemblyEntry} from './types';
import type {CadPlacement} from './assembly-cad';
import {faceDraftError,type FaceDraft,type FaceSelection,type FaceRole} from './face-connection-state';

export default function AssemblyMateEditor({selection,draft,entries,placement,valid,onPick,onChange,onApply,onCancel}:{
 selection:FaceSelection;draft:FaceDraft|null;entries:AssemblyEntry[];placement:CadPlacement|null;valid:boolean;
 onPick:(role:FaceRole)=>void;onChange:(fields:FaceDraft['fields'])=>void;onApply:()=>void;onCancel:()=>void;
}){
 const title=(id:string)=>`Panel ${entries.find(e=>e.id===id)?.label??'?'}`;
 const error=draft?faceDraftError(draft):'';
 const measure=valid?placement?.mates?.find(m=>m.entryId===draft?.movingEntryId):undefined;
 return <section className="asm-context asm-position-card" data-position-popup="true" aria-label="Planar mate controls">
  <header><strong>Connect / Mate · planar faces</strong></header>
  <p>{selection.pick==='reference'?'Click a planar face on the reference panel.':selection.pick==='moving'?'Click a planar face on the moving panel.':'Review the alignment before applying.'} Orbit and zoom to expose narrow flanges.</p>
  {(['reference','moving'] as const).map(role=><button key={role} aria-pressed={selection.pick===role} onClick={()=>onPick(role)}>{role==='reference'?'Reference':'Moving'}: {selection[role]?`${title(role==='reference'?selection.referenceEntryId:selection.movingEntryId)} · ${selection[role]!.faceId}`:'Select face'}</button>)}
  {draft&&<>
   <p>Opposing normals. At zero offsets, picked points align and local V arrows align. Red = U, green = V, blue = normal. Adjust twist to choose the in-plane orientation.</p>
   <div className="asm-inline-values">{([['gap','Plane gap','mm'],['u','Local U offset','mm'],['v','Local V offset','mm'],['normal','Additional normal separation','mm'],['twist','In-plane rotation','°']] as const).map(([key,label,unit])=><label key={key}><span>{label}</span><span><input aria-label={label} type="number" step="any" value={draft.fields[key]} onChange={e=>onChange({...draft.fields,[key]:e.target.value})}/><small>{unit}</small></span></label>)}</div>
   <p>Total plane separation: {error?'—':(Number(draft.fields.gap)+Number(draft.fields.normal)).toFixed(3)} mm. Normal adjustment changes this gap.</p>
   {measure&&<p>Measured plane gap: {measure.actual?.toFixed(3)} mm · finite-face clearance: {measure.surfaceDistance?.toFixed(3)} mm.{!measure.projectionOverlap&&' Faces do not overlap in projection; plane gap is not their shortest clearance.'}</p>}
   <p>Active dependent mates follow this edit. Unrelated panels stay fixed. One planar mate per moving panel; applying replaces its previous connection. Curved mates and closed constraint loops are unsupported.</p>
   {error&&<p role="alert">{error}</p>}
  </>}
  <footer><button onClick={onCancel}>Cancel</button><button className="primary" disabled={!draft||!valid||!!error||!!selection.pick} onClick={onApply}>Apply Mate</button></footer>
 </section>;
}
