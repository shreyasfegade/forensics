// TIFF / EXIF engine. One IFD walker shared by JPEG (APP1), PNG (eXIf),
// HEIC (Exif item), WebP (EXIF chunk), and bare TIFF/DNG files.
import type { Field, Finding, GPSFix, Range, Section, StructNode } from '../core/types';
import { Cursor, cstring, utf16le } from '../util/bytes';

export interface TiffEntry {
  ifd: string;
  tag: number;
  name: string;
  type: number;
  count: number;
  entryOffset: number;
  valueOffset: number;
  valueLength: number;
  value: number[] | string | null;
  display: string;
}

export interface TiffResult {
  le: boolean;
  start: number;
  entries: TiffEntry[];
  get(ifd: string, tag: number): TiffEntry | undefined;
  gps?: GPSFix;
  thumbnail?: Range;
  structure: StructNode;
  isDng: boolean;
}

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

type TagDef = [name: string, group: Group, sensitive?: boolean];
type Group = 'image' | 'device' | 'capture' | 'location' | 'people' | 'tech';

const TAGS: Record<string, Record<number, TagDef>> = {
  main: {
    0x0100: ['Image width', 'image'], 0x0101: ['Image height', 'image'], 0x0102: ['Bits per sample', 'tech'],
    0x0103: ['Compression', 'tech'], 0x0106: ['Photometric interpretation', 'tech'],
    0x010e: ['Image description', 'people'], 0x010f: ['Make', 'device'], 0x0110: ['Model', 'device'],
    0x0111: ['Strip offsets', 'tech'], 0x0112: ['Orientation', 'image'], 0x0115: ['Samples per pixel', 'tech'],
    0x0116: ['Rows per strip', 'tech'], 0x0117: ['Strip byte counts', 'tech'], 0x011a: ['X resolution', 'tech'],
    0x011b: ['Y resolution', 'tech'], 0x011c: ['Planar configuration', 'tech'], 0x0128: ['Resolution unit', 'tech'],
    0x0131: ['Software', 'device'], 0x0132: ['Modified', 'capture'], 0x013b: ['Artist', 'people', true],
    0x013c: ['Host computer', 'people', true], 0x013e: ['White point', 'tech'], 0x013f: ['Primary chromaticities', 'tech'],
    0x014a: ['Sub-IFDs', 'tech'],
    0x0201: ['Thumbnail offset', 'tech'], 0x0202: ['Thumbnail length', 'tech'], 0x0211: ['YCbCr coefficients', 'tech'],
    0x0213: ['YCbCr positioning', 'tech'], 0x0214: ['Reference black/white', 'tech'], 0x02bc: ['XMP packet', 'tech'],
    0x4746: ['Rating', 'people'], 0x8298: ['Copyright', 'people', true], 0x83bb: ['IPTC block', 'tech'],
    0x8769: ['Exif IFD pointer', 'tech'], 0x8773: ['ICC profile', 'tech'], 0x8825: ['GPS IFD pointer', 'tech'],
    0x9c9b: ['Windows title', 'people'], 0x9c9c: ['Windows comment', 'people', true], 0x9c9d: ['Windows author', 'people', true],
    0x9c9e: ['Windows keywords', 'people'], 0x9c9f: ['Windows subject', 'people'],
    0xc612: ['DNG version', 'tech'], 0xc614: ['Unique camera model', 'device'], 0xc62f: ['Camera serial number', 'device', true],
    0xa431: ['Body serial number', 'device', true],
  },
  exif: {
    0x829a: ['Exposure time', 'capture'], 0x829d: ['F-number', 'capture'], 0x8822: ['Exposure program', 'capture'],
    0x8827: ['ISO', 'capture'], 0x8830: ['Sensitivity type', 'tech'], 0x9000: ['Exif version', 'tech'],
    0x9003: ['Captured', 'capture'], 0x9004: ['Digitized', 'capture'], 0x9010: ['Time zone offset', 'capture'],
    0x9011: ['Capture time zone', 'capture'], 0x9012: ['Digitized time zone', 'capture'],
    0x9101: ['Components configuration', 'tech'], 0x9201: ['Shutter speed (APEX)', 'capture'], 0x9202: ['Aperture (APEX)', 'capture'],
    0x9203: ['Brightness', 'capture'], 0x9204: ['Exposure bias', 'capture'], 0x9205: ['Max aperture', 'capture'],
    0x9207: ['Metering mode', 'capture'], 0x9208: ['Light source', 'capture'], 0x9209: ['Flash', 'capture'],
    0x920a: ['Focal length', 'capture'], 0x9214: ['Subject area', 'tech'], 0x927c: ['Maker note', 'tech'],
    0x9286: ['User comment', 'people', true], 0x9290: ['Sub-second time', 'tech'], 0x9291: ['Sub-second (original)', 'tech'],
    0x9292: ['Sub-second (digitized)', 'tech'], 0xa000: ['FlashPix version', 'tech'], 0xa001: ['Color space', 'tech'],
    0xa002: ['Pixel width', 'image'], 0xa003: ['Pixel height', 'image'], 0xa005: ['Interop IFD pointer', 'tech'],
    0xa217: ['Sensing method', 'tech'], 0xa300: ['File source', 'tech'], 0xa301: ['Scene type', 'tech'],
    0xa401: ['Custom rendered', 'tech'], 0xa402: ['Exposure mode', 'capture'], 0xa403: ['White balance', 'capture'],
    0xa404: ['Digital zoom', 'capture'], 0xa405: ['35mm focal length', 'capture'], 0xa406: ['Scene capture type', 'capture'],
    0xa420: ['Image unique ID', 'device', true], 0xa430: ['Camera owner', 'people', true],
    0xa431: ['Body serial number', 'device', true], 0xa432: ['Lens specification', 'device'],
    0xa433: ['Lens make', 'device'], 0xa434: ['Lens model', 'device'], 0xa435: ['Lens serial number', 'device', true],
  },
  gps: {
    0x00: ['GPS version', 'tech'], 0x01: ['Latitude ref', 'location', true], 0x02: ['Latitude', 'location', true],
    0x03: ['Longitude ref', 'location', true], 0x04: ['Longitude', 'location', true], 0x05: ['Altitude ref', 'location'],
    0x06: ['Altitude', 'location', true], 0x07: ['GPS time (UTC)', 'location'], 0x08: ['Satellites', 'location'],
    0x09: ['GPS status', 'location'], 0x0a: ['Measure mode', 'location'], 0x0b: ['Dilution of precision', 'location'],
    0x0c: ['Speed ref', 'location'], 0x0d: ['Speed', 'location', true], 0x0e: ['Track ref', 'location'],
    0x0f: ['Track', 'location', true], 0x10: ['Image direction ref', 'location'], 0x11: ['Image direction', 'location', true],
    0x12: ['Map datum', 'location'], 0x17: ['Dest bearing ref', 'location'], 0x18: ['Dest bearing', 'location'],
    0x1b: ['Processing method', 'location'], 0x1d: ['GPS date', 'location'], 0x1f: ['Horizontal error', 'location'],
  },
  interop: { 0x0001: ['Interop index', 'tech'], 0x0002: ['Interop version', 'tech'] },
};

