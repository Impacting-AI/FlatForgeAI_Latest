'use client';

import { useEffect, useRef, useState } from 'react';
import type { Panel, Settings } from './types';
import { fileUrl } from './types';
import type { ReviewValues } from './review-state';
import { bendSourceReferences, calloutLayout, editableHinge, flatProjection, hingeAnchor, matchesHinge, polygonPath, reviewedBend } from './flat-pattern';
import type { FlatExtraction, Point2 } from './flat-pattern';
import { bendFields, bendInputValue, type BendChange } from './bend-review';
import BendEditor from './BendEditor';
import styles from './FlatPatternViewer.module.css';

const number = (value: number | null, unit: string, signed = false) => value == null || !Number.isFinite(value)
  ? 'Not established' : `${signed && value > 0 ? '+' : ''}${value.toFixed(unit === '°' ? 3 : 2).replace(/\.000$/, '')}${unit === '°' ? '' : ' '}${unit}`;

export default function FlatPatternViewer({ panel, settings, review, zoom, onBendChange }: {
  panel: Panel; settings: Settings; review: ReviewValues; zoom: number; onBendChange: BendChange;
}) {
  const [geometry, setGeometry] = useState<FlatExtraction | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [allValues, setAllValues] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [width, setWidth] = useState(820);
  const [viewportHeight, setViewportHeight] = useState(560);
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [editing, setEditing] = useState<string | null>(null);
  const [editorNotice, setEditorNotice] = useState('');
  const editorTrigger = useRef<SVGElement | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const url = `${fileUrl(panel, 'extraction.json')}?revision=${panel.revision}&updated=${panel.updated}`;
  const hasGeometry = panel.artifacts.includes('extraction.json');
  useEffect(() => {
    if (!hasGeometry) return;
    const controller = new AbortController();
    fetch(url, { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('Could not load the bend locations. Retry to load the drawing.');
        const data = await response.json() as FlatExtraction;
        if (data.version !== 2 || !data.bends || !data.outline || !data.faces || !data.bounds.every(Number.isFinite)) {
          throw new Error('Rebuild this panel once to load exact hinge locations and face regions for annotations.');
        }
        if (!controller.signal.aborted) { setGeometry(data); setError(''); }
      })
      .catch(err => { if (!controller.signal.aborted) { setGeometry(null); setError((err as Error).message); } });
    return () => controller.abort();
  }, [url, hasGeometry, retry]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver(entries => {
      setWidth(entries[0].contentRect.width);
      setViewportHeight(entries[0].contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [geometry]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    // Wide panels can be much shorter than their callout columns. Open on the
    // drawing, not on empty space above it; retain that centre when zooming.
    node.scrollLeft = Math.max(0, (node.scrollWidth - node.clientWidth) / 2);
    node.scrollTop = Math.max(0, (node.scrollHeight - node.clientHeight) / 2);
  }, [geometry, width, zoom, allValues]);

  if (!geometry) return <div className={styles.fallback}>
    {panel.artifacts.includes('extraction.svg') && <img src={fileUrl(panel, 'extraction.svg')} alt="Extracted flat panel; bend-location annotations are not yet available"/>}
    <p>{error || (hasGeometry ? 'Loading bend locations…' : 'Drawing extraction is not available yet.')}</p>
    {error && <button type="button" onClick={() => setRetry(n => n + 1)}>Retry</button>}
  </div>;

  const bends = panel.report.bends ?? [];
  const linked = geometry.bends.filter(hinge => bends.some(bend => matchesHinge(hinge, bend)));
  const active = linked.find(hinge => hinge.key === selected) ?? linked[0];
  const cardHeight = allValues ? 182 : 40;
  const height = Math.max(500, Math.ceil(linked.length / 2) * (cardHeight + 12) + 32);
  const layoutWidth = Math.max(820, width);
  // Fit desktop widths, but preserve legible labels on phones; the canvas pans.
  const displayScale = zoom * Math.min(1, Math.max(.75, width / 820));
  const project = flatProjection(geometry.bounds, layoutWidth, height);
  const cards = calloutLayout(linked, project, layoutWidth, height, cardHeight);
  const faceName = (id: number) => geometry.faces.find(face => face.id === id)?.name ?? `F${id}`;
  const path = (points: Point2[]) => 'M ' + points.map(point => project(point).join(',')).join(' L ');
  const activeBend = bends.find(bend => bend.key === active?.key);
  const editHinge = linked.find(hinge => hinge.key === editing);
  const editBend = editHinge && editableHinge(geometry, bends, editHinge.key)
    ? bends.find(bend => bend.key === editHinge.key) : undefined;
  const editPoint = editHinge ? hingeAnchor(editHinge) : null;
  const editAnchor = editPoint ? project(editPoint) : null;
  const editTop = editAnchor ? Math.max(8, Math.min(viewportHeight - 500, editAnchor[1] * displayScale - scroll.y - 24)) : 8;
  const editLeft = editAnchor && editAnchor[0] * displayScale - scroll.x > width / 2
    ? Math.max(8, width - 288) : 8;
  function openEditor(key: string, trigger: SVGElement) {
    setSelected(key);
    if (!editableHinge(geometry!, bends, key)) {
      setEditing(null); setEditorNotice('This bend’s identity or location is uncertain. Rebuild the panel before editing it.'); return;
    }
    editorTrigger.current = trigger;
    setEditorNotice(''); setEditing(key);
  }
  function closeEditor() {
    setEditing(null);
    if (editorTrigger.current?.isConnected) editorTrigger.current.focus({ preventScroll: true });
  }
  const detail = activeBend ? reviewedBend(activeBend, settings, review) : null;
  const required = (field: 'radius' | 'deduction', key: string) => review.bend_parameters[key]?.[field] == null
    && review.parameter_overrides[field] == null && panel.report.parameter_resolution?.[field]?.needs_review;
  const draft = JSON.stringify(review.bend_parameters) !== JSON.stringify(panel.overrides.bend_parameters ?? {})
    || JSON.stringify(review.parameter_overrides) !== JSON.stringify(panel.overrides.parameter_overrides ?? {})
    || settings.radius !== panel.settings.radius || settings.deduction !== panel.settings.deduction
    || settings.thickness !== panel.settings.thickness || settings.bend_model !== panel.settings.bend_model;

  return <div className={styles.viewer}>
    <div className={styles.options}>
      <label><input type="checkbox" checked={allValues} onChange={event => setAllValues(event.target.checked)}/>All bend values</label>
      <p>Select a line or label to edit its bend values and read full source references. Scroll to inspect; use zoom above.</p>
    </div>
    <div className={styles.canvasShell}>
    <div className={styles.canvas} ref={viewport} onScroll={event => setScroll({ x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop })}>
      <svg className={styles.drawing} width={layoutWidth * displayScale} height={height * displayScale} viewBox={`0 0 ${layoutWidth} ${height}`} aria-label="Flat pattern with geometry-linked bend values">
        <path className={styles.outline} d={polygonPath(geometry.outline, project)} fillRule="evenodd"/>
        {geometry.faces.filter(face => face.id === active?.parent || face.id === active?.child).map(face => <path key={face.id} className={face.id === active?.parent ? styles.parent : styles.child} d={polygonPath(face.polygons, project)} fillRule="evenodd"/>)}
        {geometry.corner_reliefs.map((relief, i) => <path key={i} d={path(relief.outline) + ' Z'} fill="#ed8a36" stroke="#a94313"><title>Proposed corner relief: {relief.area_mm2.toFixed(4)} mm²</title></path>)}
        {geometry.lines.map(line => <path key={line.handle} d={path([line.start, line.end])} className={styles.axis}><title>{line.id} · original DXF bend axis</title></path>)}
        {geometry.paint_labels.map((point, i) => <text key={i} x={project(point)[0]} y={project(point)[1]} className={styles.paint}>PAINT</text>)}
        {cards.map(({ hinge, anchor, x, y, left }) => <g key={hinge.key}>
          <path className={`${styles.leader} ${hinge.key === active?.key ? styles.activeLeader : ''}`} d={`M ${left ? x + 220 : x} ${y + cardHeight / 2} L ${left ? x + 232 : x - 12} ${y + cardHeight / 2} L ${anchor[0]} ${anchor[1]}`}/>
          <circle className={styles.anchor} cx={anchor[0]} cy={anchor[1]} r={3}/>
        </g>)}
        {linked.map(hinge => <g key={hinge.key} tabIndex={-1} onClick={event => openEditor(hinge.key, event.currentTarget)}>
          {hinge.segments.map((segment, i) => <g key={i}>
            <path d={path(segment)} className={`${styles.hinge} ${hinge.key === active?.key ? styles.activeHinge : ''}`}/>
            <path d={path(segment)} className={styles.hit}><title>{hinge.bend_ids.join(' / ')} · {faceName(hinge.parent)} → {faceName(hinge.child)}</title></path>
          </g>)}
        </g>)}
        {geometry.faces.filter(face => face.label_point && (face.id === active?.parent || face.id === active?.child)).map(face => <text key={face.id} x={project(face.label_point!)[0]} y={project(face.label_point!)[1]} textAnchor="middle" className={styles.regionLabel}>{face.name}</text>)}
        {cards.map(({ hinge, x, y }) => {
          const bend = bends.find(b => matchesHinge(hinge, b))!;
          const values = reviewedBend(bend, settings, review);
          const relation = `${faceName(hinge.parent)} → ${faceName(hinge.child)}`;
          const title = `Bend ${hinge.bend_ids.join(' / ')}`;
          const rotation = number(values.angle, '°', true);
          const radius = number(values.radius, 'mm');
          const deduction = number(values.deduction, 'mm');
          const sources = bendSourceReferences(bend).join('; ');
          const showDerived = values.calibrated && values.angle != null && Math.abs(values.angle) !== 90;
          return <g key={hinge.key} className={`${styles.card} ${hinge.key === active?.key ? styles.selected : ''}`}
            role="button" tabIndex={0} aria-pressed={hinge.key === active?.key}
            aria-label={`${title}, ${relation}, rotation ${rotation}, inside radius ${radius}, deduction ${deduction}${values.calibrated ? ' at 90 degrees' : ''}, source section / vertex: ${sources}`}
            onClick={event => openEditor(hinge.key, event.currentTarget)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openEditor(hinge.key, event.currentTarget); } }}>
            <title>{title} · {relation} · Source section / vertex: {sources}</title>
            <rect x={x} y={y} width={220} height={cardHeight} rx={6}/>
            <text className={styles.title} x={x + 10} y={y + 18}>{title}</text>
            <text className={styles.relationship} x={x + 10} y={y + 33}>{relation}</text>
            {allValues && <>
              <text x={x + 10} y={y + 53} className={values.angle == null ? styles.pending : ''}>Rotation: {rotation}</text>
              <text x={x + 10} y={y + 73}>Inside radius: {radius}{required('radius', hinge.key) ? ' *' : ''}</text>
              <text x={x + 10} y={y + 93}>Deduction{values.calibrated ? ' (90°)' : ''}: {deduction}{required('deduction', hinge.key) ? ' *' : ''}</text>
              {showDerived && <text x={x + 10} y={y + 113} className={styles.relationship}>At this rotation: {number(values.atAngle, 'mm')}</text>}
              <text x={x + 10} y={y + 133} className={styles.relationship}>Source section / vertex</text>
              <foreignObject x={x + 10} y={y + 139} width={200} height={36}>
                <div className={styles.sourcePreview} title={sources}>{sources}</div>
              </foreignObject>
            </>}
          </g>;
        })}
      </svg>
    </div>
    {editBend && editHinge && <BendEditor
      key={editBend.key + JSON.stringify([bendFields.map(field => bendInputValue(editBend, settings, review, field)), review.bend_parameters[editBend.key], settings.bend_model])}
      bend={editBend}
      names={`${faceName(editBend.parent)} → ${faceName(editBend.child)}`} settings={settings} review={review}
      resolution={panel.report.parameter_resolution}
      style={{ left: editLeft, top: editTop, maxHeight: viewportHeight - editTop - 8 }}
      onCancel={closeEditor}
      onApply={patch => {
        if (!editableHinge(geometry, bends, editBend.key)) return;
        if (Object.keys(patch).length) onBendChange(editBend.key, patch);
        setEditorNotice('Bend review updated. Save & rebuild panel to apply it to the 3D model.'); closeEditor();
      }}
      onAutomatic={() => {
        if (!editableHinge(geometry, bends, editBend.key)) return;
        onBendChange(editBend.key, null);
        setEditorNotice('Overrides cleared for this bend. Save & rebuild to detect its values again.'); closeEditor();
      }}/>}
    </div>
    <div className={styles.note} aria-live="polite">
      {editorNotice && <p>{editorNotice}</p>}
      {active && detail && <p><strong>{active.bend_ids.join(' / ')} · {faceName(active.parent)} → {faceName(active.child)}</strong> — rotation {number(detail.angle, '°', true)} · inside radius {number(detail.radius, 'mm')} · deduction{detail.calibrated ? ' at 90°' : ''} {number(detail.deduction, 'mm')}. Parent is green; child is amber.</p>}
      {activeBend && <p className={styles.sourceDetails}><strong>Source section / vertex:</strong> {bendSourceReferences(activeBend).join('; ')}.</p>}
      <p>{draft ? 'Showing current review edits. Save & rebuild applies them to the 3D model.' : 'Values follow the current panel and individual bend settings.'} {linked.some(b => required('radius', b.key) || required('deduction', b.key)) && '* This panel value still needs review.'}</p>
      {bends.length !== linked.length && <p>Some bend locations do not match this extraction. Rebuild the panel to refresh the geometry; unmatched bends are not placed by guesswork.</p>}
    </div>
  </div>;
}
