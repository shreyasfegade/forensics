// Redaction bars: personal values render under a solid bar until revealed,
// so a case can be screen-shared or screenshotted safely by default.
import type { Report } from '../core/types';
import { h } from './dom';

export function sensitiveStrings(report: Report): string[] {
  const out = new Set<string>();
  for (const s of report.sections) for (const f of s.fields) {
    if (!f.sensitive) continue;
    const v = f.value.trim();
    if (v.length >= 3) out.add(v);
    // Also catch fragments that findings quote (e.g. a name inside "Written by …").
    for (const part of v.split(/\s*[·,;|]\s*/)) if (part.length >= 4) out.add(part);
  }
  if (report.gps) {
    for (const n of [3, 4, 5, 6]) { out.add(report.gps.lat.toFixed(n)); out.add(report.gps.lon.toFixed(n)); }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export function redactedText(text: string, secrets: string[]): (Node | string)[] {
  if (!secrets.length) return [text];
  const esc = secrets.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${esc.join('|')})`, 'g');
  const parts = text.split(re);
  return parts.map((p, i) => (i % 2 ? bar(p) : p)).filter(p => p !== '');
}

export function bar(value: string): HTMLElement {
  const b = h('button', { class: 'redact', type: 'button', 'aria-label': 'Redacted value. Press to reveal.', 'aria-pressed': 'false', onclick: (e: Event) => {
    e.stopPropagation();
    const on = b.classList.toggle('shown');
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? value : 'Redacted value. Press to reveal.');
  } }, h('span', { class: 'redact-text' }, value));
  return b;
}