function tagDef(ifd: string, tag: number): TagDef | undefined {
  if (ifd === 'GPS') return TAGS.gps[tag];
  if (ifd === 'Interop') return TAGS.interop[tag];
  if (ifd === 'Exif') return TAGS.exif[tag] ?? TAGS.main[tag];
  return TAGS.main[tag] ?? TAGS.exif[tag];
}

const ORIENTATION = ['', 'Normal', 'Mirrored', 'Rotated 180°', 'Mirrored vertically', 'Mirrored, rotated 90° CCW', 'Rotated 90° CW', 'Mirrored, rotated 90° CW', 'Rotated 90° CCW'];

/** Parse a TIFF structure beginning at `start` (the II/MM byte-order mark). Offsets inside are relative to `start`. */
export function parseTiff(bytes: Uint8Array, start: number, end = bytes.length, label = 'TIFF'): TiffResult | null {
  if (start + 8 > end) return null;
  const bom = (bytes[start] << 8) | bytes[start + 1];
  if (bom !== 0x4949 && bom !== 0x4d4d) return null;
  const le = bom === 0x4949;
  const c = new Cursor(bytes.subarray(0, end), le);
  if (c.u16(start + 2) !== 42) return null;

  const entries: TiffEntry[] = [];
  const visited = new Set<number>();
  const root: StructNode = { id: `tiff@${start}`, label, kind: 'tiff', range: { offset: start, length: end - start }, children: [
    { id: `tiffhdr@${start}`, label: `TIFF header (${le ? 'II, little-endian' : 'MM, big-endian'})`, kind: 'header', range: { offset: start, length: 8 } },
  ] };
  let thumbnail: Range | undefined;

  const walk = (rel: number, name: string, parent: StructNode, depth: number): number => {
    const abs = start + rel;
    if (depth > 4 || visited.size > 32 || visited.has(abs) || rel < 8 || !c.has(abs, 2)) return 0;
    visited.add(abs);
    const count = c.u16(abs);
    if (count === 0 || count > 1000 || !c.has(abs + 2, count * 12)) return 0;
    const node: StructNode = { id: `ifd-${name}@${abs}`, label: `${name} directory · ${count} entries`, kind: 'ifd', range: { offset: abs, length: 2 + count * 12 + 4 }, children: [] };
    parent.children!.push(node);
    for (let i = 0; i < count; i++) {
      const eo = abs + 2 + i * 12;
      const tag = c.u16(eo);
      const type = c.u16(eo + 2);
      const n = c.u32(eo + 4);
      const size = (TYPE_SIZE[type] ?? 0) * n;
      if (!TYPE_SIZE[type] || size > 64 * 1024 * 1024) continue;
      const valueOffset = size <= 4 ? eo + 8 : start + c.u32(eo + 8);
      const inRange = c.has(valueOffset, size);
      const def = tagDef(name, tag);
      const value = inRange ? readValue(c, type, n, valueOffset, tag) : null;
      const entry: TiffEntry = {
        ifd: name, tag, name: def?.[0] ?? `Tag 0x${tag.toString(16).padStart(4, '0')}`, type, count: n,
        entryOffset: eo, valueOffset, valueLength: inRange ? size : 0, value, display: '',
      };
      entry.display = display(entry);
      entries.push(entry);
      node.children!.push({ id: `tag@${eo}`, label: `${entry.name}`, kind: 'entry', range: { offset: eo, length: 12 }, note: entry.display.slice(0, 80) });
      if (size > 4 && inRange && size >= 16) {
        node.children!.push({ id: `val@${valueOffset}`, label: `${entry.name} value`, kind: 'value', range: { offset: valueOffset, length: size } });
      }
      const ptr = Array.isArray(value) ? value[0] : 0;
      if (tag === 0x8769 && ptr) walk(ptr, 'Exif', node, depth + 1);
      else if (tag === 0x8825 && ptr) walk(ptr, 'GPS', node, depth + 1);
      else if (tag === 0xa005 && ptr) walk(ptr, 'Interop', node, depth + 1);
      else if (tag === 0x014a && Array.isArray(value)) value.slice(0, 8).forEach((p, k) => walk(p, `SubIFD${k}`, node, depth + 1));
    }
    return c.has(abs + 2 + count * 12, 4) ? c.u32(abs + 2 + count * 12) : 0;
  };

  const ifd0 = c.u32(start + 4);
  const next = walk(ifd0, 'IFD0', root, 0);
  if (next) walk(next, 'IFD1', root, 0);

  const get = (ifd: string, tag: number) => entries.find(e => e.ifd === ifd && e.tag === tag);

  const tOff = get('IFD1', 0x0201), tLen = get('IFD1', 0x0202);
  if (tOff && tLen && Array.isArray(tOff.value) && Array.isArray(tLen.value)) {
    const off = start + tOff.value[0], len = tLen.value[0];
    if (len > 0 && off + len <= end && bytes[off] === 0xff && bytes[off + 1] === 0xd8) {
      thumbnail = { offset: off, length: len };
      root.children!.push({ id: `thumb@${off}`, label: 'Embedded thumbnail (JPEG)', kind: 'thumbnail', range: thumbnail });
    }
  }

  const result: TiffResult = { le, start, entries, get, structure: root, thumbnail, isDng: !!get('IFD0', 0xc612) };
  result.gps = extractGps(result);
  return result;
}

