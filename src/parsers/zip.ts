// ZIP: central-directory reader (and the base for DOCX/XLSX/PPTX).
import type { Finding, ParseResult, StructNode } from '../core/types';
import { emptyResult } from '../core/types';
import { Cursor, utf8 } from '../util/bytes';
import { tryInflate } from '../util/inflate';

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  dataOffset: number;
  modified: string;
  extra: Uint8Array;
  externalAttrs: number;
  comment: string;
  cdOffset: number;
  cdLength: number;
}

export interface ZipDir {
  entries: ZipEntry[];
  cdOffset: number;
  cdSize: number;
  eocdOffset: number;
  comment: string;
}

export function readZipDir(bytes: Uint8Array): ZipDir | null {
  const c = new Cursor(bytes, true);
  // EOCD: last 22..65557 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  let total = c.u16(eocd + 10);
  let cdSize = c.u32(eocd + 12);
  let cdOffset = c.u32(eocd + 16);
  const commentLen = c.u16(eocd + 20);
  // ZIP64 locator
  if ((cdOffset === 0xffffffff || total === 0xffff) && eocd >= 20 && c.u32(eocd - 20) === 0x07064b50) {
    const z64 = c.u64(eocd - 12);
    if (c.has(z64, 56) && c.u32(z64) === 0x06064b50) {
      total = c.u64(z64 + 32); cdSize = c.u64(z64 + 40); cdOffset = c.u64(z64 + 48);
    }
  }
  if (!c.has(cdOffset, cdSize)) return null;
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let k = 0; k < Math.min(total, 100000) && c.has(p, 46) && c.u32(p) === 0x02014b50; k++) {
    const flags = c.u16(p + 8), method = c.u16(p + 10), time = c.u16(p + 12), date = c.u16(p + 14);
    const crc = c.u32(p + 16);
    let compressedSize = c.u32(p + 20), size = c.u32(p + 24);
    const nLen = c.u16(p + 28), xLen = c.u16(p + 30), cLen = c.u16(p + 32);
    const externalAttrs = c.u32(p + 38);
    let localOffset = c.u32(p + 42);
    const nameBytes = bytes.subarray(p + 46, p + 46 + nLen);
    const name = flags & 0x800 ? utf8(nameBytes) : Array.from(nameBytes, b => String.fromCharCode(b)).join('');
    const extra = bytes.subarray(p + 46 + nLen, p + 46 + nLen + xLen);
    // ZIP64 extra field
    for (let e = 0; e + 4 <= extra.length;) {
      const id = extra[e] | (extra[e + 1] << 8), len = extra[e + 2] | (extra[e + 3] << 8);
      if (id === 1) {
        const ec = new Cursor(extra.subarray(e + 4, e + 4 + len), true);
        let q = 0;
        if (size === 0xffffffff && q + 8 <= len) { size = ec.u64(q); q += 8; }
        if (compressedSize === 0xffffffff && q + 8 <= len) { compressedSize = ec.u64(q); q += 8; }
        if (localOffset === 0xffffffff && q + 8 <= len) { localOffset = ec.u64(q); q += 8; }
      }
      e += 4 + len;
    }
    let dataOffset = -1;
    if (c.has(localOffset, 30) && c.u32(localOffset) === 0x04034b50) {
      dataOffset = localOffset + 30 + c.u16(localOffset + 26) + c.u16(localOffset + 28);
    }
    const modified = `${1980 + (date >> 9)}-${String((date >> 5) & 15).padStart(2, '0')}-${String(date & 31).padStart(2, '0')} ${String(time >> 11).padStart(2, '0')}:${String((time >> 5) & 63).padStart(2, '0')}`;
    entries.push({ name, method, flags, crc, compressedSize, size, localOffset, dataOffset, modified, extra, externalAttrs, comment: utf8(bytes.subarray(p + 46 + nLen + xLen, p + 46 + nLen + xLen + cLen)), cdOffset: p, cdLength: 46 + nLen + xLen + cLen });
    p += 46 + nLen + xLen + cLen;
  }
  return { entries, cdOffset, cdSize, eocdOffset: eocd, comment: utf8(bytes.subarray(eocd + 22, eocd + 22 + commentLen)) };
}

