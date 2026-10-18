// Byte-level writers for building test fixtures and the evidence samples.
// Each produces a structurally valid file of its format.
import { concat, latin1 } from '../util/bytes';
import { crc32 } from '../util/crc32';
import { zipBytes } from '../util/zipwriter';

// ------------------------------------------------------------------ TIFF

export type TiffValue = { type: 2; value: string } | { type: 3 | 4; value: number[] } | { type: 5; value: [number, number][] } | { type: 7; value: Uint8Array };
export type TiffIfd = Record<number, TiffValue>;

export interface TiffSpec { ifd0: TiffIfd; exif?: TiffIfd; gps?: TiffIfd; thumbnail?: Uint8Array; le?: boolean }

/** Build a TIFF structure (offsets relative to its first byte). */
export function buildTiff(spec: TiffSpec): Uint8Array {
  const le = spec.le ?? true;
  const buf = new Uint8Array(1 << 20);
  const dv = new DataView(buf.buffer);
  let p = 8;
  buf[0] = buf[1] = le ? 0x49 : 0x4d;
  dv.setUint16(2, 42, le);
  dv.setUint32(4, 8, le);
  const pending: { ifd: TiffIfd; at: number; extra: Record<number, () => number> }[] = [];

  const writeIfd = (ifd: TiffIfd, extraPtrs: Record<number, number> = {}): { start: number; nextAt: number } => {
    const tags = Object.keys(ifd).map(Number).concat(Object.keys(extraPtrs).map(Number)).sort((a, b) => a - b);
    const start = p;
    dv.setUint16(p, tags.length, le);
    p += 2;
    const entriesAt = p;
    p += tags.length * 12;
    const nextAt = p;
    dv.setUint32(p, 0, le);
    p += 4;
    tags.forEach((tag, i) => {
      const e = entriesAt + i * 12;
      dv.setUint16(e, tag, le);
      if (tag in extraPtrs) {
        dv.setUint16(e + 2, 4, le); dv.setUint32(e + 4, 1, le); dv.setUint32(e + 8, extraPtrs[tag], le);
        return;
      }
      const v = ifd[tag];
      let data: Uint8Array;
      let count: number;
      if (v.type === 2) { data = latin1(v.value + '\0'); count = data.length; }
      else if (v.type === 7) { data = v.value; count = data.length; }
      else if (v.type === 3) { data = new Uint8Array(v.value.length * 2); const d = new DataView(data.buffer); v.value.forEach((x, k) => d.setUint16(k * 2, x, le)); count = v.value.length; }
      else if (v.type === 4) { data = new Uint8Array(v.value.length * 4); const d = new DataView(data.buffer); v.value.forEach((x, k) => d.setUint32(k * 4, x, le)); count = v.value.length; }
      else { data = new Uint8Array(v.value.length * 8); const d = new DataView(data.buffer); (v.value as [number, number][]).forEach(([n, dd], k) => { d.setUint32(k * 8, n, le); d.setUint32(k * 8 + 4, dd, le); }); count = v.value.length; }
      dv.setUint16(e + 2, v.type, le);
      dv.setUint32(e + 4, count, le);
      if (data.length <= 4) buf.set(data, e + 8);
      else {
        if (p & 1) p++;
        dv.setUint32(e + 8, p, le);
        buf.set(data, p);
        p += data.length;
      }
    });
    return { start, nextAt };
  };
  void pending;

  // IFD0 needs pointers to Exif/GPS, which are written after it: reserve by writing sub-IFDs first? Simpler: two passes.
  const ptrs: Record<number, number> = {};
  if (spec.exif) ptrs[0x8769] = 0;
  if (spec.gps) ptrs[0x8825] = 0;
  const ifd0 = writeIfd(spec.ifd0, ptrs);
  const patch = (tag: number, value: number) => {
    const n = dv.getUint16(ifd0.start, le);
    for (let i = 0; i < n; i++) if (dv.getUint16(ifd0.start + 2 + i * 12, le) === tag) dv.setUint32(ifd0.start + 2 + i * 12 + 8, value, le);
  };
  if (spec.exif) { const s = writeIfd(spec.exif); patch(0x8769, s.start); }
  if (spec.gps) { const s = writeIfd(spec.gps); patch(0x8825, s.start); }
  if (spec.thumbnail) {
    if (p & 1) p++;
    const ifd1 = writeIfd({ 0x0103: { type: 3, value: [6] }, 0x0201: { type: 4, value: [0] }, 0x0202: { type: 4, value: [spec.thumbnail.length] } });
    dv.setUint32(ifd0.nextAt, ifd1.start, le);
    const n = dv.getUint16(ifd1.start, le);
    for (let i = 0; i < n; i++) if (dv.getUint16(ifd1.start + 2 + i * 12, le) === 0x0201) dv.setUint32(ifd1.start + 2 + i * 12 + 8, p, le);
    buf.set(spec.thumbnail, p);
    p += spec.thumbnail.length;
  }
  return buf.slice(0, p);
}

