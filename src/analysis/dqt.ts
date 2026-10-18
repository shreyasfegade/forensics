// JPEG quantisation-table fingerprint: estimate the IJG (libjpeg) quality
// setting and say whether the tables are plain libjpeg scaling or custom.
import type { QuantInfo } from '../core/types';

// Annex K luminance table in zig-zag order, as it appears in a DQT segment.
const STD_LUMA_ZZ = [
  16, 11, 12, 14, 12, 10, 16, 14, 13, 14, 18, 17, 16, 19, 24, 40, 26, 24, 22, 22, 24, 49, 35, 37, 29, 40, 58, 51, 61, 60, 57, 51,
  56, 55, 64, 72, 92, 78, 64, 68, 87, 69, 55, 56, 80, 109, 81, 87, 95, 98, 103, 104, 103, 62, 77, 113, 121, 112, 100, 120, 92, 101, 103, 99,
];

export function scaledTable(q: number, base = STD_LUMA_ZZ): number[] {
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  return base.map(v => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
}

export interface QTable { id: number; precision: number; values: number[] }

export function parseDqt(seg: Uint8Array): QTable[] {
  const out: QTable[] = [];
  let i = 0;
  while (i < seg.length) {
    const pq = seg[i] >> 4, tq = seg[i] & 15;
    i++;
    const values: number[] = [];
    for (let k = 0; k < 64 && i < seg.length; k++) {
      values.push(pq ? (seg[i] << 8) | seg[i + 1] : seg[i]);
      i += pq ? 2 : 1;
    }
    if (values.length === 64) out.push({ id: tq, precision: pq ? 16 : 8, values });
  }
  return out;
}

export function fingerprint(tables: QTable[], adobe = false): QuantInfo {
  const luma = tables.find(t => t.id === 0) ?? tables[0];
  if (!luma) return { tables: 0, qualityEstimate: null, match: null };
  let best = 0, bestErr = Infinity;
  for (let q = 1; q <= 100; q++) {
    const s = scaledTable(q);
    let err = 0;
    for (let k = 0; k < 64; k++) err += Math.abs(s[k] - luma.values[k]);
    if (err < bestErr) { bestErr = err; best = q; }
  }
  const exact = bestErr === 0;
  let match: string;
  if (exact) match = `Standard libjpeg (IJG) tables at quality ${best}. Common for software encoders and many web pipelines.`;
  else if (bestErr / 64 < 1.5) match = `Close to libjpeg quality ${best}, but not an exact match. Usually a camera or phone encoder with tuned tables.`;
  else match = `Custom tables that don't follow libjpeg scaling (nearest quality ≈${best}).${adobe ? ' An Adobe APP14 marker is also present, which is consistent with an Adobe encoder.' : ' Typical of camera firmware or a commercial editor.'}`;
  return { tables: tables.length, qualityEstimate: best, match };
}
