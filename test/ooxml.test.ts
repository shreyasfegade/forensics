import { buildDocx } from '../src/samples/builders';
import { run } from './helpers';

const docx = buildDocx({
  creator: 'Maria Chen', lastModifiedBy: 'Tom Becker', revision: 14, company: 'Northwind Recruiting', totalTime: 312,
  template: 'C:\\Users\\tbecker\\AppData\\Roaming\\Microsoft\\Templates\\Offer.dotm',
  paragraphs: [
    'Dear candidate,',
    'We are pleased to offer you the role of Senior Analyst.',
    { before: 'Base salary: ', del: '$140,000 (approved range up to $150,000)', ins: '$120,000', author: 'Tom Becker', date: '2026-09-28T16:02:00Z', after: ' per year.' },
  ],
  comments: [{ author: 'Maria Chen', date: '2026-09-27T10:11:00Z', text: 'We can go to 150 if she pushes back. Do not mention this.' }],
});

describe('DOCX', () => {
  it('recovers deleted text, comments and people', async () => {
    const r = await run(docx, 'offer_letter_final.docx');
    expect(r.trueType.ext).toBe('docx');
    expect(r.extensionMismatch).toBe(false);
    const ch = r.findings.find(f => f.id === 'office-changes')!;
    expect(ch.severity).toBe('exposed');
    expect(ch.detail).toContain('$140,000');
    expect(r.findings.find(f => f.id === 'office-comments')!.detail).toContain('150');
    expect(r.findings.find(f => f.id === 'office-author')!.detail).toContain('Tom Becker');
    expect(r.findings.find(f => f.id === 'office-company')!.detail).toContain('Northwind');
    expect(r.findings.find(f => f.id === 'office-template')).toBeDefined();
    expect(r.findings.find(f => f.id === 'office-history')!.detail).toContain('14');
    expect(r.sanitize.supported).toBe(true);
  });
});
