// The analysis pipeline. Runs inside the worker in the browser and directly
// in Node for tests: everything here is pure and works on a Source.
import type { Finding, ParseResult, Report, SanitizePlan } from './types';
import { emptyResult } from './types';
import { extensionOf, identify, isMismatch } from './magic';
import { buildVerdict, caseIdFor, sortFindings } from './verdict';
import { Scanner } from '../analysis/scanner';
import { interpretEntropy } from '../analysis/entropy';
import { chunks, type Source } from '../util/source';
import { parseJpeg, trailingFinding } from '../parsers/jpeg';
import { parsePng } from '../parsers/png';
import { parsePdf } from '../parsers/pdf';
import { parseZipListing, readZipDir } from '../parsers/zip';
import { ooxmlKind, parseOoxml } from '../parsers/ooxml';
import { parseIsobmff } from '../parsers/isobmff';
import { parsePe } from '../parsers/pe';
import { parseId3 } from '../parsers/id3';
import { parseRiff } from '../parsers/riff';
import { parseBmp } from '../parsers/bmp';
import { parseTiff, tiffFindings, tiffSections } from '../parsers/tiff';
import { analyzeStego } from '../analysis/stego';
import { decodePng } from '../util/png-decode';
import { decodeBmp } from '../util/bmp-decode';
import { sanitizePlan } from '../sanitize/plan';

export interface Progress {
  stage: string;
  done: number;
  total: number;
}

export interface AnalyzeOptions {
  name: string;
  lastModified?: number;
  onProgress?: (p: Progress) => void;
}

/** Files up to this size are held in memory for structure parsing; larger ones are parsed from slices. */
export const FULL_LIMIT = 96 * 1024 * 1024;
const HEAD_LIMIT = 32 * 1024 * 1024;

