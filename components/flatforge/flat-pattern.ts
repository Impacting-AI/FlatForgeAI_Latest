import type { Bend, Settings } from './types';
import type { ReviewValues } from './ReviewControls';

export type Point2 = [number, number];
export type FlatPolygon = { outer: Point2[]; holes: Point2[][] };
export type FlatHinge = {
  key: string; id: number; bend_ids: string[]; parent: number; child: number;
  segments: Point2[][];
};
export type FlatExtraction = {
  version: 2; units: 'mm'; bounds: [number, number, number, number];
  outline: FlatPolygon[];
  lines: { id: string; handle: string; start: Point2; end: Point2 }[];
  faces: { id: number; name: string; polygons: FlatPolygon[]; label_point: Point2 | null }[];
  bends: FlatHinge[];
  paint_labels: Point2[];
  corner_reliefs: { outline: Point2[]; area_mm2: number }[];
};

/** Same draft precedence as the individual-bend controls. Never use default_angle. */
export function reviewedBend(bend: Bend, settings: Settings, review: ReviewValues) {
  const edit = review.bend_parameters[bend.key];
  const automaticAngle = bend.confirmed
    ? bend.source.find(source => source.profile !== 'USER CONFIRMED')?.angle ?? null
    : bend.angle;
  // A cleared angle needs fresh detection; don't resurrect a saved manual angle.
  const angle = edit?.angle === null ? null : edit?.angle ?? automaticAngle;
  const radius = edit?.radius ?? settings.radius;
  const deduction = edit?.deduction ?? settings.deduction;
  const calibrated = settings.bend_model !== 'fixed_deduction';
  // The control is BD90 in material mode, not the deduction at every rotation.
  // This is the inverse of parameters.allowance; no change to the CAD policy.
  const atAngle = angle != null && Number.isFinite(angle) && Math.abs(angle) > 0 && Math.abs(angle) < 180
    ? calibrated
      ? 2 * (radius + settings.thickness) * Math.tan(Math.abs(angle) * Math.PI / 360)
        - (2 * (radius + settings.thickness) - deduction) * Math.abs(angle) / 90
      : deduction
    : null;
  return { angle, radius, deduction, calibrated, atAngle };
}

export function hingeAnchor(hinge: FlatHinge): Point2 | null {
  // Midpoint of the longest actual segment, including multi-part hinges. Never
  // anchor across the empty gap between two tabs or use the whole DXF line.
  let longest = 0;
  let anchor: Point2 | null = null;
  for (const points of hinge.segments) for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > longest) {
      longest = length;
      anchor = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    }
  }
  return anchor;
}

export function matchesHinge(hinge: FlatHinge, bend: Bend) {
  return hinge.key === bend.key && hinge.parent === bend.parent && hinge.child === bend.child
    && hinge.bend_ids.length === bend.bend_ids.length
    && hinge.bend_ids.every(id => bend.bend_ids.includes(id));
}

export function flatProjection(bounds: FlatExtraction['bounds'], width: number, height: number, insetX = 250) {
  const [minX, minY, maxX, maxY] = bounds;
  const scale = Math.min((width - 2 * insetX) / (maxX - minX), (height - 64) / (maxY - minY));
  return (point: Point2): Point2 => [
    width / 2 + (point[0] - (minX + maxX) / 2) * scale,
    height / 2 - (point[1] - (minY + maxY) / 2) * scale,
  ];
}

export function polygonPath(polygons: FlatPolygon[], project: (point: Point2) => Point2) {
  return polygons.flatMap(p => [p.outer, ...p.holes])
    .map(ring => 'M ' + ring.map(p => project(p).join(',')).join(' L ') + ' Z').join(' ');
}

/** Pack callouts on each side, retaining vertical order and a real leader anchor. */
export function calloutLayout(hinges: FlatHinge[], project: (p: Point2) => Point2, width: number, height: number, cardHeight: number) {
  const points = hinges.flatMap(hinge => {
    const anchor = hingeAnchor(hinge);
    return anchor ? [{ hinge, anchor: project(anchor) }] : [];
  }).sort((a, b) => a.anchor[0] - b.anchor[0] || a.anchor[1] - b.anchor[1] || a.hinge.key.localeCompare(b.hinge.key));
  const split = Math.ceil(points.length / 2);
  return [points.slice(0, split), points.slice(split)].flatMap((side, index) => {
    side.sort((a, b) => a.anchor[1] - b.anchor[1] || a.anchor[0] - b.anchor[0]);
    const gap = 12;
    const positions: number[] = [];
    side.forEach((item, i) => {
      positions[i] = Math.max(16, item.anchor[1] - cardHeight / 2, i ? positions[i - 1] + cardHeight + gap : 16);
    });
    for (let i = side.length - 1; i >= 0; i--) {
      positions[i] = Math.min(positions[i], i === side.length - 1 ? height - cardHeight - 16 : positions[i + 1] - cardHeight - gap);
    }
    return side.map((item, i) => ({ ...item, x: index ? width - 232 : 12, y: positions[i], left: index === 0 }));
  });
}
