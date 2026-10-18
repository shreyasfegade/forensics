// One streaming pass over the whole file: SHA-256, byte histogram, block
// entropy, byte-plot classes and string extraction. The worker feeds it 4 MB
// chunks, so file size is bounded by disk, not memory.
import type { BytePlot, EntropyProfile, NotableString } from '../core/types';
import { Sha256 } from '../util/sha256';
import { shannonFromCounts } from './entropy';
import { orderFor } from './hilbert';

const URL_RE = /\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s"'<>()\\]{4,}/i;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PATH_RE = /(?:[A-Za-z]:\\[^\s"'<>|*?]{2,}|\\\\[A-Za-z0-9._-]+\\[^\s"'<>|]{2,}|\/(?:usr|home|etc|var|tmp|Users|Library|Applications|private|opt|mnt|Volumes)\/[^\s"'<>]{2,})/;
const SECRET_RE = /(password\s*[=:]|passwd|secret\s*[=:]|api[_-]?key|access[_-]?token|bearer\s+[A-Za-z0-9._-]{12,}|BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35})/i;

const STRINGS_HEAD = 16 * 1024 * 1024;
const STRINGS_TAIL = 1024 * 1024;
const MIN_LEN = 5;
const MAX_NOTABLE = 40;

export class Scanner {
  private readonly sha = new Sha256();
  private readonly hist = new Float64Array(256);
  private readonly blockHist = new Uint32Array(256);
  private readonly blocks: number[] = [];
  private blockFill = 0;
  readonly blockSize: number;
  private readonly order: number;
  private readonly cellsTotal: number;
  readonly bytesPerCell: number;
  private readonly cellCounts: Uint32Array;
  private pos = 0;

  // strings state
  private cur = '';
  private curStart = 0;
  private wide = '';
  private wideStart = 0;
  private wideExpectZero = false;
  private stringsTotal = 0;
  private scannedBytes = 0;
  private readonly notable: NotableString[] = [];
  private readonly seen = new Set<string>();

  constructor(readonly size: number) {
    const points = Math.max(1, Math.min(1024, Math.floor(size / 256)));
    this.blockSize = Math.max(1, Math.ceil(size / points));
    this.order = orderFor(Math.max(1, size));
    this.cellsTotal = Math.pow(4, this.order);
    this.bytesPerCell = Math.max(1, Math.ceil(size / this.cellsTotal));
    this.cellCounts = new Uint32Array(Math.ceil(size / this.bytesPerCell) * 4);
  }

  update(chunk: Uint8Array): void {
    this.sha.update(chunk);
    const hist = this.hist, bh = this.blockHist, cells = this.cellCounts, bpc = this.bytesPerCell, bs = this.blockSize;
    let pos = this.pos, fill = this.blockFill;
    const scanStrings = (p: number) => p < STRINGS_HEAD || p >= this.size - STRINGS_TAIL;
    const stringsFrom = scanStrings(pos) || scanStrings(pos + chunk.length - 1);
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      hist[b]++;
      bh[b]++;
      const cls = b === 0 ? 0 : b >= 0x20 && b < 0x7f ? 1 : b < 0x20 || b === 0x7f ? 2 : 3;
      cells[((pos / bpc) | 0) * 4 + cls]++;
      if (++fill === bs) {
        this.blocks.push(shannonFromCounts(bh, fill));
        bh.fill(0);
        fill = 0;
      }
      if (stringsFrom && scanStrings(pos)) this.stringByte(b, pos);
      pos++;
    }
    this.pos = pos;
    this.blockFill = fill;
  }

  private stringByte(b: number, pos: number): void {
    this.scannedBytes++;
    const printable = (b >= 0x20 && b <= 0x7e) || b === 0x09;
    if (printable) {
      if (!this.cur) this.curStart = pos;
      this.cur += String.fromCharCode(b);
      if (this.cur.length > 4096) this.endRun();
    } else this.endRun();
    // UTF-16LE: printable byte followed by 0x00, repeated.
    if (this.wideExpectZero) {
      if (b === 0) this.wideExpectZero = false;
      else { this.endWide(); if (printable) { this.wideStart = pos; this.wide = String.fromCharCode(b); this.wideExpectZero = true; } }
    } else if (printable) {
      if (!this.wide) this.wideStart = pos;
      this.wide += String.fromCharCode(b);
      this.wideExpectZero = true;
    } else this.endWide();
  }

  private endRun(): void {
    if (this.cur.length >= MIN_LEN) { this.stringsTotal++; this.classify(this.cur, this.curStart); }
    this.cur = '';
  }

  private endWide(): void {
    if (this.wide.length >= MIN_LEN) { this.stringsTotal++; this.classify(this.wide, this.wideStart); }
    this.wide = '';
    this.wideExpectZero = false;
  }

  private classify(s: string, offset: number): void {
    if (this.notable.length >= MAX_NOTABLE) return;
    const t = s.trim();
    let type: NotableString['type'] | null = null;
    let m: RegExpExecArray | null;
    if ((m = SECRET_RE.exec(t))) type = 'secret';
    else if ((m = URL_RE.exec(t))) type = 'url';
    else if ((m = EMAIL_RE.exec(t))) type = 'email';
    else if ((m = PATH_RE.exec(t))) type = 'path';
    if (!type || !m) return;
    // Secrets keep their surrounding context; others keep just the token.
    const value = (type === 'secret' ? t : m[0]).slice(0, 160);
    if (type === 'url' && /^(https?:\/\/)?(www\.)?(w3\.org|ns\.adobe\.com|purl\.org|schemas\.(openxmlformats|microsoft)\.com|iptc\.org|ns\.useplus\.org)/i.test(value)) return;
    const key = type + ':' + value.toLowerCase();
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.notable.push({ type, value, offset: offset + (type === 'secret' ? 0 : Math.max(0, s.indexOf(m[0]))) });
  }

  finish(): { sha256: string; entropy: EntropyProfile; byteplot: BytePlot; strings: { total: number; notable: NotableString[]; scannedBytes: number } } {
    if (this.blockFill > 0) this.blocks.push(shannonFromCounts(this.blockHist, this.blockFill));
    this.endRun();
    this.endWide();
    const nCells = Math.ceil(this.size / this.bytesPerCell);
    const classes = new Uint8Array(this.cellsTotal).fill(255);
    for (let i = 0; i < nCells; i++) {
      const o = i * 4;
      let best = 0;
      for (let k = 1; k < 4; k++) if (this.cellCounts[o + k] > this.cellCounts[o + best]) best = k;
      classes[i] = best;
    }
    const order: NotableString['type'][] = ['secret', 'url', 'email', 'path'];
    const notable = [...this.notable].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
    return {
      sha256: this.sha.digestHex(),
      entropy: { overall: shannonFromCounts(this.hist, this.size), histogram: Array.from(this.hist), blocks: this.blocks, blockSize: this.blockSize },
      byteplot: { order: this.order, cells: nCells, bytesPerCell: this.bytesPerCell, classes },
      strings: { total: this.stringsTotal, notable, scannedBytes: this.scannedBytes },
    };
  }
}