function readValue(c: Cursor, type: number, n: number, off: number, tag: number): number[] | string {
  const lim = Math.min(n, 4096);
  switch (type) {
    case 2: return cstring(c.bytes, off, n);
    case 1: case 7: {
      // Windows XP* tags are UCS-2 stored as BYTE arrays.
      if (tag >= 0x9c9b && tag <= 0x9c9f) return utf16le(c.bytes, off, off + n);
      if (tag === 0x9286 && n >= 8) return decodeUserComment(c.bytes, off, n);
      const out: number[] = [];
      for (let i = 0; i < lim; i++) out.push(c.u8(off + i));
      return out;
    }
    case 6: { const out: number[] = []; for (let i = 0; i < lim; i++) out.push((c.u8(off + i) << 24) >> 24); return out; }
    case 3: { const out: number[] = []; for (let i = 0; i < lim; i++) out.push(c.u16(off + i * 2)); return out; }
    case 8: { const out: number[] = []; for (let i = 0; i < lim; i++) out.push((c.u16(off + i * 2) << 16) >> 16); return out; }
    case 4: case 13: { const out: number[] = []; for (let i = 0; i < lim; i++) out.push(c.u32(off + i * 4)); return out; }
    case 9: { const out: number[] = []; for (let i = 0; i < lim; i++) out.push(c.i32(off + i * 4)); return out; }
    case 5: case 10: {
      const out: number[] = [];
      for (let i = 0; i < lim; i++) {
        const num = type === 5 ? c.u32(off + i * 8) : c.i32(off + i * 8);
        const den = type === 5 ? c.u32(off + i * 8 + 4) : c.i32(off + i * 8 + 4);
        out.push(den === 0 ? 0 : num / den);
      }
      return out;
    }
    case 11: { const out: number[] = []; for (let i = 0; i < lim; i++) out.push(c.dv.getFloat32(off + i * 4, c.le)); return out; }
    case 12: { const out: number[] = []; for (let i = 0; i < lim; i++) out.push(c.dv.getFloat64(off + i * 8, c.le)); return out; }
  }
  return [];
}

