import { Scanner } from '../src/analysis/scanner';
import { shannon } from '../src/analysis/entropy';
import { latin1 } from '../src/util/bytes';
import { rng } from '../src/samples/builders';

describe('scanner', () => {
  it('entropy of known distributions', () => {
    expect(shannon(new Uint8Array(1000))).toBe(0);
    expect(shannon(Uint8Array.from({ length: 256 * 64 }, (_, i) => i & 255))).toBeCloseTo(8, 6);
    expect(shannon(Uint8Array.from({ length: 1000 }, (_, i) => i & 1))).toBeCloseTo(1, 6);
  });
  it('chunking does not change results', () => {
    const r = rng(9);
    const data = Uint8Array.from({ length: 300_000 }, (_, i) => (i > 150_000 ? Math.floor(r() * 256) : 65 + (i % 26)));
    data.set(latin1(' contact: jane.doe@example.com  password=hunter2 '), 1000);
    data.set(latin1('C:\\Users\\jane\\Documents\\plan.docx'), 5000);
    const a = new Scanner(data.length); a.update(data); const ra = a.finish();
    const b = new Scanner(data.length); for (let i = 0; i < data.length; i += 777) b.update(data.subarray(i, i + 777)); const rb = b.finish();
    expect(rb.sha256).toBe(ra.sha256);
    expect(rb.entropy.blocks).toEqual(ra.entropy.blocks);
    expect(rb.strings.notable).toEqual(ra.strings.notable);
    expect(ra.entropy.blocks.length).toBe(1024);
    expect(ra.entropy.blocks[0]).toBeLessThan(5);
    expect(ra.entropy.blocks[1000]).toBeGreaterThan(6.8); // ~293-byte blocks cap measurable entropy
    const types = ra.strings.notable.map(s => s.type);
    expect(types).toEqual(expect.arrayContaining(['secret', 'path']));
    expect(ra.byteplot.classes.length).toBe(Math.pow(4, ra.byteplot.order));
  });
  it('finds UTF-16LE strings', () => {
    const s = 'https://intranet.corp.example/secret';
    const data = new Uint8Array(s.length * 2 + 8);
    for (let i = 0; i < s.length; i++) data[4 + i * 2] = s.charCodeAt(i);
    const sc = new Scanner(data.length); sc.update(data);
    expect(sc.finish().strings.notable[0]?.value).toBe(s);
  });
});
