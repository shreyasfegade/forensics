// Windows PE (EXE/DLL): build timestamp, architecture, sections with their own
// entropy (packers stand out), Authenticode presence and the debug PDB path,
// which often contains the developer's Windows username.
import type { Field, Finding, ParseResult, StructNode } from '../core/types';
import { emptyResult } from '../core/types';
import { ascii, Cursor, cstring } from '../util/bytes';
import { shannon } from '../analysis/entropy';

const MACHINES: Record<number, string> = { 0x14c: 'x86 (32-bit)', 0x8664: 'x64', 0xaa64: 'ARM64', 0x1c0: 'ARM', 0x1c4: 'ARM Thumb-2', 0x200: 'Itanium', 0x5064: 'RISC-V 64' };
const SUBSYSTEMS: Record<number, string> = { 1: 'Native', 2: 'Windows GUI', 3: 'Windows console', 9: 'Windows CE', 10: 'EFI application', 14: 'Xbox' };
const PACKERS = /^(UPX\d?|\.aspack|\.adata|\.petite|\.MPRESS\d|\.themida|\.vmp\d|\.nsp\d|\.enigma\d|FSG!|\.packed|\.ndata|pebundle)$/i;

export function parsePe(bytes: Uint8Array): ParseResult {
  const res = emptyResult();
  const c = new Cursor(bytes, true);
  if (!c.has(0, 64)) return res;
  const lfanew = c.u32(0x3c);
  const nodes: StructNode[] = [{ id: 'mz', label: 'DOS header (MZ)', kind: 'header', range: { offset: 0, length: 64 } }];
  if (!c.has(lfanew, 24) || ascii(bytes, lfanew, lfanew + 4) !== 'PE\0\0') {
    res.structure = nodes;
    res.notes = ['MZ header without a valid PE signature. This could be a DOS program, or a corrupted or disguised file.'];
    return res;
  }
  if (lfanew > 64) nodes.push({ id: 'stub', label: 'DOS stub', kind: 'stub', range: { offset: 64, length: lfanew - 64 } });
  const coff = lfanew + 4;
  const machine = c.u16(coff), nSections = c.u16(coff + 2), timestamp = c.u32(coff + 4), optSize = c.u16(coff + 16), chars = c.u16(coff + 18);
  nodes.push({ id: 'coff', label: 'PE / COFF header', kind: 'header', range: { offset: lfanew, length: 24 } });
  const opt = coff + 20;
  const magic = c.has(opt, 2) ? c.u16(opt) : 0;
  const pe32plus = magic === 0x20b;
  nodes.push({ id: 'opt', label: `Optional header (${pe32plus ? 'PE32+' : 'PE32'})`, kind: 'header', range: { offset: opt, length: optSize } });
  const subsystem = c.has(opt + 68, 2) ? c.u16(opt + 68) : 0;
  const ddBase = opt + (pe32plus ? 112 : 96);
  const nDirs = c.has(ddBase - 4, 4) ? Math.min(16, c.u32(ddBase - 4)) : 0;
  const dir = (i: number) => (i < nDirs && c.has(ddBase + i * 8, 8) ? { rva: c.u32(ddBase + i * 8), size: c.u32(ddBase + i * 8 + 4) } : { rva: 0, size: 0 });

  // sections
  const secTable = opt + optSize;
  const sections: { name: string; va: number; vsize: number; raw: number; rawSize: number; entropy: number }[] = [];
  const secNode: StructNode = { id: 'sections', label: `Section table · ${nSections}`, kind: 'table', range: { offset: secTable, length: nSections * 40 }, children: [] };
  nodes.push(secNode);
  for (let i = 0; i < Math.min(nSections, 96); i++) {
    const o = secTable + i * 40;
    if (!c.has(o, 40)) break;
    const name = cstring(bytes, o, 8);
    const vsize = c.u32(o + 8), va = c.u32(o + 12), rawSize = c.u32(o + 16), raw = c.u32(o + 20);
    const data = bytes.subarray(raw, Math.min(raw + rawSize, bytes.length));
    const s = { name, va, vsize, raw, rawSize, entropy: data.length ? shannon(data) : 0 };
    sections.push(s);
    if (rawSize && raw < bytes.length) nodes.push({ id: `sec${i}`, label: `${name || '(unnamed)'} section`, kind: 'section', range: { offset: raw, length: Math.min(rawSize, bytes.length - raw) }, note: `entropy ${s.entropy.toFixed(2)}` });
    secNode.children!.push({ id: `sech${i}`, label: name || '(unnamed)', kind: 'entry', range: { offset: o, length: 40 } });
  }
  const rvaToOff = (rva: number) => {
    for (const s of sections) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return rva - s.va + s.raw;
    return -1;
  };

  // Authenticode: data directory 4 holds a *file offset*, not an RVA.
  const sec = dir(4);
  const signed = sec.size > 0 && sec.rva > 0 && sec.rva + sec.size <= bytes.length;
  if (signed) nodes.push({ id: 'cert', label: 'Authenticode signature (WIN_CERTIFICATE)', kind: 'signature', range: { offset: sec.rva, length: sec.size } });

  // Debug directory → CodeView RSDS → PDB path
  let pdb: { path: string; offset: number } | null = null;
  const dbg = dir(6);
  const dbgOff = dbg.size ? rvaToOff(dbg.rva) : -1;
  if (dbgOff > 0) {
    for (let k = 0; k < Math.min(16, Math.floor(dbg.size / 28)); k++) {
      const e = dbgOff + k * 28;
      if (!c.has(e, 28)) break;
      if (c.u32(e + 12) !== 2) continue; // IMAGE_DEBUG_TYPE_CODEVIEW
      const ptr = c.u32(e + 24);
      if (c.has(ptr, 24) && ascii(bytes, ptr, ptr + 4) === 'RSDS') { pdb = { path: cstring(bytes, ptr + 24, 512), offset: ptr + 24 }; break; }
    }
  }

  // Rich header (between DOS stub and PE): identifies the build toolchain.
  const rich = (() => { for (let i = 0x80; i < lfanew - 4; i += 4) if (ascii(bytes, i, i + 4) === 'Rich') return i; return -1; })();
  if (rich > 0) nodes.push({ id: 'rich', label: 'Rich header (toolchain fingerprint)', kind: 'header', range: { offset: 0x80, length: rich + 8 - 0x80 } });

  // Overlay: bytes after the last section.
  const end = Math.max(...sections.map(s => s.raw + s.rawSize), opt + optSize);
  const overlayStart = signed && sec.rva >= end ? sec.rva + sec.size : end;
  if (overlayStart < bytes.length && bytes.length - overlayStart > 512) {
    nodes.push({ id: 'overlay', label: 'Overlay (appended after sections)', kind: 'trailing', range: { offset: overlayStart, length: bytes.length - overlayStart } });
  }
  res.structure = nodes;

  const built = timestamp ? new Date(timestamp * 1000) : null;
  const plausible = built && timestamp > 631152000 && built.getTime() < Date.now() + 86400000 * 365;
  const fields: Field[] = [
    { key: 'machine', label: 'Architecture', value: MACHINES[machine] ?? `0x${machine.toString(16)}` },
    { key: 'kind', label: 'Kind', value: chars & 0x2000 ? 'DLL' : chars & 0x0002 ? 'Executable' : 'Object' },
    { key: 'subsystem', label: 'Subsystem', value: SUBSYSTEMS[subsystem] ?? String(subsystem) },
    { key: 'ts', label: 'Build timestamp', value: built ? `${built.toISOString().replace('T', ' ').slice(0, 19)} UTC${plausible ? '' : ' (implausible, likely a reproducible-build hash)'}` : 'zeroed', mono: true, range: { offset: coff + 4, length: 4 } },
    { key: 'signed', label: 'Signature', value: signed ? `Authenticode block present (${sec.size.toLocaleString()} B), chain not verified in browser` : 'Not signed', range: signed ? { offset: sec.rva, length: sec.size } : undefined },
    ...(pdb ? [{ key: 'pdb', label: 'Debug symbols path', value: pdb.path, mono: true, sensitive: /\\Users\\|\/home\/|\/Users\//i.test(pdb.path), range: { offset: pdb.offset, length: pdb.path.length } }] : []),
  ];
  res.sections.push({ id: 'pe', title: 'Executable header', fields });
  res.sections.push({ id: 'pe-sections', title: 'Sections', fields: sections.map((s, i) => ({ key: `s${i}`, label: s.name || '(unnamed)', value: `${s.rawSize.toLocaleString()} B · entropy ${s.entropy.toFixed(2)}${PACKERS.test(s.name) ? ' · packer' : s.entropy > 7.2 && s.rawSize > 4096 ? ' · packed/encrypted?' : ''}`, mono: true, range: s.rawSize ? { offset: s.raw, length: Math.min(s.rawSize, bytes.length - s.raw) } : undefined })) });

  const f: Finding[] = res.findings;
  if (pdb && /\\Users\\|\/home\/|\/Users\//i.test(pdb.path)) {
    const user = /(?:\\Users\\|\/home\/|\/Users\/)([^\\/]+)/i.exec(pdb.path)?.[1];
    f.push({ id: 'pe-pdb', severity: 'caution', tag: 'PATH', title: 'Developer username in debug path', detail: `The PDB path ${pdb.path} reveals the build machine's account name${user ? ` (“${user}”)` : ''} and folder layout.`, evidence: [{ offset: pdb.offset, length: pdb.path.length }] });
  } else if (pdb) {
    f.push({ id: 'pe-pdb', severity: 'info', tag: 'PATH', title: 'Debug symbols path', detail: `Built with debug info at ${pdb.path}.`, evidence: [{ offset: pdb.offset, length: pdb.path.length }] });
  }
  if (built && plausible) f.push({ id: 'pe-ts', severity: 'info', tag: 'TIMESTAMP', title: 'Compile time recorded', detail: `Linked ${built.toISOString().replace('T', ' ').slice(0, 19)} UTC.`, evidence: [{ offset: coff + 4, length: 4 }] });
  const packed = sections.filter(s => PACKERS.test(s.name) || (s.entropy > 7.2 && s.rawSize > 4096));
  if (packed.length) f.push({ id: 'pe-packed', severity: 'caution', tag: 'PAYLOAD', title: 'Packed or encrypted code', detail: `${packed.map(s => `${s.name || '?'} (${s.entropy.toFixed(2)} bits/byte)`).join(', ')}. Packers hide what the program does from scanners.`, evidence: packed.filter(s => s.rawSize).map(s => ({ offset: s.raw, length: Math.min(s.rawSize, bytes.length - s.raw) })) });
  f.push(signed
    ? { id: 'pe-signed', severity: 'info', tag: 'SIGNATURE', title: 'Carries a code signature', detail: 'An Authenticode block is present. Its certificate chain can\'t be verified offline in a browser, so check the publisher in Windows file properties.', evidence: [{ offset: sec.rva, length: sec.size }] }
    : { id: 'pe-unsigned', severity: 'caution', tag: 'SIGNATURE', title: 'Unsigned executable', detail: 'No code signature, so nothing ties this program to a known publisher.', evidence: [] });
  return res;
}
