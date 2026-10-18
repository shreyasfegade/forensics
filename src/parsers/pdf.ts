// PDF: Info dictionaries per revision, incremental-update history, XMP,
// active content, and invisible text layers. A PDF saved with "incremental
// update" keeps every earlier version byte-for-byte in front of the new one.
import type { Field, Finding, ParseResult, PdfRevision, StructNode } from '../core/types';
import { emptyResult } from '../core/types';
import { tryInflate } from '../util/inflate';
import { parseXmp, xmpFindings, xmpSection } from './xmp';

const INFO_KEYS: [key: string, label: string, sensitive?: boolean][] = [
  ['Title', 'Title'], ['Author', 'Author', true], ['Subject', 'Subject'], ['Keywords', 'Keywords'],
  ['Creator', 'Creator tool'], ['Producer', 'Producer'], ['CreationDate', 'Created'], ['ModDate', 'Modified'],
  ['Company', 'Company', true], ['SourceModified', 'Source modified'], ['Trapped', 'Trapped'],
];

function latin1Text(bytes: Uint8Array, start = 0, end = bytes.length): string {
  const parts: string[] = [];
  for (let i = start; i < end; i += 8192) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, end)) as unknown as number[]));
  return parts.join('');
}

export function pdfString(text: string, at: number): { value: string; end: number } | null {
  let i = at;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] === '(') {
    let depth = 1, out = '';
    i++;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '\\') {
        const nx = text[i + 1];
        const esc: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
        if (nx in esc) { out += esc[nx]; i += 2; continue; }
        if (/[0-7]/.test(nx)) { const m = /^[0-7]{1,3}/.exec(text.slice(i + 1, i + 4))![0]; out += String.fromCharCode(parseInt(m, 8)); i += 1 + m.length; continue; }
        i += 2; continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) break; }
      out += ch;
      i++;
    }
    return { value: decodePdfText(out), end: i + 1 };
  }
  if (text[i] === '<' && text[i + 1] !== '<') {
    const close = text.indexOf('>', i);
    if (close < 0) return null;
    const hex = text.slice(i + 1, close).replace(/[^0-9a-fA-F]/g, '');
    let raw = '';
    for (let j = 0; j + 1 < hex.length + 1; j += 2) raw += String.fromCharCode(parseInt((hex.slice(j, j + 2) + '0').slice(0, 2), 16));
    return { value: decodePdfText(raw), end: close + 1 };
  }
  if (text[i] === '/') {
    const m = /^\/([^\s/<>[\]()]+)/.exec(text.slice(i, i + 128));
    return m ? { value: m[1], end: i + m[0].length } : null;
  }
  return null;
}

function decodePdfText(raw: string): string {
  if (raw.charCodeAt(0) === 0xfe && raw.charCodeAt(1) === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < raw.length; i += 2) s += String.fromCharCode((raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1));
    return s.replace(/\0+$/, '').trim();
  }
  if (raw.charCodeAt(0) === 0xef && raw.charCodeAt(1) === 0xbb && raw.charCodeAt(2) === 0xbf) {
    try { return new TextDecoder().decode(Uint8Array.from(raw.slice(3), c => c.charCodeAt(0))).trim(); } catch { /* fall through */ }
  }
  return raw.replace(/\0/g, '').trim();
}

export function formatPdfDate(s: string): string {
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+\-])?(\d{2})?'?(\d{2})?'?/.exec(s);
  if (!m) return s;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', tz, th, tm] = m;
  let out = `${y}-${mo}-${d} ${h}:${mi}:${se}`;
  if (tz === 'Z' || tz === 'z') out += ' UTC';
  else if (tz) out += ` UTC${tz}${th ?? '00'}:${tm ?? '00'}`;
  return out;
}

/** Info-style key/value pairs from a dictionary's source text. */
export function parseInfoDict(dict: string): { values: Record<string, string>; spans: Record<string, [number, number]> } {
  const values: Record<string, string> = {};
  const spans: Record<string, [number, number]> = {};
  for (const [key] of INFO_KEYS) {
    const re = new RegExp(`/${key}(?![A-Za-z])`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(dict))) {
      const v = pdfString(dict, m.index + key.length + 1);
      if (v && v.value) {
        values[key] = key.endsWith('Date') ? formatPdfDate(v.value) : v.value;
        spans[key] = [m.index + key.length + 1, v.end];
      }
    }
  }
  return { values, spans };
}

interface StreamRef { dictStart: number; dataStart: number; dataEnd: number; dict: string }

