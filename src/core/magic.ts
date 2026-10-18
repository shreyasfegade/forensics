// True-type identification from leading bytes ("magic numbers").
import type { Category, FileType } from './types';
import { ascii, startsWith } from '../util/bytes';

interface Signature {
  bytes: number[];
  at?: number;
  name: string;
  ext: string;
  category: Category;
  mime?: string;
  riff?: boolean;
}

export const SIGNATURES: Signature[] = [
  { bytes: [0xff, 0xd8, 0xff], name: 'JPEG image', ext: 'jpg', category: 'image', mime: 'image/jpeg' },
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], name: 'PNG image', ext: 'png', category: 'image', mime: 'image/png' },
  { bytes: [0x47, 0x49, 0x46, 0x38], name: 'GIF image', ext: 'gif', category: 'image', mime: 'image/gif' },
  { bytes: [0x42, 0x4d], name: 'BMP image', ext: 'bmp', category: 'image', mime: 'image/bmp' },
  { bytes: [0x49, 0x49, 0x2a, 0x00, 0x10, 0x00, 0x00, 0x00, 0x43, 0x52], name: 'Canon CR2 raw', ext: 'cr2', category: 'image' },
  { bytes: [0x49, 0x49, 0x2a, 0x00], name: 'TIFF image (little-endian)', ext: 'tiff', category: 'image', mime: 'image/tiff' },
  { bytes: [0x4d, 0x4d, 0x00, 0x2a], name: 'TIFF image (big-endian)', ext: 'tiff', category: 'image', mime: 'image/tiff' },
  { bytes: [0x00, 0x00, 0x01, 0x00], name: 'ICO icon', ext: 'ico', category: 'image', mime: 'image/x-icon' },
  { bytes: [0x38, 0x42, 0x50, 0x53], name: 'Photoshop document', ext: 'psd', category: 'image' },
  { bytes: [0x25, 0x50, 0x44, 0x46], name: 'PDF document', ext: 'pdf', category: 'document', mime: 'application/pdf' },
  { bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], name: 'Microsoft Office (legacy OLE)', ext: 'doc', category: 'document' },
  { bytes: [0x50, 0x4b, 0x03, 0x04], name: 'ZIP archive', ext: 'zip', category: 'archive', mime: 'application/zip' },
  { bytes: [0x50, 0x4b, 0x05, 0x06], name: 'ZIP archive (empty)', ext: 'zip', category: 'archive', mime: 'application/zip' },
  { bytes: [0x50, 0x4b, 0x07, 0x08], name: 'ZIP archive (spanned)', ext: 'zip', category: 'archive', mime: 'application/zip' },
  { bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], name: 'RAR archive', ext: 'rar', category: 'archive' },
  { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], name: '7-Zip archive', ext: '7z', category: 'archive' },
  { bytes: [0x1f, 0x8b], name: 'GZIP archive', ext: 'gz', category: 'archive' },
  { bytes: [0x42, 0x5a, 0x68], name: 'BZIP2 archive', ext: 'bz2', category: 'archive' },
  { bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a], name: 'XZ archive', ext: 'xz', category: 'archive' },
  { bytes: [0x4d, 0x5a], name: 'Windows executable (PE)', ext: 'exe', category: 'executable' },
  { bytes: [0x7f, 0x45, 0x4c, 0x46], name: 'ELF executable (Linux)', ext: 'elf', category: 'executable' },
  { bytes: [0xcf, 0xfa, 0xed, 0xfe], name: 'Mach-O binary (64-bit)', ext: 'macho', category: 'executable' },
  { bytes: [0xce, 0xfa, 0xed, 0xfe], name: 'Mach-O binary (32-bit)', ext: 'macho', category: 'executable' },
  { bytes: [0xca, 0xfe, 0xba, 0xbe], name: 'Java class / Mach-O fat binary', ext: 'class', category: 'executable' },
  { bytes: [0x00, 0x61, 0x73, 0x6d], name: 'WebAssembly module', ext: 'wasm', category: 'executable' },
  { bytes: [0x49, 0x44, 0x33], name: 'MP3 audio (ID3)', ext: 'mp3', category: 'media', mime: 'audio/mpeg' },
  { bytes: [0x66, 0x4c, 0x61, 0x43], name: 'FLAC audio', ext: 'flac', category: 'media' },
  { bytes: [0x4f, 0x67, 0x67, 0x53], name: 'OGG container', ext: 'ogg', category: 'media' },
  { bytes: [0x52, 0x49, 0x46, 0x46], name: 'RIFF container', ext: 'riff', category: 'media', riff: true },
  { bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65], name: 'SQLite database', ext: 'sqlite', category: 'data' },
  { bytes: [0x77, 0x4f, 0x46, 0x46], name: 'WOFF font', ext: 'woff', category: 'font' },
  { bytes: [0x77, 0x4f, 0x46, 0x32], name: 'WOFF2 font', ext: 'woff2', category: 'font' },
];

