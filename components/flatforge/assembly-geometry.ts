import * as THREE from 'three';
import type { AssemblyEntry, Face } from './types';

// CAD/DXF/STEP values are mm. FlatForge GLBs already contain metres.
export const MM_PER_METRE = 1000;
export const DEFAULT_ASSEMBLY_GAP_MM = 10;
export type AssemblyAxis = 'x' | 'y' | 'z';
export const faceAxis = (face: Face): AssemblyAxis => face[1].toLowerCase() as AssemblyAxis;
export const faceSign = (face: Face) => face[0] === '+' ? 1 : -1;
export const opposingFaces = (entry: AssemblyEntry) => entry.targetFace !== null
  && faceAxis(entry.myFace) === faceAxis(entry.targetFace) && faceSign(entry.myFace) !== faceSign(entry.targetFace);
export const zeroOffsets = () => ({ x: 0, y: 0, z: 0 });
export function setAssemblySpacing(entry: AssemblyEntry, axis: AssemblyAxis, value: number): AssemblyEntry {
  if (!Number.isFinite(value)) throw new Error('Enter a finite number in mm.');
  if (entry.targetFace && axis === faceAxis(entry.targetFace)) {
    if (value < 0) throw new Error('Connection gap must be zero or greater.');
    return { ...entry, gap: value };
  }
  return { ...entry, offsets: { ...zeroOffsets(), ...entry.offsets, [axis]: value } };
}
export function setAssemblyTargetFace(entry: AssemblyEntry, face: Face): AssemblyEntry {
  return { ...entry, targetFace: face, offsets: { ...zeroOffsets(), ...entry.offsets, [faceAxis(face)]: 0 } };
}
export function resetAssemblySpacing(entry: AssemblyEntry): AssemblyEntry {
  return { ...entry, gap: DEFAULT_ASSEMBLY_GAP_MM, offsets: zeroOffsets() };
}
export function removeAssemblyBranch(entries: AssemblyEntry[], id: string) {
  const removed = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) if (entry.targetId && removed.has(entry.targetId) && !removed.has(entry.id)) {
      removed.add(entry.id); changed = true;
    }
  }
  return entries.filter(entry => !removed.has(entry.id));
}
const faceOffset = (face: Face, halfSize: THREE.Vector3) => {
  const offset = new THREE.Vector3();
  const axis = faceAxis(face);
  offset[axis] = halfSize[axis] * faceSign(face);
  return offset;
};

/** Preserve every GLB node transform and dimension; the wrapper only translates. */
export function assemblyModel(model: THREE.Object3D) {
  const group = new THREE.Group();
  group.add(model);
  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(group, true);
  if (bounds.isEmpty()) throw new Error('Panel has no assembly geometry.');
  return { group, bounds };
}

/** Axis-aligned envelope-face placement, in metres; this does not rotate panels. */
export function assemblyPlacements(entries: AssemblyEntry[], bounds: Map<string, THREE.Box3>) {
  const placed = new Map<string, { translation: THREE.Vector3; bounds: THREE.Box3 }>();
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  if (byId.size !== entries.length) throw new Error('Assembly panel IDs must be unique.');
  const visiting = new Set<string>();
  function place(entry: AssemblyEntry) {
    const existing = placed.get(entry.id);
    if (existing) return existing;
    if (visiting.has(entry.id)) throw new Error('Assembly connections form a cycle.');
    visiting.add(entry.id);
    const box = bounds.get(entry.id);
    if (!box || box.isEmpty()) throw new Error('Assembly panel geometry is unavailable.');
    if (!Number.isFinite(entry.gap) || entry.gap < 0) throw new Error('Gap must be a finite, non-negative number in mm.');
    const half = box.getSize(new THREE.Vector3()).multiplyScalar(.5);
    let center = new THREE.Vector3(0, 0, half.z);
    if (entry.targetId !== null) {
      const target = byId.get(entry.targetId);
      if (!target || !entry.targetFace) throw new Error('Assembly connection target is unavailable.');
      const targetBox = place(target).bounds;
      const targetHalf = targetBox.getSize(new THREE.Vector3()).multiplyScalar(.5);
      center = targetBox.getCenter(new THREE.Vector3())
        .add(faceOffset(entry.targetFace, targetHalf)).sub(faceOffset(entry.myFace, half));
      center[faceAxis(entry.targetFace)] += faceSign(entry.targetFace) * entry.gap / MM_PER_METRE;
      if (faceAxis(entry.targetFace) !== 'z' && faceAxis(entry.myFace) !== 'z') {
        // Bottom alignment follows the reference panel, including raised ancestors.
        center.z = targetBox.min.z + half.z;
      }
      for (const axis of ['x', 'y', 'z'] as const) {
        const offset = entry.offsets?.[axis] ?? 0;
        if (!Number.isFinite(offset)) throw new Error('Offsets must be finite numbers in mm.');
        if (axis === faceAxis(entry.targetFace) && offset !== 0) throw new Error('Use the gap control along the connection direction.');
        center[axis] += offset / MM_PER_METRE;
      }
    }
    const translation = center.sub(box.getCenter(new THREE.Vector3()));
    const result = { translation, bounds: box.clone().translate(translation) };
    placed.set(entry.id, result);
    visiting.delete(entry.id);
    return result;
  }
  entries.forEach(place);
  return placed;
}
