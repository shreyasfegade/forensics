// The evidence samples double as the regression corpus: each must surface
// the leak it was built to demonstrate.
import { readFileSync } from 'node:fs';
import { run } from './helpers';
import { sanitize } from '../src/sanitize';

const load = (name: string) => new Uint8Array(readFileSync(`samples/${name}`));

const EXPECT: Record<string, { level: string; ids: string[]; type: string }> = {
  'harbor_cropped.jpg': { level: 'caution', ids: ['thumbnail', 'device', 'serial', 'edited'], type: 'jpg' },
  'paris_holiday.jpg': { level: 'exposed', ids: ['gps', 'device', 'taken'], type: 'jpg' },
  'cat_meme.jpg': { level: 'exposed', ids: ['trailing', 'strings-secret'], type: 'jpg' },
  'IMG_4127.MOV': { level: 'exposed', ids: ['gps', 'device', 'iso-time'], type: 'mov' },
  'offer_letter_final.docx': { level: 'exposed', ids: ['office-changes', 'office-comments', 'office-author', 'office-company', 'office-template'], type: 'docx' },
  'invoice_receipt.txt': { level: 'exposed', ids: ['disguise', 'pe-pdb', 'pe-unsigned'], type: 'exe' },
  'mountains.png': { level: 'exposed', ids: ['stego'], type: 'png' },
  'vacation_safe.png': { level: 'clear', ids: [], type: 'png' },
  'contract_v3.pdf': { level: 'caution', ids: ['pdf-revisions', 'pdf-invisible', 'pdf-author', 'pdf-tool'], type: 'pdf' },
};

describe('evidence samples', () => {
  for (const [name, exp] of Object.entries(EXPECT)) {
    it(name, async () => {
      const bytes = load(name);
      const r = await run(bytes, name);
      expect(r.trueType.ext).toBe(exp.type);
      expect(r.verdict.level).toBe(exp.level);
      expect(r.findings.map(f => f.id)).toEqual(expect.arrayContaining(exp.ids));
      if (exp.level === 'clear') expect(r.findings.filter(f => f.severity !== 'info')).toEqual([]);
      // Every evidence range must point inside the file.
      for (const f of r.findings) for (const e of f.evidence) expect(e.offset + e.length).toBeLessThanOrEqual(bytes.length);
      // Sanitizing a supported sample removes its fixable, non-info findings.
      if (r.sanitize.supported && name !== 'vacation_safe.png') {
        const out = await sanitize(bytes, r.trueType);
        const after = await run(out.bytes, name);
        const left = after.findings.filter(f => f.fixable && f.severity !== 'info').map(f => f.id);
        expect(left).toEqual([]);
      }
    });
  }
});
