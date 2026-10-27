'use client';
import { useEffect, useState } from 'react';
import type { AssemblyEntry } from './types';
import { faceAxis, resetAssemblySpacing, setAssemblySpacing, setAssemblySide, withDirectionalGaps } from './assembly-geometry';

export function AssemblyNumber({ label, value, min, disabled, onChange, onValidityChange }: {
  label: string; value: number; min?: number; disabled?: boolean; onChange: (value: number) => void; onValidityChange?:(valid:boolean)=>void;
}) {
  const [input, setInput] = useState({ value, draft: String(value), error: '' });
  if (input.value !== value) setInput({ value, draft: String(value), error: '' });
  const { draft, error } = input;
  useEffect(()=>{onValidityChange?.(!error||!!disabled);},[error,disabled,onValidityChange]);
  return <label className="asm-spacing-field">
    <span>{label}</span><span className="asm-spacing-input"><input type="number" step="any" min={min} disabled={disabled}
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

export default function AssemblySpacing({ entry, onChange, onValidityChange }: { entry: AssemblyEntry; onChange: (entry: AssemblyEntry) => void; onValidityChange?:(valid:boolean)=>void }) {
  const [reset, setReset] = useState(0);
  const [validity,setValidity]=useState({x:true,y:true,z:true});
  useEffect(()=>{onValidityChange?.(Object.values(validity).every(Boolean));},[validity,onValidityChange]);
  if (!entry.targetFace) return null;
  const normalAxis = faceAxis(entry.targetFace);
  if (!entry.spacing) return <div className="asm-spacing"><p className="asm-spacing-note">Saved layout uses the previous offsets. Its positions are retained. Convert to directional gaps to edit spacing; existing alignment on other axes is kept.</p><button type="button" className="table-link" onClick={() => onChange(withDirectionalGaps(entry))}>Use directional gaps</button></div>;
  return <div className="asm-spacing">
    <div className="asm-spacing-heading"><strong>Panel spacing</strong><button type="button" onClick={() => { onChange(resetAssemblySpacing(entry)); setReset(reset + 1); }}>Reset</button></div>
    {([['x', 'Horizontal (X)', 'Right (+X)', 'Left (−X)'], ['z', 'Vertical (Z)', 'Above (+Z)', 'Below (−Z)'], ['y', 'Front / back (Y)', 'Back (+Y)', 'Front (−Y)']] as const).map(([axis, label, positive, negative]) => {
      const normal = normalAxis === axis;
      const constraint = entry.spacing![axis];
      return <div className="asm-axis-gap" key={`${axis}:${entry.targetFace}:${reset}`}>
        <AssemblyNumber label={`${label} gap`} min={0} disabled={!constraint.side}
          value={constraint.side ? constraint.gap : 0} onValidityChange={valid=>setValidity(old=>old[axis]===valid?old:{...old,[axis]:valid})} onChange={value => onChange(setAssemblySpacing(entry, axis, value))}/>
        <select aria-label={`${label} direction`} disabled={normal} value={constraint.side}
          onChange={event => onChange(setAssemblySide(entry, axis, Number(event.target.value) as -1|0|1))}>
          {!normal && <option value={0}>Keep alignment{entry.offsets?.[axis] ? ` (${entry.offsets[axis]} mm saved shift)` : ''}</option>}
          <option value={1}>{positive}</option><option value={-1}>{negative}</option>
        </select>
      </div>;
    })}
    <p className="asm-spacing-note">Choose a side to add separation on an axis. Zero on an active axis means touching bounding planes; Keep alignment adds no gap. Gaps measure directional clearance, not the shortest distance between irregular surfaces.</p>
  </div>;
}
