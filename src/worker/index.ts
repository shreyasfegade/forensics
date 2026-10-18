/// <reference lib="webworker" />
// Analysis worker: every parser runs here so the page never blocks, even on
// multi-hundred-megabyte files. Files arrive as Blobs (no copy) and are read
// through Blob.slice.
import { analyze } from '../core/analyze';
import type { Report } from '../core/types';
import { BlobSource } from '../util/source';
import { sanitize } from '../sanitize';
import { decodePng, type DecodedImage } from '../util/png-decode';
import { decodeBmp } from '../util/bmp-decode';
import { bitPlane } from '../analysis/stego';
import { runEla } from '../analysis/ela';
import { compare, contentBox } from '../analysis/thumbnail';
import type { Request, Response } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const post = (msg: Response, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

let decodedFor: Blob | null = null;
let decoded: DecodedImage | null = null;

async function lossless(file: Blob): Promise<DecodedImage | null> {
  if (decodedFor === file && decoded) return decoded;
  const bytes = new Uint8Array(await file.arrayBuffer());
  decoded = bytes[0] === 0x89 ? await decodePng(bytes) : decodeBmp(bytes);
  decodedFor = file;
  return decoded;
}

async function rgbaOf(blob: Blob, maxSide = 512): Promise<{ rgba: Uint8ClampedArray; w: number; h: number; fullW: number; fullH: number }> {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0, w, h);
  return { rgba: g.getImageData(0, 0, w, h).data, w, h, fullW: bmp.width, fullH: bmp.height };
}

/** Browser-side step: decode the EXIF thumbnail and the main image and compare them. */
async function compareThumbnail(file: Blob, report: Report): Promise<void> {
  const t = report.thumbnail;
  if (!t || typeof OffscreenCanvas === 'undefined' || !report.trueType.mime) return;
  try {
    const thumb = await rgbaOf(file.slice(t.range.offset, t.range.offset + t.range.length, 'image/jpeg'), 256);
    const main = await rgbaOf(file.slice(0, file.size, report.trueType.mime), 512);
    // Undo letterboxing (camera thumbnails are often padded to 160×120).
    const box = contentBox(thumb.rgba, thumb.w, thumb.h);
    let tr = thumb.rgba, tw = thumb.w, th = thumb.h;
    if (box.w < thumb.w || box.h < thumb.h) {
      const c = new OffscreenCanvas(box.w, box.h);
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.putImageData(new ImageData(thumb.rgba as Uint8ClampedArray<ArrayBuffer>, thumb.w, thumb.h), -box.x, -box.y);
      tr = g.getImageData(0, 0, box.w, box.h).data; tw = box.w; th = box.h;
    }
    const cmp = compare({ rgba: main.rgba, w: main.w, h: main.h }, { rgba: tr, w: tw, h: th });
    t.comparison = cmp;
    const f = report.findings.find(x => x.id === 'thumbnail');
    if (f && cmp.mismatch) {
      f.severity = 'exposed';
      f.title = 'Thumbnail shows a different picture';
      f.detail = cmp.aspectDelta > 0.02
        ? `The embedded preview has a ${cmp.thumbAspect.toFixed(2)}:1 frame but the photo is ${cmp.mainAspect.toFixed(2)}:1, so the photo was cropped after capture and the thumbnail still shows the original framing. Anyone can extract it.`
        : `The embedded preview differs from the photo (difference hash distance ${cmp.hashDistance}/64). The image was edited after the preview was made, and the preview still shows the earlier version.`;
      report.findings.sort((a, b) => rank(b.severity) - rank(a.severity));
      if (report.verdict.level !== 'exposed') {
        const n = report.findings.filter(x => x.severity === 'exposed').length;
        report.verdict = { level: 'exposed', title: 'Exposed', summary: `${n} serious leak${n > 1 ? 's' : ''}.` };
      }
    } else if (f) {
      f.detail += ` It matches the main image (hash distance ${cmp.hashDistance}/64).`;
    }
  } catch {
    report.notes.push('The embedded thumbnail could not be decoded for comparison.');
  }
}

const rank = (s: string) => ({ exposed: 3, caution: 2, info: 1, clear: 0 } as Record<string, number>)[s] ?? 0;

self.onmessage = async (ev: MessageEvent<Request>) => {
  const req = ev.data;
  try {
    if (req.type === 'analyze') {
      const report = await analyze(new BlobSource(req.file), {
        name: req.name, lastModified: req.lastModified,
        onProgress: progress => post({ id: req.id, type: 'progress', progress }),
      });
      await compareThumbnail(req.file, report);
      post({ id: req.id, type: 'report', report });
    } else if (req.type === 'sanitize') {
      const bytes = new Uint8Array(await req.file.arrayBuffer());
      const before = await analyze(new BlobSource(req.file), { name: req.name });
      const out = await sanitize(bytes, before.trueType);
      const blob = new Blob([out.bytes as unknown as BlobPart]);
      const after = await analyze(new BlobSource(blob), { name: req.name });
      await compareThumbnail(blob, after);
      post({ id: req.id, type: 'sanitized', data: out.bytes, actions: out.actions, removed: out.removed, after }, [out.bytes.buffer as ArrayBuffer]);
    } else if (req.type === 'bitplane') {
      const img = await lossless(req.file);
      if (!img || !img.rgba.length) throw new Error(img?.note ?? 'This image can\'t be decoded losslessly.');
      const pixels = bitPlane(img, req.channel, req.bit);
      post({ id: req.id, type: 'image', width: img.width, height: img.height, pixels }, [pixels.buffer]);
    } else if (req.type === 'ela') {
      const r = await runEla(req.file, req.quality);
      post({ id: req.id, type: 'image', width: r.width, height: r.height, pixels: r.pixels, meta: { maxError: r.maxError, meanError: r.meanError, downscaled: r.downscaled } }, [r.pixels.buffer]);
    } else if (req.type === 'thumbnail') {
      const r = await rgbaOf(req.file.slice(req.offset, req.offset + req.length, 'image/jpeg'), 320);
      post({ id: req.id, type: 'image', width: r.w, height: r.h, pixels: r.rgba }, [r.rgba.buffer]);
    }
  } catch (e) {
    post({ id: req.id, type: 'error', message: (e as Error).message || String(e) });
  }
};
