import { createHash } from 'node:crypto';
import { Sha256, sha256Hex } from '../src/util/sha256';
import { crc32 } from '../src/util/crc32';
import { d2xy, xy2d, orderFor } from '../src/analysis/hilbert';
import { findAll, firstText, runsText } from '../src/util/xml';
import { inflate, deflateRaw } from '../src/util/inflate';
import { rng } from '../src/samples/builders';

describe('sha256', () => {
  it('matches node:crypto for many lengths and chunkings', () => {
    const r = rng(1);
    for (const len of [0, 1, 55, 56, 63, 64, 65, 1000, 70000]) {
      const data = Uint8Array.from({ length: len }, () => Math.floor(r() * 256));
      const expected = createHash('sha256').update(data).digest('hex');
      const h = new Sha256();
      for (let i = 0; i < len; i += 37) h.update(data.subarray(i, i + 37));
      expect(h.digestHex()).toBe(expected);
    }
  });
  it('streaming result equals SubtleCrypto', async () => {
    const data = new TextEncoder().encode('forensics'.repeat(1000));
    expect(new Sha256().update(data).digestHex()).toBe(await sha256Hex(data));
  });
});

describe('crc32', () => {
  it('known vector', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('hilbert', () => {
  it('d2xy and xy2d are inverses and stay adjacent', () => {
    const n = 64;
    let prev = d2xy(n, 0);
    for (let d = 0; d < n * n; d++) {
      const [x, y] = d2xy(n, d);
      expect(xy2d(n, x, y)).toBe(d);
      if (d > 0) expect(Math.abs(x - prev[0]) + Math.abs(y - prev[1])).toBe(1);
      prev = [x, y];
    }
  });
  it('picks a curve order that covers the file', () => {
    expect(orderFor(1)).toBe(1);
    expect(Math.pow(4, orderFor(5000))).toBeGreaterThanOrEqual(5000);
    expect(orderFor(1e9)).toBe(9);
  });
});

describe('xml', () => {
  const xml = '<w:body><w:p><w:del w:author="A &amp; B"><w:r><w:delText>gone</w:delText></w:r></w:del><w:del w:author="C"><w:r><w:delText>also</w:delText></w:r></w:del></w:p><dc:creator>Jane</dc:creator></w:body>';
  it('finds elements with attributes and decodes entities', () => {
    const d = findAll(xml, 'w:del');
    expect(d).toHaveLength(2);
    expect(d[0].attrs['w:author']).toBe('A & B');
    expect(runsText(d[1].inner, ['w:delText'])).toBe('also');
    expect(firstText(xml, 'dc:creator')).toBe('Jane');
  });
  it('does not confuse w:del with w:delText', () => {
    expect(findAll('<w:delText>x</w:delText>', 'w:del')).toHaveLength(0);
  });
});

describe('inflate', () => {
  it('round-trips deflate-raw', async () => {
    const data = new TextEncoder().encode('hello hello hello hello');
    expect(new TextDecoder().decode(await inflate(await deflateRaw(data), 'deflate-raw'))).toBe('hello hello hello hello');
  });
});