export const rational = (x: number, den = 10000): [number, number] => [Math.round(x * den), den];

export function gpsIfd(lat: number, lon: number, alt?: number): TiffIfd {
  const dms = (v: number): [number, number][] => {
    const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = ((a - d) * 60 - m) * 60;
    return [[d, 1], [m, 1], rational(s, 100)];
  };
  const g: TiffIfd = {
    0x00: { type: 7, value: new Uint8Array([2, 3, 0, 0]) },
    0x01: { type: 2, value: lat >= 0 ? 'N' : 'S' }, 0x02: { type: 5, value: dms(lat) },
    0x03: { type: 2, value: lon >= 0 ? 'E' : 'W' }, 0x04: { type: 5, value: dms(lon) },
  };
  if (alt != null) { g[0x05] = { type: 7, value: new Uint8Array([alt < 0 ? 1 : 0]) }; g[0x06] = { type: 5, value: [rational(Math.abs(alt), 100)] }; }
  return g;
}

// ------------------------------------------------------------------ JPEG

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const s = new Uint8Array(4 + payload.length);
  s[0] = 0xff; s[1] = marker; s[2] = (payload.length + 2) >> 8; s[3] = (payload.length + 2) & 0xff;
  s.set(payload, 4);
  return s;
}

export interface JpegExtras { exif?: Uint8Array; xmp?: string; comment?: string; trailing?: Uint8Array }

/** Insert metadata segments into an existing JPEG (right after SOI / APP0). */
export function jpegWith(base: Uint8Array, x: JpegExtras): Uint8Array {
  let at = 2;
  if (base[2] === 0xff && base[3] === 0xe0) at = 4 + ((base[4] << 8) | base[5]);
  const parts: Uint8Array[] = [base.subarray(0, at)];
  if (x.exif) parts.push(segment(0xe1, concat([latin1('Exif\0\0'), x.exif])));
  if (x.xmp) parts.push(segment(0xe1, concat([latin1('http://ns.adobe.com/xap/1.0/\0'), new TextEncoder().encode(x.xmp)])));
  if (x.comment) parts.push(segment(0xfe, latin1(x.comment)));
  parts.push(base.subarray(at));
  if (x.trailing) parts.push(x.trailing);
  return concat(parts);
}

/** A tiny but complete baseline JPEG (8×8 grey) for parser tests that don't decode pixels. */
export function tinyJpeg(): Uint8Array {
  const hex = 'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080008000801011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00d2cf20ffd9';
  return Uint8Array.from(hex.match(/../g)!.map(h => parseInt(h, 16)));
}

