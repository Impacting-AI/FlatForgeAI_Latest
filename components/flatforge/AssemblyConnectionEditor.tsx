'use client';
import {descendants} from './assembly-workspace-state';
import type {AssemblyEntry,AssemblySide} from './types';
import type {CadFaceCatalog,CadPlacement} from './assembly-cad';
import {faceDraftError,previewFaceDraft,type FaceDraft,type FaceRole} from './face-connection-state';

export default function AssemblyConnectionEditor({draft,entries,catalogs,valid,connecting,insertion,onBranch,onSide,onReference,onGap,onApply,onCancel}:{
 insertion?:CadPlacement['insertion'];onBranch:(id:string)=>void;draft:FaceDraft;entries:AssemblyEntry[];catalogs:Record<string,CadFaceCatalog>;valid:boolean;connecting:boolean;
 onSide:(role:FaceRole,side:AssemblySide)=>void;onReference:(id:string)=>void;onGap:(value:string)=>void;onApply:()=>void;onCancel:()=>void;
}){
 const name=(id:string)=>`Panel ${entries.find(e=>e.id===id)?.label??'?'}`;
 const reference=entries.find(e=>e.id===draft.referenceEntryId),side=draft.sides?.reference;
 const excluded=descendants(entries,draft.movingEntryId);
 const occupants=side?entries.filter(e=>e.id!==draft.movingEntryId&&((e.targetId===draft.referenceEntryId&&e.sides?.reference===side)||(reference?.targetId===e.id&&reference.sides?.moving===side))):[];
 const error=faceDraftError(draft),complete=!!previewFaceDraft(draft);
 return <section className="asm-context asm-position-card" data-unsaved-assembly="true" aria-label="Connection controls">
  <header><strong>{name(draft.movingEntryId)} → {name(draft.referenceEntryId)}</strong><span>{connecting?'Add connection':'Reconnect'}</span></header>
  <label className="asm-field">Reference panel<select aria-label="Reference panel" value={draft.referenceEntryId} onChange={e=>onReference(e.target.value)}>{entries.filter(e=>!excluded.has(e.id)).map(e=><option key={e.id} value={e.id}>Panel {e.label}</option>)}</select></label>
  {(['reference','moving'] as const).map(role=>{
   const id=role==='reference'?draft.referenceEntryId:draft.movingEntryId,catalog=catalogs[id],side=draft.sides?.[role];
   return <div className={'asm-side-step '+role} key={role}><strong>{name(id)} · {role==='reference'?'Reference side':'Connecting side'}</strong>
    <div className="asm-side-buttons" role="group" aria-label={role==='reference'?'Reference connection side':'Moving connection side'}>{(['left','right','top','bottom'] as const).map(value=><button key={value} disabled={!catalog?.sides} aria-pressed={side===value} onClick={()=>onSide(role,value)}>{value[0].toUpperCase()+value.slice(1)}</button>)}</div>
    <small>{!catalog?'Loading connection regions…':!catalog.sides?'Update the CAD service to use side connections.':!side?'Choose a side.':draft[role]?`${side[0].toUpperCase()+side.slice(1)} side selected`:catalog.sides[side].message}</small>
   </div>;
  })}
  {occupants.length>1&&<label className="asm-field">Insert before branch<select aria-label="Insert before branch" value={draft.insertBranchId??''} onChange={e=>onBranch(e.target.value)}><option value="">Choose occupied connection</option>{occupants.map(e=><option key={e.id} value={e.id}>{name(e.id)}</option>)}</select></label>}
  {occupants.length>0&&<p>Occupied side: insertion moves the selected connected branch. Unrelated panels stay fixed; manual offsets and rotations are retained.</p>}
  {insertion&&<p role="status">Preview: {name(insertion.referenceId)} → {name(insertion.panelId)} → {name(insertion.displacedId)}. {insertion.movedIds.length} existing panel(s) move.{insertion.rerooted?' Connection traversal starts from the fixed reference panel.':''}</p>}
  <div className="asm-inline-values"><label><span>Initial connection gap</span><span><input type="number" min={0} step="any" aria-label="Connection gap" value={draft.fields.gap} onChange={e=>onGap(e.target.value)}/><small>mm</small></span></label></div>
  <p>Sides follow each panel’s original plane and rotate with it. Connect aligns the chosen regions; you can then move either panel independently.</p>
  {draft.message&&<p role="status">{draft.message}</p>}{error&&<p role="alert">{error}</p>}
  <footer><button onClick={onCancel}>Cancel</button><button className="primary" disabled={!complete||!!error||!valid||draft.pick!==null} onClick={onApply}>Connect</button></footer>
 </section>;
}
