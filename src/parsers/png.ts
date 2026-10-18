// PNG: chunk walker. Walks length/type/CRC records properly (the V1 code
// searched for the bytes "IEND" anywhere, which can match inside image data).
import type { Field, ParseResult, StructNode } from '../core/types';
import { emptyResult } from '../core/types';
import { ascii, Cursor, previewHex, previewText, utf8 } from '../util/bytes';
import { tryInflate } from '../util/inflate';
import { parseTiff, tiffFindings, tiffSections, type TiffResult } from './tiff';
import { parseXmp, xmpFindings, xmpSection } from './xmp';

export interface PngChunk {
  type: string;
  offset: number;
  dataOffset: number;
  length: number;
  /** Whole record: 4 length + 4 type + data + 4 CRC. */
  total: number;
}

export interface PngScan {
  chunks: PngChunk[];
  end: number;
  ok: boolean;
}

export const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function scanPng(bytes: Uint8Array): PngScan {
  const chunks: PngChunk[] = [];
  const c = new Cursor(bytes);
  let i = 8;
  while (c.has(i, 12)) {
    const length = c.u32(i);
    const type = ascii(bytes, i + 4, i + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || length > 0x7fffffff || !c.has(i, 12 + length)) {
      return { chunks, end: -1, ok: false };
    }
    chunks.push({ type, offset: i, dataOffset: i + 8, length, total: 12 + length });
    i += 12 + length;
    if (type === 'IEND') return { chunks, end: i, ok: true };
  }
  return { chunks, end: -1, ok: false };
}

const COLOR = ['Grayscale', '', 'RGB', 'Indexed', 'Grayscale + alpha', '', 'RGBA'];

const TEXT_SENSITIVE = /author|artist|copyright|creator|owner|comment|description|location|gps|source|user|disclaimer/i;

