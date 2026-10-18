export { formatSize } from '../util/bytes';

export function hexOff(n: number): string {
  return '0x' + n.toString(16).toUpperCase().padStart(n > 0xffffff ? 8 : 6, '0');
}

export function rangeLabel(r: { offset: number; length: number }): string {
  return r.length <= 1 ? hexOff(r.offset) : `${hexOff(r.offset)}–${hexOff(r.offset + r.length - 1)}`;
}

export function cleanName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}.clean${name.slice(dot)}` : `${name}.clean`;
}

export function intakeStamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
