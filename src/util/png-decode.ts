// Minimal PNG decoder (zlib via DecompressionStream + scanline unfiltering).
// Steganalysis needs the exact stored sample values, and browser decoders may
// colour-manage or premultiply alpha, which rewrites least-significant bits.
import { ascii, Cursor } from './bytes';
import { inflate } from './inflate';
import { scanPng } from '../parsers/png';

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel. */
  rgba: Uint8Array;
  /** True when the stored samples are 8-bit truecolour/greyscale, so LSB statistics are meaningful. */
  lsbCapable: boolean;
  channels: number;
  note?: string;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export async function decodePng(bytes: Uint8Array): Promise<DecodedImage | null> {
  const scan = scanPng(bytes);
  const c = new Cursor(bytes);
  const ihdr = scan.chunks.find(ch => ch.type === 'IHDR');
  if (!ihdr || ihdr.length < 13) return null;
  const d = ihdr.dataOffset;
  const width = c.u32(d), height = c.u32(d + 4), depth = bytes[d + 8], ctype = bytes[d + 9], interlace = bytes[d + 12];
  const ch = CHANNELS[ctype];
  if (!ch || !width || !height || width * height > 60_000_000) return null;
  if (interlace) return { width, height, rgba: new Uint8Array(0), lsbCapable: false, channels: ch, note: 'Interlaced PNGs are not decoded for steganalysis.' };
  const idat = scan.chunks.filter(x => x.type === 'IDAT');
  let total = 0;
  for (const x of idat) total += x.length;
  const z = new Uint8Array(total);
  let o = 0;
  for (const x of idat) { z.set(bytes.subarray(x.dataOffset, x.dataOffset + x.length), o); o += x.length; }
  const bitsPerPixel = ch * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const raw = await inflate(z, 'deflate', (stride + 1) * height + 1024);
  if (raw.length < (stride + 1) * height) throw new Error('image data is truncated');

  const out = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], cc = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      switch (f) {
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: { const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : cc; break; }
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }

  const plte = scan.chunks.find(x => x.type === 'PLTE');
  const trns = scan.chunks.find(x => x.type === 'tRNS');
  const rgba = new Uint8Array(width * height * 4);
  const sample = (row: Uint8Array, idx: number): number => {
    if (depth === 8) return row[idx];
    if (depth === 16) return row[idx * 2];
    const perByte = 8 / depth;
    const byte = row[Math.floor(idx / perByte)];
    const shift = 8 - depth * ((idx % perByte) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1;
  for (let y = 0; y < height; y++) {
    const row = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (ctype === 3) {
        const i = sample(row, x);
        const po = plte ? plte.dataOffset + i * 3 : 0;
        rgba[p] = bytes[po]; rgba[p + 1] = bytes[po + 1]; rgba[p + 2] = bytes[po + 2];
        rgba[p + 3] = trns && i < trns.length ? bytes[trns.dataOffset + i] : 255;
      } else if (ctype === 0 || ctype === 4) {
        const g = Math.round(sample(row, x * ch) * scale);
        rgba[p] = rgba[p + 1] = rgba[p + 2] = g;
        rgba[p + 3] = ctype === 4 ? sample(row, x * ch + 1) : 255;
      } else {
        rgba[p] = sample(row, x * ch); rgba[p + 1] = sample(row, x * ch + 1); rgba[p + 2] = sample(row, x * ch + 2);
        rgba[p + 3] = ctype === 6 ? sample(row, x * ch + 3) : 255;
      }
    }
  }
  const lsbCapable = depth === 8 && ctype !== 3;
  return { width, height, rgba, lsbCapable, channels: ch, note: lsbCapable ? undefined : ctype === 3 ? 'Palette images store indices, so channel LSB statistics don\'t apply.' : depth === 16 ? '16-bit samples were reduced to 8 bits, so LSB statistics don\'t apply.' : 'Low bit-depth image.' };
}

export function isPng(bytes: Uint8Array): boolean {
  return ascii(bytes, 1, 4) === 'PNG';
}
