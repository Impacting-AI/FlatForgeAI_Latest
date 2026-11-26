'use client';
import { X } from 'lucide-react';
import type { AssemblyEntry } from './types';
import type { CadFaceCatalog, MateReport } from './assembly-cad';
import { faceName, motionText, sessionOffset, type MateSession } from './plane-mates';

type Slot = 'moving' | 'target';
export default function AssemblyMateCard({ session, entries, catalogs, fileNames, report, checking, valid, problem, warning, onFace, onSwap, onChange, onClear, onApply, onDone }: {
  session: MateSession; entries: AssemblyEntry[]; catalogs: Record<string, CadFaceCatalog>; fileNames: Record<string, string>;
  report?: MateReport; checking: boolean; valid: boolean; problem: string; warning: string;
  onFace: (slot: Slot) => void; onSwap: () => void; onChange: (patch: Partial<MateSession>) => void;
  onClear: () => void; onApply: () => void; onDone: () => void;
}) {
  const title = (id: string) => `Panel ${entries.find(e => e.id === id)?.label ?? '?'}`;
  const complete = !!session.moving && !!session.target && !session.pick;
  const badValue = complete && sessionOffset(session) === null;
  const own = report?.mates.find(m => m.id === session.mateId);
  const conflict = !checking && own?.state === 'conflict';
  const canApply = complete && !badValue && !checking && valid && !conflict;
  const step = !session.moving ? 1 : !session.target ? 2 : 3;
  const preferred = session.preferred ? title(session.preferred) : null;
  const prompt = step === 1 ? `Click a flat face${preferred ? ` on ${preferred}` : ' on the panel to move'}.`
    : step === 2 ? 'Now click the face it should meet, on another panel.' : '';
  const reach = prompt && ' Drag to orbit, or hide a panel in the list, to reach a covered face.';
  const result = !complete || badValue ? null
    : checking ? { tone: 'info', text: 'Solving…' }
      : conflict ? { tone: 'error', text: `This mate conflicts with the existing ones. ${own!.message}` }
        : !valid ? { tone: 'error', text: problem || 'The CAD service could not approve this mate.' }
          : report ? { tone: 'ok', text: report.dof ? `Ready to apply. ${title(session.moving!.entryId)} ${motionText(report).replace(/^Can/, 'can')} until you add more mates.` : `Ready to apply. ${title(session.moving!.entryId)} is fully defined.` }
            : { tone: 'ok', text: 'Ready to apply.' };
  const slot = (key: Slot, heading: string, empty: string) => {
    const pick = session[key];
    return <button type="button" className="asm-slot" data-slot={key} aria-pressed={session.pick === key} onClick={() => onFace(key)} title={pick ? 'Click, then pick a different face' : empty}>
      <span aria-hidden="true" className={'asm-swatch asm-swatch-' + (key === 'moving' ? 'moving' : 'reference')} />
      <span><strong>{heading}{pick ? `: ${title(pick.entryId)}` : ''}</strong>
        <small>{pick ? `${faceName(catalogs[pick.entryId], pick.face.faceId)} · ${fileNames[pick.entryId] ?? ''}` : empty}</small></span>
    </button>;
  };
  return <section className="asm-context asm-position-card asm-mate-card" data-position-popup="true" aria-label="Mate">
    <header><strong>{session.editing ? 'Edit mate' : 'Mate'}</strong><button type="button" aria-label="Close mate" onClick={onDone}><X size={14} /></button></header>
    <ol className="asm-mate-progress" aria-hidden="true">
      {['Face to move', 'Face to meet', 'Apply'].map((label, i) => <li key={label} data-done={step > i + 1} data-current={step === i + 1}><span className="asm-step-num">{i + 1}</span><span className="asm-step-label">{label}</span></li>)}
    </ol>
    {session.note && <p role="status" className="asm-mate-note">{session.note}</p>}
    {prompt && <p role="status" data-mate-prompt>{prompt}<small>{reach}</small></p>}
    {slot('moving', 'Moves', 'Waiting for a face')}
    {slot('target', 'Stays', 'Waiting for a face')}
    {complete && <>
      <div className="asm-segment" role="group" aria-label="Mate type">
        {(['coincident', 'distance'] as const).map(type => <button type="button" key={type} aria-pressed={session.type === type} onClick={() => onChange({ type })}>{type === 'coincident' ? 'Coincident' : 'Distance'}</button>)}
      </div>
      {session.type === 'distance' && <div className="asm-inline-values">
        <label><span>Distance</span><span><input aria-label="Distance" type="number" min="0" step="any" autoFocus value={session.distance} onChange={e => onChange({ distance: e.target.value })} /><small>mm</small></span></label>
        <label className="asm-check"><input type="checkbox" checked={session.reverse} onChange={e => onChange({ reverse: e.target.checked })} />Measure to the other side</label>
      </div>}
      <div className="asm-mate-options">
        <button type="button" onClick={() => onChange({ aligned: !session.aligned })} title="Turn the moving panel over">Flip · faces {session.aligned ? 'point the same way' : 'face each other'}</button>
        <button type="button" onClick={onSwap} title="Move the other panel instead">Swap panels</button>
      </div>
      <label className="asm-check" title="Slide the panel so the two picked faces sit on each other, in the directions no mate holds"><input type="checkbox" checked={session.lineUp} onChange={e => onChange({ lineUp: e.target.checked })} />Bring these faces together</label>
      {badValue && <p role="alert" data-mate-status="error">Enter a distance in millimetres.</p>}
      {result && <p role={result.tone === 'error' ? 'alert' : 'status'} data-mate-status={result.tone}>{result.text}</p>}
      {!checking && own?.state === 'redundant' && <p data-mate-status="warn">{own.message}</p>}
      {warning && <p data-mate-status="warn">{warning} Add the remaining mates, or increase the distance.</p>}
    </>}
    <footer>
      {(session.moving || session.target) && <button type="button" onClick={onClear}>Clear picks</button>}
      <button type="button" onClick={onDone}>Done</button>
      <button type="button" className="primary" disabled={!canApply} title="Enter" onClick={onApply}>{session.editing ? 'Update mate' : 'Apply'}</button>
    </footer>
  </section>;
}
