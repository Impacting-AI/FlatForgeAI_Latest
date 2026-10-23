'use client';
import { useState } from 'react';
import type { Panel } from './types';
import { Button } from '@/components/ui/button';

export default function DrawingMeasurement({ panel, disabled, onSave }: {
  panel: Panel; disabled: boolean; onSave: (value: string, axis: string) => Promise<boolean>;
}) {
  const saved = { value: panel.manual_value?.toString() ?? '', axis: panel.manual_axis || 'flat_width' };
  const [state, setState] = useState({ ...saved, baseline: JSON.stringify(saved) });
  const dirty = JSON.stringify({ value: state.value, axis: state.axis }) !== state.baseline;
  if (!dirty && state.baseline !== JSON.stringify(saved)) setState({ ...saved, baseline: JSON.stringify(saved) });
  return <div className="manual-entry" data-unsaved-measurement={dirty}>
    <select disabled={disabled} aria-label={'Measurement axis for ' + panel.filename} value={state.axis}
      onChange={event => setState({ ...state, axis: event.target.value })}>
      <option value="flat_width">Flat width</option><option value="flat_height">Flat height</option>
      <option value="folded_x">Folded X</option><option value="folded_y">Folded Y</option><option value="folded_z">Folded Z</option>
    </select>
    <input disabled={disabled} type="number" min="0" step="any" placeholder="Enter mm"
      aria-label={'Manual measurement for ' + panel.filename} value={state.value}
      onChange={event => setState({ ...state, value: event.target.value })}/>
    <Button type="button" variant="outline" size="sm" disabled={disabled || !dirty} onClick={async () => {
      const values = { value: state.value, axis: state.axis };
      if (await onSave(values.value, values.axis)) setState({ ...values, baseline: JSON.stringify(values) });
    }}>Save measurement</Button>
  </div>;
}
