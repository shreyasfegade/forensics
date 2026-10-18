// Byte-plot (Hilbert curve) and entropy-across-offsets plates.
import type { Report, StructNode } from '../../core/types';
import { d2xy, xy2d } from '../../analysis/hilbert';
import { h } from '../dom';
import { hexOff } from '../format';

function cssColor(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

function rgb(c: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (m) { const v = parseInt(m[1], 16); return [v >> 16, (v >> 8) & 255, v & 255]; }
  const r = /rgba?\((\d+)\D+(\d+)\D+(\d+)/.exec(c);
  return r ? [+r[1], +r[2], +r[3]] : [128, 128, 128];
}

function topNodeAt(structure: StructNode[], off: number): StructNode | null {
  let found: StructNode | null = null;
  const walk = (nodes: StructNode[]) => {
    for (const n of nodes) {
      if (off >= n.range.offset && off < n.range.offset + n.range.length) { found = n; if (n.children) walk(n.children); return; }
    }
  };
  walk(structure);
  return found;
}

export function bytePlot(report: Report, onPick: (offset: number) => void): HTMLElement {
  const bp = report.byteplot;
  const side = 2 ** bp.order;
  const canvas = h('canvas', { class: 'byteplot', width: side, height: side, tabindex: 0, role: 'img', 'aria-label': 'Byte-plot of the whole file along a Hilbert curve' });
  const tip = h('div', { class: 'plate-tip' }, 'Hover to see the offset. Click to open those bytes.');
  const paint = () => {
    const g = canvas.getContext('2d')!;
    const img = g.createImageData(side, side);
    const pal = [
      rgb(cssColor(canvas, '--bp-null', '#1b1b1b')),
      rgb(cssColor(canvas, '--bp-ascii', '#3e6fb0')),
      rgb(cssColor(canvas, '--bp-ctrl', '#c48a1c')),
      rgb(cssColor(canvas, '--bp-high', '#b3261e')),
      rgb(cssColor(canvas, '--bp-empty', '#e9e4d8')),
    ];
    for (let d = 0; d < side * side; d++) {
      const [x, y] = d2xy(side, d);
      const cls = bp.classes[d];
      const c = pal[cls === 255 ? 4 : cls];
      const p = (y * side + x) * 4;
      img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2]; img.data[p + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  };
  requestAnimationFrame(paint);
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const offsetAt = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * side), y = Math.floor(((e.clientY - r.top) / r.height) * side);
    const d = xy2d(side, Math.max(0, Math.min(side - 1, x)), Math.max(0, Math.min(side - 1, y)));
    return d < bp.cells ? d * bp.bytesPerCell : -1;
  };
  canvas.addEventListener('mousemove', e => {
    const o = offsetAt(e);
    if (o < 0) { tip.textContent = 'Past the end of the file'; return; }
    const n = topNodeAt(report.structure, o);
    tip.textContent = `${hexOff(o)}${n ? ` · ${n.label}` : ''}`;
  });
  canvas.addEventListener('click', e => { const o = offsetAt(e); if (o >= 0) onPick(o); });
  return h('figure', { class: 'plate' },
    h('div', { class: 'plate-media plate-square' }, canvas),
    h('figcaption', null,
      h('span', { class: 'plate-title' }, 'Byte-plot'),
      ` The whole file folded onto a Hilbert curve, ${bp.bytesPerCell.toLocaleString()} byte${bp.bytesPerCell > 1 ? 's' : ''} per cell. Neighbouring offsets stay neighbours, so text, padding and compressed or encrypted regions show up as solid patches.`,
      h('span', { class: 'bp-legend' }, ...[['null', 'NUL'], ['ascii', 'text'], ['ctrl', 'control'], ['high', 'high bytes']].map(([v, t]) => h('span', { class: 'lg' }, h('span', { class: `lg-sw lg-${v}` }), t))),
      tip));
}

export function entropyGraph(report: Report, onPick: (offset: number) => void): HTMLElement {
  const blocks = report.entropy.blocks;
  const W = 640, H = 150, PAD = 22, BAND = 12;
  const canvas = h('canvas', { class: 'entropy-graph', width: W * 2, height: (H + BAND + 6) * 2, role: 'img', 'aria-label': 'Entropy across the file' });
  const tip = h('div', { class: 'plate-tip' }, 'Hover to read the entropy at any offset.');
  const top = report.structure.filter(n => n.range.length > report.file.size / 400).slice(0, 200);
  const paint = () => {
    const g = canvas.getContext('2d')!;
    g.setTransform(2, 0, 0, 2, 0, 0);
    g.clearRect(0, 0, W, H + BAND + 6);
    const ink = cssColor(canvas, '--ink', '#222'), muted = cssColor(canvas, '--rule', '#bbb'), accent = cssColor(canvas, '--stamp', '#b3261e');
    g.strokeStyle = muted; g.lineWidth = 1; g.fillStyle = cssColor(canvas, '--muted', '#777'); g.font = '10px ui-monospace, monospace';
    for (const v of [0, 4, 8]) { const y = H - (v / 8) * (H - PAD) - 4; g.beginPath(); g.moveTo(PAD, y); g.lineTo(W, y); g.stroke(); g.fillText(String(v), 4, y + 3); }
    g.setLineDash([3, 3]); const y75 = H - (7.5 / 8) * (H - PAD) - 4; g.strokeStyle = accent; g.beginPath(); g.moveTo(PAD, y75); g.lineTo(W, y75); g.stroke(); g.setLineDash([]);
    g.strokeStyle = ink; g.lineWidth = 1.25; g.beginPath();
    blocks.forEach((b, i) => { const x = PAD + (i / Math.max(1, blocks.length - 1)) * (W - PAD); const y = H - (b / 8) * (H - PAD) - 4; i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
    // structure band
    const size = report.file.size;
    top.forEach((n, i) => {
      g.fillStyle = i % 2 ? cssColor(canvas, '--band-a', '#cfc6b3') : cssColor(canvas, '--band-b', '#a99f8a');
      if (n.kind === 'trailing') g.fillStyle = accent;
      const x0 = PAD + (n.range.offset / size) * (W - PAD), x1 = PAD + ((n.range.offset + n.range.length) / size) * (W - PAD);
      g.fillRect(x0, H + 4, Math.max(1, x1 - x0), BAND);
    });
  };
  requestAnimationFrame(paint);
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const at = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    const fx = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(blocks.length - 1, Math.round(((fx - PAD) / (W - PAD)) * (blocks.length - 1))));
    return { i, offset: i * report.entropy.blockSize };
  };
  canvas.addEventListener('mousemove', e => {
    const { i, offset } = at(e);
    const n = topNodeAt(report.structure, offset);
    tip.textContent = `${hexOff(offset)} · ${blocks[i].toFixed(2)} bits/byte${n ? ` · ${n.label}` : ''}`;
  });
  canvas.addEventListener('click', e => onPick(at(e).offset));
  return h('figure', { class: 'plate' },
    h('div', { class: 'plate-media' }, canvas),
    h('figcaption', null,
      h('span', { class: 'plate-title' }, 'Entropy across the file'),
      ` ${blocks.length.toLocaleString()} blocks of ${report.entropy.blockSize.toLocaleString()} B. The dashed line marks 7.5 bits/byte; above it, data is compressed or encrypted. The band underneath shows the file's structure${top.some(n => n.kind === 'trailing') ? ', with appended data in red' : ''}.`,
      tip));
}

export function histogram(report: Report): HTMLElement {
  const hist = report.entropy.histogram;
  const max = Math.max(1, ...hist);
  const canvas = h('canvas', { class: 'histogram', width: 512, height: 120, role: 'img', 'aria-label': 'Byte value frequency histogram' });
  requestAnimationFrame(() => {
    const g = canvas.getContext('2d')!;
    g.fillStyle = cssColor(canvas, '--ink', '#222');
    hist.forEach((v, i) => { const bh = (Math.log1p(v) / Math.log1p(max)) * 116; g.fillRect(i * 2, 120 - bh, 1.5, bh); });
  });
  return h('figure', { class: 'plate' }, h('div', { class: 'plate-media' }, canvas),
    h('figcaption', null, h('span', { class: 'plate-title' }, 'Byte value frequency'), ' Counts of each byte value 0x00–0xFF on a log scale. A flat profile means compressed or encrypted data; spikes in 0x20–0x7E mean text.'));
}