export async function parsePng(bytes: Uint8Array): Promise<ParseResult & { tiff?: TiffResult; scan: PngScan }> {
  const res = emptyResult() as ParseResult & { tiff?: TiffResult; scan: PngScan };
  const scan = scanPng(bytes);
  res.scan = scan;
  const nodes: StructNode[] = [{ id: 'png-sig', label: 'PNG signature', kind: 'header', range: { offset: 0, length: 8 } }];
  const text: Field[] = [];
  let idat: StructNode | null = null;
  const c = new Cursor(bytes);

  for (const ch of scan.chunks) {
    const range = { offset: ch.offset, length: ch.total };
    if (ch.type === 'IDAT') {
      if (!idat) {
        idat = { id: `idat@${ch.offset}`, label: 'IDAT · image data', kind: 'chunk-group', range: { ...range }, children: [] };
        nodes.push(idat);
      }
      idat.range.length = ch.offset + ch.total - idat.range.offset;
      idat.children!.push({ id: `png@${ch.offset}`, label: `IDAT · ${ch.length.toLocaleString()} B`, kind: 'chunk', range });
      idat.label = `IDAT · image data (${idat.children!.length} chunk${idat.children!.length > 1 ? 's' : ''})`;
      continue;
    }
    const node: StructNode = { id: `png@${ch.offset}`, label: `${ch.type}${CHUNK_NAMES[ch.type] ? ' · ' + CHUNK_NAMES[ch.type] : ''}`, kind: 'chunk', range };
    nodes.push(node);
    const d = ch.dataOffset, de = d + ch.length;
    if (ch.type === 'IHDR' && ch.length >= 13) {
      res.image = { width: c.u32(d), height: c.u32(d + 4), bitDepth: bytes[d + 8], colorType: COLOR[bytes[d + 9]] || `type ${bytes[d + 9]}` };
    } else if (ch.type === 'tEXt') {
      const z = bytes.indexOf(0, d);
      if (z > d && z < de) text.push(textField(ascii(bytes, d, z), latin1Text(bytes, z + 1, de), ch));
    } else if (ch.type === 'zTXt') {
      const z = bytes.indexOf(0, d);
      if (z > d && z + 2 <= de) {
        const out = await tryInflate(bytes.subarray(z + 2, de), 'deflate', 1 << 20);
        text.push(textField(ascii(bytes, d, z), out ? latin1Text(out, 0, out.length) : '(compressed text could not be decoded)', ch));
      }
    } else if (ch.type === 'iTXt') {
      const z = bytes.indexOf(0, d);
      if (z > d && z + 3 < de) {
        const keyword = ascii(bytes, d, z);
        const compressed = bytes[z + 1] === 1;
        let p = z + 3;
        const langEnd = bytes.indexOf(0, p); p = langEnd + 1;
        const transEnd = bytes.indexOf(0, p); p = transEnd + 1;
        if (langEnd > 0 && transEnd > 0 && p <= de) {
          let body: Uint8Array | null = bytes.subarray(p, de);
          if (compressed) body = await tryInflate(body, 'deflate', 4 << 20);
          const str = body ? utf8(body) : '(compressed text could not be decoded)';
          if (keyword === 'XML:com.adobe.xmp') {
            const x = parseXmp(str, range);
            const sec = xmpSection(x, 'png-xmp');
            if (sec) res.sections.push(sec);
            res.findings.push(...xmpFindings(x));
          } else text.push(textField(keyword, str, ch));
        }
      }
    } else if (ch.type === 'eXIf') {
      const t = parseTiff(bytes, d, de, 'EXIF (TIFF structure)');
      if (t) { res.tiff = t; node.children = [t.structure]; }
    } else if (ch.type === 'tIME' && ch.length >= 7) {
      const y = (bytes[d] << 8) | bytes[d + 1];
      text.push({ key: 'tIME', label: 'Last modified (tIME)', value: `${y}-${p2(bytes[d + 2])}-${p2(bytes[d + 3])} ${p2(bytes[d + 4])}:${p2(bytes[d + 5])}:${p2(bytes[d + 6])} UTC`, range, mono: true });
    } else if (ch.type === 'pHYs' && ch.length >= 9 && bytes[d + 8] === 1) {
      text.push({ key: 'pHYs', label: 'Pixel density', value: `${Math.round(c.u32(d) * 0.0254)} dpi`, range, mono: true });
    }
  }

  if (scan.end > 0 && scan.end < bytes.length) {
    const tail = bytes.subarray(scan.end);
    nodes.push({ id: `trail@${scan.end}`, label: 'Data after IEND', kind: 'trailing', range: { offset: scan.end, length: tail.length } });
    res.hidden = { offset: scan.end, length: tail.length, previewHex: previewHex(tail), previewText: previewText(tail) };
  }
  res.structure = nodes;

  if (res.image) {
    res.sections.push({ id: 'png-header', title: 'Image header', fields: [
      { key: 'dims', label: 'Dimensions', value: `${res.image.width} × ${res.image.height} px`, mono: true },
      { key: 'depth', label: 'Colour', value: `${res.image.colorType}, ${res.image.bitDepth}-bit` },
      { key: 'chunks', label: 'Chunks', value: String(scan.chunks.length), mono: true },
    ] });
  }
  if (text.length) {
    res.sections.push({ id: 'png-text', title: 'Text chunks', fields: text });
    const named = text.filter(f => f.sensitive);
    const software = text.find(f => /^software$/i.test(f.label));
    if (named.length) {
      res.findings.push({ id: 'png-text', severity: 'caution', tag: 'AUTHOR', fixable: true, title: 'Text metadata with names or notes', detail: named.slice(0, 3).map(f => `${f.label}: ${f.value.slice(0, 80)}`).join(' · '), evidence: named.map(f => f.range!).filter(Boolean) });
    } else if (text.some(f => f.key.startsWith('text:'))) {
      res.findings.push({ id: 'png-text', severity: 'info', tag: 'COMMENT', fixable: true, title: 'Text metadata', detail: text.filter(f => f.key.startsWith('text:')).slice(0, 3).map(f => `${f.label}: ${f.value.slice(0, 60)}`).join(' · '), evidence: text.map(f => f.range!).filter(Boolean) });
    }
    if (software && /photoshop|gimp|affinity|pixelmator|paint\.net|krita/i.test(software.value)) {
      res.findings.push({ id: 'edited', severity: 'info', tag: 'EDITED', title: 'Saved by an image editor', detail: `Software: ${software.value}.`, evidence: [software.range!] });
    }
  }
  if (res.tiff) {
    res.sections.push(...tiffSections(res.tiff));
    res.findings.push(...tiffFindings(res.tiff, 'image'));
    res.gps = res.tiff.gps;
  }
  if (!scan.ok) res.notes = ['The chunk sequence is broken or has no IEND chunk, so the file is truncated or malformed.'];
  return res;
}

const CHUNK_NAMES: Record<string, string> = {
  IHDR: 'header', PLTE: 'palette', IEND: 'end', tEXt: 'text', zTXt: 'compressed text', iTXt: 'international text',
  eXIf: 'EXIF', tIME: 'modified time', pHYs: 'pixel size', gAMA: 'gamma', cHRM: 'chromaticity', sRGB: 'colour space',
  iCCP: 'ICC profile', bKGD: 'background', tRNS: 'transparency', acTL: 'animation control', fcTL: 'frame control', fdAT: 'frame data',
  sBIT: 'significant bits', hIST: 'histogram', sPLT: 'suggested palette', iDOT: 'Apple decode hint', caBX: 'C2PA content credentials',
};

function textField(keyword: string, value: string, ch: PngChunk): Field {
  return { key: `text:${keyword}`, label: keyword, value: value.slice(0, 600), range: { offset: ch.offset, length: ch.total }, sensitive: TEXT_SENSITIVE.test(keyword) };
}

function latin1Text(b: Uint8Array, s: number, e: number): string {
  let out = '';
  for (let i = s; i < Math.min(e, b.length); i++) out += String.fromCharCode(b[i]);
  return out.trim();
}

function p2(n: number): string { return String(n).padStart(2, '0'); }
