'use client';
import { Euler, MathUtils, Matrix4 } from 'three';
import { Minus, Move3d } from 'lucide-react';
import { describeMove } from './assembly-actions';

/** Named as seen in the default view. Colours match the arrows on the panel. */
const AXES = [
  { axis: 'X', positive: 'Right', negative: 'Left' },
  { axis: 'Y', positive: 'Back', negative: 'Front' },
  { axis: 'Z', positive: 'Up', negative: 'Down' },
];
const number = (value: number) => (Math.round(value * 10) / 10 || 0).toLocaleString('en-US', { maximumFractionDigits: 1 });
const signed = (value: number) => (Math.round(value * 10) > 0 ? '+' : '') + number(value);
// A half turn reads as 180°, never -180°.
const degrees = (value: number | null) => value === null ? '—' : `${number(value < -179.95 ? 180 : value)}°`;

export default function AssemblyMovePanel({ title, fileName, delta, moving, position, matrix, minimized, onMinimize }: {
  title: string; fileName: string;
  /** World millimetres of the movement in progress, or of the last one made. */
  delta: number[] | null; moving: boolean;
  /** Centre of this panel measured from the centre of the base; null for the base itself. */
  position: { base: string; offset: number[] } | null;
  /** Current column-major CAD placement. */
  matrix: number[] | null; minimized: boolean; onMinimize: (minimized: boolean) => void;
}) {
  if (minimized) return <button type="button" className="asm-move-open" aria-label="Show movement values" title="Show movement values" onClick={() => onMinimize(false)}><Move3d size={15} />Values</button>;
  const move = describeMove(delta ?? [0, 0, 0]);
  const turn = matrix ? new Euler().setFromRotationMatrix(new Matrix4().fromArray(matrix), 'XYZ') : null;
  return <aside className="asm-move-panel" aria-label="Movement values" data-moving={moving}>
    <header>
      <div><strong>{title}</strong><small title={fileName}>{fileName}</small></div>
      <button type="button" aria-label="Minimize movement values" title="Minimize" onClick={() => onMinimize(true)}><Minus size={14} /></button>
    </header>
    <h4>{moving ? 'Moving now' : delta ? 'Last move' : 'Movement'}</h4>
    {delta ? <>
      <dl>{AXES.map(({ axis, positive, negative }, i) => <div key={axis} data-axis={axis}>
        <dt><b>{axis}</b>{delta[i] > 0 ? positive : delta[i] < 0 ? negative : `${positive} / ${negative}`}</dt>
        <dd>{signed(delta[i])} mm</dd>
      </div>)}</dl>
      <dl>
        <div data-value="distance"><dt>Distance</dt><dd>{number(move.distance)} mm</dd></div>
        <div data-value="heading" title="Seen from above: 0° is right (+X), 90° is back (+Y)"><dt>Angle, top view</dt><dd>{degrees(move.heading)}</dd></div>
        <div data-value="tilt" title="Above (+) or below (−) level"><dt>Angle, up / down</dt><dd>{degrees(move.tilt)}</dd></div>
      </dl>
    </> : <p>Drag an arrow or press an arrow key to see the values.</p>}
    {position && <>
      <h4>Position from {position.base}</h4>
      <dl>{AXES.map(({ axis }, i) => <div key={axis} data-position={axis}><dt><b>{axis}</b></dt><dd>{signed(position.offset[i])} mm</dd></div>)}</dl>
    </>}
    {turn && <>
      <h4>Panel angle</h4>
      <dl>{(['x', 'y', 'z'] as const).map(key => <div key={key} data-angle={key.toUpperCase()}><dt><b>{key.toUpperCase()}</b></dt><dd>{degrees(MathUtils.radToDeg(turn[key]))}</dd></div>)}</dl>
    </>}
  </aside>;
}
