// Opt-in only: a single soft "stamp" when a case is filed. Off by default.
let ctx: AudioContext | null = null;

export function stamp(enabled: boolean, severe: boolean): void {
  if (!enabled) return;
  try {
    ctx ??= new AudioContext();
    const t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(severe ? 140 : 220, t);
    o.frequency.exponentialRampToValueAtTime(severe ? 70 : 110, t + 0.12);
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.17);
  } catch { /* audio unavailable */ }
}
