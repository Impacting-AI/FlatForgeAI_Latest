'use client';
import type {AssemblyEntry} from './types';
import type {CadPlacement} from './assembly-cad';
import {faceDraftError,type FaceDraft,type FaceSelection,type FaceRole} from './face-connection-state';

export default function AssemblyMateEditor({selection,draft,entries,placement,valid,onPick,onMode,onOptions,onChange,onApply,onCancel}:{
 selection:FaceSelection;draft:FaceDraft|null;entries:AssemblyEntry[];placement:CadPlacement|null;valid:boolean;
 onMode:(mode:'face'|'edge')=>void;onOptions:(patch:Pick<FaceSelection,'alignment'|'flip'>)=>void;
 onPick:(role:FaceRole)=>void;onChange:(fields:FaceDraft['fields'])=>void;onApply:()=>void;onCancel:()=>void;
}){
 const edge=selection.geometry==='edge';
 const kind=edge?'edge':'face';
 const title=(id:string)=>`Panel ${entries.find(e=>e.id===id)?.label??'?'}`;
 const error=draft?faceDraftError(draft):'';
 const measure=valid?placement?.mates?.find(m=>m.entryId===draft?.movingEntryId):undefined;
 return <section className="asm-context asm-position-card" data-position-popup="true" aria-label="Planar mate controls">
  <header><strong>Connect / Mate · {edge?'straight edges':'planar faces'}</strong></header>
  <label>Mate using <select aria-label="Mate geometry" value={selection.geometry??'face'} onChange={e=>onMode(e.target.value as 'edge'|'face')}><option value="face">Faces</option><option value="edge">Straight edges</option></select></label>
  {!edge&&<label>Align at <select aria-label="Mate alignment" value={selection.alignment??'top'} onChange={e=>onOptions({alignment:e.target.value as 'top'|'picked'})}><option value="top">Top corner</option><option value="picked">Picked points</option></select></label>}
  <p>{selection.pick==='reference'?'Select the reference '+kind+'.':selection.pick==='moving'?'Select the moving '+kind+'.':'Review the alignment before applying.'} {edge?'Click just inside the flange beside its edge. This face sets the gap direction.':''}</p>
  {(['reference','moving'] as const).map(role=><button key={role} aria-pressed={selection.pick===role} onClick={()=>onPick(role)}>{role==='reference'?'Reference':'Moving'}: {selection[role]?`${title(role==='reference'?selection.referenceEntryId:selection.movingEntryId)} · ${selection[role]!.faceId}${selection[role]!.edgeId?' / '+selection[role]!.edgeId:''}`:'Select '+kind}</button>)}
  {draft&&<>
   <p>{edge?'The selected flange faces oppose each other. V runs along the edge; U runs across it.':'Opposing faces align at the chosen references. U and V slide within the mating plane.'}</p>
   {edge&&<label><input type="checkbox" checked={!!selection.flip} onChange={e=>onOptions({flip:e.target.checked})}/>Flip moving endpoint</label>}
   <div className="asm-inline-values">{([['gap','Plane gap','mm'],['u','Local U offset','mm'],['v','Local V offset','mm'],['normal','Additional normal separation','mm'],['twist','In-plane rotation','°']] as const).filter(([key])=>!edge||key!=='twist').map(([key,label,unit])=><label key={key}><span>{label}</span><span><input aria-label={label} type="number" step="any" value={draft.fields[key]} onChange={e=>onChange({...draft.fields,[key]:e.target.value})}/><small>{unit}</small></span></label>)}</div>
   <p>Total plane separation: {error?'—':(Number(draft.fields.gap)+Number(draft.fields.normal)).toFixed(3)} mm. Normal adjustment changes this gap.</p>
   {measure&&<p>Measured plane gap: {measure.actual?.toFixed(3)} mm · finite-{kind} clearance: {measure.surfaceDistance?.toFixed(3)} mm.{!measure.projectionOverlap&&' The selected geometry does not overlap in projection; its clearance exceeds the plane gap.'}</p>}
   <p>Active dependent mates follow this edit. Unrelated panels stay fixed. One mate per moving panel; applying replaces its previous connection. Curved mates and closed constraint loops are unsupported.</p>
   {error&&<p role="alert">{error}</p>}
  </>}
  <footer><button onClick={onCancel}>Cancel</button><button className="primary" disabled={!draft||!valid||!!error||!!selection.pick} onClick={onApply}>Apply Mate</button></footer>
 </section>;
}
