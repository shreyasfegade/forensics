// Lossless metadata removal. Nothing here re-encodes pixels or media: output
// is assembled from untouched byte ranges of the original plus small
// rewritten pieces, or the original is patched in place at the same length.
import type { FileType } from '../core/types';
import { ascii, concat, Cursor, latin1 } from '../util/bytes';
import { crc32 } from '../util/crc32';
import { scanJpeg } from '../parsers/jpeg';
import { parseTiff } from '../parsers/tiff';
import { scanPng, PNG_SIG } from '../parsers/png';
import { scanRiff } from '../parsers/riff';
import { readZipDir, type ZipDir } from '../parsers/zip';
import { parseIsobmff } from '../parsers/isobmff';
import { BytesSource } from '../util/source';

export interface SanitizeResult {
  bytes: Uint8Array;
  actions: string[];
  /** Bytes removed or blanked. */
  removed: number;
}

export async function sanitize(bytes: Uint8Array, type: FileType): Promise<SanitizeResult> {
  switch (type.ext) {
    case 'jpg': return sanitizeJpeg(bytes);
    case 'png': return sanitizePng(bytes);
    case 'webp': return sanitizeWebp(bytes);
    case 'docx': case 'xlsx': case 'pptx': return sanitizeOoxml(bytes);
    case 'pdf': return sanitizePdf(bytes);
    case 'mp4': case 'mov': case '3gp': case 'm4a': case 'heic': case 'heif': case 'avif': return sanitizeIso(bytes, type.category === 'image');
    case 'tiff': return sanitizeTiff(bytes);
  }
  throw new Error(`Cleaning isn't supported for ${type.name}.`);
}

// ------------------------------------------------------------------ JPEG

function minimalExif(orientation: number): Uint8Array {
  // APP1 "Exif\0\0" + little-endian TIFF with a single Orientation entry.
  const tiff = new Uint8Array(8 + 2 + 12 + 4);
  const v = new DataView(tiff.buffer);
  tiff[0] = 0x49; tiff[1] = 0x49; v.setUint16(2, 42, true); v.setUint32(4, 8, true);
  v.setUint16(8, 1, true);
  v.setUint16(10, 0x0112, true); v.setUint16(12, 3, true); v.setUint32(14, 1, true); v.setUint16(18, orientation, true);
  v.setUint32(22, 0, true);
  const payload = concat([latin1('Exif\0\0'), tiff]);
  const seg = new Uint8Array(4 + payload.length);
  seg[0] = 0xff; seg[1] = 0xe1; seg[2] = (payload.length + 2) >> 8; seg[3] = (payload.length + 2) & 0xff;
  seg.set(payload, 4);
  return seg;
}

export function sanitizeJpeg(bytes: Uint8Array): SanitizeResult {
  const scan = scanJpeg(bytes);
  if (!scan.segments.length) throw new Error('Not a readable JPEG.');
  const parts: Uint8Array[] = [];
  const actions: string[] = [];
  let orientation = 1;
  let removed = 0;
  for (const s of scan.segments) {
    if (s.marker === 0xe1 && s.name.endsWith('Exif')) {
      const t = parseTiff(bytes, s.payloadOffset + 6, s.payloadOffset + s.payloadLength);
      const o = t?.get('IFD0', 0x0112)?.value;
      if (Array.isArray(o) && o[0] > 1 && o[0] <= 8) orientation = o[0];
    }
  }
  let insertedExif = false;
  for (const s of scan.segments) {
    const m = s.marker;
    const keep =
      m === 0xd8 || m === 0xd9 || !(m >= 0xe0 && m <= 0xef || m === 0xfe) ||
      m === 0xe0 && /JFIF|JFXX/.test(ascii(bytes, s.payloadOffset, s.payloadOffset + 5)) ||
      m === 0xe2 && ascii(bytes, s.payloadOffset, s.payloadOffset + 12) === 'ICC_PROFILE\0' ||
      m === 0xee && ascii(bytes, s.payloadOffset, s.payloadOffset + 5) === 'Adobe';
    if (keep) {
      parts.push(bytes.subarray(s.offset, s.offset + s.length));
      // Orientation block goes right after SOI/APP0 so viewers still rotate correctly.
      if (!insertedExif && orientation > 1 && (m === 0xe0 || (m === 0xd8 && !scan.segments.some(x => x.marker === 0xe0)))) {
        parts.push(minimalExif(orientation));
        insertedExif = true;
      }
    } else {
      actions.push(`Removed ${s.name} (${s.length.toLocaleString()} B)`);
      removed += s.length;
    }
  }
  if (scan.end < 0) {
    // No EOI: keep everything after the last segment so we don't truncate image data.
    const last = scan.segments[scan.segments.length - 1];
    parts.push(bytes.subarray(last.offset + last.length));
  } else if (scan.end < bytes.length) {
    actions.push(`Removed ${(bytes.length - scan.end).toLocaleString()} B after end of image`);
    removed += bytes.length - scan.end;
  }
  if (insertedExif) actions.push(`Kept orientation (${orientation}) in a minimal EXIF block`);
  return { bytes: concat(parts), actions, removed };
}