export async function analyze(src: Source, opts: AnalyzeOptions): Promise<Report> {
  const t0 = Date.now();
  const progress = (stage: string, done: number, total: number) => opts.onProgress?.({ stage, done, total });
  const notes: string[] = [];

  progress('Reading header', 0, src.size);
  const complete = src.size <= FULL_LIMIT;
  const head = await src.read(0, complete ? src.size : HEAD_LIMIT);
  let type = identify(head.subarray(0, 4096));
  const declared = extensionOf(opts.name);

  // ---- pass 1: streaming scan of every byte
  const scanner = new Scanner(src.size);
  if (complete) {
    for (let o = 0; o < head.length; o += 4 * 1024 * 1024) {
      scanner.update(head.subarray(o, Math.min(o + 4 * 1024 * 1024, head.length)));
      progress('Hashing and measuring entropy', Math.min(o + 4 * 1024 * 1024, head.length), src.size);
      if (o % (16 * 1024 * 1024) === 0) await yieldNow();
    }
  } else {
    for await (const { offset, bytes } of chunks(src)) {
      scanner.update(bytes);
      progress('Hashing and measuring entropy', offset + bytes.length, src.size);
    }
  }
  const scan = scanner.finish();

  // ---- pass 2: format-aware structure parsing
  progress('Parsing structure', 0, 1);
  let parsed: ParseResult = emptyResult();
  const bytes = head;
  try {
    parsed = await parseByType(src, bytes, type, complete);
  } catch (e) {
    notes.push(`The ${type.name} parser stopped early: ${(e as Error).message}. Results below may be partial.`);
  }
  if (parsed.refinedType) type = parsed.refinedType;
  const mismatch = isMismatch(declared, type);

  const findings: Finding[] = [...parsed.findings];
  if (parsed.hidden) findings.push(trailingFinding(parsed.hidden, bytes, type.ext.toUpperCase()));
  if (mismatch) {
    findings.push(type.category === 'executable'
      ? { id: 'disguise', severity: 'exposed', tag: 'DISGUISE', title: 'Disguised executable', detail: `Named .${declared}, but the bytes are a ${type.name}. Opening it runs a program.`, evidence: [{ offset: 0, length: Math.min(64, src.size) }] }
      : { id: 'disguise', severity: 'caution', tag: 'DISGUISE', title: 'Extension doesn\'t match contents', detail: `Labelled .${declared}, but the bytes say ${type.name}.`, evidence: [{ offset: 0, length: Math.min(16, src.size) }] });
  }
  const secrets = scan.strings.notable.filter(s => s.type === 'secret');
  if (secrets.length) {
    findings.push({ id: 'strings-secret', severity: 'exposed', tag: 'SECRET', title: 'Credential-like text in the raw bytes', detail: `“${secrets[0].value.slice(0, 80)}”${secrets.length > 1 ? ` and ${secrets.length - 1} more` : ''}. Text that looks deleted or hidden is often still in the file.`, evidence: secrets.slice(0, 6).map(s => ({ offset: s.offset, length: s.value.length })) });
  }
  const contacts = scan.strings.notable.filter(s => s.type === 'email');
  if (contacts.length) findings.push({ id: 'strings-email', severity: 'caution', tag: 'CONTACT', title: 'Email addresses in the raw bytes', detail: contacts.slice(0, 3).map(s => s.value).join(', ') + '.', evidence: contacts.slice(0, 6).map(s => ({ offset: s.offset, length: s.value.length })) });
  const paths = scan.strings.notable.filter(s => s.type === 'path' && /(\\Users\\|\/Users\/|\/home\/)[^\\/]+/i.test(s.value));
  if (paths.length && !findings.some(f => f.tag === 'PATH')) findings.push({ id: 'strings-path', severity: 'caution', tag: 'PATH', title: 'Home-folder paths in the raw bytes', detail: `${paths[0].value} reveals an account name from the machine that made this file.`, evidence: paths.slice(0, 4).map(s => ({ offset: s.offset, length: s.value.length })) });

  // ---- steganalysis on lossless images
  let stego: Report['stego'];
  if ((type.ext === 'png' || type.ext === 'bmp') && complete) {
    progress('Running LSB steganalysis', 0, 1);
    try {
      const img = type.ext === 'png' ? await decodePng(bytes) : decodeBmp(bytes);
      if (img && img.width * img.height <= 40_000_000) {
        stego = analyzeStego(img);
        if (stego.verdict !== 'clean') {
          findings.push({ id: 'stego', severity: stego.verdict === 'likely' ? 'exposed' : 'caution', tag: 'STEGO', title: stego.verdict === 'likely' ? 'Consistent with LSB embedding' : 'Unusual least-significant-bit statistics', detail: stego.summary, evidence: [] });
        }
      } else if (img) notes.push('The image is too large for in-browser steganalysis (40 megapixel limit).');
    } catch (e) {
      notes.push(`Steganalysis skipped: ${(e as Error).message}.`);
    }
  }

  const sorted = sortFindings(dedupe(findings));
  const verdict = buildVerdict(sorted);
  const sanitize: SanitizePlan = sanitizePlan(type, parsed, sorted);
  if (scan.strings.scannedBytes < src.size) notes.push(`Strings were extracted from the first 16 MB and last 1 MB (${(scan.strings.scannedBytes / 1048576).toFixed(1)} MB of ${(src.size / 1048576).toFixed(1)} MB).`);
  if (!complete && type.category !== 'media') notes.push('Large file: structure parsing used the first 32 MB. Hash, entropy and byte-plot cover every byte.');
  notes.push(...(parsed.notes ?? []));

  return {
    schemaVersion: 2,
    tool: 'Forensics',
    analyzedAt: new Date().toISOString(),
    caseId: caseIdFor(scan.sha256),
    file: { name: opts.name, size: src.size, declaredExtension: declared || null, lastModified: opts.lastModified },
    hashes: { sha256: scan.sha256 },
    trueType: type,
    extensionMismatch: mismatch,
    verdict,
    findings: sorted,
    sections: parsed.sections,
    structure: parsed.structure,
    entropy: scan.entropy,
    byteplot: scan.byteplot,
    strings: scan.strings,
    gps: parsed.gps,
    hidden: parsed.hidden,
    image: parsed.image,
    thumbnail: parsed.thumbnail,
    revisions: parsed.revisions,
    quant: parsed.quant,
    stego,
    sanitize,
    notes,
    timings: { totalMs: Date.now() - t0 },
  };
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter(f => (seen.has(f.id) ? false : (seen.add(f.id), true)));
}