// ------------------------------------------------------------------ PNG

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(latin1(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  w.write(data as unknown as BufferSource);
  w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/** Encode RGBA (or RGB) pixels as an 8-bit PNG, with optional extra chunks before IDAT. */
export async function encodePng(width: number, height: number, rgba: Uint8Array, opts: { alpha?: boolean; chunks?: Uint8Array[]; trailing?: Uint8Array } = {}): Promise<Uint8Array> {
  const ch = opts.alpha ? 4 : 3;
  const stride = width * ch;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) for (let c = 0; c < ch; c++) raw[y * (stride + 1) + 1 + x * ch + c] = rgba[(y * width + x) * 4 + c];
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = opts.alpha ? 6 : 2;
  return concat([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...(opts.chunks ?? []),
    pngChunk('IDAT', await zlib(raw)),
    pngChunk('IEND', new Uint8Array(0)),
    ...(opts.trailing ? [opts.trailing] : []),
  ]);
}

export function textChunk(keyword: string, value: string): Uint8Array {
  return pngChunk('tEXt', concat([latin1(keyword), new Uint8Array([0]), latin1(value)]));
}

// ------------------------------------------------------------------ procedural "photo"

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A landscape-like RGBA image with sensor noise. LSB statistics behave like a real photo's. */
export function landscape(w: number, h: number, seed = 7): Uint8Array {
  const r = rng(seed);
  const out = new Uint8Array(w * h * 4);
  const ridge = (x: number, k: number) => Math.sin(x * 0.011 * k + seed) * 0.5 + Math.sin(x * 0.027 * k + 1.3) * 0.25 + Math.sin(x * 0.061 + k) * 0.1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const t = y / h;
      const m1 = h * (0.45 + ridge(x, 1) * 0.12), m2 = h * (0.62 + ridge(x, 2) * 0.08);
      let R: number, G: number, B: number;
      if (y < m1) { R = 120 + 90 * t; G = 160 + 60 * t; B = 225 - 20 * t; }
      else if (y < m2) { const s = (y - m1) / h; R = 92 - 60 * s; G = 104 - 50 * s; B = 128 - 40 * s; }
      else { const s = (y - m2) / h; R = 70 + 40 * s + 10 * Math.sin(x * 0.2); G = 110 + 30 * s; B = 60 + 10 * s; }
      const n = () => (r() + r() + r() - 1.5) * 9;
      out[p] = clamp(R + n()); out[p + 1] = clamp(G + n()); out[p + 2] = clamp(B + n()); out[p + 3] = 255;
    }
  }
  return out;
}

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** Embed bytes into the LSBs of R,G,B samples from the first pixel onward. */
export function embedLsb(rgba: Uint8Array, message: Uint8Array): Uint8Array {
  const out = rgba.slice();
  let bit = 0;
  const total = message.length * 8;
  for (let i = 0; i < out.length && bit < total; i++) {
    if ((i & 3) === 3) continue;
    const b = (message[bit >> 3] >> (7 - (bit & 7))) & 1;
    out[i] = (out[i] & 0xfe) | b;
    bit++;
  }
  return out;
}

// ------------------------------------------------------------------ PDF

export interface PdfRev { info: Record<string, string>; pageText: string; invisible?: string }

