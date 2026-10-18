// The case file: one analysed file presented as a forensic report.
import type { Finding, Report, Section } from '../core/types';
import type { WorkerClient } from './client';
import { h, download } from './dom';
import { formatSize, hexOff, intakeStamp, rangeLabel } from './format';
import { bar, redactedText, sensitiveStrings } from './redact';
import { hexView, type HexView } from './hex';
import { mapPlate } from './plates/map';
import { bytePlot, entropyGraph, histogram } from './plates/visuals';
import { elaPlate, stegoPlate, thumbnailPlate } from './plates/images';
import { cleanSection } from './clean';
import { interpretEntropy, interpretEntropyPlain } from '../analysis/entropy';

const SEV_LABEL: Record<Finding['severity'], string> = { exposed: 'Exposed', caution: 'Identifying', info: 'Noted', clear: 'Clear' };

const CHECKS: Record<string, string[]> = {
  image: ['EXIF, XMP and IPTC metadata', 'GPS coordinates', 'Embedded thumbnails', 'Data appended after the image', 'Text chunks and comments'],
  document: ['Author, company and tool properties', 'Saved revisions and edit history', 'Comments and tracked changes', 'Scripts and active content', 'Hidden or invisible text'],
  media: ['Location atoms and keys', 'Device make and model', 'Recording timestamps', 'Tags and comments'],
  executable: ['Build timestamp', 'Debug paths', 'Signature presence', 'Packed sections'],
  archive: ['Entry names and paths', 'Encrypted entries', 'Owner IDs', 'Path traversal'],
};

function section(id: string, no: string, title: string, ...children: (Node | null)[]): HTMLElement {
  return h('section', { class: 'case-sec', id, 'aria-labelledby': `${id}-h` },
    h('h2', { id: `${id}-h` }, h('span', { class: 'sec-no' }, no), title), ...children);
}

export interface CaseOptions {
  report: Report;
  file: Blob;
  client: WorkerClient;
  onNew: () => void;
}