function decodeUserComment(bytes: Uint8Array, off: number, n: number): string {
  const code = cstring(bytes, off, 8);
  if (code === 'UNICODE') return utf16le(bytes, off + 8, off + n).trim();
  return cstring(bytes, off + 8, n - 8);
}

function display(e: TiffEntry): string {
  const v = e.value;
  if (v == null) return '(value outside file)';
  if (typeof v === 'string') return v;
  if (e.tag === 0x927c && e.ifd === 'Exif') return `${e.count.toLocaleString()} bytes (vendor-specific, not decoded)`;
  if ((e.type === 7 || e.type === 1) && v.length > 16) return `${e.count.toLocaleString()} bytes`;
  if (e.ifd === 'GPS' && (e.tag === 2 || e.tag === 4) && v.length >= 3) return dms(v);
  if (e.ifd === 'GPS' && e.tag === 7 && v.length >= 3) return v.map(x => String(Math.floor(x)).padStart(2, '0')).join(':') + ' UTC';
  if (e.ifd === 'GPS' && e.tag === 0) return v.join('.');
  if (e.tag === 0x0112 && e.ifd !== 'GPS') return ORIENTATION[v[0]] ?? String(v[0]);
  if (e.tag === 0x829a && e.ifd === 'Exif') return v[0] >= 1 ? `${v[0].toFixed(1)} s` : `1/${Math.round(1 / v[0])} s`;
  if (e.tag === 0x829d && e.ifd === 'Exif') return `ƒ/${v[0].toFixed(1)}`;
  if (e.tag === 0x920a && e.ifd === 'Exif') return `${v[0].toFixed(1)} mm`;
  if (e.tag === 0x9000 || e.tag === 0xa000) return String.fromCharCode(...v.slice(0, 4));
  if (v.length > 8) return v.slice(0, 8).map(fmtNum).join(', ') + ` … (${v.length})`;
  return v.map(fmtNum).join(', ');
}

