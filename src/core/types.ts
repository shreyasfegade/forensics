// Shared contract between the analysis worker and the UI. Every finding
// carries the byte ranges that prove it, so the UI can always jump from a
// claim to the bytes behind it.

export type Severity = 'exposed' | 'caution' | 'info' | 'clear';

export interface Range {
  offset: number;
  length: number;
}

export interface Field {
  key: string;
  label: string;
  value: string;
  range?: Range;
  /** Personal or identifying value: rendered behind a redaction bar. */
  sensitive?: boolean;
  mono?: boolean;
}

export interface StructNode {
  id: string;
  label: string;
  kind: string;
  range: Range;
  note?: string;
  children?: StructNode[];
}

export type Tag =
  | 'GPS' | 'DEVICE' | 'AUTHOR' | 'PAYLOAD' | 'DISGUISE' | 'SCRIPT' | 'SECRET'
  | 'CONTACT' | 'THUMBNAIL' | 'HISTORY' | 'COMMENT' | 'TIMESTAMP' | 'STEGO'
  | 'EDITED' | 'PATH' | 'SIGNATURE' | 'ARCHIVE' | 'SERIAL' | 'CLEAN';

export interface Finding {
  id: string;
  severity: Severity;
  tag: Tag;
  title: string;
  detail: string;
  evidence: Range[];
  /** True when the sanitizer can remove what this finding describes. */
  fixable?: boolean;
}

export interface Section {
  id: string;
  title: string;
  fields: Field[];
  note?: string;
}

export type Category =
  | 'image' | 'document' | 'archive' | 'executable' | 'media' | 'data' | 'font' | 'unknown';

export interface FileType {
  name: string;
  ext: string;
  category: Category;
  mime?: string;
}

export interface GPSFix {
  lat: number;
  lon: number;
  alt?: number;
  source: string;
  range?: Range;
}

export interface HiddenData {
  offset: number;
  length: number;
  previewHex: string;
  previewText: string;
}

export interface ImageInfo {
  width: number;
  height: number;
  bitDepth?: number;
  colorType?: string;
}

export interface ThumbnailInfo {
  range: Range;
  mime: string;
  width?: number;
  height?: number;
  /** Filled in by the browser-side image comparison when it can run. */
  comparison?: ThumbnailComparison;
}

export interface ThumbnailComparison {
  mainAspect: number;
  thumbAspect: number;
  aspectDelta: number;
  hashDistance: number;
  mismatch: boolean;
}

export interface PdfRevision {
  index: number;
  endOffset: number;
  info: Record<string, string>;
}

export interface QuantInfo {
  tables: number;
  qualityEstimate: number | null;
  match: string | null;
}

export interface StegoChannel {
  channel: 'R' | 'G' | 'B';
  chiSquareP: number;
  rsEstimate: number;
}

export interface StegoResult {
  width: number;
  height: number;
  channels: StegoChannel[];
  /** Chi-square p-value over growing prefixes of the pixel stream (0..1, 32 points). */
  curve: number[];
  verdict: 'clean' | 'suspicious' | 'likely';
  summary: string;
}

export interface EntropyProfile {
  overall: number;
  histogram: number[];
  blocks: number[];
  blockSize: number;
}

export interface BytePlot {
  order: number;
  cells: number;
  bytesPerCell: number;
  /** One class per cell: 0 null, 1 ascii, 2 control, 3 high, 255 unused. */
  classes: Uint8Array;
}

export interface NotableString {
  type: 'url' | 'email' | 'path' | 'secret';
  value: string;
  offset: number;
}

export interface SanitizePlan {
  supported: boolean;
  method: string;
  removes: string[];
  keeps: string[];
  reason?: string;
}

export interface Verdict {
  level: 'clear' | 'caution' | 'exposed';
  title: string;
  summary: string;
}

export interface Report {
  schemaVersion: 2;
  tool: 'Forensics';
  analyzedAt: string;
  caseId: string;
  file: { name: string; size: number; declaredExtension: string | null; lastModified?: number };
  hashes: { sha256: string };
  trueType: FileType;
  extensionMismatch: boolean;
  verdict: Verdict;
  findings: Finding[];
  sections: Section[];
  structure: StructNode[];
  entropy: EntropyProfile;
  byteplot: BytePlot;
  strings: { total: number; notable: NotableString[]; scannedBytes: number };
  gps?: GPSFix;
  hidden?: HiddenData;
  image?: ImageInfo;
  thumbnail?: ThumbnailInfo;
  revisions?: PdfRevision[];
  quant?: QuantInfo;
  stego?: StegoResult;
  sanitize: SanitizePlan;
  /** Honest statements about what was and wasn't inspected. */
  notes: string[];
  timings: { totalMs: number };
}

export interface ParseResult {
  sections: Section[];
  findings: Finding[];
  structure: StructNode[];
  gps?: GPSFix;
  hidden?: HiddenData;
  image?: ImageInfo;
  thumbnail?: ThumbnailInfo;
  revisions?: PdfRevision[];
  quant?: QuantInfo;
  notes?: string[];
  /** A parser may refine the detected type (e.g. ZIP -> DOCX). */
  refinedType?: FileType;
}

export function emptyResult(): ParseResult {
  return { sections: [], findings: [], structure: [] };
}
