'use client';
import { Lock, LockOpen, Trash2 } from 'lucide-react';
import type { AssemblyEntry } from './types';
import type { CadPlacement } from './assembly-cad';
import { connectionStatus } from './assembly-actions';

export default function AssemblyPanelList({ entries, placement, fileNames, active, busy, onSelect, onLock, onRemove }: {
  entries: AssemblyEntry[]; placement: CadPlacement | null; fileNames: Record<string, string>; active: string | null; busy: boolean;
  onSelect: (id: string) => void; onLock: (id: string) => void; onRemove: (id: string) => void;
}) {
  return <ul className="asm-tree">
    {entries.map(entry => {
      const status = connectionStatus(entry, entries, placement?.constraints?.[entry.id]);
      return <li key={entry.id} className={entry.id === active ? 'selected' : ''} data-entry={entry.label}>
        <div className="asm-tree-row">
          <button type="button" className="asm-tree-name" aria-pressed={entry.id === active} onClick={() => onSelect(entry.id)}><b>{entry.label}</b><span>{fileNames[entry.id]}<small data-tone={status.tone}>{status.label}{entry.locked ? ' · Locked' : ''}</small></span></button>
          <button type="button" className="asm-lock" aria-label={`${entry.locked ? 'Unlock' : 'Lock'} Panel ${entry.label}`} aria-pressed={!!entry.locked} title={entry.locked ? 'Locked in place. Click to unlock.' : 'Lock this panel in place'} disabled={busy} onClick={() => onLock(entry.id)}>{entry.locked ? <Lock size={13} /> : <LockOpen size={13} />}</button>
          <button type="button" aria-label={`Remove Panel ${entry.label}`} title={entry.locked ? 'Unlock the panel to remove it' : 'Remove panel'} disabled={busy || entry.locked} onClick={() => onRemove(entry.id)}><Trash2 size={13} /></button>
        </div>
      </li>;
    })}
  </ul>;
}
