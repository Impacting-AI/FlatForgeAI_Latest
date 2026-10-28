'use client';
import type {AssemblyEntry,AssemblySide} from './types';
import type {CadFaceCatalog} from './assembly-cad';
import {faceDraftError,previewFaceDraft,type FaceDraft,type FaceRole} from './face-connection-state';

export default function AssemblyConnectionEditor({draft,entries,catalogs,valid,connecting,onSide,onReference,onGap,onApply,onCancel}:{
 draft:FaceDraft;entries:AssemblyEntry[];catalogs:Record<string,CadFaceCatalog>;valid:boolean;connecting:boolean;
 onSide:(role:FaceRole,side:AssemblySide)=>void;onReference:(id:string)=>void;onGap:(value:string)=>void;onApply:()=>void;onCancel:()=>void;
}){
 const name=(id:string)=>`Panel ${entries.find(e=>e.id===id)?.label??'?'}`;
 const error=faceDraftError(draft),complete=!!previewFaceDraft(draft);
 return <section className="asm-context asm-position-card" data-unsaved-assembly="true" aria-label="Connection controls">
  <header><strong>{name(draft.movingEntryId)} → {name(draft.referenceEntryId)}</strong><span>{connecting?'Add connection':'Reconnect'}</span></header>
  <label className="asm-field">Reference panel<select aria-label="Reference panel" value={draft.referenceEntryId} onChange={e=>onReference(e.target.value)}>{entries.slice(0,entries.findIndex(e=>e.id===draft.movingEntryId)).map(e=><option key={e.id} value={e.id}>Panel {e.label}</option>)}</select></label>
  {(['reference','moving'] as const).map(role=>{
   const id=role==='reference'?draft.referenceEntryId:draft.movingEntryId,catalog=catalogs[id],side=draft.sides?.[role];
   return <div className={'asm-side-step '+role} key={role}><strong>{name(id)} · {role==='reference'?'Reference side':'Connecting side'}</strong>
    <div className="asm-side-buttons" role="group" aria-label={role==='reference'?'Reference connection side':'Moving connection side'}>{(['left','right','top','bottom'] as const).map(value=><button key={value} disabled={!catalog?.sides} aria-pressed={side===value} onClick={()=>onSide(role,value)}>{value[0].toUpperCase()+value.slice(1)}</button>)}</div>
    <small>{!catalog?'Loading connection regions…':!catalog.sides?'Update the CAD service to use side connections.':!side?'Choose a side.':draft[role]?`${side[0].toUpperCase()+side.slice(1)} side selected`:catalog.sides[side].message}</small>
   </div>;
  })}
  <div className="asm-inline-values"><label><span>Initial connection gap</span><span><input type="number" min={0} step="any" aria-label="Connection gap" value={draft.fields.gap} onChange={e=>onGap(e.target.value)}/><small>mm</small></span></label></div>
  <p>Sides follow each panel’s original plane and rotate with it. Connect aligns the chosen regions; you can then move either panel independently.</p>
  {draft.message&&<p role="status">{draft.message}</p>}{error&&<p role="alert">{error}</p>}
  <footer><button onClick={onCancel}>Cancel</button><button className="primary" disabled={!complete||!!error||!valid||draft.pick!==null} onClick={onApply}>Connect</button></footer>
 </section>;
}
