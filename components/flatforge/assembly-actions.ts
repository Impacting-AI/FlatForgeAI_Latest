// What a click or a drag does to the saved assembly. Placement is still solved by the CAD service.
import { baseId, chooseMoving, convertedMate, currentPose, measureFaces, withMate, type Pick } from './plane-mates';
import type { CadFaceCatalog, CadPlacement, MateReport } from './assembly-cad';
import type { AssemblyEntry, PlaneMate } from './types';

export type Connection = {
  movingId: string; targetId: string; mateId: string;
  /** Layouts to try in order until the CAD service finds one without a conflict. */
  attempts: AssemblyEntry[][];
};

/**
 * Two picked faces become one coincident mate; there is nothing else to set.
 * A panel's first mate puts the faces against each other, centred. Later mates keep the
 * current facing and add to the earlier ones. If they cannot all hold, the newest pick wins.
 */
export function planConnection(entries: AssemblyEntry[], first: Pick, second: Pick, catalogs: Record<string, CadFaceCatalog>,
  placement: CadPlacement, mateId: string, preferred?: string): Connection | { error: string } {
  const defined = Object.entries(placement.constraints ?? {}).filter(([, report]) => report.status === 'defined').map(([id]) => id);
  const order = chooseMoving(entries, first.entryId, second.entryId, preferred, defined);
  if ('error' in order) return { error: order.error! };
  const [moving, target] = order.swapped ? [second, first] : [first, second];
  const info = (pick: Pick) => {
    const row = placement.entries.find(e => e.id === pick.entryId), face = catalogs[pick.entryId]?.faces.find(f => f.id === pick.face.faceId);
    return row && face?.normal ? { matrix: row.matrix, normal: face.normal, point: pick.face.point } : null;
  };
  const a = info(moving), b = info(target);
  if (!a || !b) return { error: 'The picked faces are not loaded yet. Click them again.' };
  const entry = entries.find(e => e.id === moving.entryId)!;
  const isFirst = !entry.planeMates?.length && !convertedMate(entry);
  const mate: PlaneMate = { id: mateId, targetId: target.entryId, type: 'coincident', offset: 0,
    aligned: isFirst ? false : measureFaces(a, b).aligned, lineUp: isFirst, reference: target.face, moving: moving.face };
  const attempts = [withMate(entries, moving.entryId, mate, placement)];
  if (!isFirst) {
    const cleared = entries.map(e => e.id === moving.entryId ? { ...e, planeMates: undefined, connection: undefined } : e);
    attempts.push(withMate(cleared, moving.entryId, { ...mate, aligned: false, lineUp: true }, placement));
  }
  return { movingId: moving.entryId, targetId: target.entryId, mateId, attempts };
}

/** Placed from another panel rather than from a position of its own. */
const derived = (entry: AssemblyEntry) => !entry.pose && !entry.planeMates?.length && entry.targetId !== null;
const follows = (entry: AssemblyEntry, id: string) => !!entry.planeMates?.some(m => m.targetId === id) || derived(entry) && entry.targetId === id;
const free = (entry: AssemblyEntry) => !!entry.pose && !entry.planeMates?.length && !entry.connection;

function current(entry: AssemblyEntry, placement: CadPlacement | null) {
  if (!placement) throw new Error('Wait for the current panel positions, then try again.');
  return currentPose(entry, placement);
}
/** The panel exactly where it is now, tied to nothing. */
function released(entry: AssemblyEntry, placement: CadPlacement | null): AssemblyEntry {
  const next: AssemblyEntry = { ...entry, pose: current(entry, placement) };
  delete next.connection; delete next.mateState; delete next.sides; delete next.spacing; delete next.matrix; delete next.planeMates; delete next.rootOffset;
  return next;
}
/** Keeps a panel still while the panel it follows moves away or is removed. */
function detached(entry: AssemblyEntry, id: string, placement: CadPlacement | null): AssemblyEntry {
  if (!follows(entry, id)) return entry;
  const mates = entry.planeMates?.filter(m => m.targetId !== id) ?? [];
  return mates.length ? { ...entry, pose: current(entry, placement), planeMates: mates.map(m => ({ ...m, lineUp: false })) } : released(entry, placement);
}

/** Moving by hand needs current CAD positions only when a connection has to be released. */
export function canMove(entries: AssemblyEntry[], id: string, positionsReady: boolean) {
  const entry = entries.find(e => e.id === id);
  return !!entry && (positionsReady || free(entry) && !entries.some(e => follows(e, id)));
}

/** Translates one panel by world millimetres. Every other panel stays where it is. */
export function movePanel(entries: AssemblyEntry[], id: string, delta: number[], placement: CadPlacement | null) {
  return entries.map(entry => {
    if (entry.id !== id) return detached(entry, id, placement);
    const own = free(entry) ? entry : released(entry, placement);
    const offset = own.pose!.offset.map((value, i) => Math.round((value + delta[i]) * 1e6) / 1e6) as [number, number, number];
    return { ...own, pose: { ...own.pose!, offset } };
  });
}

/** Removes one panel only. If it was the fixed base, the next panel takes that role. */
export function removePanel(entries: AssemblyEntry[], id: string, placement: CadPlacement | null): AssemblyEntry[] {
  const rest = entries.filter(e => e.id !== id);
  if (!rest.length) return rest;
  if (entries.find(e => e.id === id)?.targetId !== null) {
    const base = baseId(rest)!;
    return rest.map(entry => {
      const next = detached(entry, id, placement);
      return next.targetId === id ? { ...next, targetId: base, targetFace: next.targetFace ?? '+X' } : next;
    });
  }
  const base = rest[0].id;
  return rest.map(entry => {
    if (entry.id === base) return { ...released(entry, placement), targetId: null, targetFace: null };
    let next = detached(entry, id, placement);
    if (derived(next)) next = released(next, placement);
    return { ...next, targetId: base, targetFace: next.targetFace ?? '+X' };
  });
}

export function connectionStatus(entry: AssemblyEntry, entries: AssemblyEntry[], report?: MateReport) {
  if (entry.targetId === null) return { tone: 'base', label: 'Base · fixed' };
  const targets = entry.planeMates?.map(m => m.targetId) ?? (entry.connection && entry.mateState === 'active' ? [entry.targetId] : []);
  if (!targets.length) return { tone: 'free', label: 'Not connected' };
  if (report?.status === 'conflict') return { tone: 'conflict', label: 'Mate conflict' };
  const names = [...new Set(targets)].map(id => entries.find(e => e.id === id)?.label ?? '?');
  return { tone: 'defined', label: `Connected to ${names.join(', ')}` };
}
