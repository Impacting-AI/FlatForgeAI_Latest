// Pure assembly-mate logic. Placement itself is always solved by the CAD service.
import type { AssemblyEntry, CadFaceReference, PanelPose, PlaneMate } from './types';
import type { CadFaceCatalog, CadPlacement, MateReport } from './assembly-cad';

export type Pick = { entryId: string; face: CadFaceReference };
export type MateSession = {
  moving?: Pick; target?: Pick; pick: 'moving' | 'target' | null;
  type: 'coincident' | 'distance'; distance: string; reverse: boolean; aligned: boolean; lineUp: boolean;
  mateId: string; editing?: boolean; preferred?: string; note: string; start?: CadPlacement;
};
export const newSession = (preferred?: string, note = ''): MateSession =>
  ({ pick: 'moving', type: 'coincident', distance: '0', reverse: false, aligned: false, lineUp: false, mateId: '', preferred, note });

export const baseId = (entries: AssemblyEntry[]) => entries.find(e => e.targetId === null)?.id;

/** Mirrors the CAD service: which panels must be placed before this one. */
function dependencies(entry: AssemblyEntry) {
  if (entry.planeMates?.length) return entry.planeMates.map(m => m.targetId);
  return !entry.pose && entry.targetId ? [entry.targetId] : [];
}
export function dependsOn(entries: AssemblyEntry[], id: string, other: string, seen = new Set<string>()): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  const entry = entries.find(e => e.id === id);
  return !!entry && dependencies(entry).some(next => next === other || dependsOn(entries, next, other, seen));
}

/** The base never moves and a panel never follows its own follower. Otherwise
 * move the panel being worked on, then one that can still move, then the first picked. */
export function chooseMoving(entries: AssemblyEntry[], first: string, second: string, preferred?: string, defined: string[] = []) {
  if (first === second) return { error: 'Pick the second face on a different panel.' } as const;
  const base = baseId(entries);
  const locked = (id: string) => !!entries.find(e => e.id === id)?.locked;
  const can = (moving: string, target: string) => moving !== base && !locked(moving) && !dependsOn(entries, target, moving);
  const forward = can(first, second), backward = can(second, first);
  if (!forward && !backward) return { error: locked(first) || locked(second) ? 'Unlock a panel to connect these two.' : 'These panels already depend on each other through other mates. Remove one of those mates first.' } as const;
  const swapped = !forward || backward && (preferred === second || preferred !== first && defined.includes(first) && !defined.includes(second));
  return { movingId: swapped ? second : first, targetId: swapped ? first : second, swapped } as const;
}

const direction = (m: number[], v: number[]) => [0, 1, 2].map(i => m[i] * v[0] + m[4 + i] * v[1] + m[8 + i] * v[2]);
const position = (m: number[], p: number[]) => direction(m, p).map((value, i) => value + m[12 + i]);
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Current relation of two picked faces: which way they face and their signed gap. */
export function measureFaces(moving: { matrix: number[]; normal: number[]; point: number[] }, target: { matrix: number[]; normal: number[]; point: number[] }) {
  const a = direction(moving.matrix, moving.normal), b = direction(target.matrix, target.normal);
  const from = position(target.matrix, target.point), to = position(moving.matrix, moving.point);
  return { aligned: dot(a, b) > .5, offset: dot(b, to.map((value, i) => value - from[i])) };
}

export function sessionOffset(session: MateSession) {
  if (session.type === 'coincident') return 0;
  const value = Number(session.distance);
  return session.distance.trim() && Number.isFinite(value) && Math.abs(value) <= 1e6 ? (session.reverse ? -value : value) : null;
}
export function sessionMate(session: MateSession): PlaneMate | null {
  const offset = sessionOffset(session);
  if (!session.moving || !session.target || session.pick || offset === null) return null;
  return { id: session.mateId, targetId: session.target.entryId, type: session.type, offset: offset || 0, aligned: session.aligned, lineUp: session.lineUp, reference: session.target.face, moving: session.moving.face };
}

/** Start the next solve from where the panel is now, so free directions do not jump. */
export function currentPose(entry: AssemblyEntry, placement: CadPlacement, axis?: [number, number, number] | null): PanelPose {
  const row = placement.entries.find(e => e.id === entry.id), sourceSha = placement.sourceHashes?.[entry.id], box = placement.bounds[entry.id];
  if (!row || !sourceSha || !box) throw new Error('Current CAD placements are not available. Reload the assembly.');
  return { matrix: row.matrix, sourceSha, pivot: box.min.map((v, i) => (v + box.max[i]) / 2) as [number, number, number], axis: axis ?? [0, 0, 1], offset: [0, 0, 0], turn: 0 };
}

