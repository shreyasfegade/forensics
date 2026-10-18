// Batch: examine many files on a worker pool, then clean every supported file
// into one ZIP with a summary.
import type { Report } from '../core/types';
import { WorkerPool } from './client';
import { h, clear, download } from './dom';
import { cleanName, formatSize } from './format';
import { zipParts, type ZipInput } from '../util/zipwriter';

interface Row { file: File; path: string; report?: Report; error?: string; tr: HTMLTableRowElement }

export function batchView(files: File[], onOpen: (file: File, report: Report, back: () => void) => void, onNew: () => void): HTMLElement {
  const pool = new WorkerPool();
  const rows: Row[] = files.map(f => ({ file: f, path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, tr: h('tr') }));
  const tally = h('p', { class: 'tally', 'aria-live': 'polite' });
  const cleanBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Clean all and download ZIP');
  const jsonBtn = h('button', { class: 'btn', type: 'button', disabled: true }, 'Export summary JSON');
  const cleanStatus = h('p', { class: 'small', 'aria-live': 'polite' });
  const tbody = h('tbody');
  let self: HTMLElement;

  const paint = (r: Row) => {
    clear(r.tr);
    const rep = r.report;
    r.tr.append(
      h('td', { class: 'mono batch-path' }, r.path),
      h('td', null, rep ? rep.trueType.name : r.error ? '—' : h('span', { class: 'muted' }, 'queued')),
      h('td', null, rep ? h('span', { class: `stamp-mini stamp-${rep.verdict.level}` }, rep.verdict.title) : r.error ? h('span', { class: 'error-line' }, 'failed') : h('span', { class: 'spinner', 'aria-label': 'examining' })),
      h('td', { class: 'batch-tags' }, rep ? [...new Set(rep.findings.filter(f => f.severity !== 'info').map(f => f.tag))].map(t => h('span', { class: 'tag tag-static' }, t)) : r.error ?? ''),
      h('td', null, rep ? h('button', { class: 'btn btn-small', type: 'button', onclick: () => onOpen(r.file, rep, () => { const host = self.parentElement!; clear(host); host.append(self); }) }, 'Open case') : null));
  };
  rows.forEach(r => { paint(r); tbody.append(r.tr); });

  const update = () => {
    const done = rows.filter(r => r.report || r.error).length;
    const lv = (l: string) => rows.filter(r => r.report?.verdict.level === l).length;
    tally.replaceChildren(
      h('span', null, `${done} of ${rows.length} examined`),
      h('span', { class: 'tally-exposed' }, `${lv('exposed')} exposed`),
      h('span', { class: 'tally-caution' }, `${lv('caution')} identifying`),
      h('span', { class: 'tally-info' }, `${lv('clear')} clean`));
    if (done === rows.length) { cleanBtn.disabled = false; jsonBtn.disabled = false; }
  };
  update();

  // Feed the pool with a bounded number of files in flight.
  let next = 0;
  const pump = async (): Promise<void> => {
    while (next < rows.length) {
      const r = rows[next++];
      try { r.report = await pool.pick().analyze(r.file, r.file.name, undefined, r.file.lastModified); }
      catch (e) { r.error = (e as Error).message; }
      paint(r);
      update();
    }
  };
  for (let i = 0; i < pool.size; i++) void pump();

  const summary = () => rows.map(r => ({
    path: r.path, size: r.file.size, type: r.report?.trueType.name ?? null, sha256: r.report?.hashes.sha256 ?? null,
    verdict: r.report?.verdict.level ?? 'error', findings: r.report?.findings.map(f => ({ severity: f.severity, tag: f.tag, title: f.title })) ?? [], error: r.error ?? null,
  }));

  jsonBtn.onclick = () => download(JSON.stringify({ tool: 'Forensics', generatedAt: new Date().toISOString(), files: summary() }, null, 2), 'forensics-batch.json', 'application/json');

  cleanBtn.onclick = async () => {
    cleanBtn.disabled = true;
    const out: ZipInput[] = [];
    const used = new Set<string>();
    const results: { path: string; status: string }[] = [];
    let i = 0;
    for (const r of rows) {
      i++;
      cleanStatus.textContent = `Cleaning ${i} of ${rows.length}: ${r.path}`;
      const rep = r.report;
      if (!rep) { results.push({ path: r.path, status: `not examined: ${r.error}` }); continue; }
      if (!rep.sanitize.supported) { results.push({ path: r.path, status: `not cleaned: ${rep.sanitize.reason ?? 'unsupported format'}` }); continue; }
      if (!rep.findings.some(f => f.fixable)) { results.push({ path: r.path, status: 'nothing to remove (not included)' }); continue; }
      try {
        const res = await pool.pick().sanitize(r.file, r.file.name);
        let name = `clean/${cleanName(r.path)}`;
        for (let k = 2; used.has(name); k++) name = `clean/${cleanName(r.path).replace(/(\.[^.]+)?$/, `-${k}$1`)}`;
        used.add(name);
        out.push({ name, data: res.data });
        results.push({ path: r.path, status: `cleaned: ${res.actions.length} change(s), now ${res.after.verdict.title.toLowerCase()}` });
      } catch (e) {
        results.push({ path: r.path, status: `cleaning failed: ${(e as Error).message}` });
      }
    }
    const enc = new TextEncoder();
    out.push({ name: 'summary.json', data: enc.encode(JSON.stringify({ tool: 'Forensics', generatedAt: new Date().toISOString(), files: summary(), cleaning: results }, null, 2)) });
    out.push({ name: 'summary.html', data: enc.encode(summaryHtml(rows, results)) });
    download(new Blob(zipParts(out) as BlobPart[], { type: 'application/zip' }), 'forensics-clean.zip');
    cleanStatus.textContent = `${out.length - 2} cleaned file${out.length - 2 === 1 ? '' : 's'} plus summary.json and summary.html. Files that couldn't be cleaned are listed in the summary, not copied.`;
    cleanBtn.disabled = false;
  };

  self = h('div', { class: 'batch' },
    h('div', { class: 'case-tab' }, 'Batch intake'),
    h('h1', { class: 'case-file' }, `${rows.length} files`),
    h('p', { class: 'muted small' }, `${formatSize(files.reduce((a, f) => a + f.size, 0))} total · ${pool.size} worker${pool.size > 1 ? 's' : ''} in parallel`),
    tally,
    h('div', { class: 'case-actions' }, cleanBtn, jsonBtn, h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { pool.terminate(); onNew(); } }, 'New intake')),
    cleanStatus,
    h('div', { class: 'table-wrap' }, h('table', { class: 'batch-table' },
      h('thead', null, h('tr', null, h('th', null, 'File'), h('th', null, 'True type'), h('th', null, 'Verdict'), h('th', null, 'Evidence'), h('th', null, ''))),
      tbody)));
  return self;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function summaryHtml(rows: Row[], results: { path: string; status: string }[]): string {
  const body = rows.map((r, i) => `<tr><td>${esc(r.path)}</td><td>${esc(r.report?.trueType.name ?? '')}</td><td>${esc(r.report?.verdict.title ?? 'error')}</td><td>${esc((r.report?.findings ?? []).filter(f => f.severity !== 'info').map(f => f.title).join('; '))}</td><td>${esc(results[i]?.status ?? '')}</td></tr>`).join('\n');
  return `<!doctype html><meta charset="utf-8"><title>Forensics batch summary</title><style>body{font:14px/1.5 Georgia,serif;margin:2rem;color:#1d1b17;background:#f6f2ea}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #cfc6b3;padding:.4rem .6rem;text-align:left;vertical-align:top}th{font:600 11px/1 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase}td:first-child{font-family:ui-monospace,monospace}</style><h1>Forensics batch summary</h1><p>Generated ${esc(new Date().toISOString())} in the browser. No files were uploaded.</p><table><thead><tr><th>File</th><th>Type</th><th>Verdict</th><th>Findings</th><th>Cleaning</th></tr></thead><tbody>${body}</tbody></table>`;
}

/** Expand dropped folders (DataTransferItem.webkitGetAsEntry) into files. */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const items = [...dt.items].filter(i => i.kind === 'file');
  const entries = items.map(i => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length || entries.every(e => e.isFile)) return [...dt.files];
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (out.length > 5000) return;
    if (entry.isFile) {
      const f = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      Object.defineProperty(f, 'webkitRelativePath', { value: prefix + f.name });
      out.push(f);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out.filter(f => !/(^|\/)\.(DS_Store|git)/.test((f as File & { webkitRelativePath: string }).webkitRelativePath));
}
