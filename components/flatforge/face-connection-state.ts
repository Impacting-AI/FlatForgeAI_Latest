import type { AssemblyEntry, CadFaceReference, Face, AssemblySide } from './types';

export type FaceRole = 'reference' | 'moving';
export type FaceSelection = { referenceEntryId:string; movingEntryId:string; reference?:CadFaceReference; moving?:CadFaceReference; pick:FaceRole|null;allowed?:Partial<Record<FaceRole,string[]>>;sideNames?:Partial<Record<FaceRole,AssemblySide>> };
export type FaceDraft = FaceSelection & {
  original:AssemblyEntry;
  sides?:Partial<Record<FaceRole,AssemblySide>>;
  fields:{gap:string;u:string;v:string;normal:string;twist:string};
  message:string;
  preview?:AssemblyEntry;
};

export function beginFaceDraft(entry:AssemblyEntry):FaceDraft {
  const c=entry.connection;
  return {original:entry,referenceEntryId:entry.targetId!,movingEntryId:entry.id,
    reference:c?.reference,moving:c?.moving,pick:null,message:'',preview:c?entry:undefined,
    fields:{gap:String(entry.gap),u:String(c?.offsetU??0),v:String(c?.offsetV??0),normal:String(c?.normalOffset??0),twist:String(c?.twist??0)}};
}

export function faceDraftError(draft:FaceDraft) {
  if(Object.values(draft.fields).some(value=>value.trim()===''||!Number.isFinite(Number(value))))return 'Enter a complete, finite number in each field.';
  if(Number(draft.fields.gap)<0)return 'Connection gap must be zero or greater.';
  if(Number(draft.fields.gap)+Number(draft.fields.normal)<0)return 'Gap plus normal adjustment cannot be negative.';
  return '';
}

export function previewFaceDraft(draft:FaceDraft):AssemblyEntry|undefined {
  if(faceDraftError(draft)||!draft.reference||!draft.moving)return;
  const original={...draft.original};delete original.pose;delete original.matrix;
  if(draft.sides?.reference&&draft.sides?.moving)original.sides={reference:draft.sides.reference,moving:draft.sides.moving};
  return {...original,targetId:draft.referenceEntryId,gap:Number(draft.fields.gap),connection:{type:'planar',
    reference:draft.reference,moving:draft.moving,offsetU:Number(draft.fields.u),offsetV:Number(draft.fields.v),
    normalOffset:Number(draft.fields.normal),twist:Number(draft.fields.twist)}};
}

export function updateFaceDraft(draft:FaceDraft,patch:Partial<FaceDraft>):FaceDraft {
  const next={...draft,...patch};
  next.preview=previewFaceDraft(next)??draft.preview;
  return next;
}

/** Explicit, unsaved envelope preview to expose both surfaces for reselection.
 * A face edit may have changed gap while retaining old envelope metadata. */
export function reselectFaceDraft(draft:FaceDraft):FaceDraft {
  const original=draft.original,face=original.targetFace!;
  const axis=face[1].toLowerCase() as 'x'|'y'|'z',side=face[0]==='+'?1:-1;
  const preview:AssemblyEntry={...original,targetId:draft.referenceEntryId,connection:undefined,
    myFace:((side===1?'-':'+')+face[1]) as Face,
    spacing:original.spacing?{...original.spacing,[axis]:{side,gap:original.gap}}:undefined};
  return {...draft,reference:undefined,moving:undefined,pick:'reference',preview,
    message:'Preview restored to envelope placement for picking. Select both faces again; saved positions change only after Apply.'};
}
