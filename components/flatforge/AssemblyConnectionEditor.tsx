'use client';
import {useState} from 'react';
import type { AssemblyEntry } from './types';
import type { CadFaceCatalog } from './assembly-cad';
import { beginFaceDraft, faceDraftError, previewFaceDraft, updateFaceDraft, reselectFaceDraft, type FaceDraft, type FaceRole } from './face-connection-state';
import { faceSide, faceReference } from './assembly-workspace-state';

export default function AssemblyConnectionEditor({draft,entries,catalogs,valid,connecting,picking,rotating,dragging,onChange,onApply,onCancel}:{
 draft:FaceDraft;entries:AssemblyEntry[];catalogs:Record<string,CadFaceCatalog>;valid:boolean;connecting:boolean;picking:boolean;rotating:boolean;dragging:boolean;
 onChange:(draft:FaceDraft)=>void;onApply:()=>void;onCancel:()=>void;
}){
 const [collapsed,setCollapsed]=useState(false);
 const name=(id:string)=>`Panel ${entries.find(e=>e.id===id)?.label??'?'}`;
 const error=faceDraftError(draft),complete=!!previewFaceDraft(draft);
 const pick=(role:FaceRole)=>onChange({...draft,pick:role,message:''});
 return <section className="asm-context asm-position-card" data-position-popup={!picking?'true':undefined} data-unsaved-assembly="true" aria-label="Connection controls">
  <header><strong>{name(draft.movingEntryId)} <small>→ {name(draft.referenceEntryId)}</small></strong><span>{connecting?'New connection':picking?'Connection':'Position preview'}</span>{!picking&&<button type="button" aria-label={collapsed?'Expand position controls':'Collapse position controls'} aria-expanded={!collapsed} onClick={()=>setCollapsed(!collapsed)}>{collapsed?'+':'−'}</button>}</header>
  {collapsed&&<p className="asm-collapsed-values">Gap {(Number(draft.fields.gap)+Number(draft.fields.normal)).toFixed(2)} mm<br/>X {draft.fields.u} · Y {draft.fields.v} · Z {draft.fields.normal} mm</p>}
  <div hidden={collapsed}>
  {picking&&<>
   <label className="asm-field">Connect to<select aria-label="Reference panel" value={draft.referenceEntryId} onChange={e=>onChange(updateFaceDraft(draft,{referenceEntryId:e.target.value,reference:undefined,pick:'reference',message:''}))}>{entries.slice(0,entries.findIndex(e=>e.id===draft.movingEntryId)).map(e=><option key={e.id} value={e.id}>Panel {e.label}</option>)}</select></label>
   {(['reference','moving'] as const).map((role,index)=>{
    const id=role==='reference'?draft.referenceEntryId:draft.movingEntryId,catalog=catalogs[id],ref=draft[role];
    const face=catalog?.faces.find(f=>f.id===ref?.faceId);
    return <div className={'asm-side-step '+role} key={role}>
     <button type="button" aria-pressed={draft.pick===role} onClick={()=>pick(role)}>{index+1}. {role==='reference'?'Reference':'New'} side · {name(id)}</button>
     <small>{face?faceSide(face):'Click a surface in the viewer'}</small>
     <details><summary>Choose from face list</summary><select aria-label={role==='reference'?'Reference connection side':'Moving connection side'} value={ref?.faceId??''} onChange={e=>{const face=catalog?.faces.find(f=>f.id===e.target.value);if(face&&catalog){try{onChange(updateFaceDraft(draft,{[role]:faceReference(catalog,face),pick:role==='reference'&&!draft.moving?'moving':null,message:''}));}catch(error){onChange({...draft,pick:role,message:(error as Error).message});}}}}>
      <option value="">Select a planar face…</option>{catalog?.faces.filter(f=>f.supported).map(f=><option key={f.id} value={f.id}>{faceSide(f)}</option>)}
     </select></details>
    </div>;
   })}
   <p>The moving panel’s selected face rotates to oppose the reference face. Picked points define alignment.</p>
  </>}
  <div className="asm-inline-values">{([
   ['gap','Connection gap','mm'],['u','X offset — along face','mm'],['v','Y offset — along face','mm'],['normal','Z offset — normal','mm'],
   ...(rotating?[['twist','In-plane rotation','°']]:[]),
  ] as [keyof FaceDraft['fields'],string,string][]).map(([key,label,unit])=><label key={key}><span>{label}</span><span><input type="number" step="any" aria-label={label} min={key==='gap'?0:undefined} value={draft.fields[key]} disabled={dragging} onChange={e=>onChange(updateFaceDraft(draft,{fields:{...draft.fields,[key]:e.target.value}}))}/><small>{unit}</small></span></label>)}</div>
  {!error&&<div className="asm-gap-readout">Face gap <strong>{(Number(draft.fields.gap)+Number(draft.fields.normal)).toFixed(2)} mm</strong></div>}
  <p>Local X/Y slide along the reference face. Z adds normal separation and changes the gap. Connected descendants follow.</p>
  {!picking&&<p>Drag an axis · 1 mm steps · Shift for 0.1 mm. Type any exact value.</p>}
  {draft.message&&<p role="status">{draft.message}</p>}{error&&<p className="asm-spacing-error" role="alert">{error} Last valid preview retained.</p>}
  <footer><button disabled={dragging} onClick={()=>onChange(connecting?updateFaceDraft(draft,{fields:{...draft.fields,u:'0',v:'0',normal:'0',twist:'0'}}):{...beginFaceDraft(draft.original),pick:null})}>Reset position</button><button disabled={dragging} onClick={onCancel}>Cancel</button><button className="primary" disabled={!complete||!!error||!valid||draft.pick!==null||dragging} onClick={onApply}>{connecting?'Connect Panels':'Apply position'}</button></footer>
  {picking&&<button className="asm-text-action" disabled={dragging} onClick={()=>onChange(reselectFaceDraft(draft))}>Reselect sides</button>}
  </div>
 </section>;
}