// ------------------------------------------------------------------ PNG

const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs', 'bKGD', 'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCv', 'cLLi']);

export function sanitizePng(bytes: Uint8Array): SanitizeResult {
  const scan = scanPng(bytes);
  if (!scan.chunks.length) throw new Error('Not a readable PNG.');
  const parts: Uint8Array[] = [Uint8Array.from(PNG_SIG)];
  const actions: string[] = [];
  let removed = 0;
  for (const ch of scan.chunks) {
    const critical = ch.type[0] === ch.type[0].toUpperCase();
    if (PNG_KEEP.has(ch.type) || (critical && !PNG_KEEP.has(ch.type) && ch.type !== 'IEND')) parts.push(bytes.subarray(ch.offset, ch.offset + ch.total));
    else { actions.push(`Removed ${ch.type} chunk (${ch.total.toLocaleString()} B)`); removed += ch.total; }
  }
  const end = scan.end > 0 ? scan.end : bytes.length;
  if (end < bytes.length) { actions.push(`Removed ${(bytes.length - end).toLocaleString()} B after IEND`); removed += bytes.length - end; }
  return { bytes: concat(parts), actions, removed };
}

// ------------------------------------------------------------------ WebP

export function sanitizeWebp(bytes: Uint8Array): SanitizeResult {
  const chunks = scanRiff(bytes);
  const parts: Uint8Array[] = [bytes.slice(0, 12)];
  const actions: string[] = [];
  let removed = 0;
  for (const ch of chunks) {
    const total = 8 + ch.size + (ch.size & 1);
    if (ch.id === 'EXIF' || ch.id === 'XMP ') { actions.push(`Removed ${ch.id.trim()} chunk (${total.toLocaleString()} B)`); removed += total; continue; }
    let part = bytes.slice(ch.offset, ch.offset + total);
    if (ch.id === 'VP8X') part[8] &= ~(0x08 | 0x04);
    parts.push(part);
  }
  const out = concat(parts);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return { bytes: out, actions, removed };
}

// ------------------------------------------------------------------ OOXML

const CORE_EMPTY = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"></cp:coreProperties>';
const APP_EMPTY = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>';
const CUSTOM_EMPTY = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>';

export async function sanitizeOoxml(bytes: Uint8Array): Promise<SanitizeResult> {
  const dir = readZipDir(bytes);
  if (!dir) throw new Error('No ZIP directory found.');
  const enc = new TextEncoder();
  const actions: string[] = [];
  const thumbs = dir.entries.filter(e => /^docProps\/thumbnail\./i.test(e.name)).map(e => e.name);
  const replace = new Map<string, Uint8Array>();
  if (dir.entries.some(e => e.name === 'docProps/core.xml')) { replace.set('docProps/core.xml', enc.encode(CORE_EMPTY)); actions.push('Cleared docProps/core.xml (author, last modified by, revision, dates)'); }
  if (dir.entries.some(e => e.name === 'docProps/app.xml')) { replace.set('docProps/app.xml', enc.encode(APP_EMPTY)); actions.push('Cleared docProps/app.xml (company, manager, editing time, template, app version)'); }
  if (dir.entries.some(e => e.name === 'docProps/custom.xml')) { replace.set('docProps/custom.xml', enc.encode(CUSTOM_EMPTY)); actions.push('Cleared custom properties'); }
  if (thumbs.length) {
    const rels = dir.entries.find(e => e.name === '_rels/.rels');
    if (rels) {
      const { readEntry } = await import('../parsers/zip');
      const data = await readEntry(bytes, rels);
      if (data) {
        let xml = new TextDecoder().decode(data);
        for (const t of thumbs) xml = xml.replace(new RegExp(`<Relationship[^>]*Target="/?${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*/>`, 'g'), '');
        replace.set('_rels/.rels', enc.encode(xml));
        actions.push(`Removed saved preview ${thumbs.join(', ')}`);
      }
    }
  }
  const out = rebuildZip(bytes, dir, replace, new Set(thumbs));
  actions.push('Reset ZIP entry timestamps to 1980-01-01');
  return { bytes: out, actions, removed: Math.max(0, bytes.length - out.length) };
}

