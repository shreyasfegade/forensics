// XMP packets (Adobe's RDF/XML metadata). Pulled with a small reader because
// workers have no DOMParser.
import type { Field, Finding, Range, Section } from '../core/types';
import { decodeEntities, findAll, text } from '../util/xml';

const PROPS: [name: string, label: string, sensitive?: boolean][] = [
  ['dc:creator', 'Creator', true],
  ['dc:rights', 'Rights'],
  ['dc:title', 'Title'],
  ['dc:description', 'Description'],
  ['xmp:CreatorTool', 'Creator tool'],
  ['xmp:CreateDate', 'Created'],
  ['xmp:ModifyDate', 'Modified'],
  ['xmp:MetadataDate', 'Metadata date'],
  ['photoshop:AuthorsPosition', 'Author position', true],
  ['photoshop:City', 'City', true],
  ['photoshop:State', 'State', true],
  ['photoshop:Country', 'Country', true],
  ['Iptc4xmpCore:Location', 'Location', true],
  ['Iptc4xmpCore:CreatorContactInfo', 'Creator contact', true],
  ['exif:GPSLatitude', 'GPS latitude', true],
  ['exif:GPSLongitude', 'GPS longitude', true],
  ['tiff:Make', 'Make'],
  ['tiff:Model', 'Model'],
  ['aux:SerialNumber', 'Body serial', true],
  ['exifEX:BodySerialNumber', 'Body serial', true],
  ['aux:Lens', 'Lens'],
  ['xmpMM:DocumentID', 'Document ID'],
  ['xmpMM:OriginalDocumentID', 'Original document ID'],
  ['crs:HasCrop', 'Camera Raw: cropped'],
  ['pdf:Producer', 'PDF producer'],
  ['pdf:Keywords', 'Keywords'],
];

export interface XmpData {
  props: Record<string, string>;
  history: { action: string; when: string; agent: string }[];
  range: Range;
}

function getProp(xml: string, name: string): string | null {
  const attr = new RegExp(`\\b${name.replace(':', '\\:')}\\s*=\\s*"([^"]*)"`).exec(xml);
  if (attr) return decodeEntities(attr[1]).trim() || null;
  const els = findAll(xml, name);
  if (!els.length) return null;
  const lis = findAll(els[0].inner, 'rdf:li');
  const v = lis.length ? lis.map(l => text(l.inner)).filter(Boolean).join(', ') : text(els[0].inner);
  return v || null;
}

export function parseXmp(xml: string, range: Range): XmpData {
  const props: Record<string, string> = {};
  for (const [name] of PROPS) {
    const v = getProp(xml, name);
    if (v) props[name] = v;
  }
  const history: XmpData['history'] = [];
  const hist = findAll(xml, 'xmpMM:History')[0];
  if (hist) {
    for (const li of findAll(hist.inner, 'rdf:li')) {
      const g = (n: string) => li.attrs[n] ?? getProp(li.inner, n) ?? '';
      history.push({ action: g('stEvt:action'), when: g('stEvt:when'), agent: g('stEvt:softwareAgent') });
    }
  }
  return { props, history, range };
}

export function xmpSection(x: XmpData, id = 'xmp'): Section | null {
  const fields: Field[] = [];
  for (const [name, label, sensitive] of PROPS) {
    if (x.props[name]) fields.push({ key: name, label, value: x.props[name], range: x.range, sensitive });
  }
  x.history.slice(0, 12).forEach((h, i) => {
    fields.push({ key: `hist${i}`, label: `History ${i + 1}`, value: [h.action, h.agent, h.when].filter(Boolean).join(' · '), range: x.range });
  });
  if (!fields.length) return null;
  return { id, title: 'XMP metadata', fields };
}

export function xmpFindings(x: XmpData): Finding[] {
  const out: Finding[] = [];
  const p = x.props;
  const ev = [x.range];
  if (p['dc:creator'] || p['Iptc4xmpCore:CreatorContactInfo'] || p['photoshop:AuthorsPosition']) {
    out.push({ id: 'xmp-author', severity: 'caution', tag: 'AUTHOR', fixable: true, title: 'Creator named in XMP', detail: `XMP lists the creator as ${p['dc:creator'] ?? 'a named person'}.`, evidence: ev });
  }
  if (p['exif:GPSLatitude'] || p['photoshop:City'] || p['Iptc4xmpCore:Location']) {
    out.push({ id: 'xmp-place', severity: p['exif:GPSLatitude'] ? 'exposed' : 'caution', tag: 'GPS', fixable: true, title: 'Place recorded in XMP', detail: [p['exif:GPSLatitude'] && `GPS ${p['exif:GPSLatitude']}, ${p['exif:GPSLongitude'] ?? ''}`, p['Iptc4xmpCore:Location'], p['photoshop:City'], p['photoshop:Country']].filter(Boolean).join(' · '), evidence: ev });
  }
  if (x.history.length) {
    const agents = [...new Set(x.history.map(h => h.agent).filter(Boolean))];
    out.push({ id: 'xmp-history', severity: 'info', tag: 'HISTORY', fixable: true, title: `Edit history: ${x.history.length} step${x.history.length > 1 ? 's' : ''}`, detail: `XMP keeps a log of saves${agents.length ? ` by ${agents.slice(0, 3).join(', ')}` : ''}.`, evidence: ev });
  }
  if (p['crs:HasCrop'] === 'True') {
    out.push({ id: 'xmp-crop', severity: 'info', tag: 'EDITED', fixable: true, title: 'Cropped in Camera Raw / Lightroom', detail: 'XMP records a crop. The original framing may survive in an embedded preview.', evidence: ev });
  }
  if (p['xmpMM:OriginalDocumentID'] && p['xmpMM:OriginalDocumentID'] !== p['xmpMM:DocumentID']) {
    out.push({ id: 'xmp-lineage', severity: 'info', tag: 'HISTORY', fixable: true, title: 'Derived from another document', detail: `Original document ID ${p['xmpMM:OriginalDocumentID']} differs from this file's ID, so it can be linked back to its source.`, evidence: ev });
  }
  return out;
}
