import type { AssemblyEntry, Face } from './types';

export const ASSEMBLY_STORAGE_KEY = 'flatforge.assemblies.v1';
export type AssemblyProjects = Record<string, AssemblyEntry[]>;
const faces: Face[] = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
/** Versioned, mm-only connection data. Geometry remains in the panel artifacts. */
export function decodeAssemblies(text: string | null): AssemblyProjects {
  if (text === null) return {};
  const data = JSON.parse(text);
  if (data?.version !== 1 || data.units !== 'mm' || !data.projects || typeof data.projects !== 'object' || Array.isArray(data.projects)) throw new Error('Unrecognized saved assembly format.');
  for (const entries of Object.values(data.projects) as AssemblyEntry[][]) {
    if (!Array.isArray(entries)) throw new Error('Invalid saved assembly.');
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id) || typeof entry.panelId !== 'string'
        || !faces.includes(entry.myFace) || !Number.isFinite(entry.gap) || entry.gap < 0
        || (entry.targetId !== null && (!seen.has(entry.targetId) || !faces.includes(entry.targetFace!)))) throw new Error('Invalid saved assembly connection.');
      if (entry.offsets !== undefined && (!entry.offsets || !['x', 'y', 'z'].every(axis => Number.isFinite(entry.offsets![axis as 'x' | 'y' | 'z']))
        || (entry.targetFace && entry.offsets[entry.targetFace[1].toLowerCase() as 'x' | 'y' | 'z'] !== 0))) throw new Error('Invalid saved assembly offsets.');
      if (entry.spacing !== undefined && (!entry.spacing || !(['x','y','z'] as const).every(axis => {
        const value = entry.spacing![axis];
        return value && [-1,0,1].includes(value.side) && Number.isFinite(value.gap) && value.gap >= 0;
      }))) throw new Error('Invalid saved directional gaps.');
      if (entry.rotation !== undefined && (!Array.isArray(entry.rotation) || entry.rotation.length !== 4
        || !entry.rotation.every(Number.isFinite) || Math.abs(entry.rotation.reduce((sum, value) => sum + value * value, 0) - 1) > 1e-8)) throw new Error('Invalid saved panel rotation.');
      if (entry.connection !== undefined) {
        const c=entry.connection;
        const validReference=(r:typeof c.reference)=>r&&/^face-[1-9][0-9]*$/.test(r.faceId)&&/^[a-f0-9]{64}$/.test(r.sourceSha)&&Array.isArray(r.point)&&r.point.length===3&&r.point.every(Number.isFinite);
        if(!entry.targetId||!c||c.type!=='planar'||!validReference(c.reference)||!validReference(c.moving)
          ||![c.offsetU,c.offsetV,c.normalOffset,c.twist].every(Number.isFinite)||entry.gap+c.normalOffset<0)throw new Error('Invalid saved CAD face connection.');
      }
      if(entry.label!==undefined&&(!/^[A-Z]+$/.test(entry.label)||entries.some(other=>other!==entry&&other.label===entry.label)))throw new Error('Invalid saved panel label.');
      if(entry.rootOffset!==undefined&&(entry.targetId!==null||!Array.isArray(entry.rootOffset)||entry.rootOffset.length!==3||!entry.rootOffset.every(Number.isFinite)))throw new Error('Invalid assembly origin.');
      seen.add(entry.id);
    }
  }
  return data.projects;
}
export const encodeAssemblies = (projects: AssemblyProjects) => JSON.stringify({ version: 1, units: 'mm', projects });
