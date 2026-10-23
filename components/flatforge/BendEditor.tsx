'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import type { Bend, BendValues, Panel, Settings } from './types';
import type { ReviewValues } from './review-state';
import { bendDraftText, bendFields, bendInputValue, bendValueError, type BendDraft, type BendField } from './bend-review';
import { bendSourceReferences } from './flat-pattern';
import styles from './FlatPatternViewer.module.css';

export default function BendEditor({ bend, names, settings, review, resolution, sectionReviewRequired, style, onApply, onAutomatic, onCancel }: {
  bend: Bend; names: string; settings: Settings; review: ReviewValues;
  resolution: Panel['report']['parameter_resolution']; sectionReviewRequired: boolean; style: CSSProperties;
  onApply: (patch: BendValues) => void; onAutomatic: () => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState<BendDraft>({});
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const id = useId();
  useEffect(() => {
    // Refreshing from another review control must not steal its input focus.
    const active = document.activeElement;
    if (active?.matches('input, textarea, select') && !form.current?.contains(active)) return;
    first.current?.focus({ preventScroll: true });
  }, []);
  const current = (field: BendField) => String(bendInputValue(bend, settings, review, field));
  const input = (field: BendField) => bendDraftText(draft, field, current(field));
  const needsConfirmation = (field: BendField) => field === 'angle'
    ? sectionReviewRequired && !review.manual_bends
    : review.bend_parameters[bend.key]?.[field] == null && review.parameter_overrides[field] == null
      && resolution?.[field]?.needs_review;
  const source = (field: BendField) => {
    if (draft[field]?.base === current(field) && input(field) !== current(field)) return 'Pending edit';
    if (current(field) === '') return 'Missing · enter a value, or use automatic and rebuild';
    if (review.bend_parameters[bend.key]?.[field] != null) return 'Manual correction';
    if (needsConfirmation(field)) return field === 'angle'
      ? 'Section needs review · Apply uses reviewed bends for reconstruction'
      : 'Panel value · Apply confirms it for this bend';
    return field === 'angle' ? 'Drawing angle' : 'Panel value';
  };
  function apply() {
    const values: BendValues = Object.fromEntries(bendFields.map(field => [field, input(field).trim() === '' ? null : Number(input(field))]));
    const message = bendValueError(values, true);
    if (message) { setError(message); return; }
    // Leave unchanged automatic values automatic. Only changed or explicitly
    // unconfirmed fields become overrides; unrelated bends/state are untouched.
    const patch: BendValues = {};
    for (const field of bendFields) {
      if (current(field) === '' || values[field] !== Number(current(field)) || needsConfirmation(field)) patch[field] = values[field];
    }
    onApply(patch);
  }
  const manual = Object.values(review.bend_parameters[bend.key] ?? {}).some(value => value != null);
  return <form ref={form} className={styles.editor} style={style} role="dialog" aria-modal="false" aria-labelledby={id + '-title'}
    noValidate onSubmit={event => { event.preventDefault(); apply(); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
    <div className={styles.editorBody}>
    <h4 id={id + '-title'}>Bend {bend.bend_ids.join(' / ')} — {names}</h4>
    <div className={styles.editorSource}><strong>Source section / vertex</strong>{bendSourceReferences(bend).map(source => <p key={source}>{source}</p>)}</div>
    <p className={styles.editorHelp}>Edit this bend’s review values.</p>
    {bendFields.map(field => <label key={field} className={styles.editorField}>
      <span>{field === 'angle' ? 'Signed rotation (°)' : field === 'radius' ? 'Inside radius (mm)' : settings.bend_model === 'fixed_deduction' ? 'Bend deduction (mm)' : 'Bend deduction at 90° (mm)'}</span>
      <input ref={field === 'angle' ? first : undefined} type="number" step="any" value={input(field)} placeholder="Enter value"
        aria-describedby={`${id}-${field}-source${error ? ' ' + id + '-error' : ''}`}
        onChange={event => { setDraft(previous => ({ ...previous, [field]: { text: event.target.value, base: current(field) } })); setError(null); }}/>
      <small id={`${id}-${field}-source`}>{source(field)}</small>
    </label>)}
    {error && <p className={styles.editorError} id={id + '-error'} role="alert">{error}</p>}
    <p className={styles.editorHelp}>Apply updates the review. Save &amp; rebuild runs the full bend and geometry checks and updates the 3D model.</p>
    </div>
    <div className={styles.editorActions}>
      {manual && <button type="button" className={styles.automatic} onClick={onAutomatic}>Use automatic</button>}
      <button type="button" onClick={onCancel}>Cancel</button>
      <button type="submit" className={styles.apply}>Apply</button>
    </div>
  </form>;
}
