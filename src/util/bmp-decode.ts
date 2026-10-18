import type { DecodedImage } from './png-decode';
import { Cursor } from './bytes';

export function decodeBmp(bytes: Uint8Array): DecodedImage | null {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
  const c = new Cursor(bytes, true);
  const off = c.u32(10), w = c.i32(18), hRaw = c.i32(22), bpp = c.u16(28), comp = c.u32(30);
  const h = Math.abs(hRaw);
  if (w <= 0 || h <= 0 || w * h > 60_000_000 || (bpp !== 24 && bpp !== 32) || (comp !== 0 && comp !== 3)) return null;
  const stride = Math.ceil((w * bpp) / 32) * 4;
  if (off + stride * h > bytes.length) return null;
  const rgba = new Uint8Array(w * h * 4);
  const bp = bpp / 8;
  for (let y = 0; y < h; y++) {
    const sy = hRaw > 0 ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const s = off + sy * stride + x * bp, d = (y * w + x) * 4;
      rgba[d] = bytes[s + 2]; rgba[d + 1] = bytes[s + 1]; rgba[d + 2] = bytes[s]; rgba[d + 3] = 255;
    }
  }
  return { width: w, height: h, rgba, lsbCapable: true, channels: bp };
}
