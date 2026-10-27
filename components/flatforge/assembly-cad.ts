import type { AssemblyEntry, Panel } from './types';

export type CadEntry = AssemblyEntry & { revision: number; matrix?: number[] };
export type CadBounds = { units: 'mm'; entries: { id: string; revision: number; bounds: { min: number[]; max: number[] } }[] };
export type CadFace = {id:string;type:string;area:number;supported:boolean;center:[number,number,number];normal?:[number,number,number];u?:[number,number,number];v?:[number,number,number];positions:number[];indices:number[]};
export type CadFaceCatalog={entryId:string;revision:number;sourceSha:string;units:'mm';faces:CadFace[]};
export type CadPlacement={units:'mm';entries:(CadEntry & {matrix:number[]})[];bounds:Record<string,{min:number[];max:number[]}>};
export type CadClash = { entryIdA: string; entryIdB: string; depth: number; pointCount: number; volume?: number };
export type CadCheck = { valid: boolean; token: string | null; collisions: CadClash[];
  contacts: { entryIdA: string; entryIdB: string }[]; issues: string[];
  clearances: { entryId: string; targetId: string; axis: string; side: number; requested: number; actual: number; satisfied: boolean }[] };

export function cadEntries(entries: AssemblyEntry[], panels: Panel[]): CadEntry[] {
  return entries.map(entry => {
    const panel = panels.find(panel => panel.id === entry.panelId);
    if (!panel) throw new Error('An assembly drawing is unavailable.');
    return { ...entry, revision: panel.revision };
  });
}
async function request(projectId: string, action: string, body: unknown, signal?: AbortSignal) {
  const response = await fetch(`/api/engine/projects/${encodeURIComponent(projectId)}/assembly/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-flatforge-project-id': projectId },
    body: JSON.stringify(body), signal,
  });
  if (!response.ok) {
    let message = 'Assembly CAD request failed.';
    try { const error = await response.json() as {detail:unknown}; message = typeof error.detail === 'string' ? error.detail : JSON.stringify(error.detail); } catch {}
    throw new Error(message);
  }
  return response;
}
export async function assemblyCadBounds(projectId: string, entries: CadEntry[], signal: AbortSignal): Promise<CadBounds> {
  return (await request(projectId, 'geometry', { entries }, signal)).json();
}
export async function checkAssembly(projectId: string, entries: CadEntry[], signal: AbortSignal): Promise<CadCheck> {
  return (await request(projectId, 'validate', { entries }, signal)).json();
}
export async function downloadAssemblyStep(projectId: string, token: string) {
  const response = await request(projectId, 'step', { token });
  const blob = await response.blob();
  if (!blob.size) throw new Error('The CAD service returned an empty STEP file.');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = 'FlatForge_Assembly.step'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function placeAssembly(projectId:string,entries:CadEntry[],signal:AbortSignal):Promise<CadPlacement>{
  return (await request(projectId,'place',{entries},signal)).json();
}
export async function assemblyFaces(projectId:string,entry:CadEntry,signal:AbortSignal):Promise<CadFaceCatalog>{
  return (await request(projectId,'faces',{id:entry.id,panelId:entry.panelId,revision:entry.revision},signal)).json();
}
