import { landscape, embedLsb, rng, encodePng } from '../src/samples/builders';
import { analyzeStego, chiSquareP, rsEstimate, bitPlane } from '../src/analysis/stego';
import { run } from './helpers';

const W = 256, H = 192;
const clean = landscape(W, H, 11);
const r = rng(5);
const payload = Uint8Array.from({ length: Math.floor((W * H * 3) / 8 * 0.6) }, () => Math.floor(r() * 256));
const embedded = embedLsb(clean, payload);
const img = (rgba: Uint8Array) => ({ width: W, height: H, rgba, lsbCapable: true, channels: 3 });

describe('steganalysis', () => {
  it('chi-square p is low for natural data and high for equalised pairs', () => {
    const h = new Uint32Array(256);
    for (let i = 0; i < 256; i++) h[i] = i % 2 ? 100 : 300;
    expect(chiSquareP(h)).toBeLessThan(0.01);
    for (let i = 0; i < 256; i++) h[i] = 200;
    expect(chiSquareP(h)).toBeGreaterThan(0.99);
  });
  it('RS estimate separates clean from 60% embedded', () => {
    const red = (rgba: Uint8Array) => Uint8Array.from({ length: W * H }, (_, i) => rgba[i * 4]);
    const a = rsEstimate(red(clean)), b = rsEstimate(red(embedded));
    expect(a).toBeLessThan(0.1);
    expect(b).toBeGreaterThan(0.35);
  });
  it('verdicts', () => {
    expect(analyzeStego(img(clean)).verdict).toBe('clean');
    expect(analyzeStego(img(embedded)).verdict).toBe('likely');
  });
  it('end to end on a PNG', async () => {
    const png = await encodePng(W, H, embedded);
    const rep = await run(png, 'mountains.png');
    expect(rep.stego?.verdict).toBe('likely');
    expect(rep.findings.some(f => f.tag === 'STEGO')).toBe(true);
    const cleanRep = await run(await encodePng(W, H, clean), 'm.png');
    expect(cleanRep.findings.some(f => f.tag === 'STEGO')).toBe(false);
  });
  it('bit-plane extraction', () => {
    const p = bitPlane(img(embedded), 0, 0);
    expect(p.length).toBe(W * H * 4);
    expect(p[0] === 0 || p[0] === 255).toBe(true);
  });
});