const HEIF_BRANDS: Record<string, FileType> = {
  heic: { name: 'HEIC image', ext: 'heic', category: 'image', mime: 'image/heic' },
  heix: { name: 'HEIC image', ext: 'heic', category: 'image', mime: 'image/heic' },
  hevc: { name: 'HEIC image sequence', ext: 'heic', category: 'image', mime: 'image/heic' },
  heim: { name: 'HEIC image', ext: 'heic', category: 'image', mime: 'image/heic' },
  heis: { name: 'HEIC image', ext: 'heic', category: 'image', mime: 'image/heic' },
  mif1: { name: 'HEIF image', ext: 'heif', category: 'image', mime: 'image/heif' },
  msf1: { name: 'HEIF image sequence', ext: 'heif', category: 'image', mime: 'image/heif' },
  avif: { name: 'AVIF image', ext: 'avif', category: 'image', mime: 'image/avif' },
  avis: { name: 'AVIF image sequence', ext: 'avif', category: 'image', mime: 'image/avif' },
};

export function identify(bytes: Uint8Array): FileType {
  if (bytes.length < 2) return { name: 'Empty or unknown', ext: '', category: 'unknown' };

  // ISO base media (MP4 / MOV / HEIC): 'ftyp' box at offset 4.
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (HEIF_BRANDS[brand]) return { ...HEIF_BRANDS[brand] };
    if (brand === 'qt  ') return { name: 'QuickTime movie', ext: 'mov', category: 'media', mime: 'video/quicktime' };
    if (brand === 'M4A ') return { name: 'M4A audio', ext: 'm4a', category: 'media', mime: 'audio/mp4' };
    if (brand.startsWith('3gp')) return { name: '3GPP video', ext: '3gp', category: 'media', mime: 'video/3gpp' };
    if (brand === 'crx ') return { name: 'Canon CR3 raw', ext: 'cr3', category: 'image' };
    return { name: 'MP4 video', ext: 'mp4', category: 'media', mime: 'video/mp4' };
  }
  // Older QuickTime files can start with moov/mdat/wide/free.
  if (bytes.length >= 8 && ['moov', 'mdat', 'wide', 'free', 'skip'].includes(ascii(bytes, 4, 8)) && bytes[0] === 0) {
    return { name: 'QuickTime movie', ext: 'mov', category: 'media', mime: 'video/quicktime' };
  }

  for (const sig of SIGNATURES) {
    if (!startsWith(bytes, sig.bytes, sig.at ?? 0)) continue;
    if (sig.riff && bytes.length >= 12) {
      const sub = ascii(bytes, 8, 12);
      if (sub === 'WAVE') return { name: 'WAV audio', ext: 'wav', category: 'media', mime: 'audio/wav' };
      if (sub === 'AVI ') return { name: 'AVI video', ext: 'avi', category: 'media' };
      if (sub === 'WEBP') return { name: 'WebP image', ext: 'webp', category: 'image', mime: 'image/webp' };
      return { name: `RIFF container (${sub.trim()})`, ext: 'riff', category: 'media' };
    }
    return { name: sig.name, ext: sig.ext, category: sig.category, mime: sig.mime };
  }

  // MPEG audio frame sync, checked after the table so JPEG wins.
  if (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && bytes[1] !== 0xd8) {
    return { name: 'MP3 audio', ext: 'mp3', category: 'media', mime: 'audio/mpeg' };
  }

  let textChars = 0;
  const sampleLen = Math.min(bytes.length, 512);
  for (let i = 0; i < sampleLen; i++) {
    const b = bytes[i];
    if ((b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d || b >= 0xc2) textChars++;
  }
  if (textChars / sampleLen > 0.85) {
    const head = ascii(bytes, 0, 64).trimStart();
    if (head.startsWith('#!')) return { name: 'Script (shebang)', ext: 'sh', category: 'executable' };
    if (head.startsWith('<?xml') || head.startsWith('<svg')) {
      if (ascii(bytes, 0, 1024).includes('<svg')) return { name: 'SVG image', ext: 'svg', category: 'image', mime: 'image/svg+xml' };
      return { name: 'XML document', ext: 'xml', category: 'document' };
    }
    if (head.startsWith('<')) return { name: 'HTML document', ext: 'html', category: 'document' };
    if (head.startsWith('{') || head.startsWith('[')) return { name: 'JSON data', ext: 'json', category: 'data' };
    return { name: 'Plain text', ext: 'txt', category: 'document' };
  }

  return { name: 'Unknown binary', ext: '', category: 'unknown' };
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

// Declared extensions that legitimately map to a detected type.
const ALIASES: Record<string, string[]> = {
  jpg: ['jpg', 'jpeg', 'jpe', 'jfif'],
  tiff: ['tiff', 'tif', 'dng', 'nef', 'arw', 'orf', 'rw2', 'pef', 'srw', '3fr', 'erf'],
  cr2: ['cr2', 'tif', 'tiff'],
  html: ['html', 'htm', 'xhtml', 'txt'],
  xml: ['xml', 'plist', 'rss', 'atom', 'xsd', 'xsl', 'svg', 'txt', 'gpx', 'kml'],
  txt: ['txt', 'md', 'csv', 'tsv', 'log', 'ini', 'cfg', 'conf', 'yml', 'yaml', 'js', 'ts', 'css', 'py', 'c', 'h', 'java', 'rs', 'go', 'rb', 'sql', 'toml', 'env', 'srt', 'vtt', 'tex', 'json', 'html', 'xml'],
  json: ['json', 'geojson', 'txt', 'map', 'ipynb', 'webmanifest'],
  zip: ['zip', 'jar', 'apk', 'xpi', 'epub', 'odt', 'ods', 'odp', 'ipa', 'docx', 'xlsx', 'pptx', 'kmz', 'whl', 'aar', 'vsix', 'nupkg', 'crx'],
  docx: ['docx', 'docm', 'dotx', 'zip'],
  xlsx: ['xlsx', 'xlsm', 'xltx', 'zip'],
  pptx: ['pptx', 'pptm', 'potx', 'zip'],
  doc: ['doc', 'xls', 'ppt', 'msg', 'msi', 'dot'],
  mp4: ['mp4', 'm4v', 'm4a', 'mov', '3gp', 'm4b'],
  mov: ['mov', 'qt', 'mp4', 'm4v'],
  m4a: ['m4a', 'mp4', 'm4b', 'aac'],
  '3gp': ['3gp', '3g2', 'mp4'],
  heic: ['heic', 'heif', 'hif'],
  heif: ['heif', 'heic', 'hif'],
  exe: ['exe', 'dll', 'sys', 'scr', 'ocx', 'cpl', 'efi', 'mui', 'com', 'drv'],
  elf: ['elf', 'so', 'o', 'bin', 'out', ''],
  macho: ['macho', 'dylib', 'bundle', ''],
  mp3: ['mp3'],
  ogg: ['ogg', 'oga', 'ogv', 'opus'],
  gz: ['gz', 'tgz', 'gzip'],
  sh: ['sh', 'bash', 'zsh', 'py', 'pl', 'rb', 'command'],
  ico: ['ico', 'cur'],
  sqlite: ['sqlite', 'db', 'sqlite3', 'sqlitedb'],
  class: ['class'],
};

export function isMismatch(declared: string, type: FileType): boolean {
  if (!declared || !type.ext) return false;
  if (declared === type.ext) return false;
  return !(ALIASES[type.ext] ?? []).includes(declared);
}
