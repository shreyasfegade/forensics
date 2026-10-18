// MP3 ID3 tags (v2.2–2.4 frames at the start, v1 block at the end).
import type { Field, ParseResult } from '../core/types';
import { emptyResult } from '../core/types';
import { ascii, utf16le, utf8 } from '../util/bytes';

const FRAMES: Record<string, [string, boolean]> = {
  TIT2: ['Title', false], TPE1: ['Artist', true], TPE2: ['Album artist', true], TALB: ['Album', false], TYER: ['Year', false],
  TDRC: ['Recorded', false], TCON: ['Genre', false], TCOM: ['Composer', true], TENC: ['Encoded by', true], TSSE: ['Encoder settings', false],
  TOWN: ['Owner', true], TCOP: ['Copyright', true], TPUB: ['Publisher', false], TXXX: ['User text', true], COMM: ['Comment', true],
  WXXX: ['URL', false], PRIV: ['Private frame', true], APIC: ['Embedded picture', false], GEOB: ['Embedded object', true],
  TT2: ['Title', false], TP1: ['Artist', true], TAL: ['Album', false], COM: ['Comment', true], PIC: ['Embedded picture', false], TEN: ['Encoded by', true],
};

function syncsafe(b: Uint8Array, o: number): number {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

function decodeText(d: Uint8Array): string {
  const enc = d[0];
  const body = d.subarray(1);
  let s: string;
  if (enc === 1 || enc === 2) {
    const bom = body[0] === 0xfe ? 'be' : 'le';
    const start = body[0] === 0xff || body[0] === 0xfe ? 2 : 0;
    if (bom === 'be') { let t = ''; for (let i = start; i + 1 < body.length; i += 2) t += String.fromCharCode((body[i] << 8) | body[i + 1]); s = t; }
    else s = utf16le(body, start, body.length);
  } else if (enc === 3) s = utf8(body);
  else s = Array.from(body, b => String.fromCharCode(b)).join('');
  return s.replace(/\0+/g, ' ').trim();
}

export function parseId3(bytes: Uint8Array): ParseResult {
  const res = emptyResult();
  const fields: Field[] = [];
  if (ascii(bytes, 0, 3) === 'ID3' && bytes.length > 10) {
    const ver = bytes[3];
    const size = syncsafe(bytes, 6);
    res.structure.push({ id: 'id3v2', label: `ID3v2.${ver} tag`, kind: 'tag', range: { offset: 0, length: 10 + size }, children: [] });
    let p = 10;
    if (bytes[5] & 0x40) p += ver === 4 ? syncsafe(bytes, 10) : ((bytes[10] << 24) | (bytes[11] << 16) | (bytes[12] << 8) | bytes[13]) + 4;
    const end = Math.min(10 + size, bytes.length);
    while (p + (ver === 2 ? 6 : 10) <= end) {
      const id = ascii(bytes, p, p + (ver === 2 ? 3 : 4));
      if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
      const fsize = ver === 2 ? (bytes[p + 3] << 16) | (bytes[p + 4] << 8) | bytes[p + 5] : ver === 4 ? syncsafe(bytes, p + 4) : ((bytes[p + 4] << 24) | (bytes[p + 5] << 16) | (bytes[p + 6] << 8) | bytes[p + 7]) >>> 0;
      const hdr = ver === 2 ? 6 : 10;
      if (fsize <= 0 || p + hdr + fsize > end) break;
      const d = bytes.subarray(p + hdr, p + hdr + fsize);
      const def = FRAMES[id];
      let value: string;
      if (id === 'APIC' || id === 'PIC') value = `${fsize.toLocaleString()} B image`;
      else if (id === 'PRIV') value = `${ascii(d, 0, Math.max(0, d.indexOf(0))) || 'owner?'} · ${fsize} B`;
      else if (id === 'COMM' || id === 'COM') value = decodeText(new Uint8Array([d[0], ...d.subarray(4)]));
      else if (id[0] === 'T' || id[0] === 'W') value = id === 'WXXX' || id[0] !== 'W' ? decodeText(d) : ascii(d, 0, d.length);
      else value = `${fsize.toLocaleString()} B`;
      res.structure[0].children!.push({ id: `id3@${p}`, label: `${id}${def ? ' · ' + def[0] : ''}`, kind: 'frame', range: { offset: p, length: hdr + fsize } });
      if (value) fields.push({ key: `${id}@${p}`, label: def?.[0] ?? id, value: value.slice(0, 300), sensitive: def?.[1], range: { offset: p, length: hdr + fsize } });
      p += hdr + fsize;
    }
  }
  if (bytes.length >= 128 && ascii(bytes, bytes.length - 128, bytes.length - 125) === 'TAG') {
    const o = bytes.length - 128;
    res.structure.push({ id: 'id3v1', label: 'ID3v1 tag', kind: 'tag', range: { offset: o, length: 128 } });
    const s = (a: number, n: number) => ascii(bytes, o + a, o + a + n).replace(/\0.*$/, '').trim();
    [['Title', 3, 30], ['Artist', 33, 30], ['Album', 63, 30], ['Year', 93, 4], ['Comment', 97, 28]].forEach(([l, a, n]) => {
      const v = s(a as number, n as number);
      if (v) fields.push({ key: `v1${l}`, label: `${l} (v1)`, value: v, sensitive: l === 'Comment' || l === 'Artist', range: { offset: o, length: 128 } });
    });
  }
  if (fields.length) {
    res.sections.push({ id: 'id3', title: 'Audio tags', fields });
    const priv = fields.filter(f => f.label === 'Private frame' || f.label === 'Owner' || f.label === 'Encoded by' || f.label === 'User text');
    if (priv.length) res.findings.push({ id: 'id3-priv', severity: 'caution', tag: 'AUTHOR', title: 'Private or owner tags', detail: priv.slice(0, 3).map(f => `${f.label}: ${f.value}`).join(' · ') + '. Stores and rippers write account or software IDs here.', evidence: priv.map(f => f.range!).slice(0, 4) });
    const comm = fields.find(f => f.label.startsWith('Comment') && f.value);
    if (comm) res.findings.push({ id: 'id3-comm', severity: 'info', tag: 'COMMENT', title: 'Comment tag', detail: `“${comm.value.slice(0, 120)}”`, evidence: [comm.range!] });
    if (fields.some(f => f.label === 'Embedded picture')) res.findings.push({ id: 'id3-pic', severity: 'info', tag: 'THUMBNAIL', title: 'Embedded cover art', detail: 'An image file is embedded in the tag, and it carries its own metadata.', evidence: fields.filter(f => f.label === 'Embedded picture').map(f => f.range!) });
  }
  return res;
}
