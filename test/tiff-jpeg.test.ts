import { buildTiff, gpsIfd, jpegWith, tinyJpeg } from '../src/samples/builders';
import { parseTiff } from '../src/parsers/tiff';
import { parseJpeg, scanJpeg } from '../src/parsers/jpeg';
import { latin1 } from '../src/util/bytes';
import { run, tags } from './helpers';

const spec = {
  ifd0: { 0x010f: { type: 2 as const, value: 'Apple' }, 0x0110: { type: 2 as const, value: 'iPhone 15 Pro' }, 0x0131: { type: 2 as const, value: 'Adobe Photoshop 25.1' }, 0x0112: { type: 3 as const, value: [6] }, 0x013b: { type: 2 as const, value: 'Jane Doe' } },
  exif: { 0x9003: { type: 2 as const, value: '2026:06:14 19:02:11' }, 0x9011: { type: 2 as const, value: '+02:00' }, 0xa431: { type: 2 as const, value: 'F2LXK0Q1' } },
  gps: gpsIfd(48.858370, 2.294481, 35),
};

describe('TIFF engine', () => {
  for (const le of [true, false]) {
    it(`reads IFD0, Exif and GPS (${le ? 'II' : 'MM'})`, () => {
      const t = parseTiff(buildTiff({ ...spec, le }), 0)!;
      expect(t.le).toBe(le);
      expect(t.get('IFD0', 0x010f)!.value).toBe('Apple');
      expect(t.get('Exif', 0x9003)!.value).toBe('2026:06:14 19:02:11');
      expect(t.gps!.lat).toBeCloseTo(48.85837, 4);
      expect(t.gps!.lon).toBeCloseTo(2.294481, 4);
      expect(t.gps!.alt).toBeCloseTo(35, 1);
    });
  }
  it('applies S/W hemisphere signs', () => {
    const t = parseTiff(buildTiff({ ifd0: {}, gps: gpsIfd(-33.8568, -70.6483) }), 0)!;
    expect(t.gps!.lat).toBeCloseTo(-33.8568, 3);
    expect(t.gps!.lon).toBeCloseTo(-70.6483, 3);
  });
  it('survives self-referencing IFD loops', () => {
    const b = buildTiff({ ifd0: { 0x010f: { type: 2, value: 'X' } } });
    const dv = new DataView(b.buffer);
    const n = dv.getUint16(8, true);
    dv.setUint32(8 + 2 + n * 12, 8, true); // next IFD -> itself
    expect(() => parseTiff(b, 0)).not.toThrow();
  });
  it('finds the IFD1 thumbnail', () => {
    const thumb = tinyJpeg();
    const t = parseTiff(buildTiff({ ifd0: { 0x010f: { type: 2, value: 'X' } }, thumbnail: thumb }), 0)!;
    expect(t.thumbnail!.length).toBe(thumb.length);
  });
});

describe('JPEG', () => {
  const exif = buildTiff({ ...spec, thumbnail: tinyJpeg() });
  const jpeg = jpegWith(tinyJpeg(), { exif, comment: 'CREATOR: gd-jpeg v1.0', xmp: '<x:xmpmeta><rdf:Description xmp:CreatorTool="Lightroom" crs:HasCrop="True"><dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator></rdf:Description></x:xmpmeta>', trailing: latin1('PK\x03\x04secret archive here') });

  it('walks segments to EOI and finds trailing data', () => {
    const s = scanJpeg(jpeg);
    expect(s.end).toBeGreaterThan(0);
    expect(s.end).toBeLessThan(jpeg.length);
    expect(s.segments.map(x => x.name)).toEqual(expect.arrayContaining(['APP1 · Exif', 'APP1 · XMP', 'COM · comment', 'DQT · quantisation tables', 'SOS · scan', 'EOI · end of image']));
  });
  it('parses EXIF, XMP, comments, frame and quality', () => {
    const r = parseJpeg(jpeg);
    expect(r.gps).toBeDefined();
    expect(r.image).toEqual(expect.objectContaining({ width: 8, height: 8 }));
    expect(r.quant?.qualityEstimate).toBeGreaterThan(0);
    expect(r.thumbnail?.width).toBe(8);
    const ids = r.findings.map(f => f.id);
    expect(ids).toEqual(expect.arrayContaining(['gps', 'device', 'serial', 'exif-author', 'taken', 'edited', 'thumbnail', 'xmp-author', 'xmp-crop', 'jpeg-com']));
  });
  it('produces an exposed verdict end to end', async () => {
    const r = await run(jpeg, 'holiday.jpg');
    expect(r.verdict.level).toBe('exposed');
    expect(tags(r)).toEqual(expect.arrayContaining(['GPS', 'PAYLOAD', 'DEVICE']));
    expect(r.hidden!.length).toBe(23);
    const gps = r.findings.find(f => f.tag === 'GPS')!;
    expect(gps.evidence.length).toBeGreaterThan(0);
    for (const ev of gps.evidence) expect(ev.offset + ev.length).toBeLessThanOrEqual(jpeg.length);
  });
  it('treats an appended second JPEG as caution, not exposed', async () => {
    const r = await run(jpegWith(tinyJpeg(), { trailing: tinyJpeg() }), 'a.jpg');
    expect(r.findings.find(f => f.id === 'trailing')!.severity).toBe('caution');
  });
  it('a clean JPEG is clean', async () => {
    const r = await run(tinyJpeg(), 'x.jpg');
    expect(r.verdict.level).toBe('clear');
  });
});
