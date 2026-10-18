// ISO base media file format (MP4, MOV, 3GP, HEIC, HEIF, AVIF). One box walker
// serves both phone videos (GPS in ©xyz / Apple location keys) and HEIC photos
// (EXIF stored as an item, located through iinf/iloc).
import type { Finding, GPSFix, ParseResult, Range, StructNode } from '../core/types';
import { emptyResult } from '../core/types';
import { ascii, Cursor, cstring, utf8 } from '../util/bytes';
import type { Source } from '../util/source';
import { parseTiff, tiffFindings, tiffSections } from './tiff';
import { parseXmp, xmpFindings, xmpSection } from './xmp';

export interface Box {
  type: string;
  offset: number;
  size: number;
  headerSize: number;
  children?: Box[];
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf', 'mvex', 'moof', 'traf', 'mfra', 'iprp', 'ipco', 'ilst', 'sinf', 'schi', 'tref', 'meco', 'gmhd']);
const FULL_CONTAINERS = new Set(['meta', 'iinf', 'iref']);

/** A box that is part of a sanitize plan: retype to `free` and zero its payload. */
export interface ScrubTarget { offset: number; size: number; what: string }

function boxNode(b: Box, note?: string): StructNode {
  return { id: `box@${b.offset}`, label: b.type, kind: 'box', range: { offset: b.offset, length: b.size }, note, children: b.children?.map(c => boxNode(c)) };
}

/** Walk boxes inside an in-memory buffer whose first byte sits at absolute `base`. */
export function walkBoxes(buf: Uint8Array, start: number, end: number, base: number, depth = 0, budget = { n: 0 }): Box[] {
  const out: Box[] = [];
  const c = new Cursor(buf);
  let p = start;
  while (p + 8 <= end && budget.n++ < 4000) {
    let size = c.u32(p);
    const type = ascii(buf, p + 4, p + 8);
    let hdr = 8;
    if (size === 1 && p + 16 <= end) { size = c.u64(p + 8); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end + 0) {
      if (size < hdr) break;
      size = end - p;
    }
    const box: Box = { type, offset: base + p, size, headerSize: hdr };
    if (depth < 8) {
      if (CONTAINERS.has(type) || (type === 'meta')) {
        let cs = p + hdr;
        // ISO 'meta' is a full box (4 bytes version/flags); QuickTime's isn't.
        if (FULL_CONTAINERS.has(type) && !(type === 'meta' && ascii(buf, p + hdr + 4, p + hdr + 8) === 'hdlr')) cs += 4;
        if (type === 'iinf') cs += c.u8(p + hdr) === 0 ? 2 : 4;
        box.children = walkBoxes(buf, cs, p + size, base, depth + 1, budget);
      } else if (type === 'iinf') {
        const v = c.u8(p + hdr);
        box.children = walkBoxes(buf, p + hdr + 4 + (v === 0 ? 2 : 4), p + size, base, depth + 1, budget);
      } else if (type === 'stsd') {
        box.children = walkBoxes(buf, p + hdr + 8, p + size, base, depth + 1, budget);
      }
    }
    out.push(box);
    p += size;
  }
  return out;
}

function* iter(boxes: Box[], path: string[] = []): Generator<{ box: Box; path: string[] }> {
  for (const b of boxes) {
    yield { box: b, path };
    if (b.children) yield* iter(b.children, [...path, b.type]);
  }
}

export function parseIso6709(s: string): GPSFix | null {
  const m = /([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/.exec(s);
  if (!m) return null;
  const conv = (v: string, degDigits: number) => {
    const sign = v[0] === '-' ? -1 : 1;
    const body = v.slice(1);
    const intLen = body.split('.')[0].length;
    if (intLen <= degDigits) return sign * parseFloat(body);
    // ±DDMM.MMM / ±DDMMSS.S forms
    const deg = parseFloat(body.slice(0, degDigits));
    const rest = body.slice(degDigits);
    if (intLen - degDigits === 2) return sign * (deg + parseFloat(rest) / 60);
    return sign * (deg + parseFloat(rest.slice(0, 2)) / 60 + parseFloat(rest.slice(2)) / 3600);
  };
  const lat = conv(m[1], 2), lon = conv(m[2], 3);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, alt: m[3] ? parseFloat(m[3]) : undefined, source: '' };
}

const QT_TEXT: Record<string, [string, boolean]> = {
  '©xyz': ['Location (ISO 6709)', true], '©mak': ['Make', false], '©mod': ['Model', false], '©swr': ['Software', false],
  '©day': ['Date', false], '©too': ['Encoder', false], '©nam': ['Title', false], '©ART': ['Artist', true], '©cmt': ['Comment', true],
  '©aut': ['Author', true], '©des': ['Description', false], '©enc': ['Encoded by', true], '©inf': ['Information', false],
};

const APPLE_KEYS: Record<string, [string, boolean]> = {
  'com.apple.quicktime.location.ISO6709': ['Location (ISO 6709)', true],
  'com.apple.quicktime.location.accuracy.horizontal': ['Location accuracy (m)', false],
  'com.apple.quicktime.location.name': ['Location name', true],
  'com.apple.quicktime.make': ['Make', false],
  'com.apple.quicktime.model': ['Model', false],
  'com.apple.quicktime.software': ['Software', false],
  'com.apple.quicktime.creationdate': ['Created', false],
  'com.apple.quicktime.camera.lens_model': ['Lens', false],
  'com.apple.quicktime.camera.identifier': ['Camera', false],
  'com.apple.quicktime.content.identifier': ['Content ID', true],
  'com.apple.quicktime.author': ['Author', true],
  'com.apple.quicktime.displayname': ['Display name', false],
  'com.android.version': ['Android version', false],
  'com.android.manufacturer': ['Manufacturer', false],
  'com.android.model': ['Model', false],
  'com.android.capture.fps': ['Capture FPS', false],
};

const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';

export interface IsoParse extends ParseResult { scrub: ScrubTarget[]; boxes: Box[]; heif: boolean }

export async function parseIsobmff(src: Source, heif: boolean): Promise<IsoParse> {
  const res = emptyResult() as IsoParse;
  res.scrub = [];
  res.heif = heif;
  const top: Box[] = [];
  const bodies = new Map<number, Uint8Array>();
  let p = 0;
  for (let k = 0; p + 8 <= src.size && k < 2000; k++) {
    const h = await src.read(p, 16);
    const c = new Cursor(h);
    let size = c.u32(0);
    const type = ascii(h, 4, 8);
    let hdr = 8;
    if (size === 1 && h.length >= 16) { size = c.u64(8); hdr = 16; }
    else if (size === 0) size = src.size - p;
    if (size < hdr) break;
    size = Math.min(size, src.size - p);
    const box: Box = { type, offset: p, size, headerSize: hdr };
    if (!['mdat', 'free', 'skip', 'wide', 'idat'].includes(type) && size <= 64 * 1024 * 1024) {
      const body = await src.read(p, size);
      bodies.set(p, body);
      const kids = walkBoxes(body, 0, body.length, p);
      if (kids[0]?.children) box.children = kids[0].children;
    }
    top.push(box);
    p += size;
  }
  res.boxes = top;
  res.structure = top.map(b => boxNode(b));
  if (p < src.size) res.notes = ['Box structure ends before the end of the file; trailing bytes were not parsed.'];

  // Absolute-offset reader over the loaded top-level boxes.
  const at = (abs: number, len: number): Uint8Array | null => {
    for (const [base, body] of bodies) if (abs >= base && abs + len <= base + body.length) return body.subarray(abs - base, abs - base + len);
    return null;
  };
  const payload = (b: Box) => at(b.offset + b.headerSize, b.size - b.headerSize);

  const meta: { key: string; label: string; value: string; sensitive: boolean; range: Range }[] = [];
  const all = [...iter(top)];
  const ftyp = top.find(b => b.type === 'ftyp');
  if (ftyp) {
    const d = payload(ftyp);
    if (d) {
      const brands: string[] = [];
      for (let i = 8; i + 4 <= d.length; i += 4) brands.push(ascii(d, i, i + 4).trim());
      meta.push({ key: 'brand', label: 'Brand', value: `${ascii(d, 0, 4).trim()} (compatible: ${brands.filter(Boolean).join(', ')})`, sensitive: false, range: { offset: ftyp.offset, length: ftyp.size } });
    }
  }

  // --- movie header: creation time (seconds since 1904-01-01)
  const mvhd = all.find(x => x.box.type === 'mvhd')?.box;
  let created: string | undefined;
  if (mvhd) {
    const d = payload(mvhd);
    if (d && d.length >= 20) {
      const c = new Cursor(d);
      const v1 = d[0] === 1;
      const ct = v1 ? c.u64(4) : c.u32(4);
      const ts = v1 ? c.u32(20) : c.u32(12);
      const dur = v1 ? c.u64(24) : c.u32(16);
      if (ct > 0) {
        created = new Date((ct - 2082844800) * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
        meta.push({ key: 'mvhd.created', label: 'Created (movie header)', value: created, sensitive: false, range: { offset: mvhd.offset, length: mvhd.size } });
      }
      if (ts) meta.push({ key: 'mvhd.dur', label: 'Duration', value: `${(dur / ts).toFixed(2)} s`, sensitive: false, range: { offset: mvhd.offset, length: mvhd.size } });
    }
  }
  for (const { box } of all.filter(x => x.box.type === 'tkhd')) {
    const d = payload(box);
    if (d && d.length >= 84) {
      const c = new Cursor(d);
      const off = d[0] === 1 ? 88 : 76;
      if (d.length >= off + 8) {
        const w = c.u32(off) / 65536, h = c.u32(off + 4) / 65536;
        if (w && h && !res.image) res.image = { width: Math.round(w), height: Math.round(h) };
      }
    }
  }

  // --- QuickTime user data text atoms (©xyz, ©mak, …)
  let gps: GPSFix | undefined;
  for (const { box, path } of all) {
    if (!(box.type in QT_TEXT) || !path.includes('udta')) continue;
    const d = payload(box);
    if (!d || d.length < 4) continue;
    let value: string;
    const len = (d[0] << 8) | d[1];
    if (len > 0 && len + 4 <= d.length) value = utf8(d.subarray(4, 4 + len));
    else if (ascii(d, 4, 8) === 'data') value = utf8(d.subarray(16));
    else value = utf8(d).replace(/[\0-\x1f]/g, '');
    value = value.replace(/\0+$/, '').trim();
    if (!value) continue;
    const [label, sensitive] = QT_TEXT[box.type];
    meta.push({ key: box.type, label, value, sensitive, range: { offset: box.offset, length: box.size } });
    if (box.type === '©xyz') {
      const g = parseIso6709(value);
      if (g) { gps = { ...g, source: 'QuickTime ©xyz atom', range: { offset: box.offset, length: box.size } }; }
      res.scrub.push({ offset: box.offset, size: box.size, what: '©xyz location' });
    } else if (sensitive) res.scrub.push({ offset: box.offset, size: box.size, what: label });
  }

  // --- Apple / Android metadata keys (moov/meta: keys + ilst)
  for (const { box: metaBox } of all.filter(x => x.box.type === 'meta' && x.box.children)) {
    const keysBox = metaBox.children!.find(b => b.type === 'keys');
    const ilst = metaBox.children!.find(b => b.type === 'ilst');
    if (!keysBox || !ilst) continue;
    const kd = payload(keysBox);
    if (!kd) continue;
    const kc = new Cursor(kd);
    const keys: string[] = [];
    const n = kc.u32(4);
    let q = 8;
    for (let i = 0; i < n && q + 8 <= kd.length; i++) {
      const sz = kc.u32(q);
      if (sz < 8) break;
      keys.push(ascii(kd, q + 8, q + sz));
      q += sz;
    }
    for (const item of ilst.children ?? []) {
      const d = at(item.offset, item.size);
      if (!d) continue;
      const idx = new Cursor(d).u32(4) - 1;
      const key = keys[idx];
      if (!key) continue;
      const dataBox = walkBoxes(d, 8, d.length, item.offset).find(b => b.type === 'data');
      if (!dataBox) continue;
      const dd = at(dataBox.offset + 8, dataBox.size - 8);
      if (!dd || dd.length < 8) continue;
      const typeCode = new Cursor(dd).u32(0) & 0xffffff;
      const raw = dd.subarray(8);
      let value: string;
      if (typeCode === 1) value = utf8(raw);
      else if (typeCode === 23 && raw.length >= 4) value = new Cursor(raw).dv.getFloat32(0).toFixed(3);
      else if (typeCode === 21 || typeCode === 22) value = String(raw.length === 4 ? new Cursor(raw).i32(0) : raw[0]);
      else value = utf8(raw).replace(/[\0-\x1f]/g, '');
      value = value.trim();
      const def = APPLE_KEYS[key] ?? [key.replace(/^com\.(apple|android)\.(quicktime\.)?/, ''), /location|author|owner|identifier/.test(key)];
      meta.push({ key, label: def[0], value, sensitive: def[1], range: { offset: item.offset, length: item.size } });
      if (key === 'com.apple.quicktime.location.ISO6709') {
        const g = parseIso6709(value);
        if (g && !gps) gps = { ...g, source: 'Apple location metadata key', range: { offset: item.offset, length: item.size } };
        res.scrub.push({ offset: item.offset, size: item.size, what: 'location key' });
      } else if (def[1] || /location/.test(key)) res.scrub.push({ offset: item.offset, size: item.size, what: def[0] });
    }
  }

  // --- XMP in a uuid box or udta/XMP_
  for (const { box } of all) {
    const d = payload(box);
    if (!d) continue;
    let xmlBytes: Uint8Array | null = null;
    if (box.type === 'uuid' && Array.from(d.subarray(0, 16), b => b.toString(16).padStart(2, '0')).join('') === XMP_UUID) xmlBytes = d.subarray(16);
    else if (box.type === 'XMP_') xmlBytes = d;
    if (xmlBytes) {
      const x = parseXmp(utf8(xmlBytes), { offset: box.offset, length: box.size });
      const sec = xmpSection(x, `xmp@${box.offset}`);
      if (sec) res.sections.push(sec);
      res.findings.push(...xmpFindings(x));
    }
  }

  // --- HEIF items: EXIF (and XMP) located through iinf + iloc
  if (heif) await parseHeifItems(src, all.map(x => x.box), payload, res);

  if (meta.length) res.sections.unshift({ id: 'iso-meta', title: heif ? 'Container metadata' : 'Movie metadata', fields: meta.map(m => ({ key: m.key, label: m.label, value: m.value, sensitive: m.sensitive, range: m.range, mono: /ISO|date|Created|Duration/.test(m.label) })) });
  if (gps && !res.gps) {
    res.gps = gps;
    res.findings.unshift({ id: 'gps', severity: 'exposed', tag: 'GPS', fixable: true, title: heif ? 'Exact location embedded' : 'Recording location embedded', detail: `${gps.source} gives ${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}${gps.alt != null ? ` at ${gps.alt.toFixed(0)} m` : ''}. Phone videos save this by default.`, evidence: gps.range ? [gps.range] : [] });
  }
  const mk = meta.find(m => m.label === 'Make' || m.label === 'Manufacturer'), md = meta.find(m => m.label === 'Model');
  if ((mk || md) && !res.findings.some(f => f.id === 'device')) {
    res.findings.push({ id: 'device', severity: 'caution', tag: 'DEVICE', fixable: true, title: 'Device fingerprint', detail: `Recorded on ${[mk?.value, md?.value].filter(Boolean).join(' ')}${meta.find(m => m.label === 'Software') ? `, software ${meta.find(m => m.label === 'Software')!.value}` : ''}.`, evidence: [mk?.range, md?.range].filter(Boolean) as Range[] });
  }
  const author = meta.filter(m => ['Artist', 'Author', 'Encoded by'].includes(m.label));
  if (author.length) res.findings.push({ id: 'iso-author', severity: 'caution', tag: 'AUTHOR', fixable: true, title: 'Names in metadata', detail: author.map(a => `${a.label}: ${a.value}`).join(' · '), evidence: author.map(a => a.range) });
  const createdKey = meta.find(m => m.key === 'com.apple.quicktime.creationdate' || m.key === '©day');
  if (createdKey || created) {
    res.findings.push({ id: 'iso-time', severity: 'info', tag: 'TIMESTAMP', title: 'Recording time recorded', detail: `${createdKey?.value ?? created}${createdKey && /[+-]\d{4}$/.test(createdKey.value) ? '. The local time-zone offset is included.' : '.'}`, evidence: [createdKey?.range ?? { offset: mvhd!.offset, length: mvhd!.size }] });
  }
  return res;
}

async function parseHeifItems(src: Source, boxes: Box[], payload: (b: Box) => Uint8Array | null, res: IsoParse): Promise<void> {
  const iinf = boxes.find(b => b.type === 'iinf');
  const iloc = boxes.find(b => b.type === 'iloc');
  if (!iinf || !iloc) return;
  const items = new Map<number, { type: string; name: string; contentType?: string }>();
  for (const infe of iinf.children ?? []) {
    if (infe.type !== 'infe') continue;
    const d = payload(infe);
    if (!d) continue;
    const c = new Cursor(d);
    const v = d[0];
    if (v < 2) continue;
    const id = v === 2 ? c.u16(4) : c.u32(4);
    const o = v === 2 ? 8 : 10;
    const type = ascii(d, o, o + 4);
    const name = cstring(d, o + 4, 64);
    const ct = type === 'mime' ? cstring(d, o + 4 + name.length + 1, 128) : undefined;
    items.set(id, { type, name, contentType: ct });
  }
  const d = payload(iloc);
  if (!d) return;
  const c = new Cursor(d);
  const v = d[0];
  const offSize = d[4] >> 4, lenSize = d[4] & 15, baseSize = d[5] >> 4, idxSize = v >= 1 ? d[5] & 15 : 0;
  const rd = (q: number, n: number) => (n === 0 ? 0 : n === 4 ? c.u32(q) : n === 8 ? c.u64(q) : n === 2 ? c.u16(q) : 0);
  let q = 6;
  const count = v < 2 ? c.u16(q) : c.u32(q);
  q += v < 2 ? 2 : 4;
  const locs = new Map<number, { offset: number; length: number; method: number }>();
  for (let i = 0; i < count && q < d.length; i++) {
    const id = v < 2 ? c.u16(q) : c.u32(q);
    q += v < 2 ? 2 : 4;
    let method = 0;
    if (v >= 1) { method = c.u16(q) & 15; q += 2; }
    q += 2; // data_reference_index
    const base = rd(q, baseSize); q += baseSize;
    const ext = c.u16(q); q += 2;
    let first: { offset: number; length: number } | null = null;
    for (let e = 0; e < ext; e++) {
      q += idxSize;
      const off = rd(q, offSize); q += offSize;
      const len = rd(q, lenSize); q += lenSize;
      if (!first) first = { offset: base + off, length: len };
    }
    if (first) locs.set(id, { ...first, method });
  }
  for (const [id, item] of items) {
    const loc = locs.get(id);
    if (!loc || loc.method !== 0 || loc.length <= 0 || loc.offset + loc.length > src.size) continue;
    if (item.type === 'Exif') {
      const data = await src.read(loc.offset, Math.min(loc.length, 4 * 1024 * 1024));
      const skip = new Cursor(data).u32(0);
      const t = parseTiff(data, 4 + skip, data.length, 'EXIF item (TIFF structure)');
      if (!t) continue;
      // Re-base ranges from the item buffer to absolute file offsets.
      const shift = loc.offset;
      for (const e of t.entries) { e.valueOffset += shift; e.entryOffset += shift; }
      if (t.gps?.range) t.gps.range.offset += shift;
      if (t.thumbnail) t.thumbnail.offset += shift;
      rebase(t.structure, shift);
      res.structure.push({ id: `heif-exif@${loc.offset}`, label: 'EXIF item', kind: 'item', range: { offset: loc.offset, length: loc.length }, children: [t.structure] });
      res.sections.push(...tiffSections(t, 'heic'));
      res.findings.push(...tiffFindings(t, 'photo'));
      if (t.gps) res.gps = t.gps;
      res.scrub.push({ offset: loc.offset, size: loc.length, what: 'EXIF item' });
    } else if (item.type === 'mime' && /xmp|rdf/.test(item.contentType ?? '')) {
      const data = await src.read(loc.offset, Math.min(loc.length, 4 * 1024 * 1024));
      const x = parseXmp(utf8(data), { offset: loc.offset, length: loc.length });
      const sec = xmpSection(x, 'heic-xmp');
      if (sec) res.sections.push(sec);
      res.findings.push(...xmpFindings(x));
    }
  }
  const ispe = [...boxes].filter(b => b.type === 'ispe').map(b => payload(b)).filter(Boolean) as Uint8Array[];
  let best = { width: 0, height: 0 };
  for (const e of ispe) { const c2 = new Cursor(e); const w = c2.u32(4), h = c2.u32(8); if (w * h > best.width * best.height) best = { width: w, height: h }; }
  if (best.width) res.image = best;
  const counts: Record<string, number> = {};
  for (const it of items.values()) counts[it.type] = (counts[it.type] ?? 0) + 1;
  res.sections.push({ id: 'heif-items', title: 'HEIF items', fields: [
    ...(best.width ? [{ key: 'dims', label: 'Largest image', value: `${best.width} × ${best.height} px`, mono: true }] : []),
    { key: 'items', label: 'Items', value: Object.entries(counts).map(([k, n]) => `${n}× ${k}`).join(', '), mono: true },
  ] });
  if ((counts.hvc1 ?? 0) + (counts.av01 ?? 0) > 8 && !res.findings.some(f => f.tag === 'THUMBNAIL')) {
    res.findings.push({ id: 'heif-tiles', severity: 'info', tag: 'THUMBNAIL', title: 'Stores tiles plus a separate preview', detail: 'HEIC keeps the photo as a grid of tiles plus a smaller preview item. Edited copies can keep a stale preview.', evidence: [] });
  }
}

function rebase(n: StructNode, shift: number): void {
  n.range.offset += shift;
  n.id += `+${shift}`;
  n.children?.forEach(c => rebase(c, shift));
}

export type { Finding };
