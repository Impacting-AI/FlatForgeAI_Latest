// How two joined faces sit against each other, for their colour. Display only: CAD placement is solved by the service.
import type { AssemblyEntry, CadFaceReference } from './types';

/** Light orange while joining or apart, light green when properly matched, light blue when pushed inside. */
export type ContactState = 'joining' | 'matched' | 'inside';
export const CONTACT_COLORS: Record<ContactState, number> = { joining: 0xffc184, matched: 0x94e8aa, inside: 0x9dcbff };
/** Faces this close count as touching: reachable with the 0.1 mm keyboard step. */
export const CONTACT_TOLERANCE_MM = .1;

type FaceEnd = { entryId: string; face: CadFaceReference };
export type FacePair = { moving: FaceEnd; target: FaceEnd; /** Overrides what the geometry says. */ force?: ContactState };
export const pairKey = ({ moving, target }: FacePair) => `${moving.entryId}:${moving.face.faceId}>${target.entryId}:${target.face.faceId}`;

/** The face pairs that the saved connections hold. */
export function connectedPairs(entries: AssemblyEntry[]): FacePair[] {
  return entries.flatMap(entry => {
    const mates = entry.planeMates?.map(mate => ({ moving: { entryId: entry.id, face: mate.moving }, target: { entryId: mate.targetId, face: mate.reference } }));
    if (mates?.length) return mates;
    const joint = entry.connection;
    return joint && entry.targetId ? [{ moving: { entryId: entry.id, face: joint.moving }, target: { entryId: entry.targetId, face: joint.reference } }] : [];
  });
}

export type WorldFace = { /** World millimetres. */ points: number[][]; normal: number[] };
export type Box = { min: number[]; max: number[] };

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: number[]) => { const length = Math.hypot(...a) || 1; return a.map(v => v / length); };
const range = (points: number[][], axis: number[]) => points.reduce(([low, high], p) => { const v = dot(p, axis); return [Math.min(low, v), Math.max(high, v)]; }, [Infinity, -Infinity]);

/**
 * Matched: parallel, on one plane and over each other. Inside: the moving face has gone
 * behind the target face while the two panels occupy the same space. Anything else is
 * still being joined.
 */
export function faceContact(moving: WorldFace, target: WorldFace, bodies: { moving: Box; target: Box }): ContactState {
  const n = unit(target.normal);
  if (Math.abs(dot(unit(moving.normal), n)) < .9999) return 'joining';
  const u = unit(cross(Math.abs(n[0]) < .9 ? [1, 0, 0] : [0, 1, 0], n)), v = cross(n, u);
  // Seen square-on to the target, the two faces must cover some common area.
  const over = [u, v].every(axis => {
    const [a, b] = range(moving.points, axis), [c, d] = range(target.points, axis);
    return Math.min(b, d) - Math.max(a, c) > .001;
  });
  if (!over) return 'joining';
  const middle = (face: WorldFace) => { const [low, high] = range(face.points, n); return (low + high) / 2; };
  const gap = middle(moving) - middle(target);
  if (Math.abs(gap) <= CONTACT_TOLERANCE_MM + 1e-6) return 'matched';
  const shared = [0, 1, 2].every(i => Math.min(bodies.moving.max[i], bodies.target.max[i]) - Math.max(bodies.moving.min[i], bodies.target.min[i]) > .001);
  return gap < 0 && shared ? 'inside' : 'joining';
}