function fmtNum(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function dms(v: number[]): string {
  const deg = Math.floor(v[0]);
  return `${deg}° ${Math.floor(v[1])}′ ${(v[2] + (v[1] % 1) * 60).toFixed(2)}″`;
}

function extractGps(t: TiffResult): GPSFix | undefined {
  const lat = t.get('GPS', 2), lon = t.get('GPS', 4);
  if (!lat || !lon || !Array.isArray(lat.value) || !Array.isArray(lon.value)) return undefined;
  if (lat.value.length < 3 || lon.value.length < 3) return undefined;
  let la = lat.value[0] + lat.value[1] / 60 + lat.value[2] / 3600;
  let lo = lon.value[0] + lon.value[1] / 60 + lon.value[2] / 3600;
  const latRef = t.get('GPS', 1)?.value, lonRef = t.get('GPS', 3)?.value;
  if (la === 0 && lo === 0 && !latRef) return undefined;
  if (latRef === 'S') la = -la;
  if (lonRef === 'W') lo = -lo;
  if (Math.abs(la) > 90 || Math.abs(lo) > 180 || !Number.isFinite(la + lo)) return undefined;
  const fix: GPSFix = { lat: la, lon: lo, source: 'EXIF GPS IFD', range: { offset: lat.valueOffset, length: lat.valueLength } };
  const alt = t.get('GPS', 6)?.value;
  if (Array.isArray(alt) && alt.length) fix.alt = t.get('GPS', 5)?.value?.[0] === 1 ? -alt[0] : alt[0];
  return fix;
}

// ---------------------------------------------------------------- presentation

const GROUP_TITLES: Record<Group, string> = {
  device: 'Device', capture: 'Capture', location: 'Location', people: 'People & machine', image: 'Image', tech: 'Technical tags',
};

export function tiffSections(t: TiffResult, prefix = 'exif'): Section[] {
  const groups = new Map<Group, Field[]>();
  for (const e of t.entries) {
    if (e.ifd === 'IFD1') continue;
    const def = tagDef(e.ifd, e.tag);
    const group: Group = def?.[1] ?? 'tech';
    if (!e.display || e.display === '(value outside file)') continue;
    const list = groups.get(group) ?? [];
    list.push({
      key: `${e.ifd}.${e.tag}`, label: e.name, value: e.display,
      range: e.valueLength ? { offset: e.valueOffset, length: e.valueLength } : { offset: e.entryOffset, length: 12 },
      sensitive: !!def?.[2], mono: group === 'tech' || group === 'location',
    });
    groups.set(group, list);
  }
  if (t.gps) {
    const loc = groups.get('location') ?? [];
    loc.unshift({ key: 'gps.decimal', label: 'Decimal position', value: `${t.gps.lat.toFixed(6)}, ${t.gps.lon.toFixed(6)}`, range: t.gps.range, sensitive: true, mono: true });
    groups.set('location', loc);
  }
  const order: Group[] = ['location', 'device', 'people', 'capture', 'image', 'tech'];
  return order.filter(g => groups.get(g)?.length).map(g => ({ id: `${prefix}-${g}`, title: GROUP_TITLES[g], fields: groups.get(g)! }));
}

const EDITORS = /photoshop|lightroom|gimp|snapseed|affinity|pixelmator|capture one|darktable|luminar|picsart|canva|facetune|vsco|paint\.net|skylum|acdsee/i;

export function tiffFindings(t: TiffResult, container: string): Finding[] {
  const out: Finding[] = [];
  const r = (e?: TiffEntry): Range[] => (e ? [{ offset: e.valueLength ? e.valueOffset : e.entryOffset, length: e.valueLength || 12 }] : []);
  const s = (e?: TiffEntry) => (e && typeof e.value === 'string' ? e.value : '');

  if (t.gps) {
    const gpsEntries = t.entries.filter(e => e.ifd === 'GPS');
    out.push({
      id: 'gps', severity: 'exposed', tag: 'GPS', fixable: true,
      title: 'Exact location embedded',
      detail: `The ${container} carries GPS coordinates${t.gps.alt != null ? ' and altitude' : ''}. Anyone who receives the file can see where it was made, within a few metres.`,
      evidence: gpsEntries.filter(e => e.valueLength).map(e => ({ offset: e.valueOffset, length: e.valueLength })).slice(0, 6),
    });
  }
  const make = t.get('IFD0', 0x010f), model = t.get('IFD0', 0x0110);
  if (s(make) || s(model)) {
    out.push({
      id: 'device', severity: 'caution', tag: 'DEVICE', fixable: true,
      title: 'Device fingerprint',
      detail: `Recorded as taken on ${s(model).toLowerCase().startsWith(s(make).toLowerCase()) && s(make) ? s(model) : [s(make), s(model)].filter(Boolean).join(' ')}${s(t.get('Exif', 0xa434)) ? `, lens ${s(t.get('Exif', 0xa434))}` : ''}.`,
      evidence: [...r(make), ...r(model)],
    });
  }
  const serials = [t.get('Exif', 0xa431), t.get('IFD0', 0xa431), t.get('Exif', 0xa435), t.get('IFD0', 0xc62f), t.get('Exif', 0xa420)].filter(e => e && (s(e) || Array.isArray(e.value))) as TiffEntry[];
  if (serials.length) {
    out.push({
      id: 'serial', severity: 'caution', tag: 'SERIAL', fixable: true,
      title: 'Serial number or unique ID',
      detail: `${serials.map(e => e.name).join(', ')} can link this file to other photos from the same device.`,
      evidence: serials.flatMap(e => r(e)),
    });
  }
  const people = [t.get('IFD0', 0x013b), t.get('Exif', 0xa430), t.get('IFD0', 0x9c9d), t.get('IFD0', 0x8298), t.get('IFD0', 0x013c)].filter(e => s(e)) as TiffEntry[];
  if (people.length) {
    out.push({
      id: 'exif-author', severity: 'caution', tag: 'AUTHOR', fixable: true,
      title: 'Names recorded in the file',
      detail: people.map(e => `${e.name}: ${s(e)}`).join(' · '),
      evidence: people.flatMap(e => r(e)),
    });
  }
  const comments = [t.get('Exif', 0x9286), t.get('IFD0', 0x9c9c), t.get('IFD0', 0x010e)].filter(e => s(e).trim()) as TiffEntry[];
  if (comments.length) {
    out.push({
      id: 'exif-comment', severity: 'caution', tag: 'COMMENT', fixable: true,
      title: 'Free-text comment',
      detail: comments.map(e => `${e.name}: “${s(e).slice(0, 120)}”`).join(' · '),
      evidence: comments.flatMap(e => r(e)),
    });
  }
  const taken = t.get('Exif', 0x9003) ?? t.get('IFD0', 0x0132);
  if (s(taken)) {
    const tz = s(t.get('Exif', 0x9011)) || s(t.get('Exif', 0x9010));
    out.push({
      id: 'taken', severity: 'info', tag: 'TIMESTAMP', fixable: true,
      title: 'Capture time recorded',
      detail: `${s(taken)}${tz ? ` (UTC${tz})` : ''}. A time-zone offset narrows down where the device was.`,
      evidence: r(taken),
    });
  }
  const sw = t.get('IFD0', 0x0131);
  if (EDITORS.test(s(sw))) {
    out.push({
      id: 'edited', severity: 'info', tag: 'EDITED',
      title: 'Processed by editing software',
      detail: `Software tag reads “${s(sw)}”. The file was saved by an editor after capture.`,
      evidence: r(sw),
    });
  }
  return out;
}
