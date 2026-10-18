// Error Level Analysis: re-save a JPEG at a known quality and look at how much
// each region changes. Regions pasted in from another image, or edited after
// the last save, often recompress differently. ELA is a hint, not proof:
// edges, text and flat colours light up naturally.

export interface ElaResult {
  width: number;
  height: number;
  /** RGBA heatmap. */
  pixels: Uint8ClampedArray;
  maxError: number;
  meanError: number;
}

export function elaDiff(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number, scale = 12): ElaResult {
  const out = new Uint8ClampedArray(w * h * 4);
  let max = 0, sum = 0;
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    const e = (Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2])) / 3;
    if (e > max) max = e;
    sum += e;
    const v = Math.min(255, e * scale);
    // Ink-on-dark heat ramp: dark → amber → white.
    out[p] = Math.min(255, v * 1.6);
    out[p + 1] = Math.min(255, v * 1.0);
    out[p + 2] = Math.min(255, Math.max(0, v - 160) * 2.4);
    out[p + 3] = 255;
  }
  return { width: w, height: h, pixels: out, maxError: max, meanError: sum / (w * h) };
}

/** Browser-only: needs createImageBitmap and OffscreenCanvas (available in workers). */
export async function runEla(blob: Blob, quality = 0.9, maxPixels = 16_000_000): Promise<ElaResult & { downscaled: boolean }> {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' } as ImageBitmapOptions);
  // ELA only means something on the original 8×8 block grid, so work at full
  // size and fall back to downscaling only for very large photos.
  const s = Math.min(1, Math.sqrt(maxPixels / (bmp.width * bmp.height)));
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  const c1 = new OffscreenCanvas(w, h);
  const g1 = c1.getContext('2d', { willReadFrequently: true })!;
  g1.drawImage(bmp, 0, 0, w, h);
  const orig = g1.getImageData(0, 0, w, h).data;
  const re = await c1.convertToBlob({ type: 'image/jpeg', quality });
  const reBmp = await createImageBitmap(re, { colorSpaceConversion: 'none' } as ImageBitmapOptions);
  const c2 = new OffscreenCanvas(w, h);
  const g2 = c2.getContext('2d', { willReadFrequently: true })!;
  g2.drawImage(reBmp, 0, 0);
  const again = g2.getImageData(0, 0, w, h).data;
  return { ...elaDiff(orig, again, w, h), downscaled: s < 1 };
}
