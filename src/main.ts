// App shell: header, view switching, global drag-and-drop, preferences.
import type { Report } from './core/types';
import { WorkerClient } from './ui/client';
import { h, clear } from './ui/dom';
import { applyPrefs, loadPrefs, savePrefs } from './ui/prefs';
import { intakeView, progressView, errorView, SAMPLES } from './ui/intake';
import { caseView } from './ui/case';
import { batchView, filesFromDrop } from './ui/batch';
import { stamp } from './ui/sound';

const prefs = loadPrefs();
applyPrefs(prefs);

let client = new WorkerClient();
let busy = false;
const app = document.getElementById('app')!;

function show(view: HTMLElement): void {
  clear(app);
  app.append(view);
  window.scrollTo(0, 0);
}

function home(): void {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  show(intakeView({ onFiles: handleFiles, onSample: openSample }));
  document.title = 'Forensics: a privacy X-ray for every file';
}

async function openCase(file: Blob, name: string, lastModified?: number, back?: () => void): Promise<void> {
  if (busy) return;
  busy = true;
  const prog = progressView(name, file.size);
  show(prog.el);
  try {
    const report = await client.analyze(file, name, prog.update, lastModified);
    present(file, report, back);
  } catch (e) {
    // A crashed worker can't be reused.
    client.terminate();
    client = new WorkerClient();
    show(errorView(name, (e as Error).message, home));
  } finally {
    busy = false;
  }
}

function present(file: Blob, report: Report, back?: () => void): void {
  const view = caseView({ report, file, client, onNew: home });
  if (back) view.prepend(h('button', { class: 'btn btn-quiet back', type: 'button', onclick: back }, '← Back to batch'));
  show(view);
  document.title = `Case ${report.caseId}: ${report.file.name} · Forensics`;
  stamp(prefs.sound, report.verdict.level === 'exposed');
}

async function openSample(name: string): Promise<void> {
  if (busy) return;
  history.replaceState(null, '', `#sample=${encodeURIComponent(name)}`);
  try {
    const res = await fetch(`samples/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await openCase(await res.blob(), name);
  } catch (e) {
    show(errorView(name, `The sample could not be loaded (${(e as Error).message}).`, home));
  }
}

function handleFiles(files: File[]): void {
  if (busy || !files.length) return;
  if (files.length === 1) { void openCase(files[0], files[0].name, files[0].lastModified); return; }
  show(batchView(files, (file, report, back) => present(file, report, back), home));
  document.title = `Batch of ${files.length} · Forensics`;
}

// ---------------- header
function toggle(label: string, options: [string, string][], current: () => string, set: (v: string) => void): HTMLElement {
  const group = h('div', { class: 'seg-group', role: 'radiogroup', 'aria-label': label });
  const paint = () => [...group.children].forEach(b => { const on = (b as HTMLElement).dataset.v === current(); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
  for (const [v, text] of options) group.append(h('button', { class: 'seg', type: 'button', role: 'radio', dataset: { v }, onclick: () => { set(v); paint(); } }, text));
  paint();
  return group;
}

const soundBtn = h('button', { class: 'seg', type: 'button', 'aria-pressed': String(prefs.sound), onclick: () => {
  prefs.sound = !prefs.sound;
  savePrefs(prefs);
  soundBtn.textContent = prefs.sound ? 'Sound on' : 'Sound off';
  soundBtn.setAttribute('aria-pressed', String(prefs.sound));
  stamp(prefs.sound, false);
} }, prefs.sound ? 'Sound on' : 'Sound off');

document.getElementById('masthead')!.append(
  h('a', { class: 'brand', href: './', onclick: (e: Event) => { e.preventDefault(); if (!busy) home(); } }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }), 'Forensics'),
  h('div', { class: 'settings' },
    toggle('Theme', [['paper', 'Paper'], ['lab', 'Lab']], () => prefs.theme, v => { prefs.theme = v as typeof prefs.theme; applyPrefs(prefs); savePrefs(prefs); }),
    toggle('Detail level', [['plain', 'Plain'], ['technical', 'Technical']], () => prefs.mode, v => { prefs.mode = v as typeof prefs.mode; applyPrefs(prefs); savePrefs(prefs); }),
    h('div', { class: 'seg-group' }, soundBtn)));

// ---------------- global drag and drop
let depth = 0;
document.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { depth++; document.body.classList.add('dragging'); } });
document.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', async e => {
  e.preventDefault();
  depth = 0;
  document.body.classList.remove('dragging');
  if (!e.dataTransfer || busy) return;
  handleFiles(await filesFromDrop(e.dataTransfer));
});

// ---------------- start
const deep = /^#sample=(.+)$/.exec(location.hash);
const sample = deep ? decodeURIComponent(deep[1]) : null;
if (sample && SAMPLES.some(s => s.file === sample)) void openSample(sample);
else home();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
