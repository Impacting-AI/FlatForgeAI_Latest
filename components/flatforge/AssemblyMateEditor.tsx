'use client';
import type {AssemblyEntry} from './types';
import type {CadPlacement} from './assembly-cad';
import {faceDraftError,type FaceDraft,type FaceSelection,type FaceRole} from './face-connection-state';

export type MateStatus={checking:boolean;message:string};
const TURNS=[0,90,180,270];

export function mateGuidance(selection:FaceSelection,draft:FaceDraft|null,valid:boolean,status:MateStatus,error:string){
 if(selection.pick==='reference')return {tone:'info',text:'Select the first face: click a flat surface on the first panel.'};
 if(selection.pick==='moving')return {tone:'info',text:'Select the second face: click the matching flat surface on a different panel.'};
 if(!draft)return {tone:'info',text:'Preparing the connection…'};
 if(error)return {tone:'error',text:error};
 if(status.checking)return {tone:'info',text:'Checking the connection against the CAD solids…'};
 if(valid)return {tone:'ok',text:'Connection is valid. Apply Mate to create it.'};
 const detail=status.message||'The CAD service has not approved this connection yet.';
 const solids=/intersect/i.test(detail);
 return {tone:'error',text:`${detail}${solids?' Try a different in-plane rotation below, pick other faces, or increase the plane gap.':''}`};
}

export default function AssemblyMateEditor({selection,draft,entries,placement,valid,status,fileNames,onPick,onMode,onOptions,onChange,onApply,onCancel}:{
 selection:FaceSelection;draft:FaceDraft|null;entries:AssemblyEntry[];placement:CadPlacement|null;valid:boolean;status:MateStatus;fileNames:Record<string,string>;
 onMode:(mode:'face'|'edge')=>void;onOptions:(patch:Pick<FaceSelection,'alignment'|'flip'>)=>void;
 onPick:(role:FaceRole)=>void;onChange:(fields:FaceDraft['fields'])=>void;onApply:()=>void;onCancel:()=>void;
}){
 const edge=selection.geometry==='edge';
 const kind=edge?'edge':'face';
 const title=(id:string)=>`Panel ${entries.find(e=>e.id===id)?.label??'?'}`;
 const error=draft?faceDraftError(draft):'';
 const measure=valid?placement?.mates?.find(m=>m.entryId===draft?.movingEntryId):undefined;
 const step=!selection.reference?1:!selection.moving?2:3;
 const guide=mateGuidance(selection,draft,valid,status,error);
 const twist=draft?Number(draft.fields.twist):0;
 const picked=!!selection.reference||!!selection.moving;
 return <section className="asm-context asm-position-card" data-position-popup="true" aria-label="Planar mate controls">
  <header><strong>Connect / Mate · {edge?'straight edges':'planar faces'}</strong></header>
  <ol className="asm-mate-progress" aria-hidden="true">
   <li data-done={step>1} data-current={step===1}><span className="asm-step-num">1</span><span className="asm-step-label">Pick first {kind}</span></li>
   <li data-done={step>2} data-current={step===2}><span className="asm-step-num">2</span><span className="asm-step-label">Pick second {kind}</span></li>
   <li data-current={step===3}><span className="asm-step-num">3</span><span className="asm-step-label">Confirm</span></li>
  </ol>
  <p role={guide.tone==='error'?'alert':'status'} data-mate-status={guide.tone}>{guide.text}{selection.pick&&edge?' Click just inside the flange beside its edge. This face sets the gap direction.':''}</p>
  {(['reference','moving'] as const).map(role=>{
   const id=role==='reference'?selection.referenceEntryId:selection.movingEntryId,face=selection[role];
   return <button key={role} aria-pressed={selection.pick===role} title={face?'Click to pick this '+kind+' again':'Waiting for your selection'} onClick={()=>onPick(role)}><span aria-hidden="true" className={'asm-swatch asm-swatch-'+role}/>{role==='reference'?'Reference':'Moving'}: {face?`${title(id)}${fileNames[id]?' ('+fileNames[id]+')':''} · ${face.faceId}${face.edgeId?' / '+face.edgeId:''}`:'Select '+kind}<small> {role==='reference'?'(stays fixed)':'(moves to meet it)'}</small></button>;
  })}
  {draft&&<>
   <p>{edge?'The selected flange faces oppose each other. V runs along the edge; U runs across it.':'Faces meet with opposing normals. U and V slide within the mating plane.'}</p>
   {!edge&&<div className="asm-inline-values" role="group" aria-label="In-plane rotation"><span>In-plane rotation</span><span>{TURNS.map(turn=><button key={turn} aria-pressed={twist===turn} onClick={()=>onChange({...draft.fields,twist:String(turn)})}>{turn}°</button>)}</span></div>}
   <div className="asm-inline-values"><label><span>Plane gap</span><span><input aria-label="Plane gap" type="number" step="any" value={draft.fields.gap} onChange={e=>onChange({...draft.fields,gap:e.target.value})}/><small>mm</small></span></label></div>
   <p>Total plane separation: {error?'—':(Number(draft.fields.gap)+Number(draft.fields.normal)).toFixed(3)} mm. Most connections only need this gap value — offsets and alignment below are optional.</p>
   {measure&&<p>Measured plane gap: {measure.actual?.toFixed(3)} mm · finite-{kind} clearance: {measure.surfaceDistance?.toFixed(3)} mm.{!measure.projectionOverlap&&' The selected geometry does not overlap in projection; its clearance exceeds the plane gap.'}</p>}
  </>}
  <details className="asm-advanced">
   <summary>Advanced options</summary>
   <label className="asm-field">Mate using <select aria-label="Mate geometry" value={selection.geometry??'face'} onChange={e=>onMode(e.target.value as 'edge'|'face')}><option value="face">Faces</option><option value="edge">Straight edges</option></select></label>
   {!edge&&<label className="asm-field">Align at <select aria-label="Mate alignment" value={selection.alignment??'top'} onChange={e=>onOptions({alignment:e.target.value as 'top'|'picked'})}><option value="top">Top corner</option><option value="picked">Picked points</option></select></label>}
   {draft&&<>
    {edge&&<label><input type="checkbox" checked={!!selection.flip} onChange={e=>onOptions({flip:e.target.checked})}/>Flip moving endpoint</label>}
    <div className="asm-inline-values">{([['u','Local U offset','mm'],['v','Local V offset','mm'],['normal','Additional normal separation','mm'],['twist','In-plane rotation','°']] as const).filter(([key])=>!edge||key!=='twist').map(([key,label,unit])=><label key={key}><span>{label}</span><span><input aria-label={label} type="number" step="any" value={draft.fields[key]} onChange={e=>onChange({...draft.fields,[key]:e.target.value})}/><small>{unit}</small></span></label>)}</div>
    <p>Active dependent mates follow this edit. Unrelated panels stay fixed. One mate per moving panel; applying replaces its previous connection. Curved mates and closed constraint loops are unsupported.</p>
   </>}
  </details>
  <footer>{picked&&<button title="Clear both selections and start again" onClick={()=>onMode(selection.geometry??'face')}>Start over</button>}<button onClick={onCancel}>Cancel</button><button className="primary" disabled={!draft||!valid||!!error||!!selection.pick} title={!valid&&draft?guide.text:undefined} onClick={onApply}>Apply Mate</button></footer>
 </section>;
}
