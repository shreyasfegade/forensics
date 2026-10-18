import { buildHeic, buildMov, buildTiff, gpsIfd } from '../src/samples/builders';
import { parseIso6709 } from '../src/parsers/isobmff';
import { run } from './helpers';

describe('ISO 6709', () => {
  it('parses decimal and DDMM forms', () => {
    expect(parseIso6709('+40.7580-073.9855+012.000/')).toEqual(expect.objectContaining({ lat: 40.758, lon: -73.9855, alt: 12 }));
    const g = parseIso6709('+4045.48-07359.13/')!;
    expect(g.lat).toBeCloseTo(40.758, 2);
    expect(g.lon).toBeCloseTo(-73.9855, 2);
  });
});

describe('QuickTime / MP4', () => {
  it('finds GPS in Apple keys and ©xyz, plus device and time', async () => {
    const mov = buildMov({ iso6709: '+51.5007-000.1246+011.000/', make: 'Apple', model: 'iPhone 14', software: '17.5.1', created: '2026-08-03T18:22:40+0100' });
    const r = await run(mov, 'IMG_4127.MOV');
    expect(r.trueType.ext).toBe('mov');
    expect(r.gps!.lat).toBeCloseTo(51.5007, 3);
    expect(r.gps!.lon).toBeCloseTo(-0.1246, 3);
    const ids = r.findings.map(f => f.id);
    expect(ids).toEqual(expect.arrayContaining(['gps', 'device', 'iso-time']));
    expect(r.verdict.level).toBe('exposed');
    expect(r.structure.map(n => n.label)).toEqual(['ftyp', 'wide', 'mdat', 'moov']);
  });
});

describe('HEIC', () => {
  it('locates the EXIF item through iinf/iloc', async () => {
    const tiff = buildTiff({ ifd0: { 0x010f: { type: 2, value: 'Apple' }, 0x0110: { type: 2, value: 'iPhone 15' } }, gps: gpsIfd(35.6586, 139.7454) });
    const r = await run(buildHeic(tiff), 'IMG_0001.HEIC');
    expect(r.trueType.ext).toBe('heic');
    expect(r.gps!.lat).toBeCloseTo(35.6586, 3);
    expect(r.image).toEqual({ width: 4032, height: 3024 });
    const gps = r.findings.find(f => f.id === 'gps')!;
    // evidence offsets are absolute file offsets inside the EXIF item
    expect(gps.evidence[0].offset).toBeGreaterThan(100);
  });
});
