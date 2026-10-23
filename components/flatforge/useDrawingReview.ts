'use client';
import { useState, type SetStateAction } from 'react';
import { emptyReview, savedReview, type ReviewValues } from './review-state';
import type { Panel, Settings } from './types';

type Values = { settings: Settings; review: ReviewValues; confirm: boolean; partial: boolean; relief: boolean };
function source(panel: Panel | undefined, defaults: Settings) {
  const values: Values = { settings: panel?.settings ?? defaults, review: panel ? savedReview(panel) : emptyReview,
    confirm: panel?.overrides.confirm_parameters === true, partial: panel?.overrides.accept_partial_sections === true,
    relief: panel?.overrides.accept_relief_extensions === true };
  return { stamp: `${panel?.id}:${panel?.revision}:${panel?.status}`, revision: panel?.revision, baseline: JSON.stringify(values), values };
}
/** Mounted by drawing ID. Polling never overwrites a dirty draft or advances its expected revision. */
export function useDrawingReview(panel: Panel | undefined, defaults: Settings) {
  const [state, setState] = useState(() => source(panel, defaults));
  const incoming = `${panel?.id}:${panel?.revision}:${panel?.status}`;
  const dirty = JSON.stringify(state.values) !== state.baseline;
  if (incoming !== state.stamp && !dirty) setState(source(panel, defaults));
  const update = <K extends keyof Values>(field: K, value: SetStateAction<Values[K]>) => {
    setState(previous => ({ ...previous, values: { ...previous.values,
      [field]: typeof value === 'function' ? (value as (old: Values[K]) => Values[K])(previous.values[field]) : value } }));
  };
  return { ...state.values, dirty, revision: state.revision, stale: incoming !== state.stamp,
    setSettings: (value: SetStateAction<Settings>) => update('settings', value),
    setReview: (value: SetStateAction<ReviewValues>) => update('review', value),
    setConfirm: (value: boolean) => update('confirm', value), setPartial: (value: boolean) => update('partial', value),
    setRelief: (value: boolean) => update('relief', value),
    // This closure belongs to the submitted snapshot. Edits made while the
    // request is in flight must remain dirty rather than being marked saved.
    markSaved: () => setState(previous => ({ ...previous, baseline: JSON.stringify(state.values) })),
  };
}
