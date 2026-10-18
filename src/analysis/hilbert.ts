// Hilbert-curve mapping: consecutive file offsets stay spatially close, so
// regions of the file show up as contiguous blobs in the byte-plot.

/** Map distance d along a Hilbert curve of side n (power of two) to x,y. */
export function d2xy(n: number, d: number): [number, number] {
  let x = 0, y = 0, t = d;
  for (let s = 1; s < n; s *= 2) {
    const rx = 1 & (t / 2);
    const ry = 1 & (t ^ rx);
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
      const tmp = x; x = y; y = tmp;
    }
    x += s * rx;
    y += s * ry;
    t = Math.floor(t / 4);
  }
  return [x, y];
}

export function xy2d(n: number, x: number, y: number): number {
  let d = 0;
  for (let s = n / 2; s >= 1; s = Math.floor(s / 2)) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { x = n - 1 - x; y = n - 1 - y; }
      const tmp = x; x = y; y = tmp;
    }
  }
  return d;
}

/** Largest curve order whose 4^order cells don't exceed the byte count (so the plot is mostly filled), capped at 512×512. */
export function orderFor(size: number): number {
  let order = 1;
  while (order < 9 && Math.pow(4, order + 1) <= size) order++;
  return order;
}
