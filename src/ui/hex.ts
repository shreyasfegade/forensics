// Structure-aware hex viewer. Rows are rendered only for the visible window
// and bytes are fetched on demand with Blob.slice, so a multi-gigabyte file
// costs the same as a small one. A custom scrollbar maps the thumb to a row
// index, which avoids the browser's maximum element height on huge files.
import type { Range, StructNode } from '../core/types';
import { h, clear } from './dom';
import { hexOff, rangeLabel } from './format';

const ROW = 16;
const PAGE = 64 * 1024;
const ROW_PX = 20;

class PageCache {
  private pages = new Map<number, Uint8Array>();
  private inflight = new Map<number, Promise<Uint8Array>>();
  constructor(private readonly blob: Blob, private readonly max = 48) {}
  peek(page: number): Uint8Array | undefined {
    const p = this.pages.get(page);
    if (p) { this.pages.delete(page); this.pages.set(page, p); }
    return p;
  }
  load(page: number): Promise<Uint8Array> {
    const hit = this.peek(page);
    if (hit) return Promise.resolve(hit);
    let pr = this.inflight.get(page);
    if (!pr) {
      pr = this.blob.slice(page * PAGE, (page + 1) * PAGE).arrayBuffer().then(b => {
        const u = new Uint8Array(b);
        this.pages.set(page, u);
        this.inflight.delete(page);
        while (this.pages.size > this.max) this.pages.delete(this.pages.keys().next().value!);
        return u;
      });
      this.inflight.set(page, pr);
    }
    return pr;
  }
  byte(off: number): number | undefined {
    return this.peek(Math.floor(off / PAGE))?.[off % PAGE];
  }
}

interface Flat { node: StructNode; depth: number }

function flatten(nodes: StructNode[], depth = 0, out: Flat[] = []): Flat[] {
  for (const n of nodes) {
    out.push({ node: n, depth });
    if (n.children) flatten(n.children, depth + 1, out);
  }
  return out;
}

export interface HexView {
  el: HTMLElement;
  reveal(range: Range, label?: string): void;
}

