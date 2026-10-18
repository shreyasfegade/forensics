// JPEG: marker-segment walker. Emits every segment as structure, hands EXIF
// to the TIFF engine, and finds the true end of image (EOI) so anything
// appended after it is visible.
import type { Finding, ParseResult, StructNode } from '../core/types';
import { emptyResult } from '../core/types';
import { ascii, cstring, previewHex, previewText, startsWith, utf8 } from '../util/bytes';
import { fingerprint, parseDqt, type QTable } from '../analysis/dqt';
import { parseTiff, tiffFindings, tiffSections, type TiffResult } from './tiff';
import { parseXmp, xmpFindings, xmpSection, type XmpData } from './xmp';

export interface JpegSegment {
  marker: number;
  offset: number;
  /** Total bytes including the 0xFFxx marker (for SOS: header + entropy-coded data). */
  length: number;
  payloadOffset: number;
  payloadLength: number;
  name: string;
}

export interface JpegScan {
  segments: JpegSegment[];
  /** Offset just past EOI, or -1 if no EOI was found. */
  end: number;
}

const XMP_SIG = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXT_SIG = 'http://ns.adobe.com/xmp/extension/\0';

function markerName(m: number, bytes: Uint8Array, payload: number): string {
  if (m >= 0xe0 && m <= 0xef) {
    const id = cstring(bytes, payload, 32);
    const n = `APP${m - 0xe0}`;
    if (m === 0xe1 && startsWith(bytes, [0x45, 0x78, 0x69, 0x66, 0, 0], payload)) return `${n} · Exif`;
    if (m === 0xe1 && ascii(bytes, payload, payload + XMP_SIG.length) === XMP_SIG) return `${n} · XMP`;
    if (m === 0xe1 && ascii(bytes, payload, payload + XMP_EXT_SIG.length) === XMP_EXT_SIG) return `${n} · Extended XMP`;
    return id && /^[\x20-\x7e]+$/.test(id) ? `${n} · ${id.slice(0, 24)}` : n;
  }
  if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return `SOF${m - 0xc0} · frame header`;
  const names: Record<number, string> = { 0xc4: 'DHT · Huffman tables', 0xdb: 'DQT · quantisation tables', 0xdd: 'DRI · restart interval', 0xda: 'SOS · scan', 0xfe: 'COM · comment', 0xcc: 'DAC' };
  return names[m] ?? `Marker 0xFF${m.toString(16).toUpperCase()}`;
}

export function scanJpeg(bytes: Uint8Array): JpegScan {
  const segments: JpegSegment[] = [];
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return { segments, end: -1 };
  segments.push({ marker: 0xd8, offset: 0, length: 2, payloadOffset: 2, payloadLength: 0, name: 'SOI · start of image' });
  let i = 2;
  const n = bytes.length;
  while (i < n - 1) {
    if (bytes[i] !== 0xff) { i++; continue; }
    while (i < n - 1 && bytes[i + 1] === 0xff) i++;
    if (i >= n - 1) break;
    const m = bytes[i + 1];
    if (m === 0xd9) {
      segments.push({ marker: m, offset: i, length: 2, payloadOffset: i + 2, payloadLength: 0, name: 'EOI · end of image' });
      return { segments, end: i + 2 };
    }
    if (m === 0x00 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (i + 4 > n) break;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) { i += 2; continue; }
    const seg: JpegSegment = { marker: m, offset: i, length: 2 + len, payloadOffset: i + 4, payloadLength: len - 2, name: '' };
    seg.name = markerName(m, bytes, i + 4);
    if (m === 0xda) {
      // Entropy-coded data runs until the next real marker.
      let j = i + 2 + len;
      while (j < n - 1) {
        if (bytes[j] === 0xff) {
          const nx = bytes[j + 1];
          if (nx === 0x00 || (nx >= 0xd0 && nx <= 0xd7) || nx === 0xff) { j += nx === 0xff ? 1 : 2; continue; }
          break;
        }
        j++;
      }
      seg.length = Math.min(j, n) - i;
      segments.push(seg);
      i = j;
      continue;
    }
    segments.push(seg);
    i += 2 + len;
  }
  return { segments, end: -1 };
}

const IPTC: Record<number, [string, boolean]> = {
  5: ['Object name', false], 25: ['Keywords', false], 80: ['By-line (author)', true], 85: ['By-line title', true],
  90: ['City', true], 92: ['Sub-location', true], 95: ['Province/state', true], 101: ['Country', true],
  103: ['Transmission reference', false], 105: ['Headline', false], 110: ['Credit', true], 115: ['Source', false],
  116: ['Copyright notice', true], 118: ['Contact', true], 120: ['Caption', true], 122: ['Caption writer', true],
  55: ['Date created', false], 60: ['Time created', false], 62: ['Digital creation date', false],
};

