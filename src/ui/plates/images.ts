// Image evidence plates: thumbnail vs photo, bit-planes, error level analysis.
import type { Report } from '../../core/types';
import type { WorkerClient } from '../client';
import { h, clear } from '../dom';

function toCanvas(width: number, height: number, pixels: Uint8ClampedArray, cls = ''): HTMLCanvasElement {
  const c = h('canvas', { class: cls, width, height });
  c.getContext('2d')!.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  return c;
}

export function thumbnailPlate(report: Report, file: Blob, client: WorkerClient): HTMLElement {
  const t = report.thumbnail!;
  const cmp = t.comparison;
  const left = h('div', { class: 'cmp-cell' }, h('div', { class: 'skeleton' }));
  const url = URL.createObjectURL(file.slice(0, file.size, report.trueType.mime));
  const right = h('div', { class: 'cmp-cell' }, h('img', { src: url, alt: 'The photo as delivered', loading: 'lazy' }));
  client.image('thumbnail', { file, offset: t.range.offset, length: t.range.length })
    .then(r => { clear(left); left.append(toCanvas(r.width, r.height, r.pixels)); })
    .catch(() => { clear(left); left.append(h('p', { class: 'muted small' }, 'The embedded preview could not be decoded.')); });
  return h('figure', { class: `plate plate-compare${cmp?.mismatch ? ' plate-alert' : ''}` },
    h('div', { class: 'cmp' },
      h('div', null, left, h('div', { class: 'cmp-cap' }, `Embedded preview · ${t.width ?? '?'}×${t.height ?? '?'}`)),
      h('div', null, right, h('div', { class: 'cmp-cap' }, `Photo as delivered · ${report.image?.width ?? '?'}×${report.image?.height ?? '?'}`))),
    h('figcaption', null,
      h('span', { class: 'plate-title' }, cmp?.mismatch ? 'The preview shows a different picture' : 'Embedded preview'),
      cmp ? ` Aspect ratio ${cmp.thumbAspect.toFixed(2)} vs ${cmp.mainAspect.toFixed(2)} (${(cmp.aspectDelta * 100).toFixed(0)}% apart), difference-hash distance ${cmp.hashDistance}/64. ${cmp.mismatch ? 'Cropping or edits after capture didn\'t update the preview, so the preview still shows what was removed.' : 'They match.'}` : ' Comparison unavailable in this browser.'));
}

export function stegoPlate(report: Report, file: Blob, client: WorkerClient): HTMLElement {
  const s = report.stego!;
  const view = h('div', { class: 'plane-view' }, h('div', { class: 'skeleton' }));
  let channel = 0, bit = 0;
  const load = () => {
    clear(view);
    view.append(h('div', { class: 'skeleton' }));
    client.image('bitplane', { file, channel, bit })
      .then(r => { clear(view); view.append(toCanvas(r.width, r.height, r.pixels, 'pixelated')); })
      .catch(e => { clear(view); view.append(h('p', { class: 'muted small' }, (e as Error).message)); });
  };
  const chBtns = ['Red', 'Green', 'Blue'].map((n, i) => h('button', { class: `seg${i === 0 ? ' on' : ''}`, type: 'button', onclick: (e: Event) => { channel = i; setOn(chBtns, e.currentTarget as HTMLElement); load(); } }, n));
  const bitBtns = Array.from({ length: 8 }, (_, i) => h('button', { class: `seg${i === 0 ? ' on' : ''}`, type: 'button', title: i === 0 ? 'Least significant bit' : `Bit ${i}`, onclick: (e: Event) => { bit = i; setOn(bitBtns, e.currentTarget as HTMLElement); load(); } }, String(i)));
  if (s.channels.length) load(); else { clear(view); view.append(h('p', { class: 'muted small' }, s.summary)); }
  const spark = sparkline(s.curve);
  return h('figure', { class: `plate${s.verdict !== 'clean' ? ' plate-alert' : ''}` },
    h('div', { class: 'plane-controls' },
      h('div', { class: 'seg-group', role: 'group', 'aria-label': 'Colour channel' }, chBtns),
      h('div', { class: 'seg-group', role: 'group', 'aria-label': 'Bit plane' }, bitBtns)),
    h('div', { class: 'plate-media' }, view),
    h('figcaption', null,
      h('span', { class: 'plate-title' }, 'Bit-plane viewer and LSB steganalysis'),
      ` ${s.summary}`,
      s.channels.length ? h('table', { class: 'mini-table' },
        h('thead', null, h('tr', null, h('th', null, 'Channel'), h('th', null, 'Chi-square p'), h('th', null, 'RS estimate'))),
        h('tbody', null, s.channels.map(c => h('tr', null, h('td', null, c.channel), h('td', { class: 'mono' }, c.chiSquareP.toFixed(3)), h('td', { class: 'mono' }, `${(c.rsEstimate * 100).toFixed(1)}%`))))) : null,
      s.curve.length ? h('div', { class: 'spark-wrap' }, h('span', { class: 'small muted' }, 'Chi-square p over the pixel stream (start → end)'), spark) : null,
      h('p', { class: 'small muted' }, 'Bit 0 of a natural photo looks like noise. Embedded data often shows up as a flatter, uniform band at the top of the image, where sequential embedding starts.')));
}

function setOn(group: HTMLElement[], on: HTMLElement): void {
  group.forEach(b => b.classList.toggle('on', b === on));
}

function sparkline(values: number[]): SVGSVGElement {
  const w = 220, hh = 36;
  const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgEl.setAttribute('viewBox', `0 0 ${w} ${hh}`);
  svgEl.setAttribute('class', 'spark');
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${hh - 2 - v * (hh - 4)}`).join(' ');
  const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  pl.setAttribute('points', pts);
  svgEl.appendChild(pl);
  return svgEl;
}

export function elaPlate(report: Report, file: Blob, client: WorkerClient): HTMLElement {
  const view = h('div', { class: 'plane-view' }, h('p', { class: 'small muted' }, 'Not run yet. It decodes and re-encodes the photo in this browser.'));
  const q = report.quant;
  const btn = h('button', { class: 'btn', type: 'button', onclick: () => {
    btn.disabled = true;
    clear(view);
    view.append(h('div', { class: 'skeleton' }));
    client.image('ela', { file, quality: 0.9 })
      .then(r => {
        clear(view);
        view.append(toCanvas(r.width, r.height, r.pixels));
        note.textContent = `Re-saved at quality 90. Mean error ${(r.meta?.meanError as number).toFixed(2)}, max ${(r.meta?.maxError as number).toFixed(0)}.${r.meta?.downscaled ? ' The image was downscaled to fit memory, which weakens ELA.' : ''}`;
      })
      .catch(e => { clear(view); view.append(h('p', { class: 'muted small' }, `ELA isn't available here: ${(e as Error).message}`)); })
      .finally(() => { btn.disabled = false; });
  } }, 'Run error level analysis');
  const note = h('p', { class: 'small muted' });
  return h('figure', { class: 'plate' },
    h('div', { class: 'plane-controls' }, btn),
    h('div', { class: 'plate-media' }, view),
    h('figcaption', null,
      h('span', { class: 'plate-title' }, 'Tampering checks'),
      q ? ` Compression fingerprint: ${q.match}` : '',
      ' Error level analysis re-saves the JPEG and maps how much each area changes. Regions pasted in or edited after the last save often stand out, but so do edges, text and smooth gradients. Treat it as a pointer, not a verdict.',
      note));
}
