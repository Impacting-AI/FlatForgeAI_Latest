'use client';
import type { AssemblyEntry, Panel } from './types';
import { faceDraftError, previewFaceDraft, updateFaceDraft, reselectFaceDraft, type FaceDraft } from './face-connection-state';

export default function AssemblyConnectionEditor({draft,entries,panels,valid,onChange,onApply,onCancel}:{
  draft:FaceDraft;entries:AssemblyEntry[];panels:Panel[];valid:boolean;
  onChange:(draft:FaceDraft)=>void;onApply:()=>void;onCancel:()=>void;
}) {
  const name=(id:string)=>{const entry=entries.find(e=>e.id===id);return panels.find(p=>p.id===entry?.panelId)?.filename??id;};
  const error=faceDraftError(draft),complete=!!previewFaceDraft(draft);
  return <section className="asm-face-editor" data-unsaved-assembly="true" aria-label="CAD face connection editor">
    <div className="asm-face-heading"><strong>Connect actual CAD faces</strong><span>Preview · Apply to save</span></div>
    <div className="asm-face-pair">
      <div><label>Reference panel A<select aria-label="Reference panel A" value={draft.referenceEntryId} onChange={e=>onChange(updateFaceDraft(draft,{referenceEntryId:e.target.value,reference:undefined,pick:'reference',message:''}))}>
        {entries.slice(0,entries.findIndex(e=>e.id===draft.movingEntryId)).map(e=><option key={e.id} value={e.id}>{name(e.id)}</option>)}
      </select></label><button type="button" className="asm-pick-reference" aria-pressed={draft.pick==='reference'} onClick={()=>onChange({...draft,pick:'reference',message:''})}>Pick reference face A</button><small>{draft.reference?.faceId??'No face selected'}</small></div>
      <div><label>Moving panel B<strong>{name(draft.movingEntryId)}</strong></label><button type="button" className="asm-pick-moving" aria-pressed={draft.pick==='moving'} onClick={()=>onChange({...draft,pick:'moving',message:''})}>Pick moving face B</button><small>{draft.moving?.faceId??'No face selected'}</small></div>
    </div>
    <p>Click a planar surface at the desired connection point. B rotates to face A; the picked points define zero alignment. A stays fixed.</p>
    <div className="asm-face-values">{([
      ['gap','Connection gap','mm'],['u','Horizontal offset (local U)','mm'],['v','Vertical offset (local V)','mm'],
      ['normal','Normal adjustment (local N)','mm'],['twist','In-plane rotation','°'],
    ] as const).map(([key,label,unit])=><label key={key}><span>{label}</span><span className="asm-spacing-input"><input aria-label={label} type="number" step="any" min={key==='gap'?0:undefined} value={draft.fields[key]} onChange={e=>onChange(updateFaceDraft(draft,{fields:{...draft.fields,[key]:e.target.value}}))}/><small>{unit}</small></span></label>)}</div>
    <p className="asm-local-frame"><span>U blue</span> · <span>V green</span> · <span>N amber</span>. U/V slide along face A. V follows the panel’s projected up direction (Y on horizontal faces). The frame rotates with A. Normal adjustment changes separation explicitly.</p>
    {!error&&<strong className="asm-effective-gap">Effective face gap: {Number(draft.fields.gap)+Number(draft.fields.normal)} mm</strong>}
    {draft.message&&<p role="status">{draft.message}</p>}
    {error&&<p role="alert" className="asm-spacing-error">{error} The last valid preview is retained.</p>}
    {complete&&!valid&&!error&&<p>CAD validation must pass before applying. See clearance or collision details below.</p>}
    <div className="asm-face-actions"><button type="button" onClick={()=>onChange(reselectFaceDraft(draft))}>Reselect both faces</button><button type="button" onClick={()=>onChange(updateFaceDraft(draft,{fields:{...draft.fields,u:'0',v:'0',normal:'0',twist:'0'}}))}>Reset alignment</button><button type="button" onClick={onCancel}>Cancel</button><button type="button" disabled={!complete||!!error||!valid||draft.pick!==null} onClick={onApply}>Apply position</button></div>
  </section>;
}
