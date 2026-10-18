import type { ParseResult } from '../core/types';
import { emptyResult } from '../core/types';
import { Cursor, previewHex, previewText } from '../util/bytes';

export function parseBmp(bytes: Uint8Array): ParseResult {
  const res = emptyResult();
  const c = new Cursor(bytes, true);
  if (bytes.length < 30) return res;
  const fileSize = c.u32(2), dataOff = c.u32(10), hdr = c.u32(14);
  const width = c.i32(18), height = Math.abs(c.i32(22)), bpp = c.u16(28);
  res.image = { width, height, bitDepth: bpp };
  res.structure = [
    { id: 'bmp-file', label: 'BITMAPFILEHEADER', kind: 'header', range: { offset: 0, length: 14 } },
    { id: 'bmp-info', label: `DIB header (${hdr} B)`, kind: 'header', range: { offset: 14, length: hdr } },
    { id: 'bmp-pixels', label: 'Pixel array', kind: 'data', range: { offset: dataOff, length: Math.max(0, Math.min(fileSize, bytes.length) - dataOff) } },
  ];
  if (fileSize > 0 && fileSize < bytes.length) {
    const tail = bytes.subarray(fileSize);
    res.hidden = { offset: fileSize, length: tail.length, previewHex: previewHex(tail), previewText: previewText(tail) };
    res.structure.push({ id: 'bmp-trail', label: 'Data after declared size', kind: 'trailing', range: { offset: fileSize, length: tail.length } });
  }
  res.sections.push({ id: 'bmp', title: 'Bitmap', fields: [
    { key: 'dims', label: 'Dimensions', value: `${width} × ${height} px`, mono: true },
    { key: 'bpp', label: 'Bits per pixel', value: String(bpp), mono: true },
  ] });
  return res;
}
