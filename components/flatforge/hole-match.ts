// Screw holes of two panels sitting on each other. Display only: read from the CAD face meshes.

/** Hole centres this close, seen along the hole, are lined up. Reachable with a 1 mm drag. */
export const HOLE_TOLERANCE_MM = 1;
/** The two sheets this close (or this far into each other) are touching. */
export const SEAT_TOLERANCE_MM = .5;
/** Wider openings are cut-outs rather than fastener holes. */
const LARGEST_HOLE_MM = 60;
/** Loops on the two sides of one sheet belong to the same hole. */
const SHEET_MM = 6;

/** One hole through a sheet: its middle, direction and half the sheet thickness, in millimetres. */
export type Hole = { centre: number[]; axis: number[]; half: number; /** The faces it opens in. */ faces: number[] };

const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: number[], b: number[], scale = 1) => a.map((v, i) => v + b[i] * scale);

/** Middles of the closed inner boundaries of one flat triangulated face. */
export function innerLoops(positions: number[], indices: number[]) {
  // Tessellation may repeat a vertex, so vertices are joined by position.
  const points: number[][] = [], ids = new Map<string, number>();
  const vertex = (i: number) => {
    const p = positions.slice(i * 3, i * 3 + 3), key = p.map(v => Math.round(v * 1000)).join();
    let id = ids.get(key);
    if (id === undefined) { id = points.push(p) - 1; ids.set(key, id); }
    return id;
  };
  const edges = new Map<string, [number, number]>();
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const corner = [0, 1, 2].map(k => vertex(indices[i + k]));
    for (let k = 0; k < 3; k++) {
      const a = corner[k], b = corner[(k + 1) % 3], key = a < b ? `${a},${b}` : `${b},${a}`;
      // An edge shared by two triangles is inside the face.
      if (a !== b && !edges.delete(key)) edges.set(key, [a, b]);
    }
  }
  const next = new Map<number, number[]>();
  for (const [a, b] of edges.values()) for (const [from, to] of [[a, b], [b, a]]) next.set(from, [...(next.get(from) ?? []), to]);
  const seen = new Set<number>(), loops: { min: number[]; max: number[] }[] = [];
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], open = [start];
    seen.add(start);
    while (open.length) {
      const at = open.pop()!;
      points[at].forEach((v, i) => { min[i] = Math.min(min[i], v); max[i] = Math.max(max[i], v); });
      for (const to of next.get(at)!) if (!seen.has(to)) { seen.add(to); open.push(to); }
    }
    loops.push({ min, max });
  }
  const size = (loop: { min: number[]; max: number[] }) => Math.hypot(...sub(loop.max, loop.min));
  // The widest loop is the outline of the face itself.
  return loops.sort((a, b) => size(b) - size(a)).slice(1).filter(loop => size(loop) <= LARGEST_HOLE_MM).map(loop => loop.min.map((v, i) => (v + loop.max[i]) / 2));
}

/** The holes of a panel, in its own coordinates. */
export function panelHoles(faces: { supported: boolean; normal?: number[]; positions: number[]; indices: number[] }[]) {
  const holes: Hole[] = [];
  for (const [index, face] of faces.entries()) {
    if (!face.supported || !face.normal) continue;
    for (const centre of innerLoops(face.positions, face.indices)) {
      const found = holes.find(hole => {
        if (Math.abs(dot(hole.axis, face.normal!)) < .999) return false;
        const apart = sub(centre, hole.centre), along = dot(apart, hole.axis);
        return Math.hypot(...add(apart, hole.axis, -along)) < .2 && Math.abs(along) <= SHEET_MM;
      });
      if (!found) { holes.push({ centre, axis: face.normal, half: 0, faces: [index] }); continue; }
      found.faces.push(index);
      // The other side of the sheet: widen the hole to span both.
      const along = dot(sub(centre, found.centre), found.axis);
      const low = Math.min(-found.half, along), high = Math.max(found.half, along);
      found.centre = add(found.centre, found.axis, (low + high) / 2);
      found.half = (high - low) / 2;
    }
  }
  return holes;
}

export type HoleMatch = {
  /** Indexes into the moving panel's holes that sit properly on a hole of the other panel. */
  matched: number[];
  /** Lined up, but the two sheets occupy the same space. */
  inside: number[];
  /** The holes of the other panel that those sit on. */
  onto: { matched: number[]; inside: number[] };
  /** Smallest movement of the moving panel, in mm, that would seat a nearby pair. */
  move: number[] | null;
};

/** Compares holes given in the same (world) coordinates. */
export function matchHoles(moving: Hole[], target: Hole[], reach = 30): HoleMatch {
  const matched: number[] = [], inside: number[] = [], onto = { matched: [] as number[], inside: [] as number[] };
  let move: number[] | null = null, shortest = reach;
  moving.forEach((a, index) => {
    for (const [other, b] of target.entries()) {
      if (Math.abs(dot(a.axis, b.axis)) < .999) continue;
      const apart = sub(a.centre, b.centre), along = dot(apart, b.axis), across = add(apart, b.axis, -along);
      const thickness = a.half + b.half, gap = Math.abs(along) - thickness;
      if (Math.hypot(...across) <= HOLE_TOLERANCE_MM && gap <= SEAT_TOLERANCE_MM) {
        const state = gap < -SEAT_TOLERANCE_MM ? 'inside' : 'matched', list = state === 'inside' ? inside : matched;
        if (!list.includes(index)) list.push(index);
        if (!onto[state].includes(other)) onto[state].push(other);
      }
      // Slide across onto the other hole, then rest the sheet on its nearer side.
      const needed = add(across.map(v => -v), b.axis, (along < 0 ? -thickness : thickness) - along);
      const length = Math.hypot(...needed);
      if (length < shortest) { shortest = length; move = needed; }
    }
  });
  return { matched, inside, onto, move };
}
