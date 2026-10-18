// The fix: lossless sanitizing with a before/after comparison.
import type { Report } from '../core/types';
import type { WorkerClient } from './client';
import { h, clear, download } from './dom';
import { cleanName, formatSize } from './format';

export function cleanSection(report: Report, file: Blob, client: WorkerClient): HTMLElement {
  const plan = report.sanitize;
  const out = h('div', { class: 'clean-result', 'aria-live': 'polite' });
  if (!plan.supported) {
    return h('div', { class: 'clean' }, h('p', { class: 'lede' }, plan.reason ?? 'Cleaning is not available for this file.'));
  }
  const btn = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
    btn.disabled = true;
    btn.textContent = 'Cleaning…';
    clear(out);
    try {
      const r = await client.sanitize(file, report.file.name);
      const before = report.findings.filter(f => f.severity !== 'clear');
      const afterIds = new Set(r.after.findings.map(f => f.id));
      const blob = new Blob([r.data as unknown as BlobPart], { type: report.trueType.mime ?? 'application/octet-stream' });
      out.append(
        h('h3', { class: 'sub' }, 'Before and after'),
        h('table', { class: 'diff' },
          h('thead', null, h('tr', null, h('th', null, 'Finding'), h('th', null, 'Original'), h('th', null, 'Clean copy'))),
          h('tbody', null, before.map(f => {
            const gone = !afterIds.has(f.id);
            return h('tr', { class: gone ? 'gone' : 'kept' }, h('td', null, f.title), h('td', null, 'present'), h('td', null, gone ? 'removed' : f.fixable ? 'still present' : 'kept (content)'));
          }))),
        h('p', { class: 'small' }, `${formatSize(report.file.size)} → ${formatSize(r.data.length)}. New verdict: ${r.after.verdict.title}. SHA-256 ${r.after.hashes.sha256.slice(0, 16)}…`),
        h('details', { class: 'actions-log' }, h('summary', null, `${r.actions.length} change${r.actions.length === 1 ? '' : 's'} made`), h('ul', null, r.actions.map(a => h('li', null, a)))),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => download(blob, cleanName(report.file.name)) }, `Download ${cleanName(report.file.name)}`));
    } catch (e) {
      out.append(h('p', { class: 'error-line' }, `Cleaning failed: ${(e as Error).message}. The original file is unchanged.`));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Clean a copy';
    }
  } }, 'Clean a copy');
  return h('div', { class: 'clean' },
    h('p', { class: 'lede' }, plan.method),
    h('div', { class: 'clean-cols' },
      h('div', null, h('div', { class: 'label' }, 'Removes'), plan.removes.length ? h('ul', { class: 'ticks' }, plan.removes.map(r => h('li', null, r))) : h('p', { class: 'muted' }, 'Nothing.')),
      h('div', null, h('div', { class: 'label' }, 'Keeps'), h('ul', { class: 'ticks keep' }, plan.keeps.map(r => h('li', null, r))))),
    plan.reason ? h('p', { class: 'note' }, plan.reason) : null,
    h('p', { class: 'small muted' }, 'The original is never modified. The copy is built in this browser, then re-examined so you can see what changed.'),
    btn, out);
}
