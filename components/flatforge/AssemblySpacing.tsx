'use client';
import { useState } from 'react';
import type { AssemblyEntry } from './types';
import { faceAxis, opposingFaces, resetAssemblySpacing, setAssemblySpacing } from './assembly-geometry';

export function AssemblyNumber({ label, value, min, onChange }: {
  label: string; value: number; min?: number; onChange: (value: number) => void;
}) {
  const [input, setInput] = useState({ value, draft: String(value), error: '' });
  if (input.value !== value) setInput({ value, draft: String(value), error: '' });
  const { draft, error } = input;
  return <label className="asm-spacing-field">
    <span>{label}</span><span className="asm-spacing-input"><input type="number" step="any" min={min}
      aria-label={label} aria-invalid={!!error} value={draft} onChange={event => {
        const text = event.target.value;
        const number = Number(text);
        const message = text.trim() === '' || !Number.isFinite(number) ? 'Enter a finite number in mm.'
          : min !== undefined && number < min ? `Enter ${min} or greater.` : '';
        setInput({ value: message ? value : number, draft: text, error: message });
        if (!message) onChange(number);
      }}/><small>mm</small></span>
    {error && <small role="alert" className="asm-spacing-error">{error} Last valid value remains applied.</small>}
  </label>;
}

export default function AssemblySpacing({ entry, onChange }: { entry: AssemblyEntry; onChange: (entry: AssemblyEntry) => void }) {
  const [reset, setReset] = useState(0);
  if (!entry.targetFace) return null;
  const normalAxis = faceAxis(entry.targetFace);
  const isGap = opposingFaces(entry);
  return <div className="asm-spacing">
    <div className="asm-spacing-heading"><strong>Panel spacing</strong><button type="button" onClick={() => { onChange(resetAssemblySpacing(entry)); setReset(reset + 1); }}>Reset</button></div>
    {([['x', 'Horizontal (X)'], ['z', 'Vertical (Z)'], ['y', 'Front / back (Y)']] as const).map(([axis, label]) => {
      const normal = normalAxis === axis;
      return <AssemblyNumber key={`${axis}:${entry.targetFace}:${reset}`} label={`${label} ${normal && isGap ? 'gap' : 'offset'}`}
        min={normal ? 0 : undefined} value={normal ? entry.gap : entry.offsets?.[axis] ?? 0}
        onChange={value => onChange(setAssemblySpacing(entry, axis, value))}/>;
    })}
    <p className="asm-spacing-note">{isGap ? `Gap along ${entry.targetFace} between bounding planes.` : `Connection offset along ${entry.targetFace}; faces are not opposing.`} Offsets: +X right, +Z up, −Y front / +Y back.</p>
  </div>;
}
