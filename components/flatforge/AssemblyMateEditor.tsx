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
 const step=!selection.reference?1:!selection.moving?2:3;
 return <section className="asm-context asm-position-card" data-position-popup="true" aria-label="Planar mate controls">
  <header><strong>Connect / Mate · {edge?'straight edges':'planar faces'}</strong></header>
  <ol className="asm-mate-progress" aria-hidden="true">
   <li data-done={step>1} data-current={step===1}><span className="asm-step-num">1</span><span className="asm-step-label">Pick first {kind}</span></li>
   <li data-done={step>2} data-current={step===2}><span className="asm-step-num">2</span><span className="asm-step-label">Pick second {kind}</span></li>
   <li data-current={step===3}><span className="asm-step-num">3</span><span className="asm-step-label">Confirm</span></li>
  </ol>
  <p>{selection.pick==='reference'?`Click the connecting ${kind} on the first panel — it highlights blue.`:selection.pick==='moving'?`Now click the matching ${kind} on the second panel — it highlights orange.`:'Review the alignment below, then confirm.'} {edge?'Click just inside the flange beside its edge. This face sets the gap direction.':''}</p>
  {(['reference','moving'] as const).map(role=><button key={role} aria-pressed={selection.pick===role} onClick={()=>onPick(role)}><span aria-hidden="true" className={'asm-swatch asm-swatch-'+role}/>{role==='reference'?'Reference':'Moving'}: {selection[role]?`${title(role==='reference'?selection.referenceEntryId:selection.movingEntryId)} · ${selection[role]!.faceId}${selection[role]!.edgeId?' / '+selection[role]!.edgeId:''}`:'Select '+kind}</button>)}
  {draft&&<>
   <p>{edge?'The selected flange faces oppose each other. V runs along the edge; U runs across it.':'Faces align at the chosen references. U and V slide within the mating plane.'}</p>
   <div className="asm-inline-values"><label><span>Plane gap</span><span><input aria-label="Plane gap" type="number" step="any" value={draft.fields.gap} onChange={e=>onChange({...draft.fields,gap:e.target.value})}/><small>mm</small></span></label></div>
   <p>Total plane separation: {error?'—':(Number(draft.fields.gap)+Number(draft.fields.normal)).toFixed(3)} mm. Most connections only need this gap value — offsets, rotation and alignment below are optional.</p>
   {measure&&<p>Measured plane gap: {measure.actual?.toFixed(3)} mm · finite-{kind} clearance: {measure.surfaceDistance?.toFixed(3)} mm.{!measure.projectionOverlap&&' The selected geometry does not overlap in projection; its clearance exceeds the plane gap.'}</p>}
   <p>Active dependent mates follow this edit. Unrelated panels stay fixed. One mate per moving panel; applying replaces its previous connection. Curved mates and closed constraint loops are unsupported.</p>
   {error&&<p role="alert">{error}</p>}
  </>}
  <details className="asm-advanced">
   <summary>Advanced options</summary>
   <label className="asm-field">Mate using <select aria-label="Mate geometry" value={selection.geometry??'face'} onChange={e=>onMode(e.target.value as 'edge'|'face')}><option value="face">Faces</option><option value="edge">Straight edges</option></select></label>
   {!edge&&<label className="asm-field">Align at <select aria-label="Mate alignment" value={selection.alignment??'top'} onChange={e=>onOptions({alignment:e.target.value as 'top'|'picked'})}><option value="top">Top corner</option><option value="picked">Picked points</option></select></label>}
   {draft&&<>
    {edge&&<label><input type="checkbox" checked={!!selection.flip} onChange={e=>onOptions({flip:e.target.checked})}/>Flip moving endpoint</label>}
    <div className="asm-inline-values">{([['u','Local U offset','mm'],['v','Local V offset','mm'],['normal','Additional normal separation','mm'],['twist','In-plane rotation','°']] as const).filter(([key])=>!edge||key!=='twist').map(([key,label,unit])=><label key={key}><span>{label}</span><span><input aria-label={label} type="number" step="any" value={draft.fields[key]} onChange={e=>onChange({...draft.fields,[key]:e.target.value})}/><small>{unit}</small></span></label>)}</div>
   </>}
  </details>
  <footer><button onClick={onCancel}>Cancel</button><button className="primary" disabled={!draft||!valid||!!error||!!selection.pick} onClick={onApply}>Apply Mate</button></footer>
 </section>;
}
