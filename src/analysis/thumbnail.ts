// EXIF thumbnail vs. main image. Editors that crop or retouch often leave the
// embedded preview alone, so it still shows the original frame.
import type { ThumbnailComparison } from '../core/types';

/** 9×8 grayscale difference hash of an RGBA image (64 bits as 16 hex chars). */
export function dHash(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): bigint {
  const gw = 9, gh = 8;
  const g = new Float64Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      // Box-average the source region for this cell.
      const x0 = Math.floor((x * w) / gw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / gw));
      const y0 = Math.floor((y * h) / gh), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / gh));
      let s = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const p = (yy * w + xx) * 4;
        s += 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
        n++;
      }
      g[y * gw + x] = s / n;
    }
  }
  let bits = 0n;
  for (let y = 0; y < gh; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | (g[y * gw + x] > g[y * gw + x + 1] ? 1n : 0n);
  return bits;
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b, n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

export function compare(main: { rgba: Uint8ClampedArray; w: number; h: number }, thumb: { rgba: Uint8ClampedArray; w: number; h: number }): ThumbnailComparison {
  const mainAspect = main.w / main.h, thumbAspect = thumb.w / thumb.h;
  // Thumbnails are often letterboxed to 160×120; compare the visible area only.
  const aspectDelta = Math.abs(mainAspect - thumbAspect) / Math.max(mainAspect, thumbAspect);
  const hashDistance = hamming(dHash(main.rgba, main.w, main.h), dHash(thumb.rgba, thumb.w, thumb.h));
  return { mainAspect, thumbAspect, aspectDelta, hashDistance, mismatch: aspectDelta > 0.02 || hashDistance > 12 };
}

/** Bounding box of non-black content (to undo letterboxing in thumbnails). */
export function contentBox(rgba: Uint8ClampedArray, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const dark = (x: number, y: number) => { const p = (y * w + x) * 4; return rgba[p] + rgba[p + 1] + rgba[p + 2] < 24; };
  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  const rowDark = (y: number) => { for (let x = 0; x < w; x++) if (!dark(x, y)) return false; return true; };
  const colDark = (x: number) => { for (let y = top; y <= bottom; y++) if (!dark(x, y)) return false; return true; };
  while (top < bottom && rowDark(top)) top++;
  while (bottom > top && rowDark(bottom)) bottom--;
  while (left < right && colDark(left)) left++;
  while (right > left && colDark(right)) right--;
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}