/** A PDF whose later versions are appended as incremental updates. */
export function buildPdf(revs: PdfRev[]): Uint8Array {
  const parts: string[] = [];
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: Record<number, number> = {};
  const obj = (n: number, body: string) => { offsets[n] = out.length; out += `${n} 0 obj\n${body}\nendobj\n`; };
  const infoStr = (info: Record<string, string>) => '<<' + Object.entries(info).map(([k, v]) => ` /${k} (${v.replace(/([()\\])/g, '\\$1')})`).join('') + ' >>';
  let prevXref = 0;
  revs.forEach((rev, i) => {
    const start = Object.keys(offsets).length;
    void start;
    const content = `BT /F1 18 Tf 72 720 Td (${rev.pageText}) Tj ET${rev.invisible ? `\nBT 3 Tr /F1 10 Tf 72 100 Td (${rev.invisible}) Tj ET` : ''}`;
    if (i === 0) {
      obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
      obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
      obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
      obj(4, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
      obj(6, infoStr(rev.info));
      const xref = out.length;
      out += 'xref\n0 7\n0000000000 65535 f \n' + [1, 2, 3, 4, 5, 6].map(n => String(offsets[n]).padStart(10, '0') + ' 00000 n \n').join('');
      out += `trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      prevXref = xref;
    } else {
      obj(4, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      obj(6, infoStr(rev.info));
      const xref = out.length;
      out += `xref\n0 1\n0000000000 65535 f \n4 1\n${String(offsets[4]).padStart(10, '0')} 00000 n \n6 1\n${String(offsets[6]).padStart(10, '0')} 00000 n \n`;
      out += `trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R /Prev ${prevXref} >>\nstartxref\n${xref}\n%%EOF\n`;
      prevXref = xref;
    }
  });
  void parts;
  return latin1(out);
}

// ------------------------------------------------------------------ DOCX

export interface DocxSpec {
  creator: string; lastModifiedBy: string; revision: number; company?: string; template?: string; totalTime?: number;
  paragraphs: (string | { del?: string; ins?: string; author: string; date: string; before?: string; after?: string })[];
  comments?: { author: string; date: string; text: string }[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildDocx(spec: DocxSpec): Uint8Array {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const body = spec.paragraphs.map((p, i) => {
    if (typeof p === 'string') return `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r>${i === 1 && spec.comments?.length ? '<w:commentRangeStart w:id="0"/><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>' : ''}</w:p>`;
    return `<w:p>${p.before ? `<w:r><w:t xml:space="preserve">${esc(p.before)}</w:t></w:r>` : ''}${p.del ? `<w:del w:id="${10 + i}" w:author="${esc(p.author)}" w:date="${p.date}"><w:r><w:delText xml:space="preserve">${esc(p.del)}</w:delText></w:r></w:del>` : ''}${p.ins ? `<w:ins w:id="${20 + i}" w:author="${esc(p.author)}" w:date="${p.date}"><w:r><w:t xml:space="preserve">${esc(p.ins)}</w:t></w:r></w:ins>` : ''}${p.after ? `<w:r><w:t xml:space="preserve">${esc(p.after)}</w:t></w:r>` : ''}</w:p>`;
  }).join('');
  const files: { name: string; data: Uint8Array }[] = [];
  const add = (name: string, s: string) => files.push({ name, data: new TextEncoder().encode(s) });
  add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
  add('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  add('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${spec.comments?.length ? '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>' : ''}</Relationships>`);
  add('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`);
  if (spec.comments?.length) add('word/comments.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}>${spec.comments.map((c, i) => `<w:comment w:id="${i}" w:author="${esc(c.author)}" w:date="${c.date}" w:initials="${c.author.split(' ').map(x => x[0]).join('')}"><w:p><w:r><w:t>${esc(c.text)}</w:t></w:r></w:p></w:comment>`).join('')}</w:comments>`);
  add('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>${esc(spec.creator)}</dc:creator><cp:lastModifiedBy>${esc(spec.lastModifiedBy)}</cp:lastModifiedBy><cp:revision>${spec.revision}</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">2026-09-02T09:14:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-09-29T17:41:00Z</dcterms:modified></cp:coreProperties>`);
  add('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Template>${esc(spec.template ?? 'Normal.dotm')}</Template><TotalTime>${spec.totalTime ?? 0}</TotalTime><Application>Microsoft Office Word</Application><Company>${esc(spec.company ?? '')}</Company><AppVersion>16.0000</AppVersion></Properties>`);
  return zipBytes(files);
}

// ------------------------------------------------------------------ MP4 / MOV

function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const body = concat(children);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(latin1(type), 4);
  out.set(body, 8);
  return out;
}

function u32(...v: number[]): Uint8Array { const o = new Uint8Array(v.length * 4); const d = new DataView(o.buffer); v.forEach((x, i) => d.setUint32(i * 4, x >>> 0)); return o; }

/** QuickTime movie with Apple location keys and a ©xyz atom. Metadata only, no media frames. */
export function buildMov(opts: { iso6709: string; make: string; model: string; software: string; created: string }): Uint8Array {
  const enc = new TextEncoder();
  const qtText = (type: string, s: string) => { const t = enc.encode(s); const h = new Uint8Array(4); new DataView(h.buffer).setUint16(0, t.length); new DataView(h.buffer).setUint16(2, 0x15c7); return box(type, h, t); };
  const keys = ['com.apple.quicktime.location.ISO6709', 'com.apple.quicktime.make', 'com.apple.quicktime.model', 'com.apple.quicktime.software', 'com.apple.quicktime.creationdate'];
  const values = [opts.iso6709, opts.make, opts.model, opts.software, opts.created];
  const keysBox = box('keys', u32(0, keys.length), ...keys.map(k => { const kb = enc.encode(k); return concat([u32(8 + kb.length), latin1('mdta'), kb]); }));
  const ilst = box('ilst', ...values.map((v, i) => { const b = box('data', u32(1, 0), enc.encode(v)); const item = new Uint8Array(8 + b.length); new DataView(item.buffer).setUint32(0, item.length); new DataView(item.buffer).setUint32(4, i + 1); item.set(b, 8); return item; }));
  const hdlr = box('hdlr', u32(0, 0), latin1('mdta'), u32(0, 0, 0), new Uint8Array(1));
  const created = Math.floor(Date.parse(opts.created.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) / 1000) + 2082844800;
  const mvhd = box('mvhd', u32(0, created, created, 600, 600 * 4), u32(0x00010000), new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]), u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000), new Uint8Array(24), u32(2));
  const moov = box('moov', mvhd, box('udta', qtText('©xyz', opts.iso6709), qtText('©mak', opts.make), qtText('©mod', opts.model)), box('meta', hdlr, keysBox, ilst));
  return concat([box('ftyp', latin1('qt  '), u32(0), latin1('qt  ')), box('wide'), box('mdat', new Uint8Array(64)), moov]);
}

/** Minimal HEIF container whose EXIF item carries GPS. Not decodable as a picture. */
export function buildHeic(exifTiff: Uint8Array): Uint8Array {
  const ftyp = box('ftyp', latin1('heic'), u32(0), latin1('mif1heic'));
  const hdlr = box('hdlr', u32(0, 0), latin1('pict'), u32(0, 0, 0), new Uint8Array(1));
  const infe = (id: number, type: string) => box('infe', new Uint8Array([2, 0, 0, 0, id >> 8, id & 255, 0, 0]), latin1(type), new Uint8Array(1));
  const iinf = box('iinf', u32(0), new Uint8Array([0, 2]), infe(1, 'hvc1'), infe(2, 'Exif'));
  const exifData = concat([u32(0), exifTiff]);
  const ispe = box('ispe', u32(0, 4032, 3024));
  const iprp = box('iprp', box('ipco', ispe));
  const mk = (exifOff: number) => box('iloc', new Uint8Array([0, 0, 0, 0, 0x44, 0x00]), new Uint8Array([0, 2]),
    new Uint8Array([0, 1, 0, 0, 0, 1]), u32(0, 0),
    new Uint8Array([0, 2, 0, 0, 0, 1]), u32(exifOff, exifData.length));
  const metaWith = (off: number) => box('meta', u32(0), hdlr, box('pitm', u32(0), new Uint8Array([0, 1])), iinf, mk(off), iprp);
  const metaLen = metaWith(0).length;
  const mdatOff = ftyp.length + metaLen;
  return concat([ftyp, metaWith(mdatOff + 8), box('mdat', exifData)]);
}

// ------------------------------------------------------------------ PE

/** A small PE32+ executable layout with a CodeView debug record. */
export function buildPe(opts: { pdbPath: string; timestamp: number; planted?: string; seed?: number }): Uint8Array {
  const size = 4096;
  const b = new Uint8Array(size);
  const dv = new DataView(b.buffer);
  const r = rng(opts.seed ?? 3);
  b[0] = 0x4d; b[1] = 0x5a;
  dv.setUint32(0x3c, 0x80, true);
  b.set(latin1('This program cannot be run in DOS mode.\r\r\n$'), 0x4e);
  const pe = 0x80;
  b.set(latin1('PE\0\0'), pe);
  const coff = pe + 4;
  dv.setUint16(coff, 0x8664, true); dv.setUint16(coff + 2, 2, true); dv.setUint32(coff + 4, opts.timestamp, true);
  dv.setUint16(coff + 16, 240, true); dv.setUint16(coff + 18, 0x0022, true);
  const opt = coff + 20;
  dv.setUint16(opt, 0x20b, true); dv.setUint16(opt + 68, 3, true); dv.setUint32(opt + 108, 16, true);
  // Debug directory (index 6) → RVA 0x2000 in .rdata
  dv.setUint32(opt + 112 + 6 * 8, 0x2000, true); dv.setUint32(opt + 112 + 6 * 8 + 4, 28, true);
  const sec = opt + 240;
  const writeSec = (i: number, name: string, va: number, raw: number, rawSize: number) => {
    const o = sec + i * 40;
    b.set(latin1(name), o); dv.setUint32(o + 8, rawSize, true); dv.setUint32(o + 12, va, true); dv.setUint32(o + 16, rawSize, true); dv.setUint32(o + 20, raw, true);
  };
  writeSec(0, '.text', 0x1000, 0x400, 0x800);
  writeSec(1, '.rdata', 0x2000, 0xc00, 0x400);
  for (let i = 0x400; i < 0xc00; i++) b[i] = Math.floor(r() * 256);
  // IMAGE_DEBUG_DIRECTORY at file 0xc00 → CodeView record at file 0xc40
  dv.setUint32(0xc00 + 12, 2, true); dv.setUint32(0xc00 + 16, 24 + opts.pdbPath.length + 1, true); dv.setUint32(0xc00 + 20, 0x2040, true); dv.setUint32(0xc00 + 24, 0xc40, true);
  b.set(latin1('RSDS'), 0xc40);
  for (let i = 0; i < 16; i++) b[0xc44 + i] = Math.floor(r() * 256);
  dv.setUint32(0xc54, 1, true);
  b.set(latin1(opts.pdbPath + '\0'), 0xc58);
  if (opts.planted) b.set(latin1(opts.planted), 0xd80);
  return b;
}