function parseIptc(bytes: Uint8Array, start: number, end: number) {
  const out: { label: string; value: string; sensitive: boolean; offset: number; length: number }[] = [];
  // Photoshop image resource blocks: '8BIM', id, pascal name, size, data.
  let i = start;
  while (i + 12 <= end) {
    if (ascii(bytes, i, i + 4) !== '8BIM') break;
    const id = (bytes[i + 4] << 8) | bytes[i + 5];
    let p = i + 6;
    const nameLen = bytes[p];
    p += 1 + nameLen + ((nameLen + 1) % 2);
    const size = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
    p += 4;
    if (size < 0 || p + size > end) break;
    if (id === 0x0404) {
      let k = p;
      while (k + 5 <= p + size && bytes[k] === 0x1c) {
        const rec = bytes[k + 1], ds = bytes[k + 2], len = (bytes[k + 3] << 8) | bytes[k + 4];
        const v = utf8(bytes.subarray(k + 5, k + 5 + len)).trim();
        if (rec === 2 && IPTC[ds] && v) out.push({ label: IPTC[ds][0], value: v, sensitive: IPTC[ds][1], offset: k + 5, length: len });
        k += 5 + len;
      }
    }
    i = p + size + (size % 2);
  }
  return out;
}

export interface JpegParse extends ParseResult {
  scan: JpegScan;
  tiff?: TiffResult;
  xmp?: XmpData;
}

export function parseJpeg(bytes: Uint8Array): JpegParse {
  const res = emptyResult() as JpegParse;
  const scan = scanJpeg(bytes);
  res.scan = scan;
  const nodes: StructNode[] = [];
  const tables: QTable[] = [];
  let adobe = false;
  const comments: { text: string; offset: number; length: number }[] = [];
  const iptc: ReturnType<typeof parseIptc> = [];

  for (const s of scan.segments) {
    const node: StructNode = { id: `jpeg@${s.offset}`, label: s.name, kind: 'segment', range: { offset: s.offset, length: s.length } };
    nodes.push(node);
    const p = s.payloadOffset, pe = p + s.payloadLength;
    if (s.marker === 0xe1 && s.name.endsWith('Exif') && !res.tiff) {
      const t = parseTiff(bytes, p + 6, pe, 'EXIF (TIFF structure)');
      if (t) { res.tiff = t; node.children = [t.structure]; }
    } else if (s.marker === 0xe1 && s.name.endsWith('· XMP') && !res.xmp) {
      res.xmp = parseXmp(utf8(bytes.subarray(p + XMP_SIG.length, pe)), { offset: s.offset, length: s.length });
    } else if (s.marker === 0xed && ascii(bytes, p, p + 14) === 'Photoshop 3.0\0') {
      iptc.push(...parseIptc(bytes, p + 14, pe));
    } else if (s.marker === 0xee && ascii(bytes, p, p + 5) === 'Adobe') {
      adobe = true;
    } else if (s.marker === 0xfe) {
      comments.push({ text: utf8(bytes.subarray(p, pe)).replace(/\0+$/, '').trim(), offset: p, length: s.payloadLength });
    } else if (s.marker === 0xdb) {
      tables.push(...parseDqt(bytes.subarray(p, pe)));
    } else if (s.marker >= 0xc0 && s.marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(s.marker) && !res.image) {
      res.image = { height: (bytes[p + 1] << 8) | bytes[p + 2], width: (bytes[p + 3] << 8) | bytes[p + 4], bitDepth: bytes[p], colorType: `${bytes[p + 5]} component${bytes[p + 5] === 1 ? '' : 's'}${s.marker === 0xc2 ? ', progressive' : ''}` };
    }
  }

  if (scan.end > 0 && scan.end < bytes.length) {
    const tail = bytes.subarray(scan.end);
    nodes.push({ id: `trail@${scan.end}`, label: 'Data after end of image', kind: 'trailing', range: { offset: scan.end, length: tail.length } });
    res.hidden = { offset: scan.end, length: tail.length, previewHex: previewHex(tail), previewText: previewText(tail) };
  }
  res.structure = nodes;

  if (res.tiff) {
    res.sections.push(...tiffSections(res.tiff));
    res.findings.push(...tiffFindings(res.tiff, 'photo'));
    res.gps = res.tiff.gps;
    if (res.tiff.thumbnail) {
      res.thumbnail = { range: res.tiff.thumbnail, mime: 'image/jpeg' };
      const th = scanJpeg(bytes.subarray(res.tiff.thumbnail.offset, res.tiff.thumbnail.offset + res.tiff.thumbnail.length));
      const sof = th.segments.find(s => s.marker >= 0xc0 && s.marker <= 0xc3);
      if (sof) {
        const base = res.tiff.thumbnail.offset + sof.payloadOffset;
        res.thumbnail.height = (bytes[base + 1] << 8) | bytes[base + 2];
        res.thumbnail.width = (bytes[base + 3] << 8) | bytes[base + 4];
      }
      res.findings.push({
        id: 'thumbnail', severity: 'info', tag: 'THUMBNAIL', fixable: true,
        title: 'Embedded preview image',
        detail: `A ${res.thumbnail.width ?? '?'}×${res.thumbnail.height ?? '?'} thumbnail is stored inside the EXIF block. Editors often leave it untouched, so it can show the picture before cropping or retouching.`,
        evidence: [res.tiff.thumbnail],
      });
    }
  }
  if (res.xmp) {
    const sec = xmpSection(res.xmp);
    if (sec) res.sections.push(sec);
    res.findings.push(...xmpFindings(res.xmp));
  }
  if (iptc.length) {
    res.sections.push({ id: 'iptc', title: 'IPTC (Photoshop) metadata', fields: iptc.map((f, i) => ({ key: `iptc${i}`, label: f.label, value: f.value, sensitive: f.sensitive, range: { offset: f.offset, length: f.length } })) });
    const named = iptc.filter(f => f.sensitive);
    if (named.length) res.findings.push({ id: 'iptc', severity: 'caution', tag: 'AUTHOR', fixable: true, title: 'IPTC credits and captions', detail: named.slice(0, 4).map(f => `${f.label}: ${f.value.slice(0, 60)}`).join(' · '), evidence: named.map(f => ({ offset: f.offset, length: f.length })) });
  }
  if (comments.some(c => c.text)) {
    const c = comments.filter(c => c.text);
    res.sections.push({ id: 'jpeg-com', title: 'JPEG comments', fields: c.map((x, i) => ({ key: `com${i}`, label: `Comment ${i + 1}`, value: x.text.slice(0, 400), range: { offset: x.offset, length: x.length } })) });
    res.findings.push({ id: 'jpeg-com', severity: 'info', tag: 'COMMENT', fixable: true, title: 'Comment segment', detail: `“${c[0].text.slice(0, 120)}”${/^(CREATOR: gd-jpeg|Created with GIMP|LEAD Technologies|Optimized by JPEGmini)/.test(c[0].text) ? ' (left by the encoding software)' : ''}`, evidence: c.map(x => ({ offset: x.offset, length: x.length })) });
  }
  if (tables.length) {
    res.quant = fingerprint(tables, adobe);
    res.sections.push({ id: 'jpeg-quant', title: 'Compression fingerprint', fields: [
      { key: 'q.est', label: 'Estimated quality', value: res.quant.qualityEstimate != null ? `≈ ${res.quant.qualityEstimate} / 100` : 'unknown', mono: true },
      { key: 'q.match', label: 'Tables', value: res.quant.match ?? '' },
      { key: 'q.n', label: 'Quantisation tables', value: String(tables.length), mono: true },
    ] });
  }
  if (res.image) {
    res.sections.push({ id: 'jpeg-frame', title: 'Frame', fields: [
      { key: 'dims', label: 'Dimensions', value: `${res.image.width} × ${res.image.height} px`, mono: true },
      { key: 'comp', label: 'Encoding', value: `${res.image.bitDepth}-bit, ${res.image.colorType}` },
      { key: 'segs', label: 'Segments', value: String(scan.segments.length), mono: true },
    ] });
  }
  if (scan.end < 0) res.notes = ['No end-of-image marker was found. The file is truncated or not a complete JPEG.'];
  return res;
}

