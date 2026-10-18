// Byte-level helpers shared by every parser.

export function hex2(b: number): string {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

export function hexOffset(n: number, pad = 8): string {
  return '0x' + n.toString(16).toUpperCase().padStart(pad, '0');
}

export function ascii(bytes: Uint8Array, start: number, end: number): string {
  let s = '';
  const e = Math.min(end, bytes.length);
  for (let i = Math.max(0, start); i < e; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** NUL-terminated (or length-bounded) Latin-1 string, trimmed. */
export function cstring(bytes: Uint8Array, start: number, maxLen: number): string {
  let s = '';
  const e = Math.min(start + maxLen, bytes.length);
  for (let i = start; i < e; i++) {
    const c = bytes[i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

export function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function utf16le(bytes: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i + 1 < Math.min(end, bytes.length); i += 2) {
    const c = bytes[i] | (bytes[i + 1] << 8);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export function startsWith(bytes: Uint8Array, sig: ArrayLike<number>, at = 0): boolean {
  if (bytes.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[at + i] !== sig[i]) return false;
  return true;
}

export function indexOfBytes(bytes: Uint8Array, needle: ArrayLike<number>, from = 0, to = bytes.length): number {
  const n = needle.length;
  const end = Math.min(to, bytes.length) - n;
  outer: for (let i = Math.max(0, from); i <= end; i++) {
    for (let j = 0; j < n; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function lastIndexOfBytes(bytes: Uint8Array, needle: ArrayLike<number>, from = bytes.length - needle.length): number {
  const n = needle.length;
  outer: for (let i = Math.min(from, bytes.length - n); i >= 0; i--) {
    for (let j = 0; j < n; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return (i === 0 ? String(val) : val.toFixed(2)) + ' ' + units[i];
}

export function previewHex(bytes: Uint8Array, max = 128): string {
  const rows: string[] = [];
  const n = Math.min(bytes.length, max);
  for (let i = 0; i < n; i += 16) {
    const row: string[] = [];
    for (let j = i; j < Math.min(i + 16, n); j++) row.push(hex2(bytes[j]));
    rows.push(row.join(' '));
  }
  return rows.join('\n');
}

export function previewText(bytes: Uint8Array, max = 160): string {
  let s = '';
  const n = Math.min(bytes.length, max);
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    s += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : b === 0x0a ? '\n' : '·';
  }
  return s;
}

/** Bounded reader over a byte array with an explicit endianness. */
export class Cursor {
  readonly dv: DataView;
  constructor(readonly bytes: Uint8Array, public le = false) {
    this.dv = view(bytes);
  }
  has(off: number, len: number): boolean {
    return off >= 0 && len >= 0 && off + len <= this.bytes.length;
  }
  u8(off: number): number { return this.bytes[off]; }
  u16(off: number): number { return this.dv.getUint16(off, this.le); }
  u32(off: number): number { return this.dv.getUint32(off, this.le); }
  i32(off: number): number { return this.dv.getInt32(off, this.le); }
  u64(off: number): number {
    const hi = this.le ? this.dv.getUint32(off + 4, true) : this.dv.getUint32(off, false);
    const lo = this.le ? this.dv.getUint32(off, true) : this.dv.getUint32(off + 4, false);
    return hi * 2 ** 32 + lo;
  }
}
