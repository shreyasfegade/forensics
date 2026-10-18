// Intake: the landing screen, the evidence-sample ledger, and the
// in-progress and failure states.
import type { Progress } from '../core/analyze';
import { h, clear } from './dom';
import { formatSize } from './format';

export const SAMPLES = [
  { file: 'harbor_cropped.jpg', title: 'Cropped photo', hides: 'Its EXIF preview still shows the street sign that was cropped out.' },
  { file: 'paris_holiday.jpg', title: 'Holiday photo', hides: 'GPS position to a few metres, phone model, capture time and time zone.' },
  { file: 'IMG_4127.MOV', title: 'Phone video', hides: 'Recording location in Apple metadata keys and a ©xyz atom. Metadata only, no frames.' },
  { file: 'offer_letter_final.docx', title: 'Final offer letter', hides: 'Tracked deletions with the real salary band, a reviewer\'s comment, two authors.' },
  { file: 'invoice_receipt.txt', title: 'Invoice receipt', hides: 'Actually a Windows program, with the developer\'s username in its debug path.' },
  { file: 'mountains.png', title: 'Mountain landscape', hides: 'A message written into the least-significant bits of its pixels.' },
  { file: 'contract_v3.pdf', title: 'Signed contract', hides: 'An earlier saved version with different terms, and an invisible text line.' },
  { file: 'cat_meme.jpg', title: 'Cat meme', hides: 'A note with a password, appended after the image ends.' },
  { file: 'vacation_safe.png', title: 'Clean landscape', hides: 'Nothing. This is the control sample.' },
];

export interface IntakeHandlers {
  onFiles: (files: File[]) => void;
  onSample: (name: string) => void;
}

export function intakeView({ onFiles, onSample }: IntakeHandlers): HTMLElement {
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { if (fileInput.files?.length) onFiles([...fileInput.files]); fileInput.value = ''; } });
  const dirInput = h('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: true, onchange: () => { if (dirInput.files?.length) onFiles([...dirInput.files]); dirInput.value = ''; } });
  const tray = h('div', { class: 'tray', tabindex: 0, role: 'button', 'aria-label': 'Choose a file to examine, or drop files and folders here', onclick: () => fileInput.click(), onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } } },
    h('div', { class: 'tray-label' }, 'Intake'),
    h('p', { class: 'tray-main' }, 'Drop a file here to open a case.'),
    h('p', { class: 'tray-sub' }, 'Photos, videos, PDFs, Office documents, archives, executables. Drop several files or a folder to examine them as a batch.'),
    h('div', { class: 'tray-buttons' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: (e: Event) => { e.stopPropagation(); fileInput.click(); } }, 'Choose file'),
      h('button', { class: 'btn', type: 'button', onclick: (e: Event) => { e.stopPropagation(); dirInput.click(); } }, 'Choose folder')),
    fileInput, dirInput);

  const ledger = h('table', { class: 'ledger' },
    h('caption', null, 'Evidence samples'),
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'No.'), h('th', { scope: 'col' }, 'Sample'), h('th', { scope: 'col' }, 'What it gives away'), h('th', { scope: 'col', class: 'col-file' }, 'File'))),
    h('tbody', null, SAMPLES.map((s, i) => h('tr', { tabindex: 0, role: 'button', 'aria-label': `Open sample: ${s.title}`, onclick: () => onSample(s.file), onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSample(s.file); } } },
      h('td', { class: 'mono' }, String(i + 1).padStart(2, '0')),
      h('td', { class: 'ledger-title' }, s.title),
      h('td', null, s.hides),
      h('td', { class: 'mono col-file' }, s.file)))));

  return h('div', { class: 'intake' },
    h('section', { class: 'intake-hero' },
      h('h1', null, 'A privacy X-ray for every file, and the fix.'),
      h('p', { class: 'lede' }, 'Forensics opens a case on any file: where it was made, who touched it, what it still remembers, and what is hidden inside. Then it strips the leaks without re-encoding a single pixel.'),
      h('p', { class: 'assurance' }, 'Files are read by a background worker in this browser. Nothing is uploaded, and there is no server to upload to.')),
    tray,
    h('section', { class: 'samples' }, ledger, h('p', { class: 'small muted' }, 'All samples are synthetic. The people, places and numbers in them are invented.')),
    h('section', { class: 'coverage' },
      h('h2', null, 'What it reads'),
      h('dl', { class: 'coverage-list' },
        cov('Images', 'JPEG, PNG, HEIC/HEIF, WebP, TIFF and DNG, BMP. EXIF, GPS, XMP, IPTC, embedded thumbnails, text chunks, quantisation tables. LSB steganalysis on PNG and BMP; error level analysis on JPEG.'),
        cov('Video and audio', 'MP4, MOV and 3GP location atoms, Apple and Android metadata keys, recording time. MP3 ID3 tags. WAV and AVI INFO tags.'),
        cov('Documents', 'PDF properties, saved revisions, XMP, scripts and actions, invisible text. DOCX, XLSX and PPTX authors, comments, tracked changes, speaker notes, hidden sheets.'),
        cov('Everything else', 'True type from magic bytes, SHA-256, byte-plot, entropy map, strings. ZIP listings and Windows executables (build time, debug paths, signature presence).'))));
}

function cov(k: string, v: string): HTMLElement[] {
  return [h('dt', null, k), h('dd', null, v)];
}

const STAGES = ['Reading header', 'Hashing and measuring entropy', 'Parsing structure', 'Running LSB steganalysis'];

export function progressView(name: string, size: number): { el: HTMLElement; update: (p: Progress) => void } {
  const items = STAGES.map(s => h('li', { class: 'stage' }, h('span', { class: 'stage-mark', 'aria-hidden': 'true' }), h('span', { class: 'stage-name' }, s), h('span', { class: 'stage-pct mono' })));
  const barFill = h('div', { class: 'progress-fill' });
  const el = h('div', { class: 'working', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'case-tab' }, 'Intake in progress'),
    h('h1', { class: 'case-file' }, name),
    h('p', { class: 'muted mono small' }, `${formatSize(size)} · reading locally`),
    h('div', { class: 'progress' }, barFill),
    h('ol', { class: 'stages' }, items));
  let current = -1;
  const update = (p: Progress) => {
    const idx = STAGES.indexOf(p.stage);
    if (idx < 0) return;
    if (idx !== current) {
      items.forEach((li, i) => { li.classList.toggle('done', i < idx); li.classList.toggle('active', i === idx); });
      current = idx;
    }
    const frac = p.total ? p.done / p.total : 0;
    if (p.stage === STAGES[1]) {
      items[1].querySelector('.stage-pct')!.textContent = `${Math.round(frac * 100)}%`;
      barFill.style.width = `${10 + frac * 75}%`;
    } else barFill.style.width = `${[5, 0, 90, 96][idx]}%`;
  };
  return { el, update };
}

export function errorView(name: string, message: string, onBack: () => void): HTMLElement {
  return h('div', { class: 'working failed', role: 'alert' },
    h('div', { class: 'case-tab' }, 'Intake failed'),
    h('h1', { class: 'case-file' }, name),
    h('p', { class: 'lede' }, 'This file could not be examined.'),
    h('p', { class: 'mono small' }, message),
    h('p', { class: 'small muted' }, 'The file may be unreadable (for example, a cloud placeholder that isn\'t downloaded), or the browser ran out of memory. Nothing was uploaded.'),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: onBack }, 'Back to intake'));
}

export function clearTo(el: HTMLElement, view: HTMLElement): void {
  clear(el);
  el.append(view);
}
