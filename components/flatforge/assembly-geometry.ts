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
/** Explicit opt-in for old layouts: retain saved tangential alignment offsets. */
export function withDirectionalGaps(entry: AssemblyEntry): AssemblyEntry {
  const spacing = { x: { side: 0, gap: 0 }, y: { side: 0, gap: 0 }, z: { side: 0, gap: 0 } } as NonNullable<AssemblyEntry['spacing']>;
  if (entry.targetFace) spacing[faceAxis(entry.targetFace)] = { side: faceSign(entry.targetFace), gap: entry.gap };
  return { ...entry, spacing };
}
export function setAssemblySide(entry: AssemblyEntry, axis: AssemblyAxis, side: -1|0|1): AssemblyEntry {
  const next = entry.spacing ? entry : withDirectionalGaps(entry);
  if (entry.targetFace && axis === faceAxis(entry.targetFace) && side !== faceSign(entry.targetFace)) throw new Error('Change the connection face to change this direction.');
  return { ...next, spacing: { ...next.spacing!, [axis]: { ...next.spacing![axis], side } } };
}
export function setAssemblySpacing(entry: AssemblyEntry, axis: AssemblyAxis, value: number): AssemblyEntry {
  if (!Number.isFinite(value) || value < 0) throw new Error('Gap must be a finite, non-negative number in mm.');
  const next = entry.spacing ? entry : withDirectionalGaps(entry);
  if (!next.spacing![axis].side) throw new Error('Choose the separation side for this axis first.');
  return { ...next, gap: entry.targetFace && axis === faceAxis(entry.targetFace) ? value : entry.gap,
    spacing: { ...next.spacing!, [axis]: { ...next.spacing![axis], gap: value } } };
}
export function setAssemblyTargetFace(entry: AssemblyEntry, face: Face): AssemblyEntry {
  const next = { ...entry, targetFace: face, offsets: { ...zeroOffsets(), ...entry.offsets, [faceAxis(face)]: 0 } };
  if (!entry.spacing) return next;
  const spacing = { ...entry.spacing };
  if (entry.targetFace) spacing[faceAxis(entry.targetFace)] = { side: 0, gap: 0 };
  spacing[faceAxis(face)] = { side: faceSign(face), gap: entry.gap };
  return { ...next, spacing };
}
export function resetAssemblySpacing(entry: AssemblyEntry): AssemblyEntry {
  return withDirectionalGaps({ ...entry, gap: DEFAULT_ASSEMBLY_GAP_MM, offsets: zeroOffsets() });
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

/** Offline sample placement and compatibility reference for envelope layouts.
 * Live CAD placement is authoritative in backend assembly_connections.py.
 * Bounds supplied here already include the preserved rotation.
 * Active axes are directional support-plane gaps; other axes keep alignment. */
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
    if(entry.targetId===null&&entry.rootOffset)center.add(new THREE.Vector3(...entry.rootOffset).multiplyScalar(.001));
    if (entry.targetId !== null) {
      const target = byId.get(entry.targetId);
      if (!target || !entry.targetFace) throw new Error('Assembly connection target is unavailable.');
      const targetBox = place(target).bounds;
      if (entry.spacing && !opposingFaces(entry)) throw new Error('Choose opposing envelope faces for a gap connection. Panel rotations are preserved.');
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
      if (entry.spacing) {
        for (const axis of ['x', 'y', 'z'] as const) {
          const constraint = entry.spacing[axis];
          if (!constraint || ![-1,0,1].includes(constraint.side) || !Number.isFinite(constraint.gap) || constraint.gap < 0) throw new Error('Invalid directional gap.');
          if (axis === faceAxis(entry.targetFace) && (constraint.side !== faceSign(entry.targetFace) || constraint.gap !== entry.gap)) throw new Error('Connection face and gap direction disagree.');
          if (constraint.side === 1) center[axis] = targetBox.max[axis] + constraint.gap / MM_PER_METRE + half[axis];
          if (constraint.side === -1) center[axis] = targetBox.min[axis] - constraint.gap / MM_PER_METRE - half[axis];
        }
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

export function assemblyRotation(entry: AssemblyEntry) {
  const values = entry.rotation ?? [0, 0, 0, 1];
  if (values.length !== 4 || !values.every(Number.isFinite)) throw new Error('Invalid panel rotation.');
  const rotation = new THREE.Quaternion(...values);
  if (Math.abs(rotation.lengthSq() - 1) > 1e-8) throw new Error('Panel rotation must be a unit quaternion.');
  return rotation;
}
/** Column-major rigid CAD matrix: dimensionless rotation and mm translation. */
export function assemblyMatrix(entry: AssemblyEntry, translationMetres: THREE.Vector3) {
  return new THREE.Matrix4().compose(translationMetres.clone().multiplyScalar(MM_PER_METRE), assemblyRotation(entry), new THREE.Vector3(1,1,1)).toArray();
}
