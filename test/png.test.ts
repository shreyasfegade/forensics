import { encodePng, landscape, pngChunk, textChunk, buildTiff, gpsIfd } from '../src/samples/builders';
import { parsePng, scanPng } from '../src/parsers/png';
import { decodePng } from '../src/util/png-decode';
import { latin1 } from '../src/util/bytes';
import { run } from './helpers';

describe('PNG', () => {
  it('walks chunks properly (no false IEND inside image data)', async () => {
    // A private chunk whose payload contains the bytes "IEND": V1 stopped here.
    const png = await encodePng(4, 4, landscape(4, 4), { chunks: [pngChunk('prVt', latin1('xxxxIENDxxxxxxxx'))] });
    const s = scanPng(png);
    expect(s.ok).toBe(true);
    expect(s.end).toBe(png.length);
    const r = await run(png, 'a.png');
    expect(r.hidden).toBeUndefined();
  });
  it('reads text, eXIf and trailing data', async () => {
    const exif = buildTiff({ ifd0: { 0x010f: { type: 2, value: 'Google' } }, gps: gpsIfd(37.422, -122.084) });
    const png = await encodePng(8, 8, landscape(8, 8), { chunks: [textChunk('Author', 'Sam Lee'), textChunk('Software', 'GIMP 2.10'), pngChunk('eXIf', exif)], trailing: latin1('hidden!hidden!') });
    const r = await parsePng(png);
    expect(r.image).toEqual(expect.objectContaining({ width: 8, height: 8, bitDepth: 8 }));
    expect(r.gps!.lon).toBeCloseTo(-122.084, 2);
    expect(r.hidden!.length).toBe(14);
    expect(r.findings.map(f => f.id)).toEqual(expect.arrayContaining(['png-text', 'edited', 'gps']));
  });
  it('decodes pixels exactly', async () => {
    const px = landscape(17, 9, 3);
    const png = await encodePng(17, 9, px);
    const img = (await decodePng(png))!;
    for (let i = 0; i < px.length; i++) expect(img.rgba[i]).toBe(px[i]);
  });
});