export function caseView({ report, file, client, onNew }: CaseOptions): HTMLElement {
  const secrets = sensitiveStrings(report);
  let hex: HexView | null = null;
  const bytesSec = h('div', { class: 'bytes-host' });
  const openBytes = (offset: number, length = 1, label = '') => {
    ensureHex();
    hex!.reveal({ offset, length }, label);
    document.getElementById('bytes')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  };
  const ensureHex = () => {
    if (hex) return;
    hex = hexView(file, report.structure);
    bytesSec.replaceChildren(hex.el);
  };

  // ---------------- header
  const tags = [...new Set(report.findings.filter(f => f.severity !== 'info').map(f => f.tag))];
  const head = h('header', { class: 'case-head' },
    h('div', { class: 'case-tab' }, 'Case file'),
    h('div', { class: 'case-title-row' },
      h('div', null,
        h('div', { class: 'case-no' }, h('span', { class: 'label' }, 'Case no.'), h('span', { class: 'case-id' }, report.caseId)),
        h('h1', { class: 'case-file' }, report.file.name)),
      h('div', { class: `stamp stamp-${report.verdict.level}`, role: 'status', 'aria-label': `Verdict: ${report.verdict.title}` }, report.verdict.title)),
    h('p', { class: 'case-summary' }, report.verdict.summary),
    h('dl', { class: 'case-meta' },
      meta('True type', report.trueType.name + (report.extensionMismatch ? ` (named .${report.file.declaredExtension})` : '')),
      meta('Size', `${formatSize(report.file.size)} · ${report.file.size.toLocaleString()} B`),
      meta('SHA-256', report.hashes.sha256, true),
      meta('Intake', intakeStamp(report.analyzedAt), true),
      meta('Examined in', `${report.timings.totalMs.toLocaleString()} ms, in this browser`)),
    tags.length ? h('ul', { class: 'tags', 'aria-label': 'Evidence tags' }, tags.map(t => h('li', null, h('a', { class: 'tag', href: `#f-${report.findings.find(f => f.tag === t)!.id}` }, t)))) : null,
    h('div', { class: 'case-actions' },
      report.sanitize.supported ? h('a', { class: 'btn btn-primary', href: '#clean' }, 'Clean a copy') : null,
      h('button', { class: 'btn', type: 'button', onclick: () => download(JSON.stringify(exportable(report), null, 2), `case-${report.caseId}.json`, 'application/json') }, 'Export JSON'),
      h('button', { class: 'btn', type: 'button', onclick: () => window.print() }, 'Print / Save as PDF'),
      h('button', { class: 'btn', type: 'button', 'aria-pressed': 'false', onclick: (e: Event) => {
        const el = e.currentTarget as HTMLElement;
        const on = root.classList.toggle('reveal-all');
        el.setAttribute('aria-pressed', String(on));
        el.textContent = on ? 'Hide redacted values' : 'Reveal redacted values';
      } }, 'Reveal redacted values'),
      h('a', { class: 'btn btn-quiet', href: `https://www.virustotal.com/gui/file/${report.hashes.sha256}`, target: '_blank', rel: 'noopener noreferrer', title: 'Opens VirusTotal in a new tab. Only the SHA-256 hash is sent. The file never leaves this browser.' }, 'Look up hash on VirusTotal ↗'),
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: onNew }, 'New intake')));

  // ---------------- findings
  const findings = report.findings;
  const findingsBody = findings.length
    ? h('ol', { class: 'findings' }, findings.map((f, i) => findingItem(f, i + 1, secrets, openBytes)))
    : h('div', { class: 'empty' },
      h('p', { class: 'lede' }, 'No findings. Nothing in this file identifies a person, a place or a device.'),
      h('p', { class: 'small muted' }, 'What was checked:'),
      h('ul', { class: 'ticks' }, (CHECKS[report.trueType.category] ?? ['File type against its extension', 'Embedded strings', 'Appended data']).concat(['Credentials, emails and paths in the raw bytes']).map(c => h('li', null, c))));

  // ---------------- evidence plates
  const plates: HTMLElement[] = [];
  if (report.gps) plates.push(h('figure', { class: 'plate plate-alert' }, mapPlate(report.gps), h('figcaption', null, h('span', { class: 'plate-title' }, 'Recorded location'), ' ', bar(`${report.gps.lat.toFixed(6)}, ${report.gps.lon.toFixed(6)}`), report.gps.alt != null ? ` · altitude ${report.gps.alt.toFixed(0)} m` : '', ` · from ${report.gps.source}.`)));
  if (report.thumbnail && report.trueType.mime && report.trueType.category === 'image') plates.push(thumbnailPlate(report, file, client));
  if (report.stego) plates.push(stegoPlate(report, file, client));
  if (report.trueType.ext === 'jpg') plates.push(elaPlate(report, file, client));
  plates.push(bytePlot(report, o => openBytes(o, report.byteplot.bytesPerCell)));
  plates.push(entropyGraph(report, o => openBytes(o, report.entropy.blockSize)));
  const tech = h('div', { class: 'tech-only' }, histogram(report));

  // ---------------- record
  const record = h('div', { class: 'record' },
    report.sections.length ? report.sections.map(s => recordTable(s, secrets, openBytes)) : h('p', { class: 'muted' }, 'This format carries no structured metadata that Forensics reads.'),
    stringsTable(report, openBytes));

  // ---------------- PDF revisions
  const revs = report.revisions && report.revisions.length > 1 ? section('revisions', '3a', 'Saved versions',
    h('p', { class: 'lede' }, 'Each version below is a complete PDF that ends where that save ended. Opening an earlier one shows the document as it was then.'),
    h('ol', { class: 'rev-list' }, report.revisions.map((r, i) => h('li', null,
      h('span', { class: 'rev-name' }, `Version ${r.index}${i === report.revisions!.length - 1 ? ' (current)' : ''}`),
      h('span', { class: 'mono small' }, `bytes 0–${r.endOffset.toLocaleString()}`),
      r.info.Title ? h('span', { class: 'small' }, `“${r.info.Title}”`) : null,
      r.info.ModDate ? h('span', { class: 'small muted' }, r.info.ModDate) : null,
      i < report.revisions!.length - 1 ? h('button', { class: 'btn btn-small', type: 'button', onclick: () => download(file.slice(0, r.endOffset, 'application/pdf'), report.file.name.replace(/\.pdf$/i, '') + `.v${r.index}.pdf`) }, 'Download this version') : null)))) : null;

  // ---------------- notes
  const entropyLine = h('p', null, h('span', { class: 'tech-only' }, `Overall entropy ${report.entropy.overall.toFixed(4)} bits/byte: ${interpretEntropy(report.entropy.overall)}.`), h('span', { class: 'plain-only' }, `Randomness ${report.entropy.overall.toFixed(1)} of 8: ${interpretEntropyPlain(report.entropy.overall)}.`));
  const notes = h('div', { class: 'notes' },
    entropyLine,
    h('ul', { class: 'notes-list' }, [
      `Read with ${report.structure.length ? `a ${report.trueType.name} structure parser` : 'generic checks only'}, plus a full-file pass for the hash, entropy, byte-plot and strings.`,
      `${report.strings.total.toLocaleString()} printable strings found; ${report.strings.notable.length} flagged.`,
      ...report.notes,
      'Everything ran locally in a Web Worker. No bytes were uploaded.',
    ].map(n => h('li', null, n))));

  const sevCounts = (['exposed', 'caution', 'info'] as const).map(s => [s, findings.filter(f => f.severity === s).length] as const).filter(([, n]) => n);

  const root = h('article', { class: `case case-${report.verdict.level}` },
    head,
    h('nav', { class: 'case-index', 'aria-label': 'Sections' },
      h('a', { href: '#findings' }, '1 Findings'), h('a', { href: '#evidence' }, '2 Evidence'), h('a', { href: '#record' }, '3 Record'),
      h('a', { href: '#bytes', class: 'tech-only' }, '4 Bytes'), h('a', { href: '#clean' }, '5 Clean'), h('a', { href: '#method' }, '6 Method')),
    section('findings', '1', 'Findings',
      sevCounts.length ? h('p', { class: 'tally' }, sevCounts.map(([s, n]) => h('span', { class: `tally-${s}` }, `${n} ${SEV_LABEL[s].toLowerCase()}`))) : null,
      findingsBody),
    section('evidence', '2', 'Evidence', h('div', { class: 'plates' }, plates), tech),
    section('record', '3', 'Record', record),
    revs,
    section('bytes', '4', 'Bytes',
      h('p', { class: 'lede' }, 'Every finding above links to the bytes that prove it. The structure map shows how the file is put together.'),
      bytesSec),
    section('clean', '5', 'Clean', cleanSection(report, file, client)),
    section('method', '6', 'Method and limits', notes));

  // The hex view is created on demand (it reads bytes as you scroll).
  bytesSec.append(h('button', { class: 'btn', type: 'button', onclick: () => ensureHex() }, 'Open the byte viewer'));
  return root;
}

