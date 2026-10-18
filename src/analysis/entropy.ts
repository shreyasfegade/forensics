// Shannon entropy: whole-file, per block (to find encrypted or compressed
// regions inside a container), and for arbitrary byte ranges.

export function shannonFromCounts(freq: ArrayLike<number>, total: number): number {
  if (total <= 0) return 0;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    const f = freq[i];
    if (f > 0) {
      const p = f / total;
      h -= p * Math.log2(p);
    }
  }
  return h;
}

export function shannon(bytes: Uint8Array): number {
  const freq = new Uint32Array(256);
  for (let i = 0; i < bytes.length; i++) freq[bytes[i]]++;
  return shannonFromCounts(freq, bytes.length);
}

export function interpretEntropy(value: number): string {
  if (value < 1.0) return 'Very low: almost uniform, repetitive bytes';
  if (value < 3.0) return 'Low: structured or human-readable text';
  if (value < 5.0) return 'Medium: mixed content, typical of programs and rich documents';
  if (value < 7.0) return 'High: compressed data or a dense binary format';
  if (value < 7.5) return 'Very high: strongly compressed or encrypted';
  return 'Near maximum: encrypted, compressed or random data';
}

export function interpretEntropyPlain(value: number): string {
  if (value < 1.0) return 'Mostly repeating or empty space';
  if (value < 3.0) return 'Plain text';
  if (value < 5.0) return 'A typical document or program';
  if (value < 7.0) return 'Dense data such as photos, audio or video';
  if (value < 7.5) return 'Highly compressed, like a zip';
  return 'Scrambled-looking. Encrypted or compressed';
}
