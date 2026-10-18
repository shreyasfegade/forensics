import { buildDocx, buildHeic, buildMov, buildPdf, buildTiff, encodePng, gpsIfd, jpegWith, landscape, pngChunk, textChunk, tinyJpeg } from '../src/samples/builders';
import { sanitize } from '../src/sanitize';
import { scanJpeg } from '../src/parsers/jpeg';
import { scanPng } from '../src/parsers/png';
import { latin1 } from '../src/util/bytes';
import { readZipDir, readEntry } from '../src/parsers/zip';
import { parseTiff } from '../src/parsers/tiff';
import { run } from './helpers';

const sensitive = (r: Awaited<ReturnType<typeof run>>) => r.findings.filter(f => f.fixable && f.severity !== 'info').map(f => f.id);

describe('sanitize: JPEG', () => {
  const exif = buildTiff({ ifd0: { 0x010f: { type: 2, value: 'Apple' }, 0x0112: { type: 3, value: [6] } }, gps: gpsIfd(1, 2), thumbnail: tinyJpeg() });
  const src = jpegWith(tinyJpeg(), { exif, comment: 'hello', xmp: '<x:xmpmeta><dc:creator>Jane</dc:creator></x:xmpmeta>', trailing: latin1('payload!') });
  it('removes metadata, keeps scan data byte-identical and orientation', async () => {
    const before = await run(src, 'a.jpg');
    const out = await sanitize(src, before.trueType);
    const after = await run(out.bytes, 'a.jpg');
    expect(sensitive(before).length).toBeGreaterThan(0);
    expect(sensitive(after)).toEqual([]);
    expect(after.hidden).toBeUndefined();
    const sos = (b: Uint8Array) => { const s = scanJpeg(b).segments.find(x => x.marker === 0xda)!; return b.subarray(s.offset, s.offset + s.length); };
    expect(sos(out.bytes)).toEqual(sos(src));
    const app1 = scanJpeg(out.bytes).segments.find(s => s.marker === 0xe1)!;
    const t = parseTiff(out.bytes, app1.payloadOffset + 6)!;
    expect(t.entries).toHaveLength(1);
    expect(t.get('IFD0', 0x0112)!.value).toEqual([6]);
  });
});

describe('sanitize: PNG', () => {
  it('drops text and eXIf, keeps IDAT', async () => {
    const src = await encodePng(8, 8, landscape(8, 8), { chunks: [textChunk('Author', 'Sam'), pngChunk('eXIf', buildTiff({ ifd0: {}, gps: gpsIfd(3, 4) })), pngChunk('sRGB', new Uint8Array([0]))], trailing: latin1('xx') });
    const out = await sanitize(src, (await run(src, 'a.png')).trueType);
    const types = scanPng(out.bytes).chunks.map(c => c.type);
    expect(types).toEqual(['IHDR', 'sRGB', 'IDAT', 'IEND']);
    const after = await run(out.bytes, 'a.png');
    expect(sensitive(after)).toEqual([]);
  });
});

describe('sanitize: DOCX', () => {
  it('clears properties but keeps content parts intact', async () => {
    const src = buildDocx({ creator: 'A', lastModifiedBy: 'B', revision: 3, company: 'Co', paragraphs: ['hi'], comments: [{ author: 'C', date: '2026-01-01T00:00:00Z', text: 'note' }] });
    const before = await run(src, 'a.docx');
    const out = await sanitize(src, before.trueType);
    const after = await run(out.bytes, 'a.docx');
    expect(after.findings.find(f => f.id === 'office-author')).toBeUndefined();
    expect(after.findings.find(f => f.id === 'office-company')).toBeUndefined();
    // comments are content: still reported, not silently removed
    expect(after.findings.find(f => f.id === 'office-comments')).toBeDefined();
    const d1 = readZipDir(src)!, d2 = readZipDir(out.bytes)!;
    const doc = async (b: Uint8Array, d: typeof d1) => new TextDecoder().decode((await readEntry(b, d.entries.find(e => e.name === 'word/document.xml')!))!);
    expect(await doc(out.bytes, d2)).toBe(await doc(src, d1));
  });
});

describe('sanitize: PDF', () => {
  it('blanks Info in every revision without moving offsets', async () => {
    const src = buildPdf([{ info: { Author: 'Alex Kim', Producer: 'Quartz', Title: 'T' }, pageText: 'a' }, { info: { Author: 'Alex Kim', Producer: 'Acrobat' }, pageText: 'b' }]);
    const out = await sanitize(src, (await run(src, 'a.pdf')).trueType);
    expect(out.bytes.length).toBe(src.length);
    const text = new TextDecoder('latin1').decode(out.bytes);
    expect(text).not.toContain('Alex Kim');
    expect(text).toContain('/Title (T)');
    const after = await run(out.bytes, 'a.pdf');
    expect(after.findings.find(f => f.id === 'pdf-author')).toBeUndefined();
  });
});

describe('sanitize: MOV and HEIC', () => {
  it('turns location atoms into padding of the same size', async () => {
    const src = buildMov({ iso6709: '+51.5007-000.1246/', make: 'Apple', model: 'iPhone', software: '17', created: '2026-08-03T18:22:40+0100' });
    const out = await sanitize(src, (await run(src, 'a.mov')).trueType);
    expect(out.bytes.length).toBe(src.length);
    const after = await run(out.bytes, 'a.mov');
    expect(after.gps).toBeUndefined();
    expect(after.findings.some(f => f.tag === 'GPS')).toBe(false);
  });
  it('zeroes the HEIC EXIF item', async () => {
    const src = buildHeic(buildTiff({ ifd0: { 0x010f: { type: 2, value: 'Apple' } }, gps: gpsIfd(10, 20) }));
    const out = await sanitize(src, (await run(src, 'a.heic')).trueType);
    const after = await run(out.bytes, 'a.heic');
    expect(after.gps).toBeUndefined();
  });
});

describe('sanitize: TIFF', () => {
  it('blanks GPS and names in place', async () => {
    const src = buildTiff({ ifd0: { 0x010f: { type: 2, value: 'Nikon' }, 0x013b: { type: 2, value: 'Pat Smith' } }, gps: gpsIfd(10, 20) });
    const out = await sanitize(src, (await run(src, 'a.tif')).trueType);
    const after = await run(out.bytes, 'a.tif');
    expect(after.gps).toBeUndefined();
    expect(after.findings.find(f => f.id === 'exif-author')).toBeUndefined();
  });
});