function meta(k: string, v: string, mono = false): HTMLElement[] {
  return [h('dt', null, k), h('dd', { class: mono ? 'mono' : '' }, v)];
}

function findingItem(f: Finding, n: number, secrets: string[], openBytes: (o: number, l: number, label: string) => void): HTMLElement {
  return h('li', { class: `finding sev-${f.severity}`, id: `f-${f.id}` },
    h('div', { class: 'finding-margin' },
      h('span', { class: 'exhibit' }, `Exhibit ${n}`),
      h('span', { class: `sev sev-${f.severity}` }, SEV_LABEL[f.severity]),
      h('span', { class: 'tag tag-static' }, f.tag)),
    h('div', { class: 'finding-body' },
      h('h3', null, f.title),
      h('p', null, ...redactedText(f.detail, secrets)),
      h('div', { class: 'finding-foot' },
        f.evidence.slice(0, 4).map(r => h('button', { class: 'evidence-link', type: 'button', onclick: () => openBytes(r.offset, r.length, f.title) }, `bytes ${rangeLabel(r)}`)),
        f.evidence.length > 4 ? h('span', { class: 'small muted' }, `+${f.evidence.length - 4} more`) : null,
        f.fixable ? h('a', { class: 'fix-link', href: '#clean' }, 'Removable with Clean') : null)));
}

function recordTable(s: Section, secrets: string[], openBytes: (o: number, l: number, label: string) => void): HTMLElement {
  const technical = /Technical tags|Contents|Sections|Link targets|HEIF items/.test(s.title);
  return h('div', { class: `record-block${technical ? ' tech-only' : ''}` },
    h('h3', { class: 'record-title' }, s.title),
    h('dl', { class: 'record-table' }, s.fields.map(f => [
      h('dt', null, f.label),
      h('dd', { class: f.mono ? 'mono' : '' },
        f.sensitive ? bar(f.value) : redactedText(f.value, secrets),
        f.range ? h('button', { class: 'byte-ref', type: 'button', title: `Show bytes ${rangeLabel(f.range)}`, 'aria-label': `Show bytes for ${f.label}`, onclick: () => openBytes(f.range!.offset, f.range!.length, f.label) }, hexOff(f.range.offset)) : null),
    ])));
}

function stringsTable(report: Report, openBytes: (o: number, l: number, label: string) => void): HTMLElement | null {
  if (!report.strings.notable.length) return null;
  return h('div', { class: 'record-block' },
    h('h3', { class: 'record-title' }, 'Strings in the raw bytes'),
    h('dl', { class: 'record-table' }, report.strings.notable.map(s => [
      h('dt', null, { url: 'Link', email: 'Email', path: 'Path', secret: 'Credential-like' }[s.type]),
      h('dd', { class: 'mono' }, s.type === 'secret' || s.type === 'email' ? bar(s.value) : s.value,
        h('button', { class: 'byte-ref', type: 'button', onclick: () => openBytes(s.offset, s.value.length, 'string') }, hexOff(s.offset))),
    ])));
}

function exportable(report: Report): unknown {
  const { byteplot, ...rest } = report;
  return { ...rest, byteplot: { order: byteplot.order, cells: byteplot.cells, bytesPerCell: byteplot.bytesPerCell }, privacyNote: 'Generated entirely in the browser. No file data was uploaded.' };
}
