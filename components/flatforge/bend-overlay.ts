import * as THREE from 'three';

export type LabelBox = { x: number; y: number; width: number; height: number };

/** Moves each label straight up or down until it clears the ones already placed. */
export function spreadLabels(boxes: LabelBox[], height: number): LabelBox[] {
  const placed: LabelBox[] = [];
  const result: LabelBox[] = [...boxes];
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a].y - boxes[b].y || boxes[a].x - boxes[b].x);
  const overlaps = (a: LabelBox, b: LabelBox) => a.x < b.x + b.width + 3 && b.x < a.x + a.width + 3
    && a.y < b.y + b.height + 3 && b.y < a.y + a.height + 3;
  for (const i of order) {
    const box = boxes[i];
    let choice = box;
    for (let k = 0; k <= boxes.length * 2; k++) {
      const shift = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (box.height + 4);
      const y = Math.max(0, Math.min(height - box.height, box.y + shift));
      const candidate = { ...box, y };
      if (!placed.some(other => overlaps(candidate, other))) { choice = candidate; break; }
    }
    placed.push(choice);
    result[i] = choice;
  }
  return result;
}

export type BendLabel = { id: number; text: string; title: string; anchor: THREE.Vector3; selected: boolean; changed: boolean };

/** Clickable bend names over the canvas, each linked to its line on the model. */
export function createBendLabels(host: HTMLElement, onSelect: (id: number) => void) {
  const layer = document.createElement('div');
  layer.className = 'bend-labels';
  const links = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  layer.appendChild(links);
  host.appendChild(layer);
  const rows = new Map<number, { button: HTMLButtonElement; line: SVGLineElement }>();
  function row(id: number) {
    let found = rows.get(id);
    if (found) return found;
    const button = document.createElement('button');
    button.type = 'button';
    button.addEventListener('click', () => onSelect(id));
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    links.appendChild(line);
    layer.appendChild(button);
    found = { button, line };
    rows.set(id, found);
    return found;
  }
  return {
    update(labels: BendLabel[], camera: THREE.Camera) {
      const width = host.clientWidth, height = host.clientHeight;
      const seen = new Set<number>();
      const shown = labels.flatMap(label => {
        const p = label.anchor.clone().project(camera);
        const x = (p.x + 1) * width / 2, y = (1 - p.y) * height / 2;
        return p.z < 1 && p.z > -1 && x >= 0 && x <= width && y >= 0 && y <= height ? [{ label, x, y }] : [];
      });
      const middle = shown.reduce((sum, item) => sum + item.x, 0) / (shown.length || 1);
      const items = shown.map(item => {
        const elements = row(item.label.id);
        const button = elements.button;
        if (button.textContent !== item.label.text) button.textContent = item.label.text;
        button.title = item.label.title;
        button.setAttribute('aria-pressed', String(item.label.selected));
        button.dataset.changed = String(item.label.changed);
        button.hidden = false;
        const w = button.offsetWidth || 70, h = button.offsetHeight || 20;
        // Names sit outward from the model, so they cover as little of it as possible.
        const x = Math.max(0, Math.min(width - w, item.x < middle ? item.x - 28 - w : item.x + 28));
        return { ...item, elements, box: { x, y: item.y - h / 2, width: w, height: h } };
      });
      const boxes = spreadLabels(items.map(item => item.box), height);
      items.forEach((item, i) => {
        seen.add(item.label.id);
        const { button, line } = item.elements;
        const box = boxes[i];
        button.style.transform = `translate(${box.x}px,${box.y}px)`;
        line.style.display = '';
        line.setAttribute('x1', String(item.x));
        line.setAttribute('y1', String(item.y));
        line.setAttribute('x2', String(box.x < item.x ? box.x + box.width : box.x));
        line.setAttribute('y2', String(box.y + box.height / 2));
        line.setAttribute('data-selected', String(item.label.selected));
      });
      for (const [id, { button, line }] of rows) if (!seen.has(id)) { button.hidden = true; line.style.display = 'none'; }
    },
    dispose() { layer.remove(); rows.clear(); },
  };
}
