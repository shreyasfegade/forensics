import { buildPdf } from '../src/samples/builders';
import { parsePdf, formatPdfDate, pdfString } from '../src/parsers/pdf';
import { latin1 } from '../src/util/bytes';
import { run } from './helpers';

const pdf = buildPdf([
  { info: { Title: 'Draft contract', Author: 'Alex Kim', Creator: 'Microsoft Word', Producer: 'macOS Quartz PDFContext', CreationDate: "D:20260901093000+02'00'" }, pageText: 'Price: 48,000 EUR' },
  { info: { Title: 'Final contract', Author: 'Alex Kim', Creator: 'Microsoft Word', Producer: 'Adobe Acrobat Pro 24' }, pageText: 'Price: 52,000 EUR', invisible: 'internal floor price 45k' },
]);

describe('PDF', () => {
  it('dates keep their time zone', () => {
    expect(formatPdfDate("D:20260901093000+02'00'")).toBe('2026-09-01 09:30:00 UTC+02:00');
    expect(formatPdfDate('D:20260520034600Z')).toBe('2026-05-20 03:46:00 UTC');
  });
  it('decodes literal, escaped and UTF-16 hex strings', () => {
    expect(pdfString('(a\\(b\\) c\\101)', 0)!.value).toBe('a(b) cA');
    expect(pdfString('<FEFF00480069>', 0)!.value).toBe('Hi');
  });
  it('counts revisions and takes the latest Info (V1 took the first)', async () => {
    const r = await parsePdf(pdf);
    expect(r.revisions).toHaveLength(2);
    expect(r.revisions![0].info.Title).toBe('Draft contract');
    const props = r.sections.find(s => s.id === 'pdf-info')!;
    expect(props.fields.find(f => f.key === 'info.Title')!.value).toBe('Final contract');
    expect(props.fields.find(f => f.key === 'info.Producer')!.value).toBe('Adobe Acrobat Pro 24');
    const rev = r.findings.find(f => f.id === 'pdf-revisions')!;
    expect(rev.detail).toContain('Draft contract');
  });
  it('finds invisible text and flags JavaScript', async () => {
    const r = await parsePdf(pdf);
    expect(r.findings.find(f => f.id === 'pdf-invisible')!.detail).toContain('internal floor price 45k');
    const js = latin1(new TextDecoder('latin1').decode(pdf).replace('/Type /Catalog', '/Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >>'));
    const r2 = await run(js, 'a.pdf');
    expect(r2.findings.some(f => f.tag === 'SCRIPT' && f.severity === 'exposed')).toBe(true);
  });
  it('end to end: author is a caution, revisions are history', async () => {
    const r = await run(pdf, 'contract.pdf');
    expect(r.findings.map(f => f.tag)).toEqual(expect.arrayContaining(['AUTHOR', 'HISTORY', 'PAYLOAD', 'DEVICE']));
    expect(r.verdict.level).toBe('caution');
  });
});