export function trailingFinding(hidden: { offset: number; length: number }, bytes: Uint8Array | null, container: string): Finding {
  const tail = bytes ? bytes.subarray(hidden.offset, hidden.offset + 16) : null;
  const isJpeg = !!tail && tail[0] === 0xff && tail[1] === 0xd8 && tail[2] === 0xff;
  const isZip = !!tail && tail[0] === 0x50 && tail[1] === 0x4b && tail[2] === 0x03;
  const allZero = !!tail && tail.every(b => b === 0);
  if (isJpeg) {
    return { id: 'trailing', severity: 'caution', tag: 'PAYLOAD', fixable: true, title: 'Second image appended', detail: `${hidden.length.toLocaleString()} bytes after the ${container}'s end marker form another JPEG. Phones do this for depth maps and HDR gain maps (MPF), but it can also be a hidden original.`, evidence: [hidden] };
  }
  if (allZero && hidden.length < 4096) {
    return { id: 'trailing', severity: 'info', tag: 'PAYLOAD', fixable: true, title: 'Zero padding after end marker', detail: `${hidden.length.toLocaleString()} zero bytes follow the ${container}'s end marker. Usually harmless padding.`, evidence: [hidden] };
  }
  return { id: 'trailing', severity: 'exposed', tag: 'PAYLOAD', fixable: true, title: isZip ? 'ZIP archive hidden after the image' : 'Data hidden after the end marker', detail: `${hidden.length.toLocaleString()} bytes sit past the ${container}'s official end. Viewers ignore them, so they're a classic hiding place for appended payloads and polyglot files.`, evidence: [hidden] };
}