export async function readEntry(bytes: Uint8Array, e: ZipEntry, maxOut = 32 * 1024 * 1024): Promise<Uint8Array | null> {
  if (e.dataOffset < 0 || e.flags & 1) return null;
  const raw = bytes.subarray(e.dataOffset, e.dataOffset + e.compressedSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return tryInflate(raw, 'deflate-raw', maxOut);
  return null;
}

export async function readEntryText(bytes: Uint8Array, dir: ZipDir, name: string): Promise<string | null> {
  const e = dir.entries.find(x => x.name === name);
  if (!e) return null;
  const data = await readEntry(bytes, e);
  return data ? utf8(data) : null;
}

const METHODS: Record<number, string> = { 0: 'stored', 8: 'deflate', 9: 'deflate64', 12: 'bzip2', 14: 'lzma', 93: 'zstd', 95: 'xz', 99: 'AES' };

/** Extra fields that leak identity: Unix UID/GID (0x7875, 0x5855), NTFS times (0x000a). */
function extraInfo(extra: Uint8Array): { uid?: number; gid?: number; ntfs?: boolean } {
  const out: { uid?: number; gid?: number; ntfs?: boolean } = {};
  for (let e = 0; e + 4 <= extra.length;) {
    const id = extra[e] | (extra[e + 1] << 8), len = extra[e + 2] | (extra[e + 3] << 8);
    const d = extra.subarray(e + 4, e + 4 + len);
    if (id === 0x7875 && d.length >= 3) {
      const ul = d[1];
      let uid = 0; for (let i = 0; i < ul && i < 4; i++) uid |= d[2 + i] << (8 * i);
      const gl = d[2 + ul];
      let gid = 0; for (let i = 0; i < gl && i < 4; i++) gid |= d[3 + ul + i] << (8 * i);
      out.uid = uid >>> 0; out.gid = gid >>> 0;
    } else if (id === 0x5855 && d.length >= 12) {
      out.uid = d[8] | (d[9] << 8); out.gid = d[10] | (d[11] << 8);
    } else if (id === 0x000a) out.ntfs = true;
    e += 4 + len;
  }
  return out;
}

export function parseZipListing(bytes: Uint8Array, dir: ZipDir): ParseResult {
  const res = emptyResult();
  const nodes: StructNode[] = [];
  const shown = dir.entries.slice(0, 400);
  for (const e of shown) {
    if (e.localOffset >= 0 && e.dataOffset > 0) {
      nodes.push({ id: `zip@${e.localOffset}`, label: e.name || '(unnamed)', kind: 'zip-entry', range: { offset: e.localOffset, length: e.dataOffset - e.localOffset + e.compressedSize }, note: `${METHODS[e.method] ?? 'method ' + e.method}, ${e.size.toLocaleString()} B` });
    }
  }
  nodes.push({ id: 'zip-cd', label: `Central directory · ${dir.entries.length} entries`, kind: 'directory', range: { offset: dir.cdOffset, length: dir.cdSize } });
  nodes.push({ id: 'zip-eocd', label: 'End of central directory', kind: 'trailer', range: { offset: dir.eocdOffset, length: bytes.length - dir.eocdOffset } });
  res.structure = nodes;

  const total = dir.entries.reduce((a, e) => a + e.size, 0);
  const encrypted = dir.entries.filter(e => e.flags & 1);
  const traversal = dir.entries.filter(e => /(^|[\\/])\.\.([\\/]|$)/.test(e.name) || /^([a-zA-Z]:|[\\/])/.test(e.name));
  const ids = dir.entries.map(e => extraInfo(e.extra)).filter(x => x.uid != null);
  const uids = [...new Set(ids.map(x => `${x.uid}:${x.gid}`))];
  const macJunk = dir.entries.filter(e => e.name.startsWith('__MACOSX/') || e.name.endsWith('.DS_Store'));
  const userPaths = dir.entries.filter(e => /(^|\/)(Users|home)\/[^/]+\//.test(e.name));
  const dates = dir.entries.map(e => e.modified).sort();
  const ratio = dir.entries.filter(e => e.compressedSize > 0 && e.size / e.compressedSize > 200 && e.size > 50 * 1024 * 1024);

  res.sections.push({ id: 'zip', title: 'Archive', fields: [
    { key: 'n', label: 'Entries', value: dir.entries.length.toLocaleString(), mono: true },
    { key: 'size', label: 'Uncompressed total', value: `${total.toLocaleString()} B`, mono: true },
    ...(dates.length ? [{ key: 'dates', label: 'Timestamps span', value: `${dates[0]} → ${dates[dates.length - 1]}`, mono: true }] : []),
    ...(dir.comment ? [{ key: 'comment', label: 'Archive comment', value: dir.comment.slice(0, 300) }] : []),
    ...(uids.length ? [{ key: 'uid', label: 'Unix owner (uid:gid)', value: uids.slice(0, 4).join(', '), mono: true, sensitive: true }] : []),
  ] });
  res.sections.push({ id: 'zip-list', title: `Contents${dir.entries.length > 60 ? ' (first 60)' : ''}`, fields: dir.entries.slice(0, 60).map((e, i) => ({
    key: `e${i}`, label: e.name, value: `${e.size.toLocaleString()} B · ${METHODS[e.method] ?? e.method}${e.flags & 1 ? ' · encrypted' : ''} · ${e.modified}`, mono: true,
    range: e.dataOffset > 0 ? { offset: e.localOffset, length: e.dataOffset - e.localOffset + e.compressedSize } : undefined,
  })) });

  const f: Finding[] = res.findings;
  if (traversal.length) f.push({ id: 'zip-slip', severity: 'exposed', tag: 'PAYLOAD', title: 'Path-traversal entries (zip slip)', detail: `${traversal.length} entr${traversal.length > 1 ? 'ies' : 'y'} like “${traversal[0].name}” would be written outside the extraction folder by naive unzip tools.`, evidence: traversal.slice(0, 4).map(e => ({ offset: e.cdOffset, length: e.cdLength })) });
  if (encrypted.length) f.push({ id: 'zip-enc', severity: 'info', tag: 'ARCHIVE', title: 'Password-protected entries', detail: `${encrypted.length} of ${dir.entries.length} entries are encrypted. File names are still readable.`, evidence: encrypted.slice(0, 4).map(e => ({ offset: e.cdOffset, length: e.cdLength })) });
  if (uids.length) f.push({ id: 'zip-uid', severity: 'info', tag: 'DEVICE', title: 'Unix user IDs recorded', detail: `Entries carry the creator's numeric user/group IDs (${uids.slice(0, 2).join(', ')}).`, evidence: [] });
  if (userPaths.length) f.push({ id: 'zip-userpath', severity: 'caution', tag: 'PATH', title: 'Home-folder paths in entry names', detail: `“${userPaths[0].name}” reveals a username from the machine that made the archive.`, evidence: [{ offset: userPaths[0].cdOffset, length: userPaths[0].cdLength }] });
  if (macJunk.length) f.push({ id: 'zip-mac', severity: 'info', tag: 'DEVICE', title: 'macOS metadata folders', detail: `${macJunk.length} __MACOSX / .DS_Store entries show the archive was made on a Mac and can list other file names from that folder.`, evidence: [] });
  if (ratio.length) f.push({ id: 'zip-bomb', severity: 'caution', tag: 'PAYLOAD', title: 'Extreme compression ratio', detail: `“${ratio[0].name}” expands over 200× to ${ratio[0].size.toLocaleString()} bytes, which is decompression-bomb territory.`, evidence: [] });
  const exe = dir.entries.filter(e => /\.(exe|scr|bat|cmd|ps1|vbs|js|jar|msi|lnk|hta|dll)$/i.test(e.name));
  if (exe.length) f.push({ id: 'zip-exe', severity: 'caution', tag: 'DISGUISE', title: 'Executable or script inside', detail: `Contains ${exe.slice(0, 3).map(e => e.name).join(', ')}${exe.length > 3 ? ` and ${exe.length - 3} more` : ''}.`, evidence: exe.slice(0, 4).map(e => ({ offset: e.cdOffset, length: e.cdLength })) });
  return res;
}
