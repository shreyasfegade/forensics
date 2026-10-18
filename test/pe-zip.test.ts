import { buildPe } from '../src/samples/builders';
import { zipBytes } from '../src/util/zipwriter';
import { run } from './helpers';

describe('PE', () => {
  it('reads timestamp, sections and the PDB username', async () => {
    const pe = buildPe({ pdbPath: 'C:\\Users\\dkowalski\\source\\repos\\Updater\\x64\\Release\\Updater.pdb', timestamp: Date.UTC(2026, 3, 9, 14, 5) / 1000 });
    const r = await run(pe, 'invoice_receipt.txt');
    expect(r.trueType.ext).toBe('exe');
    expect(r.extensionMismatch).toBe(true);
    const ids = r.findings.map(f => f.id);
    expect(ids).toEqual(expect.arrayContaining(['disguise', 'pe-pdb', 'pe-ts', 'pe-unsigned']));
    expect(r.findings.find(f => f.id === 'pe-pdb')!.detail).toContain('dkowalski');
    expect(r.findings[0].severity).toBe('exposed');
  });
});

describe('ZIP', () => {
  it('flags traversal paths and executables', async () => {
    const z = zipBytes([
      { name: 'readme.txt', data: new TextEncoder().encode('hi') },
      { name: '../../etc/cron.d/x', data: new TextEncoder().encode('* * * * * root sh') },
      { name: 'Users/alice/Desktop/run.exe', data: new Uint8Array(10) },
    ]);
    const r = await run(z, 'files.zip');
    const ids = r.findings.map(f => f.id);
    expect(ids).toEqual(expect.arrayContaining(['zip-slip', 'zip-exe', 'zip-userpath']));
  });
});