function rebuildZip(bytes: Uint8Array, dir: ZipDir, replace: Map<string, Uint8Array>, drop: Set<string>): Uint8Array {
  const c = new Cursor(bytes, true);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const enc = new TextEncoder();
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  let offset = 0;
  for (const e of dir.entries) {
    if (drop.has(e.name)) continue;
    const rep = replace.get(e.name);
    let local: Uint8Array;
    let cd = bytes.slice(e.cdOffset, e.cdOffset + e.cdLength);
    const cv = new DataView(cd.buffer);
    if (rep) {
      const name = enc.encode(e.name);
      local = new Uint8Array(30 + name.length + rep.length);
      const lv = new DataView(local.buffer);
      const crc = crc32(rep);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
      lv.setUint16(10, 0, true); lv.setUint16(12, DOS_DATE, true); lv.setUint32(14, crc, true);
      lv.setUint32(18, rep.length, true); lv.setUint32(22, rep.length, true); lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
      local.set(name, 30); local.set(rep, 30 + name.length);
      // Central entry: rebuild without extra/comment.
      cd = new Uint8Array(46 + name.length);
      const nv = new DataView(cd.buffer);
      nv.setUint32(0, 0x02014b50, true); nv.setUint16(4, 20, true); nv.setUint16(6, 20, true); nv.setUint16(8, 0x0800, true); nv.setUint16(10, 0, true);
      nv.setUint16(12, 0, true); nv.setUint16(14, DOS_DATE, true); nv.setUint32(16, crc, true);
      nv.setUint32(20, rep.length, true); nv.setUint32(24, rep.length, true); nv.setUint16(28, name.length, true);
      cd.set(name, 46);
      new DataView(cd.buffer).setUint32(42, offset, true);
    } else {
      if (e.dataOffset < 0) throw new Error(`Entry ${e.name} has no local header.`);
      let end = e.dataOffset + e.compressedSize;
      if (e.flags & 8) end += c.has(end, 4) && c.u32(end) === 0x08074b50 ? 16 : 12;
      local = bytes.slice(e.localOffset, end);
      const lv = new DataView(local.buffer);
      lv.setUint16(10, 0, true); lv.setUint16(12, DOS_DATE, true);
      cv.setUint16(12, 0, true); cv.setUint16(14, DOS_DATE, true);
      cv.setUint32(42, offset, true);
    }
    parts.push(local);
    central.push(cd);
    offset += local.length;
  }
  let cdSize = 0;
  for (const x of central) cdSize += x.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  return concat([...parts, ...central, eocd]);
}

// ------------------------------------------------------------------ PDF

const PDF_KEYS = ['Author', 'Creator', 'Producer', 'Company', 'Manager', 'Keywords', 'CreationDate', 'ModDate', 'SourceModified'];

