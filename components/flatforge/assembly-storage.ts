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
      seen.add(entry.id);
    }
  }
  return data.projects;
}
export const encodeAssemblies = (projects: AssemblyProjects) => JSON.stringify({ version: 1, units: 'mm', projects });