const yieldNow = () => new Promise<void>(r => setTimeout(r, 0));

async function parseByType(src: Source, bytes: Uint8Array, type: ReturnType<typeof identify>, complete: boolean): Promise<ParseResult> {
  switch (type.ext) {
    case 'jpg': return parseJpeg(bytes);
    case 'png': return parsePng(bytes);
    case 'pdf': {
      if (complete) return parsePdf(bytes, true);
      // Large PDF: head + tail (revisions and the final Info live at the end).
      const tail = await src.read(Math.max(0, src.size - 8 * 1024 * 1024), 8 * 1024 * 1024);
      const r = await parsePdf(bytes, false);
      const t = await parsePdf(tail, false);
      r.findings.push(...t.findings.filter(f => !r.findings.some(g => g.id === f.id)));
      return r;
    }
    case 'zip': {
      const zipBytes = complete ? bytes : null;
      if (!zipBytes) return { ...emptyResult(), notes: ['ZIP archives over 96 MB are listed only by their header.'] };
      const dir = readZipDir(zipBytes);
      if (!dir) return { ...emptyResult(), notes: ['No ZIP central directory found. The archive is truncated or corrupt.'] };
      const kind = ooxmlKind(dir);
      const listing = parseZipListing(zipBytes, dir);
      if (kind) {
        const o = await parseOoxml(zipBytes, dir, kind);
        o.structure = listing.structure;
        o.sections.push(...listing.sections.filter(s => s.id === 'zip-list'));
        o.findings.push(...listing.findings.filter(f => f.id === 'zip-uid' || f.id === 'zip-slip'));
        return o;
      }
      return listing;
    }
    case 'mp4': case 'mov': case 'm4a': case '3gp': case 'cr3':
      return parseIsobmff(src, false);
    case 'heic': case 'heif': case 'avif':
      return parseIsobmff(src, true);
    case 'exe': return parsePe(bytes);
    case 'mp3': return parseId3(complete ? bytes : concatHeadTail(bytes, await src.read(src.size - 128, 128)));
    case 'webp': return parseRiff(bytes, 'WEBP');
    case 'wav': return parseRiff(bytes, 'WAVE');
    case 'avi': return parseRiff(bytes, 'AVI');
    case 'bmp': return parseBmp(bytes);
    case 'tiff': case 'cr2': {
      const t = parseTiff(bytes, 0, bytes.length, type.ext === 'cr2' ? 'Canon CR2 (TIFF)' : 'TIFF');
      if (!t) return emptyResult();
      const r: ParseResult = { sections: tiffSections(t), findings: tiffFindings(t, t.isDng ? 'raw photo' : 'image'), structure: [t.structure], gps: t.gps };
      if (t.isDng) r.refinedType = { name: 'Adobe DNG raw image', ext: 'tiff', category: 'image', mime: 'image/x-adobe-dng' };
      const w = t.get('IFD0', 0x0100)?.value, h = t.get('IFD0', 0x0101)?.value;
      if (Array.isArray(w) && Array.isArray(h)) r.image = { width: w[0], height: h[0] };
      if (t.thumbnail) r.thumbnail = { range: t.thumbnail, mime: 'image/jpeg' };
      return r;
    }
  }
  return emptyResult();
}

function concatHeadTail(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const out = new Uint8Array(head.length + tail.length);
  out.set(head); out.set(tail, head.length);
  return out;
}

export { interpretEntropy };