export function sanitizePdf(input: Uint8Array): SanitizeResult {
  const bytes = input.slice();
  const text = Array.from({ length: Math.ceil(bytes.length / 65536) }, (_, i) => String.fromCharCode.apply(null, bytes.subarray(i * 65536, (i + 1) * 65536) as unknown as number[])).join('');
  const actions: string[] = [];
  let removed = 0;
  const counts: Record<string, number> = {};
  for (const key of PDF_KEYS) {
    const re = new RegExp(`/${key}(?![A-Za-z])\\s*`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      let i = m.index + m[0].length;
      if (text[i] === '(') {
        let depth = 1, j = i + 1;
        while (j < text.length && depth > 0) {
          if (text[j] === '\\') { j += 2; continue; }
          if (text[j] === '(') depth++;
          else if (text[j] === ')') depth--;
          if (depth > 0) j++;
        }
        for (let k = i + 1; k < j; k++) bytes[k] = 0x20;
        removed += j - i - 1;
        counts[key] = (counts[key] ?? 0) + 1;
      } else if (text[i] === '<' && text[i + 1] !== '<') {
        const close = text.indexOf('>', i);
        if (close > i) { for (let k = i + 1; k < close; k++) bytes[k] = 0x20; removed += close - i - 1; counts[key] = (counts[key] ?? 0) + 1; }
      }
    }
  }
  for (const [k, n] of Object.entries(counts)) actions.push(`Blanked /${k} (${n} occurrence${n > 1 ? 's' : ''} across revisions)`);
  // Uncompressed XMP packets.
  const empty = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"/><?xpacket end="w"?>';
  let at = 0, packets = 0;
  for (;;) {
    const s = text.indexOf('<?xpacket begin', at);
    if (s < 0) break;
    const endTag = text.indexOf('<?xpacket end', s);
    const e = endTag < 0 ? -1 : text.indexOf('?>', endTag);
    if (e < 0) break;
    const len = e + 2 - s;
    if (len >= empty.length) {
      const fill = empty + ' '.repeat(len - empty.length);
      for (let k = 0; k < len; k++) bytes[s + k] = fill.charCodeAt(k);
      removed += len;
      packets++;
    }
    at = e + 2;
  }
  if (packets) actions.push(`Emptied ${packets} XMP packet${packets > 1 ? 's' : ''}`);
  if (!actions.length) actions.push('No uncompressed metadata values were found to blank');
  return { bytes, actions, removed };
}

// ------------------------------------------------------------------ ISO BMFF

export async function sanitizeIso(input: Uint8Array, heif: boolean): Promise<SanitizeResult> {
  const bytes = input.slice();
  const parsed = await parseIsobmff(new BytesSource(input), heif);
  const actions: string[] = [];
  let removed = 0;
  for (const t of parsed.scrub) {
    if (t.what === 'EXIF item') {
      // Item data, not a box: zero it but keep a valid 4-byte TIFF-offset prefix.
      bytes.fill(0, t.offset + 4, t.offset + t.size);
    } else {
      const hdr = new Cursor(bytes).u32(t.offset) === 1 ? 16 : 8;
      bytes.set(latin1('free'), t.offset + 4);
      bytes.fill(0, t.offset + hdr, t.offset + t.size);
    }
    actions.push(`${t.what === 'EXIF item' ? 'Zeroed' : 'Turned into padding:'} ${t.what} (${t.size.toLocaleString()} B)`);
    removed += t.size;
  }
  if (!actions.length) actions.push('No location or identity metadata boxes found');
  return { bytes, actions, removed };
}

// ------------------------------------------------------------------ TIFF / DNG

const TIFF_BLANK = new Set(['IFD0:315', 'IFD0:316', 'IFD0:33432', 'IFD0:40093', 'IFD0:40092', 'IFD0:50735', 'Exif:42032', 'Exif:42033', 'Exif:42037', 'Exif:42016', 'Exif:37510', 'IFD0:42033']);

export function sanitizeTiff(input: Uint8Array): SanitizeResult {
  const bytes = input.slice();
  const t = parseTiff(input, 0);
  if (!t) throw new Error('Not a readable TIFF.');
  const actions: string[] = [];
  let removed = 0;
  for (const e of t.entries) {
    const gpsValue = e.ifd === 'GPS' && e.tag !== 0;
    if (!gpsValue && !TIFF_BLANK.has(`${e.ifd}:${e.tag}`)) continue;
    const len = e.valueLength || 4;
    bytes.fill(e.type === 2 ? 0x20 : 0, e.valueOffset, e.valueOffset + len);
    if (e.type === 2 && len > 0) bytes[e.valueOffset + len - 1] = 0;
    removed += len;
    actions.push(`Blanked ${e.ifd} ${e.name}`);
  }
  if (!actions.length) actions.push('No sensitive tags found');
  return { bytes, actions, removed };
}
