// Office Open XML (DOCX / XLSX / PPTX): authorship, edit history, comments,
// tracked changes (including recoverable deleted text), hidden content.
import type { Field, FileType, Finding, ParseResult, Range } from '../core/types';
import { findAll, firstText, runsText, text } from '../util/xml';
import { readEntryText, type ZipDir, type ZipEntry } from './zip';

export type OoxmlKind = 'docx' | 'xlsx' | 'pptx';

export function ooxmlKind(dir: ZipDir): OoxmlKind | null {
  const names = new Set(dir.entries.map(e => e.name));
  if (!names.has('[Content_Types].xml')) return null;
  if (names.has('word/document.xml')) return 'docx';
  if (names.has('xl/workbook.xml')) return 'xlsx';
  if (names.has('ppt/presentation.xml')) return 'pptx';
  return null;
}

export const OOXML_TYPES: Record<OoxmlKind, FileType> = {
  docx: { name: 'Word document (DOCX)', ext: 'docx', category: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { name: 'Excel workbook (XLSX)', ext: 'xlsx', category: 'document', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pptx: { name: 'PowerPoint deck (PPTX)', ext: 'pptx', category: 'document', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
};

const CORE: [tag: string, label: string, sensitive?: boolean][] = [
  ['dc:title', 'Title'], ['dc:subject', 'Subject'], ['dc:creator', 'Author', true], ['cp:lastModifiedBy', 'Last modified by', true],
  ['cp:revision', 'Revision number'], ['dcterms:created', 'Created'], ['dcterms:modified', 'Modified'], ['cp:lastPrinted', 'Last printed'],
  ['cp:keywords', 'Keywords'], ['dc:description', 'Comments field', true], ['cp:category', 'Category'], ['cp:contentStatus', 'Status'],
];
const APP: [tag: string, label: string, sensitive?: boolean][] = [
  ['Application', 'Application'], ['AppVersion', 'App version'], ['Company', 'Company', true], ['Manager', 'Manager', true],
  ['TotalTime', 'Total editing time (min)'], ['Template', 'Template', true], ['Pages', 'Pages'], ['Words', 'Words'],
  ['Slides', 'Slides'], ['Notes', 'Notes pages'], ['HyperlinkBase', 'Hyperlink base', true],
];

export interface TrackedChange { kind: 'insert' | 'delete'; author: string; date: string; text: string }
export interface OfficeComment { author: string; date: string; text: string; part: string }

export interface OoxmlParse extends ParseResult {
  kind: OoxmlKind;
  core: Record<string, string>;
  app: Record<string, string>;
  changes: TrackedChange[];
  comments: OfficeComment[];
}

export async function parseOoxml(bytes: Uint8Array, dir: ZipDir, kind: OoxmlKind): Promise<OoxmlParse> {
  const res: OoxmlParse = { sections: [], findings: [], structure: [], kind, core: {}, app: {}, changes: [], comments: [], refinedType: OOXML_TYPES[kind] };
  const ent = (name: string) => dir.entries.find(e => e.name === name);
  const range = (e?: ZipEntry): Range[] => (e && e.dataOffset > 0 ? [{ offset: e.localOffset, length: e.dataOffset - e.localOffset + e.compressedSize }] : []);
  const read = (name: string) => readEntryText(bytes, dir, name);
  const f = res.findings;

  // --- document properties
  const core = await read('docProps/core.xml');
  if (core) for (const [tag] of CORE) { const v = firstText(core, tag); if (v) res.core[tag] = v; }
  const app = await read('docProps/app.xml');
  if (app) for (const [tag] of APP) { const v = firstText(app, tag); if (v) res.app[tag] = v; }
  const custom = await read('docProps/custom.xml');
  const customProps: Field[] = custom ? findAll(custom, 'property').map((p, i) => ({ key: `custom${i}`, label: p.attrs.name ?? `Property ${i + 1}`, value: text(p.inner), range: range(ent('docProps/custom.xml'))[0] })).filter(x => x.value) : [];

  const coreRange = range(ent('docProps/core.xml'))[0], appRange = range(ent('docProps/app.xml'))[0];
  const props: Field[] = [
    ...CORE.filter(([t]) => res.core[t]).map(([t, label, sensitive]) => ({ key: t, label, value: res.core[t], sensitive, range: coreRange })),
    ...APP.filter(([t]) => res.app[t]).map(([t, label, sensitive]) => ({ key: t, label, value: res.app[t], sensitive, range: appRange })),
  ];
  if (props.length) res.sections.push({ id: 'office-props', title: 'Document properties', fields: props });
  if (customProps.length) res.sections.push({ id: 'office-custom', title: 'Custom properties', fields: customProps });

  const author = res.core['dc:creator'], lastBy = res.core['cp:lastModifiedBy'];
  if (author || lastBy) {
    f.push({ id: 'office-author', severity: 'caution', tag: 'AUTHOR', fixable: true, title: author && lastBy && author !== lastBy ? 'Two people named in properties' : 'Author name in properties', detail: [author && `Written by ${author}`, lastBy && `last saved by ${lastBy}`].filter(Boolean).join(', ') + '.', evidence: range(ent('docProps/core.xml')) });
  }
  if (res.app.Company || res.app.Manager) {
    f.push({ id: 'office-company', severity: 'caution', tag: 'AUTHOR', fixable: true, title: 'Organisation recorded', detail: [res.app.Company && `Company: ${res.app.Company}`, res.app.Manager && `Manager: ${res.app.Manager}`].filter(Boolean).join(' · ') + '.', evidence: range(ent('docProps/app.xml')) });
  }
  const rev = parseInt(res.core['cp:revision'] ?? '', 10), mins = parseInt(res.app.TotalTime ?? '', 10);
  if (rev > 1 || mins > 0) {
    f.push({ id: 'office-history', severity: 'info', tag: 'HISTORY', fixable: true, title: 'Editing history counters', detail: `${rev > 1 ? `Saved ${rev} times` : ''}${rev > 1 && mins > 0 ? ', ' : ''}${mins > 0 ? `${mins} minutes of editing time` : ''}${res.core['dcterms:created'] ? `, created ${res.core['dcterms:created']}` : ''}.`, evidence: [...range(ent('docProps/core.xml')), ...range(ent('docProps/app.xml'))] });
  }
  if (res.app.Template && /[\\/]/.test(res.app.Template)) {
    f.push({ id: 'office-template', severity: 'caution', tag: 'PATH', fixable: true, title: 'Template path from the author\'s machine', detail: `Template: ${res.app.Template}`, evidence: range(ent('docProps/app.xml')) });
  }

  // --- external references in relationships (attached templates, linked files)
  const relPaths: { part: string; target: string }[] = [];
  for (const e of dir.entries.filter(x => x.name.endsWith('.rels'))) {
    const rels = await read(e.name);
    if (!rels) continue;
    for (const r of findAll(rels, 'Relationship')) {
      if (r.attrs.TargetMode === 'External' && /^(file:|[a-zA-Z]:\\|\\\\)/i.test(r.attrs.Target ?? '')) relPaths.push({ part: e.name, target: r.attrs.Target });
    }
  }
  if (relPaths.length) {
    f.push({ id: 'office-extpath', severity: 'caution', tag: 'PATH', title: 'Links to files on a private drive', detail: `${relPaths[0].target}${relPaths.length > 1 ? ` and ${relPaths.length - 1} more` : ''}. Local paths often contain usernames and network share names.`, evidence: range(ent(relPaths[0].part)) });
    res.sections.push({ id: 'office-ext', title: 'External file links', fields: relPaths.slice(0, 20).map((r, i) => ({ key: `ext${i}`, label: r.part, value: r.target, mono: true, sensitive: true })) });
  }

  // --- people (Word co-authoring identities)
  const people = await read('word/people.xml');
  if (people) {
    const persons = findAll(people, 'w15:person').map(p => ({ name: p.attrs['w15:author'] ?? '', id: findAll(p.inner, 'w15:presenceInfo')[0]?.attrs['w15:userId'] ?? '', provider: findAll(p.inner, 'w15:presenceInfo')[0]?.attrs['w15:providerId'] ?? '' }));
    if (persons.length) {
      res.sections.push({ id: 'office-people', title: 'Collaborators', fields: persons.map((p, i) => ({ key: `p${i}`, label: p.name || `Person ${i + 1}`, value: [p.provider, p.id].filter(Boolean).join(' · ') || 'listed', sensitive: true })) });
      if (persons.some(p => p.id)) f.push({ id: 'office-ids', severity: 'caution', tag: 'AUTHOR', title: 'Account identifiers of collaborators', detail: `word/people.xml stores ${persons.length} collaborator identit${persons.length > 1 ? 'ies' : 'y'}, including account IDs such as “${persons.find(p => p.id)!.id.slice(0, 60)}”.`, evidence: range(ent('word/people.xml')) });
    }
  }

  // --- comments
  const commentParts = dir.entries.filter(e => /^(word\/comments\.xml|xl\/comments\d*\.xml|ppt\/comments\/.*\.xml|xl\/threadedComments\/.*\.xml)$/.test(e.name));
  let authorsXl: string[] = [];
  for (const e of commentParts) {
    const xml = await read(e.name);
    if (!xml) continue;
    if (e.name.startsWith('word/')) {
      for (const c of findAll(xml, 'w:comment')) res.comments.push({ author: c.attrs['w:author'] ?? '', date: c.attrs['w:date'] ?? '', text: runsText(c.inner, ['w:t']), part: e.name });
    } else if (e.name.startsWith('xl/comments')) {
      authorsXl = findAll(xml, 'author').map(a => text(a.inner));
      for (const c of findAll(xml, 'comment')) res.comments.push({ author: authorsXl[parseInt(c.attrs.authorId ?? '0', 10)] ?? '', date: '', text: runsText(c.inner, ['t']), part: e.name });
    } else if (e.name.startsWith('xl/threadedComments')) {
      for (const c of findAll(xml, 'threadedComment')) res.comments.push({ author: c.attrs.personId ?? '', date: c.attrs.dT ?? '', text: text(findAll(c.inner, 'text')[0]?.inner ?? ''), part: e.name });
    } else {
      for (const c of findAll(xml, 'p:cm')) res.comments.push({ author: c.attrs.authorId ?? '', date: c.attrs.dt ?? '', text: text(findAll(c.inner, 'p:text')[0]?.inner ?? ''), part: e.name });
    }
  }
  const pptAuthors = await read('ppt/commentAuthors.xml');
  if (pptAuthors) {
    const map = new Map(findAll(pptAuthors, 'p:cmAuthor').map(a => [a.attrs.id, a.attrs.name]));
    for (const c of res.comments) if (c.part.startsWith('ppt/') && map.has(c.author)) c.author = map.get(c.author)!;
  }
  if (res.comments.length) {
    const authors = [...new Set(res.comments.map(c => c.author).filter(Boolean))];
    res.sections.push({ id: 'office-comments', title: `Comments (${res.comments.length})`, fields: res.comments.slice(0, 40).map((c, i) => ({ key: `c${i}`, label: [c.author, c.date].filter(Boolean).join(' · ') || `Comment ${i + 1}`, value: c.text || '(empty)', sensitive: true })) });
    f.push({ id: 'office-comments', severity: 'caution', tag: 'COMMENT', title: `${res.comments.length} reviewer comment${res.comments.length > 1 ? 's' : ''} left in`, detail: `${authors.length ? `From ${authors.slice(0, 3).join(', ')}. ` : ''}First: “${(res.comments[0].text || '').slice(0, 120)}”. Comments travel with the file even when the margin is hidden.`, evidence: commentParts.flatMap(e => range(e)) });
  }

  // --- body: tracked changes and hidden text (Word)
  if (kind === 'docx') {
    const doc = await read('word/document.xml');
    if (doc) {
      for (const d of findAll(doc, 'w:del')) {
        const t = runsText(d.inner, ['w:delText']);
        if (t.trim()) res.changes.push({ kind: 'delete', author: d.attrs['w:author'] ?? '', date: d.attrs['w:date'] ?? '', text: t });
      }
      for (const d of findAll(doc, 'w:ins')) {
        const t = runsText(d.inner, ['w:t']);
        if (t.trim()) res.changes.push({ kind: 'insert', author: d.attrs['w:author'] ?? '', date: d.attrs['w:date'] ?? '', text: t });
      }
      const hidden: string[] = [];
      for (const r of findAll(doc, 'w:r')) if (/<w:vanish\s*\/>|<w:vanish\s+w:val="(true|1|on)"/.test(r.inner)) { const t = runsText(r.inner, ['w:t']); if (t.trim()) hidden.push(t); }
      const docRange = range(ent('word/document.xml'));
      if (res.changes.length) {
        const dels = res.changes.filter(c => c.kind === 'delete');
        const authors = [...new Set(res.changes.map(c => c.author).filter(Boolean))];
        res.sections.push({ id: 'office-changes', title: `Tracked changes (${res.changes.length})`, fields: res.changes.slice(0, 60).map((c, i) => ({ key: `tc${i}`, label: `${c.kind === 'delete' ? 'Deleted' : 'Inserted'} · ${c.author || 'unknown'}${c.date ? ' · ' + c.date.replace('T', ' ').replace('Z', '') : ''}`, value: c.text.slice(0, 500), sensitive: c.kind === 'delete' })) });
        f.push({
          id: 'office-changes', severity: dels.length ? 'exposed' : 'caution', tag: 'HISTORY',
          title: dels.length ? 'Deleted text is still in the file' : 'Unaccepted tracked insertions',
          detail: dels.length
            ? `${dels.length} tracked deletion${dels.length > 1 ? 's' : ''} by ${authors.slice(0, 2).join(', ') || 'an editor'} can be read back word for word: “${dels[0].text.slice(0, 140)}”.`
            : `${res.changes.length} insertion${res.changes.length > 1 ? 's' : ''} by ${authors.slice(0, 2).join(', ') || 'an editor'} with names and timestamps.`,
          evidence: docRange,
        });
      }
      if (hidden.length) {
        res.sections.push({ id: 'office-hidden', title: 'Hidden text', fields: hidden.slice(0, 20).map((t, i) => ({ key: `h${i}`, label: `Run ${i + 1}`, value: t.slice(0, 400), sensitive: true })) });
        f.push({ id: 'office-hidden', severity: 'caution', tag: 'PAYLOAD', title: 'Hidden text runs', detail: `${hidden.length} run${hidden.length > 1 ? 's are' : ' is'} formatted as hidden: “${hidden[0].slice(0, 120)}”.`, evidence: docRange });
      }
    }
    const settings = await read('word/settings.xml');
    const rsids = settings ? findAll(settings, 'w:rsid').length : 0;
    if (rsids > 1) res.sections.find(s => s.id === 'office-props')?.fields.push({ key: 'rsids', label: 'Editing sessions (rsid)', value: String(rsids), mono: true });
  }

  // --- PowerPoint speaker notes, Excel hidden sheets
  if (kind === 'pptx') {
    const notes = dir.entries.filter(e => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(e.name));
    const texts: string[] = [];
    for (const e of notes.slice(0, 50)) {
      const xml = await read(e.name);
      const t = xml ? runsText(xml, ['a:t']).trim() : '';
      if (t && !/^\d+$/.test(t)) texts.push(t);
    }
    if (texts.length) {
      res.sections.push({ id: 'ppt-notes', title: 'Speaker notes', fields: texts.slice(0, 20).map((t, i) => ({ key: `n${i}`, label: `Note ${i + 1}`, value: t.slice(0, 400), sensitive: true })) });
      f.push({ id: 'ppt-notes', severity: 'caution', tag: 'COMMENT', title: 'Speaker notes travel with the deck', detail: `${texts.length} slide${texts.length > 1 ? 's have' : ' has'} notes: “${texts[0].slice(0, 120)}”.`, evidence: notes.flatMap(e => range(e)).slice(0, 4) });
    }
  }
  if (kind === 'xlsx') {
    const wb = await read('xl/workbook.xml');
    const hiddenSheets = wb ? findAll(wb, 'sheet').filter(s => s.attrs.state === 'hidden' || s.attrs.state === 'veryHidden') : [];
    if (hiddenSheets.length) f.push({ id: 'xl-hidden', severity: 'caution', tag: 'PAYLOAD', title: 'Hidden worksheets', detail: `${hiddenSheets.map(s => `“${s.attrs.name}”${s.attrs.state === 'veryHidden' ? ' (very hidden)' : ''}`).join(', ')} won't show in the tab bar but open with one click.`, evidence: range(ent('xl/workbook.xml')) });
    const ext = dir.entries.filter(e => e.name.startsWith('xl/externalLinks/'));
    if (ext.length) f.push({ id: 'xl-extlinks', severity: 'info', tag: 'PATH', title: 'Links to other workbooks', detail: `${ext.length} external workbook link${ext.length > 1 ? 's' : ''}.`, evidence: ext.flatMap(e => range(e)).slice(0, 3) });
  }

  // --- parts that matter regardless of kind
  const thumb = dir.entries.find(e => /^docProps\/thumbnail\./.test(e.name));
  if (thumb) f.push({ id: 'office-thumb', severity: 'info', tag: 'THUMBNAIL', fixable: true, title: 'Saved preview image', detail: `${thumb.name} holds a picture of the first page as it looked at the last save.`, evidence: range(thumb) });
  const vba = dir.entries.find(e => /vbaProject\.bin$/i.test(e.name));
  if (vba) f.push({ id: 'office-macro', severity: 'exposed', tag: 'SCRIPT', title: 'VBA macros embedded', detail: `${vba.name} contains macro code that Office can run.`, evidence: range(vba) });
  const embeds = dir.entries.filter(e => /\/embeddings\//.test(e.name));
  if (embeds.length) f.push({ id: 'office-embeds', severity: 'info', tag: 'ARCHIVE', title: 'Embedded objects', detail: `${embeds.length} embedded file${embeds.length > 1 ? 's' : ''} (${embeds.slice(0, 3).map(e => e.name.split('/').pop()).join(', ')}). Embedded spreadsheets and documents carry their own metadata.`, evidence: embeds.flatMap(e => range(e)).slice(0, 4) });
  const customXml = dir.entries.filter(e => e.name.startsWith('customXml/item') && !e.name.includes('Props'));
  if (customXml.length) res.sections.find(s => s.id === 'office-props')?.fields.push({ key: 'customXml', label: 'customXml parts', value: String(customXml.length), mono: true });
  return res;
}
