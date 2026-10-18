// A deliberately small XML reader. DOMParser does not exist inside Web
// Workers, and OOXML/XMP only need element text, attributes and order.

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  start: number;
  end: number;
  inner: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

export function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** All elements with the given qualified name (non-nested occurrences). */
export function findAll(xml: string, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const n = escapeRe(name);
  const re = new RegExp(`<${n}(\\s[^>]*?)?(/?)>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = parseAttrs(m[1] ?? '');
    const start = m.index;
    if (m[2] === '/') {
      out.push({ name, attrs, start, end: re.lastIndex, inner: '' });
      continue;
    }
    const close = findClose(xml, name, re.lastIndex);
    const end = close < 0 ? xml.length : close;
    out.push({ name, attrs, start, end: close < 0 ? xml.length : close + name.length + 3, inner: xml.slice(re.lastIndex, end) });
    re.lastIndex = close < 0 ? xml.length : close + name.length + 3;
  }
  return out;
}

function findClose(xml: string, name: string, from: number): number {
  // Handles nesting of the same element name.
  const open = new RegExp(`<${escapeRe(name)}(\\s[^>]*?)?(/?)>|</${escapeRe(name)}\\s*>`, 'g');
  open.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = open.exec(xml))) {
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) return m.index;
    } else if (m[2] !== '/') depth++;
  }
  return -1;
}

export function text(xml: string): string {
  return decodeEntities(xml.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Text of the first element with this name, or null. */
export function firstText(xml: string, name: string): string | null {
  const els = findAll(xml, name);
  if (!els.length) return null;
  const t = text(els[0].inner);
  return t || null;
}

/** Concatenated text of the given child elements (e.g. w:t / w:delText runs). */
export function runsText(xml: string, names: string[]): string {
  const re = new RegExp(`<(${names.map(escapeRe).join('|')})(?:\\s[^>]*)?>([\\s\\S]*?)</\\1>`, 'g');
  let s = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) s += decodeEntities(m[2]);
  return s;
}
