// RIFF containers: WebP (VP8/VP8L/VP8X + EXIF/XMP chunks) and WAV/AVI listings.
import type { ParseResult, StructNode } from '../core/types';
import { emptyResult } from '../core/types';
import { ascii, Cursor, utf8 } from '../util/bytes';
import { parseTiff, tiffFindings, tiffSections } from './tiff';
import { parseXmp, xmpFindings, xmpSection } from './xmp';

export interface RiffChunk { id: string; offset: number; dataOffset: number; size: number }

export function scanRiff(bytes: Uint8Array): RiffChunk[] {
  const c = new Cursor(bytes, true);
  const out: RiffChunk[] = [];
  const end = Math.min(bytes.length, 8 + c.u32(4));
  let p = 12;
  while (p + 8 <= end && out.length < 5000) {
    const size = c.u32(p + 4);
    out.push({ id: ascii(bytes, p, p + 4), offset: p, dataOffset: p + 8, size });
    p += 8 + size + (size & 1);
  }
  return out;
}

export function parseRiff(bytes: Uint8Array, form: string): ParseResult {
  const res = emptyResult();
  const c = new Cursor(bytes, true);
  const chunks = scanRiff(bytes);
  res.structure = [{ id: 'riff', label: `RIFF · ${form}`, kind: 'header', range: { offset: 0, length: 12 } }, ...chunks.map<StructNode>(ch => ({ id: `riff@${ch.offset}`, label: ch.id, kind: 'chunk', range: { offset: ch.offset, length: 8 + ch.size } }))];
  const riffEnd = 8 + c.u32(4);
  if (riffEnd < bytes.length) res.hidden = { offset: riffEnd, length: bytes.length - riffEnd, previewHex: '', previewText: '' };
  for (const ch of chunks) {
    const d = ch.dataOffset, e = Math.min(d + ch.size, bytes.length);
    if (ch.id === 'VP8X' && ch.size >= 10) res.image = { width: 1 + (bytes[d + 4] | (bytes[d + 5] << 8) | (bytes[d + 6] << 16)), height: 1 + (bytes[d + 7] | (bytes[d + 8] << 8) | (bytes[d + 9] << 16)) };
    else if (ch.id === 'VP8 ' && !res.image && ch.size >= 10) res.image = { width: c.u16(d + 6) & 0x3fff, height: c.u16(d + 8) & 0x3fff };
    else if (ch.id === 'VP8L' && !res.image && ch.size >= 5) { const b = c.u32(d + 1); res.image = { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
    else if (ch.id === 'EXIF') {
      const start = ascii(bytes, d, d + 6) === 'Exif\0\0' ? d + 6 : d;
      const t = parseTiff(bytes, start, e, 'EXIF (TIFF structure)');
      if (t) { res.sections.push(...tiffSections(t, 'webp')); res.findings.push(...tiffFindings(t, 'image')); res.gps = t.gps; }
    } else if (ch.id === 'XMP ') {
      const x = parseXmp(utf8(bytes.subarray(d, e)), { offset: ch.offset, length: 8 + ch.size });
      const s = xmpSection(x, 'webp-xmp');
      if (s) res.sections.push(s);
      res.findings.push(...xmpFindings(x));
    } else if (ch.id === 'LIST' && ascii(bytes, d, d + 4) === 'INFO') {
      const fields = [];
      let p = d + 4;
      while (p + 8 <= e) {
        const id = ascii(bytes, p, p + 4), sz = c.u32(p + 4);
        const v = ascii(bytes, p + 8, p + 8 + sz).replace(/\0+$/, '').trim();
        if (v) fields.push({ key: id, label: INFO[id] ?? id, value: v, sensitive: ['IART', 'ICMT', 'ICOP', 'IENG', 'ITCH'].includes(id), range: { offset: p, length: 8 + sz } });
        p += 8 + sz + (sz & 1);
      }
      if (fields.length) {
        res.sections.push({ id: 'riff-info', title: 'INFO tags', fields });
        const named = fields.filter(f => f.sensitive);
        if (named.length) res.findings.push({ id: 'riff-info', severity: 'caution', tag: 'AUTHOR', fixable: false, title: 'Names in INFO tags', detail: named.map(f => `${f.label}: ${f.value}`).join(' · '), evidence: named.map(f => f.range) });
      }
    }
  }
  if (res.image) res.sections.push({ id: 'riff-img', title: 'Image', fields: [{ key: 'dims', label: 'Dimensions', value: `${res.image.width} × ${res.image.height} px`, mono: true }] });
  return res;
}

const INFO: Record<string, string> = { IART: 'Artist', ICMT: 'Comment', ICOP: 'Copyright', ICRD: 'Created', IENG: 'Engineer', INAM: 'Title', IPRD: 'Product', ISFT: 'Software', ITCH: 'Technician', ISBJ: 'Subject', IGNR: 'Genre' };
