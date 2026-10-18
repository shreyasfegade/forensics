// Least-significant-bit steganalysis for lossless images:
//  - Westfeld & Pfitzmann chi-square attack on pairs of values (PoVs)
//  - Fridrich, Goljan & Du "RS analysis" estimate of the embedded fraction
// Both are statistical: they report "consistent with LSB embedding", never proof.
import type { StegoChannel, StegoResult } from '../core/types';
import type { DecodedImage } from '../util/png-decode';

// ---- chi-square distribution (regularised incomplete gamma)

function lnGamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function gammp(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a, del = sum, ap = a;
    for (let n = 0; n < 500; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-12) break; }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/** P-value that the pair-of-values histogram is equalised (≈1 means "looks embedded"). */
export function chiSquareP(hist: ArrayLike<number>): number {
  let chi = 0, k = 0;
  for (let i = 0; i < 256; i += 2) {
    const expected = (hist[i] + hist[i + 1]) / 2;
    if (expected < 5) continue;
    chi += (hist[i] - expected) ** 2 / expected;
    k++;
  }
  if (k < 2) return 0;
  return 1 - gammp((k - 1) / 2, chi / 2);
}

// ---- RS analysis

const MASK = [0, 1, 1, 0];

function flip1(v: number): number { return v ^ 1; }
function flipNeg(v: number): number { return v & 1 ? v + 1 : v - 1; }

function smooth(g: number[]): number {
  let s = 0;
  for (let i = 0; i < g.length - 1; i++) s += Math.abs(g[i + 1] - g[i]);
  return s;
}

function rsCounts(values: Uint8Array, invertLsb: boolean): { rm: number; sm: number; rn: number; sn: number } {
  let rm = 0, sm = 0, rn = 0, sn = 0;
  const g = [0, 0, 0, 0], a = [0, 0, 0, 0], b = [0, 0, 0, 0];
  const n = values.length - (values.length % 4);
  for (let i = 0; i < n; i += 4) {
    for (let k = 0; k < 4; k++) g[k] = invertLsb ? values[i + k] ^ 1 : values[i + k];
    const f0 = smooth(g);
    for (let k = 0; k < 4; k++) {
      a[k] = MASK[k] ? flip1(g[k]) : g[k];
      b[k] = MASK[k] ? flipNeg(g[k]) : g[k];
    }
    const fa = smooth(a), fb = smooth(b);
    if (fa > f0) rm++; else if (fa < f0) sm++;
    if (fb > f0) rn++; else if (fb < f0) sn++;
  }
  const total = n / 4 || 1;
  return { rm: rm / total, sm: sm / total, rn: rn / total, sn: sn / total };
}

/** Estimated fraction of samples whose LSB carries a message (0..1). */
export function rsEstimate(values: Uint8Array): number {
  const p = rsCounts(values, false);
  const q = rsCounts(values, true);
  const d0 = p.rm - p.sm, d1 = q.rm - q.sm, dn0 = p.rn - p.sn, dn1 = q.rn - q.sn;
  const A = 2 * (d1 + d0), B = dn0 - dn1 - d1 - 3 * d0, C = d0 - dn0;
  let z: number;
  if (Math.abs(A) < 1e-12) z = Math.abs(B) < 1e-12 ? 0 : -C / B;
  else {
    const disc = B * B - 4 * A * C;
    if (disc < 0) return 0;
    const r1 = (-B + Math.sqrt(disc)) / (2 * A), r2 = (-B - Math.sqrt(disc)) / (2 * A);
    z = Math.abs(r1) < Math.abs(r2) ? r1 : r2;
  }
  const est = z / (z - 0.5);
  return Number.isFinite(est) ? Math.max(0, Math.min(1, est)) : 0;
}

// ---- driver

function channel(img: DecodedImage, c: number): Uint8Array {
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = img.rgba[i * 4 + c];
  return out;
}

export function analyzeStego(img: DecodedImage): StegoResult {
  const base = { width: img.width, height: img.height };
  if (!img.lsbCapable || !img.rgba.length) {
    return { ...base, channels: [], curve: [], verdict: 'clean', summary: img.note ?? 'Not analysed.' };
  }
  const names: StegoChannel['channel'][] = ['R', 'G', 'B'];
  const gray = img.channels <= 2;
  const channels: StegoChannel[] = [];
  for (let c = 0; c < (gray ? 1 : 3); c++) {
    const v = channel(img, c);
    const hist = new Uint32Array(256);
    for (let i = 0; i < v.length; i++) hist[v[i]]++;
    // Rows of the image as RS groups; columns would work equally well.
    channels.push({ channel: names[c], chiSquareP: chiSquareP(hist), rsEstimate: rsEstimate(v) });
  }
  // Sequential embedding fills pixels from the start: chi-square over growing prefixes.
  const n = img.width * img.height;
  const curve: number[] = [];
  const hist = new Uint32Array(256);
  let filled = 0;
  for (let k = 1; k <= 32; k++) {
    const upto = Math.floor((n * k) / 32);
    for (; filled < upto; filled++) for (let c = 0; c < (gray ? 1 : 3); c++) hist[img.rgba[filled * 4 + c]]++;
    curve.push(chiSquareP(hist));
  }
  const maxRs = Math.max(...channels.map(c => c.rsEstimate));
  const maxChi = Math.max(...channels.map(c => c.chiSquareP));
  const prefixHigh = curve.slice(0, 4).every(p => p > 0.9);
  let verdict: StegoResult['verdict'] = 'clean';
  if ((maxChi > 0.95 && maxRs > 0.15) || (prefixHigh && maxRs > 0.1) || maxRs > 0.35) verdict = 'likely';
  else if (maxChi > 0.95 || maxRs > 0.12 || prefixHigh) verdict = 'suspicious';
  const pct = (maxRs * 100).toFixed(0);
  const summary = verdict === 'clean'
    ? `LSB statistics look natural (RS estimate ${pct}% of capacity, chi-square p=${maxChi.toFixed(2)}).`
    : `RS analysis estimates about ${pct}% of the least-significant bits carry data${prefixHigh ? ', concentrated at the start of the pixel stream' : ''}, and the chi-square p-value is ${maxChi.toFixed(2)}. That's consistent with LSB steganography, but it's statistical evidence, not proof.`;
  return { ...base, channels, curve, verdict, summary };
}

/** One bit-plane of one channel as a black/white RGBA image. */
export function bitPlane(img: DecodedImage, channelIndex: number, bit: number): Uint8ClampedArray {
  const n = img.width * img.height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = (img.rgba[i * 4 + channelIndex] >> bit) & 1 ? 255 : 0;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}