export function hexView(file: Blob, structure: StructNode[]): HexView {
  const cache = new PageCache(file);
  const totalRows = Math.max(1, Math.ceil(file.size / ROW));
  const flat = flatten(structure);
  let top = 0;
  let visible = 24;
  let cursor = 0;
  let sel: Range | null = null;
  let selLabel = '';

  const rowsEl = h('div', { class: 'hex-rows', role: 'grid', 'aria-label': 'Hex view of the file', tabindex: 0 });
  const thumb = h('div', { class: 'hex-thumb' });
  const track = h('div', { class: 'hex-track', 'aria-hidden': 'true' }, thumb);
  const inspector = h('div', { class: 'hex-inspector', 'aria-live': 'polite' });
  const gotoInput = h('input', { class: 'hex-goto', type: 'text', placeholder: 'Go to offset (e.g. 0x1F40)', 'aria-label': 'Go to offset', spellcheck: false });
  const status = h('span', { class: 'hex-status' });
  const tree = h('div', { class: 'hex-tree', role: 'tree', 'aria-label': 'File structure' });

  // ---- structure tree
  const nodeButtons = new Map<StructNode, HTMLElement>();
  const buildTree = (nodes: StructNode[], parent: HTMLElement, depth: number) => {
    for (const n of nodes) {
      const btn = h('button', { class: 'tree-node', type: 'button', role: 'treeitem', title: `${n.label} · ${rangeLabel(n.range)} · ${n.range.length.toLocaleString()} B`, onclick: () => reveal(n.range, n.label) },
        h('span', { class: 'tree-label' }, n.label),
        n.note ? h('span', { class: 'tree-note' }, n.note) : null,
        h('span', { class: 'tree-range' }, hexOff(n.range.offset)));
      nodeButtons.set(n, btn);
      if (n.children?.length) {
        const kids = h('div', { class: 'tree-children', role: 'group' });
        const det = h('details', { class: 'tree-branch', open: depth < 1 && n.children.length < 40 }, h('summary', null, btn), kids);
        buildTree(n.children, kids, depth + 1);
        parent.append(det);
      } else parent.append(btn);
    }
  };
  if (structure.length) buildTree(structure, tree, 0);
  else tree.append(h('p', { class: 'muted small' }, 'No structure map for this format. The bytes are still browsable.'));

  const nodeAt = (off: number): StructNode | null => {
    let best: Flat | null = null;
    for (const f of flat) {
      const r = f.node.range;
      if (off >= r.offset && off < r.offset + r.length && (!best || f.depth >= best.depth)) best = f;
    }
    return best?.node ?? null;
  };

  // ---- rendering
  const render = () => {
    const first = top * ROW;
    const last = Math.min(file.size, (top + visible) * ROW);
    const pages = new Set<number>();
    for (let p = Math.floor(first / PAGE); p <= Math.floor(Math.max(first, last - 1) / PAGE); p++) pages.add(p);
    const missing = [...pages].filter(p => !cache.peek(p));
    if (missing.length) Promise.all(missing.map(p => cache.load(p))).then(render);
    clear(rowsEl);
    for (let r = top; r < Math.min(totalRows, top + visible); r++) {
      const base = r * ROW;
      const hexCells: HTMLElement[] = [], ascii: HTMLElement[] = [];
      for (let i = 0; i < ROW; i++) {
        const off = base + i;
        if (off >= file.size) { hexCells.push(h('span', { class: 'hb empty' }, '  ')); ascii.push(h('span', { class: 'ha empty' }, ' ')); continue; }
        const b = cache.byte(off);
        const cls = b === undefined ? 'pending' : b === 0 ? 'b-null' : b >= 0x20 && b < 0x7f ? 'b-ascii' : b < 0x20 || b === 0x7f ? 'b-ctrl' : 'b-high';
        const inSel = sel && off >= sel.offset && off < sel.offset + sel.length;
        const extra = `${inSel ? ' sel' : ''}${off === cursor ? ' cur' : ''}`;
        hexCells.push(h('span', { class: `hb ${cls}${extra}`, dataset: { o: String(off) } }, b === undefined ? '··' : b.toString(16).toUpperCase().padStart(2, '0')));
        ascii.push(h('span', { class: `ha ${cls}${extra}`, dataset: { o: String(off) } }, b === undefined ? ' ' : b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·'));
      }
      rowsEl.append(h('div', { class: 'hex-row', role: 'row' },
        h('span', { class: 'ho' }, base.toString(16).toUpperCase().padStart(8, '0')),
        h('span', { class: 'hx' }, hexCells.slice(0, 8), h('span', { class: 'hgap' }), hexCells.slice(8)),
        h('span', { class: 'hs' }, ascii)));
    }
    const ratio = totalRows <= visible ? 0 : top / (totalRows - visible);
    const th = Math.max(24, (visible / totalRows) * track.clientHeight);
    thumb.style.height = `${Math.min(track.clientHeight, th)}px`;
    thumb.style.transform = `translateY(${ratio * Math.max(0, track.clientHeight - th)}px)`;
    status.textContent = `${hexOff(top * ROW)} / ${hexOff(Math.max(0, file.size - 1))}${sel ? ` · selected ${selLabel ? selLabel + ' ' : ''}${rangeLabel(sel)} (${sel.length.toLocaleString()} B)` : ''}`;
    inspect();
  };

  const inspect = () => {
    clear(inspector);
    const bytes: number[] = [];
    for (let i = 0; i < 8; i++) { const b = cache.byte(cursor + i); if (b === undefined) break; bytes.push(b); }
    if (!bytes.length) return;
    const dv = new DataView(new Uint8Array([...bytes, 0, 0, 0, 0, 0, 0, 0, 0]).buffer);
    const node = nodeAt(cursor);
    const row = (k: string, v: string) => h('div', { class: 'insp-row' }, h('span', { class: 'insp-k' }, k), h('span', { class: 'insp-v' }, v));
    inspector.append(
      row('Offset', `${hexOff(cursor)} (${cursor.toLocaleString()})`),
      row('In', node ? node.label : 'outside mapped structure'),
      row('u8 / i8', `${dv.getUint8(0)} / ${dv.getInt8(0)}`),
      row('Binary', dv.getUint8(0).toString(2).padStart(8, '0')),
      ...(bytes.length >= 2 ? [row('u16 LE / BE', `${dv.getUint16(0, true)} / ${dv.getUint16(0, false)}`)] : []),
      ...(bytes.length >= 4 ? [row('u32 LE / BE', `${dv.getUint32(0, true)} / ${dv.getUint32(0, false)}`), row('f32 LE', String(dv.getFloat32(0, true).toPrecision(7))), row('Unix time (LE)', unixTime(dv.getUint32(0, true)))] : []),
    );
  };

  const scrollTo = (row: number) => {
    top = Math.max(0, Math.min(totalRows - Math.min(visible, totalRows), Math.floor(row)));
    render();
  };

  function reveal(range: Range, label = '') {
    sel = { offset: range.offset, length: Math.max(1, range.length) };
    selLabel = label;
    cursor = range.offset;
    const row = Math.floor(range.offset / ROW);
    scrollTo(row - Math.min(4, Math.floor(visible / 4)));
    for (const [n, b] of nodeButtons) b.classList.toggle('active', n.range.offset === range.offset && n.range.length === range.length);
    rowsEl.classList.remove('pulse');
    void rowsEl.offsetWidth;
    rowsEl.classList.add('pulse');
  }

  // ---- input
  rowsEl.addEventListener('wheel', e => { e.preventDefault(); scrollTo(top + Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / ROW_PX))); }, { passive: false });
  rowsEl.addEventListener('click', e => {
    const o = (e.target as HTMLElement).dataset?.o;
    if (!o) return;
    const off = Number(o);
    if (e.shiftKey && sel) { const a = Math.min(cursor, off), b = Math.max(cursor, off); sel = { offset: a, length: b - a + 1 }; selLabel = ''; }
    else { cursor = off; sel = null; }
    render();
  });
  rowsEl.addEventListener('keydown', e => {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: ROW, ArrowUp: -ROW, PageDown: ROW * visible, PageUp: -ROW * visible };
    if (e.key in moves) {
      e.preventDefault();
      cursor = Math.max(0, Math.min(file.size - 1, cursor + moves[e.key]));
      const r = Math.floor(cursor / ROW);
      if (r < top) top = r; else if (r >= top + visible) top = r - visible + 1;
      render();
    } else if (e.key === 'Home') { e.preventDefault(); cursor = 0; scrollTo(0); }
    else if (e.key === 'End') { e.preventDefault(); cursor = file.size - 1; scrollTo(totalRows); }
    else if (e.key === 'g') { e.preventDefault(); gotoInput.focus(); }
  });
  gotoInput.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const v = gotoInput.value.trim();
    const n = /^0x/i.test(v) ? parseInt(v, 16) : /^[0-9a-f]+h$/i.test(v) ? parseInt(v, 16) : parseInt(v, 10);
    if (Number.isFinite(n) && n >= 0 && n < file.size) { reveal({ offset: n, length: 1 }); rowsEl.focus(); gotoInput.classList.remove('bad'); }
    else gotoInput.classList.add('bad');
  });
  let drag: { y: number; top: number } | null = null;
  thumb.addEventListener('pointerdown', e => { drag = { y: e.clientY, top }; thumb.setPointerCapture(e.pointerId); });
  thumb.addEventListener('pointermove', e => {
    if (!drag) return;
    const usable = track.clientHeight - thumb.clientHeight;
    if (usable > 0) scrollTo(drag.top + ((e.clientY - drag.y) / usable) * (totalRows - visible));
  });
  thumb.addEventListener('pointerup', () => { drag = null; });
  track.addEventListener('pointerdown', e => {
    if (e.target !== track) return;
    const rect = track.getBoundingClientRect();
    scrollTo(((e.clientY - rect.top) / rect.height) * (totalRows - visible));
  });

  const pane = h('div', { class: 'hex-pane' }, rowsEl, track);
  const el = h('div', { class: 'hex' },
    h('div', { class: 'hex-side' }, h('div', { class: 'label' }, 'Structure'), tree),
    h('div', { class: 'hex-main' },
      h('div', { class: 'hex-bar' }, gotoInput, status),
      pane,
      h('div', { class: 'hex-legend' }, legend('b-null', 'NUL'), legend('b-ascii', 'printable'), legend('b-ctrl', 'control'), legend('b-high', '≥ 0x80'))),
    h('div', { class: 'hex-insp-wrap' }, h('div', { class: 'label' }, 'Inspector'), inspector));

  const resize = () => {
    const v = Math.max(8, Math.floor(rowsEl.clientHeight / ROW_PX));
    if (v !== visible) { visible = v; render(); }
  };
  new ResizeObserver(resize).observe(rowsEl);
  cache.load(0).then(() => render());
  return { el, reveal };
}

function legend(cls: string, text: string): HTMLElement {
  return h('span', { class: 'lg' }, h('span', { class: `lg-sw ${cls}` }), text);
}

function unixTime(v: number): string {
  if (v < 315532800 || v > 4102444800) return '—';
  return new Date(v * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}