function findStreams(text: string, limit = 400): StreamRef[] {
  const out: StreamRef[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < limit) {
    if (text.slice(m.index - 3, m.index) === 'end') continue;
    const dictStart = text.lastIndexOf('<<', m.index);
    const objStart = text.lastIndexOf(' obj', m.index);
    if (dictStart < 0) continue;
    const dict = text.slice(Math.max(dictStart, objStart), m.index);
    const dataStart = m.index + m[0].length;
    const lenM = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    let dataEnd = lenM ? dataStart + parseInt(lenM[1], 10) : -1;
    if (dataEnd < 0 || text.slice(dataEnd, dataEnd + 12).replace(/^\s+/, '').slice(0, 9) !== 'endstream') {
      dataEnd = text.indexOf('endstream', dataStart);
      if (dataEnd < 0) break;
      while (dataEnd > dataStart && (text[dataEnd - 1] === '\n' || text[dataEnd - 1] === '\r')) dataEnd--;
    }
    out.push({ dictStart, dataStart, dataEnd, dict });
    re.lastIndex = dataEnd;
  }
  return out;
}

const RISK: [RegExp, string, Finding['severity'], Finding['tag'], string][] = [
  [/\/JavaScript\b|\/JS\s*[(<\[]|\/JS\s+\d+\s+\d+\s+R/, 'Embedded JavaScript', 'exposed', 'SCRIPT', 'The document contains JavaScript, which PDF readers can run when it opens or when you interact with it.'],
  [/\/Launch\b/, 'Launch action', 'exposed', 'SCRIPT', 'A /Launch action asks the reader to open another program or file.'],
  [/\/OpenAction\b/, 'Runs an action on open', 'caution', 'SCRIPT', 'An /OpenAction fires as soon as the file is opened (often harmless, like jumping to a page, but it\'s also how scripts start).'],
  [/\/EmbeddedFiles?\b/, 'Embedded file attachments', 'caution', 'ARCHIVE', 'Other files are packed inside this PDF.'],
  [/\/SubmitForm\b/, 'Form that submits data', 'caution', 'SCRIPT', 'A form action can send what you type to a remote address.'],
  [/\/RichMedia\b|\/XFA\b/, 'Rich media or XFA forms', 'caution', 'SCRIPT', 'Rich media and XFA are historically exploited PDF features.'],
];

export async function parsePdf(bytes: Uint8Array, complete = true): Promise<ParseResult> {
  const res = emptyResult();
  const text = latin1Text(bytes);
  const nodes: StructNode[] = [];
  const header = /^%PDF-(\d\.\d)/.exec(text.slice(0, 16));
  nodes.push({ id: 'pdf-header', label: `Header · PDF ${header?.[1] ?? '?'}`, kind: 'header', range: { offset: 0, length: Math.max(8, text.indexOf('\n') + 1) } });

  // --- revisions (each %%EOF closes one saved version)
  const eofs: number[] = [];
  const eofRe = /%%EOF[ \t]*(\r\n|\r|\n)?/g;
  let m: RegExpExecArray | null;
  while ((m = eofRe.exec(text))) eofs.push(m.index + m[0].length);
  const linearized = /\/Linearized\s/.test(text.slice(0, 2048));
  const revEnds = linearized && eofs.length > 1 ? eofs.slice(1) : eofs;

  const revisions: PdfRevision[] = [];
  let prev = 0;
  revEnds.forEach((end, i) => {
    const segment = text.slice(prev, end);
    const info = resolveInfo(text, segment, end);
    revisions.push({ index: i + 1, endOffset: end, info: info.values });
    nodes.push({ id: `rev${i}`, label: `Revision ${i + 1}${i === 0 ? ' · original save' : ' · incremental update'}`, kind: 'revision', range: { offset: prev, length: end - prev } });
    prev = end;
  });
  if (prev < bytes.length && revEnds.length) {
    nodes.push({ id: 'pdf-trailing', label: 'Data after final %%EOF', kind: 'trailing', range: { offset: prev, length: bytes.length - prev } });
  }

  // --- decoded streams: object streams (where modern PDFs hide their Info and
  // actions) and page content (for invisible text).
  const streams = findStreams(text);
  let decodedObjects = '';
  const invisible: { text: string; offset: number }[] = [];
  let inflatedBytes = 0;
  let objStreams = 0;
  for (const s of streams) {
    if (inflatedBytes > 48 * 1024 * 1024) break;
    const isObjStm = /\/Type\s*\/ObjStm/.test(s.dict);
    const isImage = /\/Subtype\s*\/Image|\/Type\s*\/XObject|\/Type\s*\/Metadata/.test(s.dict);
    if (isImage || /\/Type\s*\/XRef/.test(s.dict)) continue;
    let t: string;
    if (!/\/Filter/.test(s.dict)) t = text.slice(s.dataStart, s.dataEnd);
    else {
      if (!/\/FlateDecode/.test(s.dict) || /\/Filter\s*\[[^\]]*\/\w+\s+\/\w+/.test(s.dict)) continue;
      const out = await tryInflate(bytes.subarray(s.dataStart, s.dataEnd), 'deflate', 8 * 1024 * 1024);
      if (!out) continue;
      inflatedBytes += out.length;
      t = latin1Text(out);
    }
    if (isObjStm) { decodedObjects += '\n' + t; objStreams++; continue; }
    // Text render mode 3 = neither fill nor stroke: invisible but extractable.
    const tr = /\b3\s+Tr\b/g;
    let k: RegExpExecArray | null;
    while ((k = tr.exec(t)) && invisible.length < 20) {
      const stop = t.slice(k.index).search(/\b[0-24-7]\s+Tr\b|\bET\b/);
      const block = t.slice(k.index, stop > 0 ? k.index + stop : k.index + 4000);
      const shown = [...block.matchAll(/\((?:\\.|[^\\)])*\)\s*'?T[jJ]?|\[(.*?)\]\s*TJ/g)].map(x => x[0]).join(' ');
      const strs = [...shown.matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map(x => x[1].replace(/\\(.)/g, '$1')).join('');
      if (strs.trim()) invisible.push({ text: strs.trim().slice(0, 300), offset: s.dataStart });
    }
  }

  // --- current Info (last revision wins), falling back to object streams
  const current = revisions.length ? { ...revisions[revisions.length - 1].info } : {};
  if (!Object.keys(current).length && decodedObjects) Object.assign(current, parseInfoDict(decodedObjects).values);
  const infoRange = (() => {
    const idx = text.lastIndexOf('/Producer') > 0 ? text.lastIndexOf('/Producer') : text.lastIndexOf('/Author');
    return idx > 0 ? { offset: Math.max(0, text.lastIndexOf('<<', idx)), length: Math.min(512, text.indexOf('>>', idx) - text.lastIndexOf('<<', idx) + 2) } : undefined;
  })();

  const infoFields: Field[] = INFO_KEYS.filter(([k]) => current[k]).map(([k, label, sensitive]) => ({ key: `info.${k}`, label, value: current[k], sensitive, range: infoRange }));

  // pages
  let pages = 0;
  const all = text + decodedObjects;
  const pageRe = /\/Type\s*\/Page(?![s\w])/g;
  while (pageRe.exec(all)) pages++;
  const countM = [...all.matchAll(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages/g)].map(x => parseInt(x[1] ?? x[2], 10));
  if (countM.length) pages = Math.max(...countM);
  if (pages) infoFields.push({ key: 'pages', label: 'Pages', value: String(pages), mono: true });
  if (header) infoFields.push({ key: 'version', label: 'PDF version', value: header[1], mono: true });
  infoFields.push({ key: 'revisions', label: 'Saved versions', value: String(Math.max(1, revisions.length)), mono: true });
  const encrypted = /\/Encrypt\s/.test(all);
  if (encrypted) infoFields.push({ key: 'enc', label: 'Encryption', value: 'Encrypted (strings and streams may be unreadable)' });
  res.sections.push({ id: 'pdf-info', title: 'Document properties', fields: infoFields });

  // XMP (usually stored as an uncompressed metadata stream)
  const xs = all.indexOf('<x:xmpmeta');
  if (xs >= 0) {
    const xe = all.indexOf('</x:xmpmeta>', xs);
    const x = parseXmp(all.slice(xs, xe > 0 ? xe + 12 : xs + 65536), { offset: Math.min(xs, bytes.length - 1), length: xe > 0 && xs < text.length ? xe + 12 - xs : 1 });
    const sec = xmpSection(x, 'pdf-xmp');
    if (sec) res.sections.push(sec);
    res.findings.push(...xmpFindings(x).filter(f => f.id !== 'xmp-author' || !current.Author));
  }

  // --- findings
  if (current.Author) {
    res.findings.push({ id: 'pdf-author', severity: 'caution', tag: 'AUTHOR', fixable: true, title: 'Author name in document properties', detail: `Author: ${current.Author}${current.Company ? ` (${current.Company})` : ''}.`, evidence: infoRange ? [infoRange] : [] });
  }
  if (current.Creator || current.Producer) {
    res.findings.push({ id: 'pdf-tool', severity: 'info', tag: 'DEVICE', fixable: true, title: 'Software fingerprint', detail: [current.Creator && `Made with ${current.Creator}`, current.Producer && `produced by ${current.Producer}`].filter(Boolean).join(', ') + '. Version strings reveal the OS and app the author uses.', evidence: infoRange ? [infoRange] : [] });
  }
  if (revisions.length > 1) {
    const changes: string[] = [];
    for (let i = 1; i < revisions.length; i++) {
      for (const [k, label] of INFO_KEYS) {
        const a = revisions[i - 1].info[k], b = revisions[i].info[k];
        if (a && b && a !== b && !k.endsWith('Date')) changes.push(`${label} “${a}” → “${b}”`);
      }
    }
    res.findings.push({
      id: 'pdf-revisions', severity: 'caution', tag: 'HISTORY',
      title: `${revisions.length} saved versions inside`,
      detail: `This PDF was saved with incremental updates, so the earlier ${revisions.length - 1 === 1 ? 'version is' : `${revisions.length - 1} versions are`} still in the file and can be recovered intact.${changes.length ? ' Changed between versions: ' + changes.slice(0, 3).join('; ') + '.' : ''}`,
      evidence: revisions.slice(0, -1).map((r, i) => ({ offset: i === 0 ? 0 : revisions[i - 1].endOffset, length: r.endOffset - (i === 0 ? 0 : revisions[i - 1].endOffset) })),
    });
  }
  for (const [re, title, severity, tag, detail] of RISK) {
    const idx = all.search(re);
    if (idx >= 0) res.findings.push({ id: `pdf-${tag}-${title}`, severity, tag, title, detail, evidence: idx < text.length ? [{ offset: idx, length: 24 }] : [] });
  }
  if (invisible.length) {
    res.findings.push({ id: 'pdf-invisible', severity: 'caution', tag: 'PAYLOAD', title: 'Invisible text layer', detail: `Text drawn in invisible render mode (3 Tr): “${invisible[0].text.slice(0, 140)}”. It doesn't show on screen but is selectable and searchable. It's common in OCR'd scans and also used to hide content.`, evidence: invisible.map(v => ({ offset: v.offset, length: 64 })) });
    res.sections.push({ id: 'pdf-invisible', title: 'Invisible text', fields: invisible.map((v, i) => ({ key: `inv${i}`, label: `Block ${i + 1}`, value: v.text, range: { offset: v.offset, length: 64 } })) });
  }
  if (/\/URI\s*\(/.test(all)) {
    const uris = [...all.matchAll(/\/URI\s*\(([^)]{4,200})\)/g)].map(x => x[1]);
    res.sections.push({ id: 'pdf-links', title: 'Link targets', fields: [...new Set(uris)].slice(0, 20).map((u, i) => ({ key: `uri${i}`, label: `Link ${i + 1}`, value: u, mono: true })) });
  }

  res.revisions = revisions;
  res.structure = nodes;
  const notes: string[] = [];
  if (objStreams) notes.push(`${objStreams} compressed object stream${objStreams > 1 ? 's were' : ' was'} decompressed and inspected.`);
  if (encrypted) notes.push('The document is encrypted. Encrypted strings and streams were not decoded.');
  if (!complete) notes.push('Only the first and last parts of this large PDF were inspected.');
  if (linearized) notes.push('Linearized ("fast web view") PDF. Its first-page section is not counted as a separate version.');
  res.notes = notes;
  return res;
}

function resolveInfo(all: string, segment: string, end: number): { values: Record<string, string> } {
  // Trailer (classic) or XRef stream dictionary names the Info object.
  const refs = [...segment.matchAll(/\/Info\s+(\d+)\s+(\d+)\s+R/g)];
  const ref = refs[refs.length - 1];
  if (ref) {
    const head = all.slice(0, end);
    const objRe = new RegExp(`(?:^|[^0-9])${ref[1]}\\s+${ref[2]}\\s+obj\\b`, 'g');
    let last = -1, mm: RegExpExecArray | null;
    while ((mm = objRe.exec(head))) last = mm.index;
    if (last >= 0) {
      const stop = head.indexOf('endobj', last);
      return parseInfoDict(head.slice(last, stop > 0 ? stop : last + 8192));
    }
  }
  return parseInfoDict(segment.replace(/stream\r?\n[\s\S]*?endstream/g, ''));
}