/** An applied one-step connection already holds its two faces; keep it as the first mate. */
export function convertedMate(entry: AssemblyEntry): PlaneMate | null {
  const c = entry.connection;
  if (!c || entry.mateState !== 'active' || !entry.targetId) return null;
  const face = ({ faceId, sourceSha, point }: CadFaceReference) => ({ faceId, sourceSha, point });
  const offset = entry.gap + c.normalOffset;
  return { id: `snap-${entry.id}`.slice(0, 160), targetId: entry.targetId, type: offset ? 'distance' : 'coincident', offset, aligned: false, reference: face(c.reference), moving: face(c.moving) };
}

function repositioned(entries: AssemblyEntry[], entry: AssemblyEntry, placement: CadPlacement, mates: PlaneMate[]): AssemblyEntry {
  // The tree parent only orders rows now; mates carry the real relationships.
  const next: AssemblyEntry = { ...entry, targetId: baseId(entries)!, targetFace: entry.targetFace ?? '+X', pose: currentPose(entry, placement) };
  delete next.connection; delete next.mateState; delete next.sides; delete next.spacing; delete next.matrix; delete next.planeMates;
  if (mates.length) next.planeMates = mates;
  return next;
}

export function withMate(entries: AssemblyEntry[], movingId: string, mate: PlaneMate, placement: CadPlacement) {
  return entries.map(entry => {
    if (entry.id !== movingId) return entry;
    const kept = entry.planeMates ?? [convertedMate(entry)].filter((m): m is PlaneMate => !!m);
    const mates = kept.some(m => m.id === mate.id) ? kept.map(m => m.id === mate.id ? mate : m) : [...kept, mate];
    return repositioned(entries, entry, placement, mates);
  });
}
export function withoutMate(entries: AssemblyEntry[], movingId: string, mateId: string, placement: CadPlacement) {
  return entries.map(entry => entry.id === movingId ? repositioned(entries, entry, placement, (entry.planeMates ?? []).filter(m => m.id !== mateId)) : entry);
}
/** After panels are removed, drop the mates that pointed at them without moving anything. */
export function withoutTargets(entries: AssemblyEntry[], removed: string[], placement: CadPlacement | null) {
  return entries.map(entry => {
    if (!entry.planeMates?.some(m => removed.includes(m.targetId))) return entry;
    if (!placement) throw new Error('Wait for the current panel positions before removing a mated panel.');
    return repositioned(entries, entry, placement, entry.planeMates.filter(m => !removed.includes(m.targetId)));
  });
}

const list = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0];
export function motionText(report: MateReport) {
  if (!report.dof) return 'Fully defined';
  const parts: string[] = [];
  if (report.translationDof) parts.push(report.freeAxes.length ? `slide along ${list(report.freeAxes)}` : `slide in ${report.translationDof} direction${report.translationDof > 1 ? 's' : ''}`);
  if (report.rotationDof === 3) parts.push('rotate freely');
  else if (report.rotationDof) {
    const axis = report.rotationAxis?.findIndex(v => Math.abs(v) > .999) ?? -1;
    parts.push(axis < 0 ? 'turn about one axis' : `turn about ${'XYZ'[axis]}`);
  }
  return `Can still ${list(parts)}`;
}

export type PanelStatus = { tone: 'base' | 'defined' | 'under' | 'conflict' | 'free'; label: string };
/** Only the CAD service's solve may call a panel fully defined. */
export function panelStatus(entry: AssemblyEntry, report?: MateReport): PanelStatus {
  if (entry.targetId === null) return { tone: 'base', label: 'Base · fixed' };
  if (entry.planeMates?.length) {
    if (!report) return { tone: 'under', label: 'Checking…' };
    if (report.status === 'conflict') return { tone: 'conflict', label: 'Mate conflict' };
    return report.status === 'defined' ? { tone: 'defined', label: 'Fully defined' } : { tone: 'under', label: `Under defined · ${report.dof} free` };
  }
  if (entry.connection && entry.mateState === 'active') return { tone: 'defined', label: 'Snapped · positioned' };
  return { tone: 'free', label: 'Not mated' };
}

export function mateTitle(mate: PlaneMate, moving: string, target: string) {
  return `${mate.type === 'coincident' ? 'Coincident' : `Distance ${+Math.abs(mate.offset).toFixed(3)} mm`} · ${moving} → ${target}`;
}
export function faceName(catalog: CadFaceCatalog | undefined, faceId: string) {
  const side = (['left', 'right', 'top', 'bottom'] as const).find(s => catalog?.sides?.[s].candidates.some(c => c.faceId === faceId));
  return `${side ? side[0].toUpperCase() + side.slice(1) + ' side' : 'Face ' + faceId.slice(5)} (${faceId})`;
}
