// Decompression through the platform's DecompressionStream (browsers and
// Node 18+). No bundled zlib.

export type InflateFormat = 'deflate' | 'deflate-raw' | 'gzip';

export async function inflate(data: Uint8Array, format: InflateFormat, maxOut = 64 * 1024 * 1024): Promise<Uint8Array> {
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  // Errors surface on the readable side; swallow the writer's copy.
  writer.write(data as unknown as BufferSource).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
      if (total > maxOut) {
        await reader.cancel();
        break;
      }
    }
  } catch (e) {
    // Truncated or trailing-garbage streams still yield what was decoded.
    if (total === 0) throw e;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p.subarray(0, Math.min(p.length, total - o)), o); o += p.length; }
  return out;
}

export async function tryInflate(data: Uint8Array, format: InflateFormat, maxOut?: number): Promise<Uint8Array | null> {
  try {
    return await inflate(data, format, maxOut);
  } catch {
    return null;
  }
}

export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(data as unknown as BufferSource);
  writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}
