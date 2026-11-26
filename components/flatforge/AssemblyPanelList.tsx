'use client';
import { Eye, EyeOff, Focus, Link2, Pencil, Trash2 } from 'lucide-react';
import type { AssemblyEntry } from './types';
import type { CadPlacement } from './assembly-cad';
import { mateTitle, motionText, panelStatus } from './plane-mates';

export default function AssemblyPanelList({ entries, placement, fileNames, active, hidden, busy, canHide, onSelect, onFocus, onToggle, onMate, onEdit, onRemove }: {
  entries: AssemblyEntry[]; placement: CadPlacement | null; fileNames: Record<string, string>; active: string | null; hidden: string[]; busy: boolean; canHide: boolean;
  onSelect: (id: string) => void; onFocus: (id: string) => void; onToggle: (id: string) => void; onMate: (id: string) => void;
  onEdit: (entryId: string, mateId: string) => void; onRemove: (entryId: string, mateId: string) => void;
}) {
  const label = (id: string) => entries.find(e => e.id === id)?.label ?? '?';
  return <ul className="asm-tree">
    {entries.map(entry => {
      const report = placement?.constraints?.[entry.id], status = panelStatus(entry, report), shown = !hidden.includes(entry.id);
      return <li key={entry.id} className={entry.id === active ? 'selected' : ''} data-entry={entry.label}>
        <div className="asm-tree-row">
          <button type="button" className="asm-tree-name" onClick={() => onSelect(entry.id)}><b>{entry.label}</b><span>{fileNames[entry.id]}<small data-tone={status.tone}>{status.label}</small></span></button>
          <button type="button" aria-label={`Focus Panel ${entry.label}`} title="Zoom to this panel" disabled={!shown} onClick={() => onFocus(entry.id)}><Focus size={13} /></button>
          <button type="button" aria-label={`${shown ? 'Hide' : 'Show'} Panel ${entry.label}`} title={shown ? 'Hide' : 'Show'} disabled={!canHide} onClick={() => onToggle(entry.id)}>{shown ? <Eye size={13} /> : <EyeOff size={13} />}</button>
          {entry.targetId !== null && <button type="button" aria-label={`Mate Panel ${entry.label}`} title="Add a mate to this panel" disabled={busy} onClick={() => onMate(entry.id)}><Link2 size={13} /></button>}
        </div>
        {report && report.status === 'under' && <p>{motionText(report)}. Pick faces pointing another way.</p>}
        {!!entry.planeMates?.length && <ul aria-label={`Mates on Panel ${entry.label}`}>
          {entry.planeMates.map(mate => {
            const state = report?.mates.find(m => m.id === mate.id), name = mateTitle(mate, entry.label ?? '?', label(mate.targetId));
            return <li key={mate.id} data-state={state?.state ?? 'ok'}>
              <span title={`${mate.moving.faceId} ↔ ${mate.reference.faceId}${state?.message ? ' · ' + state.message : ''}`}>{name}<small>{mate.moving.faceId} ↔ {mate.reference.faceId}{state && state.state !== 'ok' ? ` · ${state.state}` : ''}</small></span>
              <button type="button" aria-label={`Edit ${name}`} title="Edit" disabled={busy} onClick={() => onEdit(entry.id, mate.id)}><Pencil size={12} /></button>
              <button type="button" aria-label={`Remove ${name}`} title="Remove" disabled={busy} onClick={() => onRemove(entry.id, mate.id)}><Trash2 size={12} /></button>
            </li>;
          })}
        </ul>}
        {entry.connection && entry.targetId && <p>{entry.mateState === 'suspended' ? 'Suspended' : 'Snap'} connection → Panel {label(entry.targetId)}</p>}
      </li>;
    })}
  </ul>;
}
