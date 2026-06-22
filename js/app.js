/*
 * Forensics — client-side file intelligence
 * ------------------------------------------------------------------
 * Everything in this file runs in the browser. No file bytes ever leave
 * the page. There are zero third-party runtime libraries: the binary
 * parsers, the byte-distribution chart, the slippy map, and every
 * animation below are all hand-rolled in vanilla JS.
 */
(() => {
  'use strict';

  // ====================================================
  // GLOBAL STATE
  // ====================================================
  let isAnalyzing = false;
  let currentReport = null;      // structured report for export
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  // ====================================================
  // TINY ANIMATION ENGINE (replaces GSAP)
  // ====================================================
  const Ease = {
    out:      t => 1 - Math.pow(1 - t, 3),
    outQuart: t => 1 - Math.pow(1 - t, 4),
    inOut:    t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
    outBack:  t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  };

  function tween({ duration = 600, ease = Ease.out, onUpdate, onComplete }) {
    if (REDUCED) { if (onUpdate) onUpdate(1, 1); if (onComplete) onComplete(); return { cancel() {} }; }
    const start = performance.now();
    let raf = 0, killed = false;
    function frame(now) {
      if (killed) return;
      const p = Math.min(1, (now - start) / duration);
      if (onUpdate) onUpdate(ease(p), p);
      if (p < 1) raf = requestAnimationFrame(frame);
      else if (onComplete) onComplete();
    }
    raf = requestAnimationFrame(frame);
    return { cancel() { killed = true; cancelAnimationFrame(raf); } };
  }

  function countUp(el, target, { decimals = 0, suffix = '', duration = 750 } = {}) {
    tween({ duration, ease: Ease.outQuart, onUpdate: e => {
      const v = target * e;
      if (decimals > 0) {
        el.textContent = v.toFixed(decimals) + suffix;
      } else {
        el.textContent = Math.round(v).toLocaleString() + suffix;
      }
    }});
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ====================================================
  // MAGIC BYTES DATABASE
  // ====================================================
  const SIGNATURES = [
    { bytes: [0xFF,0xD8,0xFF],                                 name: 'JPEG Image',                ext: 'jpg',   category: 'image' },
    { bytes: [0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A],       name: 'PNG Image',                  ext: 'png',   category: 'image' },
    { bytes: [0x47,0x49,0x46,0x38],                            name: 'GIF Image',                  ext: 'gif',   category: 'image' },
    { bytes: [0x42,0x4D],                                      name: 'BMP Image',                  ext: 'bmp',   category: 'image' },
    { bytes: [0x49,0x49,0x2A,0x00],                            name: 'TIFF Image (LE)',            ext: 'tiff',  category: 'image' },
    { bytes: [0x4D,0x4D,0x00,0x2A],                            name: 'TIFF Image (BE)',            ext: 'tiff',  category: 'image' },
    { bytes: [0x00,0x00,0x01,0x00],                            name: 'ICO Icon',                   ext: 'ico',   category: 'image' },
    { bytes: [0x38,0x42,0x50,0x53],                            name: 'Photoshop Document',         ext: 'psd',   category: 'image' },
    { bytes: [0x25,0x50,0x44,0x46],                            name: 'PDF Document',               ext: 'pdf',   category: 'document' },
    { bytes: [0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1],       name: 'Microsoft Office (Legacy)',  ext: 'doc',   category: 'document' },
    { bytes: [0x50,0x4B,0x03,0x04],                            name: 'ZIP Archive',                ext: 'zip',   category: 'archive' },
    { bytes: [0x50,0x4B,0x05,0x06],                            name: 'ZIP Archive (Empty)',        ext: 'zip',   category: 'archive' },
    { bytes: [0x50,0x4B,0x07,0x08],                            name: 'ZIP Archive (Spanned)',      ext: 'zip',   category: 'archive' },
    { bytes: [0x52,0x61,0x72,0x21,0x1A,0x07],                  name: 'RAR Archive',                ext: 'rar',   category: 'archive' },
    { bytes: [0x37,0x7A,0xBC,0xAF,0x27,0x1C],                  name: '7-Zip Archive',              ext: '7z',    category: 'archive' },
    { bytes: [0x1F,0x8B],                                      name: 'GZIP Archive',               ext: 'gz',    category: 'archive' },
    { bytes: [0x42,0x5A,0x68],                                 name: 'BZIP2 Archive',              ext: 'bz2',   category: 'archive' },
    { bytes: [0xFD,0x37,0x7A,0x58,0x5A],                       name: 'XZ Archive',                 ext: 'xz',    category: 'archive' },
    { bytes: [0x4D,0x5A],                                      name: 'Windows Executable',         ext: 'exe',   category: 'executable' },
    { bytes: [0x7F,0x45,0x4C,0x46],                            name: 'ELF Executable (Linux)',     ext: 'elf',   category: 'executable' },
    { bytes: [0xCF,0xFA,0xED,0xFE],                            name: 'Mach-O Binary (macOS)',      ext: 'macho', category: 'executable' },
    { bytes: [0xCE,0xFA,0xED,0xFE],                            name: 'Mach-O Binary (32-bit)',     ext: 'macho', category: 'executable' },
    { bytes: [0xCA,0xFE,0xBA,0xBE],                            name: 'Java Class / Mach-O Fat',    ext: 'class', category: 'executable' },
    { bytes: [0x00,0x61,0x73,0x6D],                            name: 'WebAssembly Module',         ext: 'wasm',  category: 'executable' },
    { bytes: [0x49,0x44,0x33],                                 name: 'MP3 Audio (ID3)',            ext: 'mp3',   category: 'media' },
    { bytes: [0x66,0x4C,0x61,0x43],                            name: 'FLAC Audio',                 ext: 'flac',  category: 'media' },
    { bytes: [0x4F,0x67,0x67,0x53],                            name: 'OGG Container',              ext: 'ogg',   category: 'media' },
    { bytes: [0x52,0x49,0x46,0x46],                            name: 'RIFF Container',             ext: 'riff',  category: 'media', riff: true },
    { bytes: [0x53,0x51,0x4C,0x69,0x74,0x65],                  name: 'SQLite Database',            ext: 'sqlite',category: 'data' },
    { bytes: [0x77,0x4F,0x46,0x46],                            name: 'WOFF Font',                  ext: 'woff',  category: 'font' },
    { bytes: [0x77,0x4F,0x46,0x32],                            name: 'WOFF2 Font',                 ext: 'woff2', category: 'font' },
  ];

  // ====================================================
  // UTILITY FUNCTIONS
  // ====================================================
  function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const val = bytes / Math.pow(1024, i);
    return (i === 0 ? val : val.toFixed(2)) + ' ' + units[i];
  }

  function toHex(byte) {
    return byte.toString(16).toUpperCase().padStart(2, '0');
  }

  function getExtension(filename) {
    const dot = filename.lastIndexOf('.');
    return dot >= 0 ? filename.substring(dot + 1).toLowerCase() : '';
  }

  function escapeHTML(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
  }

  const RENDERABLE = new Set(['jpg', 'png', 'gif', 'webp', 'bmp', 'ico']);
  const MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon' };

  // ====================================================
  // MAGIC BYTES PARSER
  // ====================================================
  function identifyFileType(bytes) {
    if (bytes.length < 2) return { name: 'Unknown', ext: '', category: 'unknown' };

    // Check ftyp (MP4/MOV) — at offset 4
    if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
      if (brand === 'qt  ') return { name: 'QuickTime Movie', ext: 'mov', category: 'media' };
      if (brand === 'M4A ') return { name: 'M4A Audio', ext: 'm4a', category: 'media' };
      if (brand.startsWith('3gp')) return { name: '3GPP Video', ext: '3gp', category: 'media' };
      return { name: 'MP4 Video', ext: 'mp4', category: 'media' };
    }

    for (const sig of SIGNATURES) {
      if (bytes.length < sig.bytes.length) continue;
      let match = true;
      for (let i = 0; i < sig.bytes.length; i++) {
        if (bytes[i] !== sig.bytes[i]) { match = false; break; }
      }
      if (match) {
        // RIFF sub-type detection
        if (sig.riff && bytes.length >= 12) {
          const sub = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
          if (sub === 'WAVE') return { name: 'WAV Audio', ext: 'wav', category: 'media' };
          if (sub === 'AVI ') return { name: 'AVI Video', ext: 'avi', category: 'media' };
          if (sub === 'WEBP') return { name: 'WebP Image', ext: 'webp', category: 'image' };
          return { name: 'RIFF Container (' + sub.trim() + ')', ext: 'riff', category: 'media' };
        }
        return { name: sig.name, ext: sig.ext, category: sig.category };
      }
    }

    // Check MP3 sync word (after signature table to avoid false positives with JPEG)
    if (bytes.length >= 4 && bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0 && bytes[1] !== 0xD8) {
      return { name: 'MP3 Audio', ext: 'mp3', category: 'media' };
    }

    // Check if it's likely text
    let textChars = 0;
    const sampleLen = Math.min(bytes.length, 512);
    for (let i = 0; i < sampleLen; i++) {
      const b = bytes[i];
      if ((b >= 0x20 && b <= 0x7E) || b === 0x09 || b === 0x0A || b === 0x0D) textChars++;
    }
    if (textChars / sampleLen > 0.85) {
      const head = String.fromCharCode(...bytes.slice(0, Math.min(64, bytes.length)));
      if (head.trimStart().startsWith('<')) return { name: 'HTML/XML Document', ext: 'html', category: 'document' };
      if (head.trimStart().startsWith('{') || head.trimStart().startsWith('[')) return { name: 'JSON Data', ext: 'json', category: 'data' };
      if (head.includes('#!')) return { name: 'Script (Shebang)', ext: 'sh', category: 'executable' };
      return { name: 'Plain Text', ext: 'txt', category: 'document' };
    }

    return { name: 'Unknown Binary', ext: '', category: 'unknown' };
  }

  // ====================================================
  // EXIF PARSER (Manual — DataView + ArrayBuffer)
  // ====================================================
  function createEmptyExifResult() {
    return {
      make: null, model: null, software: null, dateTime: null,
      exposureTime: null, fNumber: null, iso: null,
      focalLength: null, lensModel: null,
      imageWidth: null, imageHeight: null,
      gps: null,
      hasAnyData: false
    };
  }

  function readAscii(view, offset, count) {
    let str = '';
    for (let i = 0; i < count - 1; i++) {
      if (offset + i >= view.byteLength) break;
      const c = view.getUint8(offset + i);
      if (c === 0) break;
      str += String.fromCharCode(c);
    }
    return str.trim();
  }

  function readRational(view, offset, le) {
    if (offset + 8 > view.byteLength) return 0;
    const num = view.getUint32(offset, le);
    const den = view.getUint32(offset + 4, le);
    return den === 0 ? 0 : num / den;
  }

  function readGPSCoord(view, offset, le) {
    const deg = readRational(view, offset, le);
    const min = readRational(view, offset + 8, le);
    const sec = readRational(view, offset + 16, le);
    return deg + min / 60 + sec / 3600;
  }

  function getDataOffset(view, entryOffset, tiffStart, type, count, le) {
    const typeSizes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
    const typeSize = typeSizes[type] || 1;
    const totalSize = typeSize * count;
    const valueFieldOffset = entryOffset + 8;
    if (totalSize <= 4) return valueFieldOffset;
    return tiffStart + view.getUint32(valueFieldOffset, le);
  }

  function parseIFD(view, tiffStart, ifdOffset, le, result, ifdType) {
    if (ifdOffset < 0 || ifdOffset + 2 > view.byteLength) return;

    let entryCount;
    try { entryCount = view.getUint16(ifdOffset, le); } catch (e) { return; }
    if (entryCount > 500) return; // sanity check

    for (let i = 0; i < entryCount; i++) {
      const entryStart = ifdOffset + 2 + (i * 12);
      if (entryStart + 12 > view.byteLength) break;

      const tag = view.getUint16(entryStart, le);
      const type = view.getUint16(entryStart + 2, le);
      const count = view.getUint32(entryStart + 4, le);

      if (count > 10000) continue; // sanity check

      let dataOff;
      try { dataOff = getDataOffset(view, entryStart, tiffStart, type, count, le); } catch (e) { continue; }
      if (dataOff < 0 || dataOff >= view.byteLength) continue;

      if (ifdType === 'ifd0') {
        switch (tag) {
          case 0x010F: result.make = readAscii(view, dataOff, count); result.hasAnyData = true; break;
          case 0x0110: result.model = readAscii(view, dataOff, count); result.hasAnyData = true; break;
          case 0x0131: result.software = readAscii(view, dataOff, count); result.hasAnyData = true; break;
          case 0x0132: result.dateTime = readAscii(view, dataOff, count); result.hasAnyData = true; break;
          case 0xA002: result.imageWidth = type === 3 ? view.getUint16(dataOff, le) : view.getUint32(dataOff, le); break;
          case 0xA003: result.imageHeight = type === 3 ? view.getUint16(dataOff, le) : view.getUint32(dataOff, le); break;
          case 0x8769: { // ExifIFD pointer
            const ptr = view.getUint32(entryStart + 8, le);
            parseIFD(view, tiffStart, tiffStart + ptr, le, result, 'exif');
            break;
          }
          case 0x8825: { // GPS IFD pointer
            const ptr = view.getUint32(entryStart + 8, le);
            result.gps = {};
            parseIFD(view, tiffStart, tiffStart + ptr, le, result, 'gps');
            break;
          }
        }
      } else if (ifdType === 'exif') {
        switch (tag) {
          case 0x829A: result.exposureTime = readRational(view, dataOff, le); result.hasAnyData = true; break;
          case 0x829D: result.fNumber = readRational(view, dataOff, le); result.hasAnyData = true; break;
          case 0x8827:
            result.iso = type === 3 ? view.getUint16(dataOff, le) : view.getUint32(dataOff, le);
            result.hasAnyData = true; break;
          case 0x9003:
            result.dateTime = readAscii(view, dataOff, count); result.hasAnyData = true; break;
          case 0x920A: result.focalLength = readRational(view, dataOff, le); result.hasAnyData = true; break;
          case 0xA434: result.lensModel = readAscii(view, dataOff, count); result.hasAnyData = true; break;
          case 0xA002: result.imageWidth = type === 3 ? view.getUint16(dataOff, le) : view.getUint32(dataOff, le); break;
          case 0xA003: result.imageHeight = type === 3 ? view.getUint16(dataOff, le) : view.getUint32(dataOff, le); break;
        }
      } else if (ifdType === 'gps') {
        switch (tag) {
          case 0x0001: result.gps.latRef = readAscii(view, dataOff, count); break;
          case 0x0002: result.gps.lat = readGPSCoord(view, dataOff, le); break;
          case 0x0003: result.gps.lonRef = readAscii(view, dataOff, count); break;
          case 0x0004: result.gps.lon = readGPSCoord(view, dataOff, le); break;
          case 0x0005: result.gps.altRef = view.getUint8(dataOff); break;
          case 0x0006: result.gps.alt = readRational(view, dataOff, le); break;
        }
      }
    }
  }

  function parseExif(buffer) {
    const view = new DataView(buffer);
    const result = createEmptyExifResult();

    if (view.byteLength < 4) return null;
    if (view.getUint16(0, false) !== 0xFFD8) return null;

    let offset = 2;
    while (offset < view.byteLength - 4) {
      if (view.getUint8(offset) !== 0xFF) { offset++; continue; }
      while (offset < view.byteLength - 1 && view.getUint8(offset + 1) === 0xFF) { offset++; }
      if (offset >= view.byteLength - 1) break;

      const markerType = view.getUint8(offset + 1);

      if (markerType === 0xE1) { // APP1
        if (offset + 4 > view.byteLength) break;
        const segLength = view.getUint16(offset + 2, false);

        if (offset + 10 <= view.byteLength) {
          const e1 = view.getUint8(offset + 4), e2 = view.getUint8(offset + 5);
          const e3 = view.getUint8(offset + 6), e4 = view.getUint8(offset + 7);
          const e5 = view.getUint8(offset + 8), e6 = view.getUint8(offset + 9);

          if (e1 === 0x45 && e2 === 0x78 && e3 === 0x69 && e4 === 0x66 && e5 === 0x00 && e6 === 0x00) {
            const tiffStart = offset + 10;
            if (tiffStart + 8 > view.byteLength) break;
            const byteOrder = view.getUint16(tiffStart, false);
            const le = (byteOrder === 0x4949);
            const magic = view.getUint16(tiffStart + 2, le);
            if (magic !== 42) break;

            const ifd0Ptr = view.getUint32(tiffStart + 4, le);
            parseIFD(view, tiffStart, tiffStart + ifd0Ptr, le, result, 'ifd0');

            if (result.gps) {
              if (typeof result.gps.lat !== 'number' || typeof result.gps.lon !== 'number' ||
                  (result.gps.lat === 0 && result.gps.lon === 0 && !result.gps.latRef)) {
                result.gps = null;
              } else {
                result.hasAnyData = true;
                if (result.gps.latRef === 'S') result.gps.lat = -result.gps.lat;
                if (result.gps.lonRef === 'W') result.gps.lon = -result.gps.lon;
                if (result.gps.altRef === 1 && result.gps.alt) result.gps.alt = -result.gps.alt;
              }
            }
            return result.hasAnyData ? result : null;
          }
        }
        offset += 2 + segLength;
        continue;
      }

      if (markerType === 0xDA) break; // SOS
      if (markerType === 0xD9) break; // EOI

      if (markerType >= 0xC0 && markerType <= 0xFE && markerType !== 0xD0 &&
          markerType !== 0xD1 && markerType !== 0xD2 && markerType !== 0xD3 &&
          markerType !== 0xD4 && markerType !== 0xD5 && markerType !== 0xD6 &&
          markerType !== 0xD7 && markerType !== 0xD8) {
        if (offset + 4 > view.byteLength) break;
        const len = view.getUint16(offset + 2, false);
        offset += 2 + len;
        continue;
      }
      offset += 2;
    }
    return result.hasAnyData ? result : null;
  }

  // ====================================================
  // PNG EXIF PARSER
  // ====================================================
  function parsePNGExif(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    if (bytes.length < 8) return null;
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4E || bytes[3] !== 0x47) return null;

    let offset = 8;
    while (offset < bytes.length - 12) {
      if (offset + 8 > bytes.length) break;
      const chunkLen = view.getUint32(offset, false);
      const chunkType = String.fromCharCode(bytes[offset+4], bytes[offset+5], bytes[offset+6], bytes[offset+7]);

      if (chunkType === 'eXIf' && chunkLen > 8) {
        const tiffStart = offset + 8;
        const result = createEmptyExifResult();
        const byteOrder = view.getUint16(tiffStart, false);
        const le = (byteOrder === 0x4949);
        const magic = view.getUint16(tiffStart + 2, le);
        if (magic === 42) {
          const ifd0Ptr = view.getUint32(tiffStart + 4, le);
          parseIFD(view, tiffStart, tiffStart + ifd0Ptr, le, result, 'ifd0');
          if (result.gps) {
            if (typeof result.gps.lat === 'number' && typeof result.gps.lon === 'number') {
              if (result.gps.latRef === 'S') result.gps.lat = -result.gps.lat;
              if (result.gps.lonRef === 'W') result.gps.lon = -result.gps.lon;
              if (result.gps.altRef === 1 && result.gps.alt) result.gps.alt = -result.gps.alt;
              result.hasAnyData = true;
            } else {
              result.gps = null;
            }
          }
          return result.hasAnyData ? result : null;
        }
      }
      if (chunkType === 'IEND') break;
      offset += 12 + chunkLen;
    }
    return null;
  }

  // ====================================================
  // ENTROPY ANALYZER
  // ====================================================
  function computeEntropy(bytes) {
    const freq = new Uint32Array(256);
    for (let i = 0; i < bytes.length; i++) freq[bytes[i]]++;

    let entropy = 0;
    const len = bytes.length;
    let maxFreq = 0;
    for (let i = 0; i < 256; i++) {
      if (freq[i] > maxFreq) maxFreq = freq[i];
      if (freq[i] > 0) {
        const p = freq[i] / len;
        entropy -= p * Math.log2(p);
      }
    }
    return { entropy, frequencies: freq, maxFreq };
  }

  function interpretEntropy(value) {
    if (value < 1.0) return 'Very low — nearly uniform data, repetitive bytes';
    if (value < 3.0) return 'Low — structured or human-readable text data';
    if (value < 5.0) return 'Medium — mixed content, likely executable or rich document';
    if (value < 7.0) return 'High — compressed data or dense binary format';
    if (value < 7.5) return 'Very high — strongly compressed or encrypted';
    return 'Extremely high — encrypted, random, or maximum-entropy data';
  }

  function interpretEntropySimple(value) {
    if (value < 1.0) return 'Extremely simple — mostly repeating empty space';
    if (value < 3.0) return 'Plain text — standard written documents or basic script';
    if (value < 5.0) return 'Standard document — formatted files or programs';
    if (value < 7.0) return 'Dense file — high-quality images, video, or audio';
    if (value < 7.5) return 'Highly compressed — zipped folder or secure file';
    return 'Encrypted / scrambled — completely random byte patterns';
  }

  // ====================================================
  // HIDDEN DATA SCANNER (steganography / appended payloads)
  // ====================================================
  function findJPEGEnd(bytes) {
    if (bytes.length < 4) return bytes.length;
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return bytes.length;

    let i = 2;
    while (i < bytes.length - 1) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      while (i < bytes.length - 1 && bytes[i + 1] === 0xFF) i++;
      if (i >= bytes.length - 1) break;

      const marker = bytes[i + 1];
      if (marker === 0xD9) return i + 2; // EOI

      if (marker === 0xDA) { // SOS
        if (i + 4 > bytes.length) break;
        const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
        i += 2 + segLen;
        while (i < bytes.length - 1) {
          if (bytes[i] === 0xFF) {
            const next = bytes[i + 1];
            if (next === 0x00) { i += 2; continue; }
            if (next >= 0xD0 && next <= 0xD7) { i += 2; continue; }
            if (next === 0xFF) { i++; continue; }
            if (next === 0xD9) return i + 2;
            break;
          }
          i++;
        }
        continue;
      }
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
      if (i + 4 > bytes.length) break;
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      i += 2 + len;
    }
    return bytes.length;
  }

  function findPNGEnd(bytes) {
    if (bytes.length < 12) return bytes.length;
    for (let i = 8; i < bytes.length - 11; i++) {
      if (bytes[i+4] === 0x49 && bytes[i+5] === 0x45 && bytes[i+6] === 0x4E && bytes[i+7] === 0x44) {
        return i + 12;
      }
    }
    return bytes.length;
  }

  function scanHiddenData(bytes, fileType) {
    let endPos = bytes.length;
    if (fileType.ext === 'jpg') endPos = findJPEGEnd(bytes);
    else if (fileType.ext === 'png') endPos = findPNGEnd(bytes);
    else return null;

    if (endPos < bytes.length) {
      const hiddenLen = bytes.length - endPos;
      const preview = bytes.slice(endPos, Math.min(endPos + 128, bytes.length));
      return { offset: endPos, length: hiddenLen, preview };
    }
    return null;
  }

  // ====================================================
  // STRINGS EXTRACTOR (printable ASCII runs)
  // ====================================================
  function extractStrings(bytes, { minLen = 5, scanLimit = 2 * 1024 * 1024 } = {}) {
    const limit = Math.min(bytes.length, scanLimit);
    const all = [];
    let cur = '';
    for (let i = 0; i < limit; i++) {
      const b = bytes[i];
      if (b >= 0x20 && b <= 0x7E) {
        cur += String.fromCharCode(b);
      } else {
        if (cur.length >= minLen) all.push(cur);
        cur = '';
      }
    }
    if (cur.length >= minLen) all.push(cur);

    const urlRe   = /\b(?:https?:\/\/|www\.)[^\s"'<>]{4,}/i;
    const emailRe = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
    const pathRe  = /(?:[A-Za-z]:\\[^\s"'<>|]{2,}|\/(?:usr|home|etc|var|tmp|Users|Library|Applications)\/[^\s"'<>]{2,})/;
    const keyRe   = /(password|passwd|secret|api[_-]?key|token|BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{12,}|Authorization)/i;

    const seen = new Set();
    const notable = [];
    for (const s of all) {
      const trimmed = s.trim();
      if (trimmed.length < minLen) continue;
      let type = null;
      if (urlRe.test(trimmed))        type = 'url';
      else if (emailRe.test(trimmed)) type = 'email';
      else if (keyRe.test(trimmed))   type = 'secret';
      else if (pathRe.test(trimmed))  type = 'path';
      if (!type) continue;
      // Pull the matching token out of a longer line for tidy display.
      const re = type === 'url' ? urlRe : type === 'email' ? emailRe : type === 'secret' ? keyRe : pathRe;
      const m = trimmed.match(re);
      const value = (m ? m[0] : trimmed).slice(0, 120);
      const key = type + ':' + value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      notable.push({ type, value });
      if (notable.length >= 14) break;
    }

    return { total: all.length, notable };
  }

  // ====================================================
  // PDF PARSER
  // ====================================================
  function parsePDF(buffer) {
    const bytes = new Uint8Array(buffer);
    const searchLimit = Math.min(bytes.length, 2 * 1024 * 1024);

    function bytesToString(arr, start, end) {
      const chunks = [];
      const chunkSize = 8192;
      for (let i = start; i < end; i += chunkSize) {
        const slice = arr.subarray(i, Math.min(i + chunkSize, end));
        chunks.push(String.fromCharCode.apply(null, slice));
      }
      return chunks.join('');
    }

    let text = bytesToString(bytes, 0, searchLimit);
    if (bytes.length > searchLimit) {
      const tailStart = Math.max(searchLimit, bytes.length - 200 * 1024);
      text += '\n' + bytesToString(bytes, tailStart, bytes.length);
    }

    const result = {
      author: null, title: null, subject: null, creator: null,
      producer: null, creationDate: null, modDate: null,
      pageCount: 0, hasJavaScript: false, hasAnyData: false
    };

    const fields = [
      { key: 'author', pattern: '/Author' },
      { key: 'title', pattern: '/Title' },
      { key: 'subject', pattern: '/Subject' },
      { key: 'creator', pattern: '/Creator' },
      { key: 'producer', pattern: '/Producer' },
      { key: 'creationDate', pattern: '/CreationDate' },
      { key: 'modDate', pattern: '/ModDate' }
    ];

    for (const field of fields) {
      const idx = text.indexOf(field.pattern);
      if (idx !== -1) {
        const val = extractPDFValue(text, idx + field.pattern.length);
        if (val) { result[field.key] = val; result.hasAnyData = true; }
      }
    }

    result.hasJavaScript = text.includes('/JavaScript') || text.includes('/JS ') || text.includes('/JS\n') || text.includes('/JS>>');

    const pageRegex = /\/Type\s*\/Page(?![s])/g;
    while (pageRegex.exec(text) !== null) result.pageCount++;

    if (result.creationDate) result.creationDate = formatPDFDate(result.creationDate);
    if (result.modDate) result.modDate = formatPDFDate(result.modDate);

    return result.hasAnyData || result.pageCount > 0 || result.hasJavaScript ? result : null;
  }

  function extractPDFValue(text, startIdx) {
    let i = startIdx;
    while (i < text.length && (text[i] === ' ' || text[i] === '\r' || text[i] === '\n' || text[i] === '\t')) i++;
    if (i >= text.length) return null;

    if (text[i] === '(') {
      let depth = 1, result = '';
      i++;
      while (i < text.length && depth > 0) {
        if (text[i] === '\\') { i++; if (i < text.length) result += text[i]; }
        else if (text[i] === '(') { depth++; result += '('; }
        else if (text[i] === ')') { depth--; if (depth > 0) result += ')'; }
        else result += text[i];
        i++;
      }
      return result.trim() || null;
    }

    if (text[i] === '<') {
      if (text[i + 1] === '<') return null;
      let hex = '';
      i++;
      while (i < text.length && text[i] !== '>') { if (/[0-9A-Fa-f]/.test(text[i])) hex += text[i]; i++; }
      if (!hex) return null;
      let result = '';
      if (hex.length >= 4 && hex.substring(0, 4).toUpperCase() === 'FEFF') {
        for (let j = 4; j + 3 < hex.length; j += 4) {
          const code = parseInt(hex.substring(j, j + 4), 16);
          if (code > 0) result += String.fromCharCode(code);
        }
      } else {
        for (let j = 0; j + 1 < hex.length; j += 2) {
          const code = parseInt(hex.substring(j, j + 2), 16);
          if (code >= 0x20) result += String.fromCharCode(code);
        }
      }
      return result.trim() || null;
    }
    return null;
  }

  function formatPDFDate(dateStr) {
    if (!dateStr) return null;
    const str = dateStr.replace(/^D:/, '');
    if (str.length < 4) return dateStr;
    try {
      const year = str.substring(0, 4);
      const month = str.substring(4, 6) || '01';
      const day = str.substring(6, 8) || '01';
      const hour = str.substring(8, 10) || '00';
      const min = str.substring(10, 12) || '00';
      const sec = str.substring(12, 14) || '00';
      const d = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(min), parseInt(sec));
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return dateStr; }
  }

  // ====================================================
  // FORMAT HELPERS
  // ====================================================
  function formatExposure(val) {
    if (!val) return '—';
    if (val >= 1) return val.toFixed(1) + 's';
    return '1/' + Math.round(1 / val) + 's';
  }
  function formatFNumber(val)    { return !val ? '—' : 'ƒ/' + val.toFixed(1); }
  function formatFocalLength(val){ return !val ? '—' : val.toFixed(0) + 'mm'; }
  function formatISO(val)        { return !val ? '—' : 'ISO ' + val; }
  function formatDateTime(str) {
    if (!str) return '—';
    const m = str.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
    if (m) {
      try {
        const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]), parseInt(m[4]), parseInt(m[5]), parseInt(m[6]));
        return d.toLocaleString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      } catch (e) { return str; }
    }
    return str;
  }

  // ====================================================
  // ENTROPY CHART RENDERER (hand-rolled canvas)
  // ====================================================
  function renderEntropyChart(canvas, frequencies, maxFreq) {
    const logicalW = 640, logicalH = 170;
    canvas.width = logicalW * DPR;
    canvas.height = logicalH * DPR;
    canvas.style.width = '100%';
    canvas.style.maxWidth = logicalW + 'px';
    canvas.style.height = 'auto';
    const ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);

    let hoverByte = -1;
    let progress = 0;

    tween({ duration: 700, ease: Ease.out, onUpdate: e => {
      progress = e;
      drawBars(ctx, frequencies, maxFreq, logicalW, logicalH, progress, hoverByte);
    }});

    const wrap = canvas.parentNode;
    let tooltip = wrap.querySelector('.entropy-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'entropy-tooltip';
      wrap.appendChild(tooltip);
    }
    tooltip.textContent = 'Hover the chart to explore byte distribution';

    const barW = 2, gap = 0.5, step = barW + gap;
    canvas.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      const mouseX = ((e.clientX - rect.left) / rect.width) * logicalW;
      const byteVal = Math.floor(mouseX / step);
      if (byteVal >= 0 && byteVal < 256 && hoverByte !== byteVal) {
        hoverByte = byteVal;
        drawBars(ctx, frequencies, maxFreq, logicalW, logicalH, progress, hoverByte);
        const freq = frequencies[byteVal];
        const char = (byteVal >= 32 && byteVal <= 126) ? String.fromCharCode(byteVal) : '·';
        const total = frequencies.reduce((a, b) => a + b, 0);
        const pct = total > 0 ? ((freq / total) * 100).toFixed(2) : 0;
        const hex = '0x' + byteVal.toString(16).toUpperCase().padStart(2, '0');
        tooltip.innerHTML = `Byte <span class="mono">${byteVal}</span> (${hex}) &nbsp;·&nbsp; Count <span class="mono" style="color:var(--accent)">${freq.toLocaleString()}</span> (${pct}%) &nbsp;·&nbsp; Char <span class="mono">${escapeHTML(char)}</span>`;
      }
    });
    canvas.addEventListener('mouseleave', () => {
      hoverByte = -1;
      drawBars(ctx, frequencies, maxFreq, logicalW, logicalH, progress, hoverByte);
      tooltip.textContent = 'Hover the chart to explore byte distribution';
    });
  }

  function drawBars(ctx, frequencies, maxFreq, w, h, progress, hoverByte = -1) {
    ctx.clearRect(0, 0, w, h);
    if (maxFreq === 0) return;

    const barW = 2, gap = 0.5, step = barW + gap, pad = 8, chartH = h - pad;

    for (let i = 0; i < 256; i++) {
      const barDelay = (i / 255) * 0.4;
      const barProg = Math.max(0, Math.min(1, (progress - barDelay) / 0.6));
      const eased = 1 - Math.pow(1 - barProg, 3);
      const barH = (frequencies[i] / maxFreq) * chartH * eased;
      const x = i * step;
      const t = i / 255;
      let alpha = (0.25 + t * 0.75) * (0.45 + eased * 0.55);
      if (hoverByte !== -1) {
        if (i === hoverByte) { ctx.fillStyle = 'rgba(255,255,255,1)'; }
        else { alpha *= 0.25; ctx.fillStyle = `rgba(74,158,255,${alpha})`; }
      } else {
        ctx.fillStyle = `rgba(74,158,255,${alpha})`;
      }
      ctx.fillRect(x, h - barH, barW, barH);
    }

    if (progress > 0.5) {
      ctx.beginPath();
      let first = true;
      const windowSize = 4;
      for (let i = 0; i < 256; i++) {
        let sum = 0, count = 0;
        for (let j = i - windowSize; j <= i + windowSize; j++) {
          if (j >= 0 && j < 256) { sum += frequencies[j]; count++; }
        }
        const avgFreq = sum / count;
        const barDelay = (i / 255) * 0.4;
        const barProg = Math.max(0, Math.min(1, (progress - barDelay) / 0.6));
        const eased = 1 - Math.pow(1 - barProg, 3);
        const barH = (avgFreq / maxFreq) * chartH * eased;
        const x = i * step + barW / 2;
        const y = h - barH;
        if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = hoverByte !== -1 ? 'rgba(74,158,255,0.3)' : 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (hoverByte !== -1) {
      const x = hoverByte * step + barW / 2;
      ctx.beginPath();
      ctx.moveTo(x, 0); ctx.lineTo(x, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  // ====================================================
  // HAND-ROLLED SLIPPY MAP (replaces Leaflet)
  // Loads OpenStreetMap raster tiles directly onto a canvas, applies a
  // dark-mode filter, and paints a custom target overlay. Tiles are only
  // requested after the user explicitly opts in, so nothing touches the
  // network by default.
  // ====================================================
  let activeMap = null;

  function project(lat, lon, z) {
    const n = Math.pow(2, z);
    const x = (lon + 180) / 360 * n * 256;
    const latRad = lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n * 256;
    return { x, y };
  }

  function createMap(host, lat, lon) {
    if (activeMap) { activeMap.destroy(); activeMap = null; }
    host.innerHTML = '';

    const W = host.clientWidth || 640;
    const H = host.clientHeight || 300;
    let zoom = 14;
    let raf = 0, destroyed = false;

    const tileCanvas = document.createElement('canvas');
    const overlay = document.createElement('canvas');
    for (const c of [tileCanvas, overlay]) {
      c.width = W * DPR; c.height = H * DPR;
      c.style.width = W + 'px'; c.style.height = H + 'px';
      c.style.position = 'absolute'; c.style.inset = '0';
      host.appendChild(c);
    }
    const tctx = tileCanvas.getContext('2d');
    const octx = overlay.getContext('2d');

    function drawTiles() {
      tctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      tctx.clearRect(0, 0, W, H);
      tctx.fillStyle = '#0a0e16';
      tctx.fillRect(0, 0, W, H);

      const c = project(lat, lon, zoom);
      const originX = c.x - W / 2, originY = c.y - H / 2;
      const x0 = Math.floor(originX / 256), x1 = Math.floor((originX + W) / 256);
      const y0 = Math.floor(originY / 256), y1 = Math.floor((originY + H) / 256);
      const n = Math.pow(2, zoom);

      for (let tx = x0; tx <= x1; tx++) {
        for (let ty = y0; ty <= y1; ty++) {
          if (ty < 0 || ty >= n) continue;
          const wx = ((tx % n) + n) % n;
          const sx = tx * 256 - originX, sy = ty * 256 - originY;
          const img = new Image();
          img.onload = () => {
            if (destroyed || img._z !== zoom) return;
            tctx.save();
            tctx.filter = 'invert(1) hue-rotate(180deg) brightness(0.75) contrast(1.05) saturate(0.7)';
            tctx.drawImage(img, sx, sy, 256, 256);
            tctx.restore();
          };
          img._z = zoom;
          img.src = `https://tile.openstreetmap.org/${zoom}/${wx}/${ty}.png`;
        }
      }
    }

    // Animated target overlay (pulsing range rings + sweep + crosshair).
    let t0 = performance.now();
    function drawOverlay(now) {
      if (destroyed) return;
      const elapsed = (now - t0) / 1000;
      octx.setTransform(DPR, 0, 0, DPR, 0, 0);
      octx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2;

      // crosshair
      octx.strokeStyle = 'rgba(74,158,255,0.25)';
      octx.lineWidth = 1;
      octx.beginPath();
      octx.moveTo(cx, 0); octx.lineTo(cx, H);
      octx.moveTo(0, cy); octx.lineTo(W, cy);
      octx.stroke();

      // pulsing rings
      for (let k = 0; k < 3; k++) {
        const phase = (elapsed * 0.5 + k / 3) % 1;
        const r = 16 + phase * 70;
        octx.beginPath();
        octx.arc(cx, cy, r, 0, Math.PI * 2);
        octx.strokeStyle = `rgba(74,158,255,${0.45 * (1 - phase)})`;
        octx.lineWidth = 1.5;
        octx.stroke();
      }

      // radar sweep
      if (!REDUCED) {
        const ang = elapsed * 1.4;
        const grad = octx.createConicGradient ? octx.createConicGradient(ang, cx, cy) : null;
        if (grad) {
          grad.addColorStop(0, 'rgba(74,158,255,0.35)');
          grad.addColorStop(0.08, 'rgba(74,158,255,0)');
          grad.addColorStop(1, 'rgba(74,158,255,0)');
          octx.fillStyle = grad;
          octx.beginPath();
          octx.arc(cx, cy, 88, 0, Math.PI * 2);
          octx.fill();
        }
      }

      // center pin
      octx.beginPath();
      octx.arc(cx, cy, 5, 0, Math.PI * 2);
      octx.fillStyle = '#FF453A';
      octx.shadowColor = '#FF453A';
      octx.shadowBlur = 12;
      octx.fill();
      octx.shadowBlur = 0;
      octx.beginPath();
      octx.arc(cx, cy, 9, 0, Math.PI * 2);
      octx.strokeStyle = 'rgba(255,69,58,0.6)';
      octx.lineWidth = 1.5;
      octx.stroke();

      raf = requestAnimationFrame(drawOverlay);
    }

    drawTiles();
    raf = requestAnimationFrame(drawOverlay);

    const api = {
      setZoom(z) { zoom = Math.max(3, Math.min(19, z)); drawTiles(); },
      getZoom() { return zoom; },
      destroy() { destroyed = true; cancelAnimationFrame(raf); }
    };
    activeMap = api;
    return api;
  }

  // ====================================================
  // RISK VERDICT
  // ====================================================
  function buildVerdict({ exif, pdf, hidden, isMismatch, fileType, fileExt, strings }) {
    const findings = [];
    let level = 'clear'; // clear | caution | exposed

    if (exif && exif.gps) {
      findings.push({ sev: 'exposed', text: 'Embedded GPS coordinates reveal exactly where this was captured.' });
      level = 'exposed';
    }
    if (hidden) {
      findings.push({ sev: 'exposed', text: `${hidden.length.toLocaleString()} bytes are hidden after the file's end-of-file marker.` });
      level = 'exposed';
    }
    if (isMismatch && fileType.category === 'executable') {
      findings.push({ sev: 'exposed', text: `Disguised executable — the .${fileExt} extension hides a real ${fileType.name}.` });
      level = 'exposed';
    }
    if (pdf && pdf.hasJavaScript) {
      findings.push({ sev: 'exposed', text: 'This document carries embedded JavaScript that runs on open.' });
      if (level !== 'exposed') level = 'exposed';
    }
    if (isMismatch && fileType.category !== 'executable') {
      findings.push({ sev: 'caution', text: `Extension mismatch — labelled .${fileExt} but the bytes say ${fileType.name}.` });
      if (level === 'clear') level = 'caution';
    }
    if (exif && (exif.make || exif.model)) {
      findings.push({ sev: 'caution', text: `Camera fingerprint left behind: ${[exif.make, exif.model].filter(Boolean).join(' ')}.` });
      if (level === 'clear') level = 'caution';
    }
    if (pdf && (pdf.author || pdf.creator)) {
      findings.push({ sev: 'caution', text: `Author / tool metadata exposed: ${[pdf.author, pdf.creator].filter(Boolean).join(' · ')}.` });
      if (level === 'clear') level = 'caution';
    }
    if (strings && strings.notable.some(s => s.type === 'secret')) {
      findings.push({ sev: 'exposed', text: 'Credential-like strings were found inside the raw bytes.' });
      level = 'exposed';
    } else if (strings && strings.notable.some(s => s.type === 'url' || s.type === 'email')) {
      findings.push({ sev: 'caution', text: 'URLs or email addresses are embedded in the raw bytes.' });
      if (level === 'clear') level = 'caution';
    }

    if (findings.length === 0) {
      findings.push({ sev: 'clear', text: 'No location data, hidden payloads, or identifying metadata detected.' });
    }

    const labels = {
      clear:   { title: 'Clean', sub: 'Nothing sensitive surfaced' },
      caution: { title: 'Caution', sub: 'Identifying metadata present' },
      exposed: { title: 'Exposed', sub: 'Sensitive data is leaking' }
    };
    return { level, findings, ...labels[level] };
  }

  // ====================================================
  // UI BUILDER
  // ====================================================
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function buildResults(file, buffer) {
    const container = document.getElementById('results-container');
    container.innerHTML = '';
    const cards = [];

    const bytes = new Uint8Array(buffer);
    const fileExt = getExtension(file.name);
    const fileType = identifyFileType(bytes);

    const isMismatch = fileExt && fileType.ext && fileExt !== fileType.ext &&
      !(fileExt === 'jpeg' && fileType.ext === 'jpg') &&
      !(fileExt === 'htm' && fileType.ext === 'html') &&
      !(fileExt === 'tif' && fileType.ext === 'tiff') &&
      !((fileExt === 'docx' || fileExt === 'xlsx' || fileExt === 'pptx' || fileExt === 'jar' || fileExt === 'apk') && fileType.ext === 'zip');

    const entropyData = computeEntropy(bytes);

    let exifData = null;
    if (fileType.ext === 'jpg') exifData = parseExif(buffer);
    else if (fileType.ext === 'png') exifData = parsePNGExif(buffer);

    let pdfData = null;
    if (fileType.ext === 'pdf') pdfData = parsePDF(buffer);

    const hiddenData = scanHiddenData(bytes, fileType);
    const stringsData = extractStrings(bytes);

    const verdict = buildVerdict({ exif: exifData, pdf: pdfData, hidden: hiddenData, isMismatch, fileType, fileExt, strings: stringsData });

    // ---- assemble structured report for export ----
    currentReport = {
      tool: 'Forensics',
      analyzedAt: new Date().toISOString(),
      file: { name: file.name, size: bytes.length, declaredExtension: fileExt || null },
      verdict: { level: verdict.level, findings: verdict.findings.map(f => f.text) },
      trueType: { name: fileType.name, extension: fileType.ext, category: fileType.category, extensionMismatch: !!isMismatch },
      entropy: { bitsPerByte: Number(entropyData.entropy.toFixed(4)), interpretation: interpretEntropy(entropyData.entropy) },
      exif: exifData ? {
        make: exifData.make, model: exifData.model, lens: exifData.lensModel,
        software: exifData.software, dateTime: exifData.dateTime,
        gps: exifData.gps ? { lat: exifData.gps.lat, lon: exifData.gps.lon, alt: exifData.gps.alt || null } : null
      } : null,
      pdf: pdfData || null,
      hiddenData: hiddenData ? { offsetBytes: hiddenData.offset, lengthBytes: hiddenData.length } : null,
      strings: stringsData.notable,
      privacyNote: 'Generated entirely in-browser. No file data was uploaded.'
    };

    // ============ VERDICT CARD ============
    const verdictReasons = verdict.findings.map(f =>
      `<li class="verdict-finding sev-${f.sev}"><span class="verdict-dot"></span><span>${escapeHTML(f.text)}</span></li>`
    ).join('');

    const verdictCard = el(`
      <div class="card card-verdict verdict-${verdict.level}">
        <div class="verdict-head">
          <div class="verdict-ring" aria-hidden="true">
            <span class="verdict-glyph"></span>
          </div>
          <div class="verdict-head-text">
            <div class="verdict-title">${escapeHTML(verdict.title)}</div>
            <div class="verdict-sub">${escapeHTML(verdict.sub)}</div>
          </div>
          <div class="verdict-actions">
            <button class="ghost-btn" id="copy-report-btn" title="Copy the full JSON report to clipboard">Copy report</button>
            <button class="ghost-btn ghost-btn-accent" id="export-report-btn" title="Download the full JSON report">Export JSON</button>
          </div>
        </div>
        <div class="verdict-file"><span class="verdict-file-name">${escapeHTML(file.name)}</span><span class="verdict-file-meta">${escapeHTML(fileType.name)} · ${formatFileSize(bytes.length)}</span></div>
        <ul class="verdict-findings">${verdictReasons}</ul>
      </div>
    `);
    cards.push(verdictCard);

    // ============ OVERVIEW STATS ============
    const overviewCard = el(`
      <div class="card">
        <div class="card-label">Overview</div>
        <div class="stat-grid">
          <div class="stat">
            <span class="stat-label technical-explain">True file type</span>
            <span class="stat-label simple-explain">Detected format</span>
            <span class="stat-value">${escapeHTML(fileType.name)}</span>
            ${isMismatch ? `<span class="stat-flag">⚠ extension .${escapeHTML(fileExt)} ≠ true type</span>` : `<span class="stat-sub">extension matches</span>`}
          </div>
          <div class="stat">
            <span class="stat-label">File size</span>
            <span class="stat-value" id="size-value">${formatFileSize(bytes.length)}</span>
            <span class="stat-sub">${bytes.length.toLocaleString()} bytes</span>
          </div>
          <div class="stat">
            <span class="stat-label technical-explain">Shannon entropy</span>
            <span class="stat-label simple-explain">Randomness</span>
            <span class="stat-value mono" id="entropy-summary" data-target="${entropyData.entropy}">0.0000</span>
            <span class="stat-sub">of 8.0 max</span>
          </div>
          <div class="stat">
            <span class="stat-label technical-explain">Readable strings</span>
            <span class="stat-label simple-explain">Text fragments</span>
            <span class="stat-value mono" id="strings-count" data-target="${stringsData.total}">0</span>
            <span class="stat-sub">${stringsData.notable.length} flagged</span>
          </div>
        </div>
      </div>
    `);
    cards.push(overviewCard);

    // ============ IMAGE PREVIEW (real images only) ============
    if (RENDERABLE.has(fileType.ext)) {
      const previewCard = el(`
        <div class="card" id="preview-card" style="display:none">
          <div class="card-label">Decoded preview</div>
          <div class="preview-wrap"><img id="preview-img" alt="Decoded preview of the analyzed image"></div>
          <div class="preview-note">Rendered locally from the raw bytes — never uploaded.</div>
        </div>
      `);
      const blob = new Blob([buffer], { type: MIME[fileType.ext] || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const img = previewCard.querySelector('#preview-img');
      img.onload = () => { previewCard.style.display = ''; };
      img.onerror = () => { URL.revokeObjectURL(url); previewCard.remove(); };
      img.src = url;
      cards.push(previewCard);
    }

    // ============ GPS / LOCATION CARD ============
    if (exifData && exifData.gps) {
      const { lat, lon, alt } = exifData.gps;
      let coordsHTML = `
        <div class="gps-coord"><span class="gps-coord-label">Latitude</span><span class="gps-coord-value">${lat.toFixed(6)}°</span></div>
        <div class="gps-coord"><span class="gps-coord-label">Longitude</span><span class="gps-coord-value">${lon.toFixed(6)}°</span></div>`;
      if (alt && alt !== 0) coordsHTML += `<div class="gps-coord"><span class="gps-coord-label">Altitude</span><span class="gps-coord-value">${alt.toFixed(1)}m</span></div>`;

      const gpsCard = el(`
        <div class="card" id="gps-card">
          <div class="card-label technical-explain">Location</div>
          <div class="card-label simple-explain">Photo location leak</div>
          <div class="gps-warning" role="alert">
            <span class="gps-warning-icon">⚠</span>
            <div>
              <div class="gps-warning-title">Location data found</div>
              <div class="gps-warning-text technical-explain">This file embeds GPS coordinates revealing exactly where the photo was taken. Anyone who receives the file can extract them.</div>
              <div class="gps-warning-text simple-explain">This photo has GPS coordinates attached. Anyone you send it to can see the exact spot it was taken.</div>
            </div>
          </div>
          <div class="gps-coords">${coordsHTML}</div>
          <div class="map-shell">
            <div class="map-canvas" id="map-canvas" role="application" aria-label="Map showing the embedded GPS location"></div>
            <div class="map-veil" id="map-veil">
              <button class="map-reveal-btn" id="map-reveal-btn">Plot location on map ↗</button>
              <span class="map-veil-note">Loads map tiles from OpenStreetMap — the only optional network request in the app.</span>
            </div>
            <div class="map-controls" id="map-controls" style="display:none">
              <button class="map-zoom" data-z="in" aria-label="Zoom in">+</button>
              <button class="map-zoom" data-z="out" aria-label="Zoom out">−</button>
            </div>
          </div>
        </div>
      `);
      gpsCard._gps = { lat, lon };
      cards.push(gpsCard);
    }

    // ============ MAGIC BYTES / HEX GRID ============
    const maxGridBytes = 256;
    let gridHTML = '<div class="hex-grid">';
    for (let i = 0; i < maxGridBytes; i++) {
      if (i < bytes.length) {
        const b = bytes[i];
        const hex = toHex(b);
        let byteClass = 'byte-other';
        if (b === 0) byteClass = 'byte-null';
        else if (b >= 0x20 && b <= 0x7E) byteClass = 'byte-ascii';
        else if ((b > 0 && b < 0x20) || b === 0x7F) byteClass = 'byte-control';
        const isMagic = i < 16 ? ' magic-byte-highlight' : '';
        gridHTML += `<div class="hex-cell ${byteClass}${isMagic}" data-offset="${i}" data-val="${b}" data-hex="${hex}" data-ascii="${b >= 32 && b <= 126 ? escapeHTML(String.fromCharCode(b)) : '·'}">${hex}</div>`;
      } else {
        gridHTML += '<div class="hex-cell byte-empty">—</div>';
      }
    }
    gridHTML += '</div>';

    const magicCard = el(`
      <div class="card" id="magic-card">
        <div class="card-label technical-explain">Magic bytes &amp; hex grid</div>
        <div class="card-label simple-explain">Digital fingerprint</div>
        <div class="magic-result">Identified as <strong>${escapeHTML(fileType.name)}</strong> from its byte signature.</div>
        ${gridHTML}
        <div class="hex-grid-tooltip" id="hex-tooltip">Hover a byte to inspect it</div>
        <div class="magic-note technical-explain">The first 256 bytes of the binary header. The leading 16 bytes (outlined) hold the magic signature used to identify the format.</div>
        <div class="magic-note simple-explain">Every file starts with a signature that acts like a fingerprint. The outlined bytes are the part we matched to verify what this file really is.</div>
      </div>
    `);
    wireHexGrid(magicCard);
    cards.push(magicCard);

    // ============ EXIF CARD ============
    if (exifData && (exifData.make || exifData.model || exifData.dateTime || exifData.exposureTime || exifData.software || exifData.lensModel)) {
      let gridItems = '';
      if (exifData.make || exifData.model)
        gridItems += metaItem('Camera', ((exifData.make || '') + ' ' + (exifData.model || '')).trim());
      if (exifData.lensModel) gridItems += metaItem('Lens', exifData.lensModel);
      if (exifData.dateTime) gridItems += metaItem('Captured', formatDateTime(exifData.dateTime));
      if (exifData.exposureTime || exifData.fNumber || exifData.iso) {
        const parts = [];
        if (exifData.exposureTime) parts.push(formatExposure(exifData.exposureTime));
        if (exifData.fNumber) parts.push(formatFNumber(exifData.fNumber));
        if (exifData.iso) parts.push(formatISO(exifData.iso));
        gridItems += metaItem('Exposure', parts.join('  ·  '), true);
      }
      if (exifData.focalLength) gridItems += metaItem('Focal length', formatFocalLength(exifData.focalLength), true);
      if (exifData.software) gridItems += metaItem('Software', exifData.software);

      cards.push(el(`
        <div class="card">
          <div class="card-label technical-explain">Camera metadata</div>
          <div class="card-label simple-explain">Photo &amp; camera settings</div>
          <div class="meta-grid">${gridItems}</div>
        </div>
      `));
    }

    // ============ PDF CARD ============
    if (pdfData) {
      let gridItems = '';
      if (pdfData.title) gridItems += metaItem('Title', pdfData.title);
      if (pdfData.author) gridItems += metaItem('Author', pdfData.author);
      if (pdfData.creator) gridItems += metaItem('Creator tool', pdfData.creator);
      if (pdfData.producer) gridItems += metaItem('Producer', pdfData.producer);
      if (pdfData.creationDate) gridItems += metaItem('Created', pdfData.creationDate);
      if (pdfData.modDate) gridItems += metaItem('Modified', pdfData.modDate);
      if (pdfData.pageCount > 0) gridItems += `<div class="meta-item"><span class="meta-item-label">Pages</span><span class="meta-item-value" id="pdf-pages" data-target="${pdfData.pageCount}">0</span></div>`;

      let pagesVisual = '';
      if (pdfData.pageCount > 0) {
        pagesVisual = '<div class="pdf-pages-visual">';
        const limit = Math.min(12, pdfData.pageCount);
        for (let p = 1; p <= limit; p++) pagesVisual += `<div class="pdf-page-icon" title="Page ${p}">${p}</div>`;
        if (pdfData.pageCount > 12) pagesVisual += `<div class="pdf-page-icon">+${pdfData.pageCount - 12}</div>`;
        pagesVisual += '</div>';
      }
      const jsWarning = pdfData.hasJavaScript ? '<div class="pdf-js-warning">⚠ This PDF contains embedded JavaScript</div>' : '';

      cards.push(el(`
        <div class="card">
          <div class="card-label technical-explain">Document metadata</div>
          <div class="card-label simple-explain">Document history &amp; author</div>
          <div class="meta-grid">${gridItems}</div>
          ${pagesVisual}
          ${jsWarning}
        </div>
      `));
    }

    // ============ STRINGS CARD ============
    if (stringsData.notable.length > 0) {
      const typeLabel = { url: 'URL', email: 'Email', path: 'Path', secret: 'Secret' };
      const rows = stringsData.notable.map(s =>
        `<div class="string-row string-${s.type}"><span class="string-tag">${typeLabel[s.type]}</span><span class="string-val mono">${escapeHTML(s.value)}</span></div>`
      ).join('');
      cards.push(el(`
        <div class="card">
          <div class="card-label technical-explain">Embedded strings</div>
          <div class="card-label simple-explain">Hidden text inside the bytes</div>
          <div class="strings-list">${rows}</div>
          <div class="magic-note">Printable text recovered directly from the raw bytes — links, paths and addresses often survive inside files long after they look "deleted".</div>
        </div>
      `));
    }

    // ============ ENTROPY CARD ============
    const canvas = document.createElement('canvas');
    canvas.id = 'entropy-canvas';
    const entropyCard = el(`
      <div class="card" id="entropy-card">
        <div class="card-label technical-explain">Byte distribution</div>
        <div class="card-label simple-explain">Data density &amp; patterns</div>
        <div class="entropy-header">
          <span class="entropy-value" id="entropy-value" data-target="${entropyData.entropy}">0.0000</span>
          <span class="entropy-unit technical-explain">bits / byte (of 8.0 max)</span>
          <span class="entropy-unit simple-explain">complexity score (of 8.0 max)</span>
        </div>
        <div class="entropy-interpretation technical-explain">${escapeHTML(interpretEntropy(entropyData.entropy))}</div>
        <div class="entropy-interpretation simple-explain">${escapeHTML(interpretEntropySimple(entropyData.entropy))}</div>
        <div class="entropy-canvas-wrap" id="entropy-canvas-wrap"></div>
        <div class="entropy-legend"><span>0x00</span><span>0x80</span><span>0xFF</span></div>
      </div>
    `);
    entropyCard._entropyData = entropyData;
    entropyCard._canvas = canvas;
    cards.push(entropyCard);

    // ============ HIDDEN DATA CARD ============
    if (hiddenData) {
      let hexPreview = '';
      for (let i = 0; i < hiddenData.preview.length; i += 16) {
        const rowBytes = [];
        for (let j = i; j < i + 16 && j < hiddenData.preview.length; j++) rowBytes.push(toHex(hiddenData.preview[j]));
        hexPreview += rowBytes.join(' ') + '\n';
      }
      cards.push(el(`
        <div class="card card-alert" id="hidden-card">
          <div class="card-label technical-explain">Hidden data</div>
          <div class="card-label simple-explain">Secret appended content</div>
          <div class="hidden-data-alert">⚠ ${hiddenData.length.toLocaleString()} bytes found after the end-of-file marker</div>
          <div class="hidden-data-hex">${escapeHTML(hexPreview.trim())}</div>
          <div class="hidden-data-note technical-explain">Data exists at offset 0x${hiddenData.offset.toString(16).toUpperCase()} beyond the file's official end marker — a hallmark of appended payloads, steganography, or polyglot files.</div>
          <div class="hidden-data-note simple-explain">Extra bytes are attached after this file's official "stop" marker — a common way to smuggle data inside an image without breaking it.</div>
        </div>
      `));
    }

    // ---- append (hidden until animated in) ----
    cards.forEach(card => { card.classList.add('card-enter'); container.appendChild(card); });

    // ---- wire report buttons ----
    const copyBtn = verdictCard.querySelector('#copy-report-btn');
    const exportBtn = verdictCard.querySelector('#export-report-btn');
    if (copyBtn) copyBtn.addEventListener('click', () => copyReport(copyBtn));
    if (exportBtn) exportBtn.addEventListener('click', () => downloadReport(file.name));

    return cards;
  }

  function metaItem(label, value, mono = false) {
    return `<div class="meta-item"><span class="meta-item-label">${escapeHTML(label)}</span><span class="meta-item-value${mono ? ' mono' : ''}">${escapeHTML(value)}</span></div>`;
  }

  function wireHexGrid(card) {
    const cells = card.querySelectorAll('.hex-cell[data-offset]');
    const tip = card.querySelector('#hex-tooltip');
    if (!tip) return;
    const show = target => {
      const offset = parseInt(target.dataset.offset);
      const val = parseInt(target.dataset.val);
      const offsetHex = '0x' + offset.toString(16).toUpperCase().padStart(2, '0');
      const binary = val.toString(2).padStart(8, '0');
      tip.innerHTML = `Offset <span class="mono">${offset}</span> (${offsetHex}) &nbsp;·&nbsp; Value <span class="mono" style="color:var(--accent)">${val}</span> (0b${binary}) &nbsp;·&nbsp; Char <span class="mono">${escapeHTML(target.dataset.ascii)}</span>`;
    };
    cells.forEach(cell => {
      cell.setAttribute('tabindex', '0');
      cell.setAttribute('role', 'button');
      cell.setAttribute('aria-label', `Byte at offset ${cell.dataset.offset}: value ${cell.dataset.val} (hex ${cell.dataset.hex})`);
      cell.addEventListener('mouseenter', e => show(e.target));
      cell.addEventListener('focus', e => show(e.target));
      cell.addEventListener('mouseleave', () => { tip.textContent = 'Hover a byte to inspect it'; });
      cell.addEventListener('blur', () => { tip.textContent = 'Hover a byte to inspect it'; });
      cell.addEventListener('keydown', e => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); const n = cell.nextElementSibling; if (n && n.dataset.offset) n.focus(); }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); const p = cell.previousElementSibling; if (p && p.dataset.offset) p.focus(); }
      });
    });
  }

  // ====================================================
  // REPORT EXPORT
  // ====================================================
  function downloadReport(filename) {
    if (!currentReport) return;
    playChime('click');
    const blob = new Blob([JSON.stringify(currentReport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const base = (filename || 'file').replace(/\.[^.]+$/, '');
    a.href = url;
    a.download = `forensics-report-${base}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copyReport(btn) {
    if (!currentReport) return;
    playChime('click');
    const text = JSON.stringify(currentReport, null, 2);
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied ✓';
    } catch (e) {
      btn.textContent = 'Copy failed';
    }
    setTimeout(() => { btn.textContent = original; }, 1600);
  }

  // ====================================================
  // ANIMATION ORCHESTRATOR
  // ====================================================
  function animateResultCards(cards) {
    cards.forEach((card, i) => {
      const delay = REDUCED ? 0 : i * 70;
      setTimeout(() => card.classList.add('card-in'), delay);
    });

    const entropySummary = document.getElementById('entropy-summary');
    if (entropySummary) countUp(entropySummary, parseFloat(entropySummary.dataset.target), { decimals: 4 });
    const stringsCount = document.getElementById('strings-count');
    if (stringsCount) countUp(stringsCount, parseInt(stringsCount.dataset.target), { decimals: 0 });

    const totalDelay = cards.length * 70 + 150;
    setTimeout(() => {
      const entropyValue = document.getElementById('entropy-value');
      if (entropyValue) countUp(entropyValue, parseFloat(entropyValue.dataset.target), { decimals: 4 });
      const pdfPages = document.getElementById('pdf-pages');
      if (pdfPages) countUp(pdfPages, parseInt(pdfPages.dataset.target), { decimals: 0 });

      const entropyCard = cards.find(c => c.id === 'entropy-card');
      if (entropyCard && entropyCard._entropyData) {
        const wrap = document.getElementById('entropy-canvas-wrap');
        if (wrap) {
          wrap.appendChild(entropyCard._canvas);
          renderEntropyChart(entropyCard._canvas, entropyCard._entropyData.frequencies, entropyCard._entropyData.maxFreq);
        }
      }
    }, totalDelay);

    // GPS map opt-in wiring
    const gpsCard = cards.find(c => c.id === 'gps-card');
    if (gpsCard && gpsCard._gps) {
      const { lat, lon } = gpsCard._gps;
      const host = gpsCard.querySelector('#map-canvas');
      const veil = gpsCard.querySelector('#map-veil');
      const controls = gpsCard.querySelector('#map-controls');
      const revealBtn = gpsCard.querySelector('#map-reveal-btn');
      revealBtn.addEventListener('click', () => {
        playChime('click');
        veil.classList.add('hidden');
        controls.style.display = 'flex';
        const map = createMap(host, lat, lon);
        controls.querySelectorAll('.map-zoom').forEach(b => {
          b.addEventListener('click', () => {
            map.setZoom(map.getZoom() + (b.dataset.z === 'in' ? 1 : -1));
          });
        });
      });
    }
  }

  // ====================================================
  // SOUND ENGINE (Web Audio API)
  // ====================================================
  let audioCtx = null;
  let soundMuted = true;

  function getAudioContext() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  function playTone(freq, type, duration, gainStart) {
    if (soundMuted) return;
    try {
      const ctx = getAudioContext();
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      osc.connect(gainNode); gainNode.connect(ctx.destination);
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gainNode.gain.setValueAtTime(gainStart, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
      osc.start(); osc.stop(ctx.currentTime + duration);
    } catch (e) { /* ignore */ }
  }
  function playChime(type) {
    if (soundMuted) return;
    if (type === 'drop') { playTone(180, 'sine', 0.12, 0.25); setTimeout(() => playTone(120, 'sine', 0.1, 0.2), 30); }
    else if (type === 'click') { playTone(800, 'triangle', 0.03, 0.1); }
    else if (type === 'complete') { playTone(523.25, 'sine', 0.4, 0.15); setTimeout(() => playTone(659.25, 'sine', 0.4, 0.15), 100); setTimeout(() => playTone(783.99, 'sine', 0.5, 0.15), 200); }
    else if (type === 'warning') { playTone(330, 'triangle', 0.25, 0.2); setTimeout(() => playTone(311.13, 'triangle', 0.35, 0.25), 120); }
  }

  // ====================================================
  // PARTICLE BACKDROP
  // ====================================================
  let forceMultiplier = 1.0;
  let targetForceMultiplier = 1.0;

  function initParticles() {
    const canvas = document.getElementById('particles-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let w = canvas.width = window.innerWidth;
    let h = canvas.height = window.innerHeight;
    const particles = [];
    const numParticles = Math.min(48, Math.floor(window.innerWidth / 26));

    class Particle {
      constructor() {
        this.x = Math.random() * w; this.y = Math.random() * h;
        this.r = Math.random() * 1.5 + 0.5;
        this.vx = Math.random() * 0.4 - 0.2; this.vy = Math.random() * 0.4 - 0.2;
        this.alpha = Math.random() * 0.3 + 0.1;
      }
      update() {
        this.x += this.vx * forceMultiplier; this.y += this.vy * forceMultiplier;
        if (this.x < 0) this.x = w; if (this.x > w) this.x = 0;
        if (this.y < 0) this.y = h; if (this.y > h) this.y = 0;
      }
      draw() {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(120,170,255,${this.alpha})`;
        ctx.fill();
      }
    }
    for (let i = 0; i < numParticles; i++) particles.push(new Particle());
    function animate() {
      ctx.clearRect(0, 0, w, h);
      forceMultiplier += (targetForceMultiplier - forceMultiplier) * 0.08;
      particles.forEach(p => { p.update(); p.draw(); });
      requestAnimationFrame(animate);
    }
    animate();
    window.addEventListener('resize', () => { w = canvas.width = window.innerWidth; h = canvas.height = window.innerHeight; });
  }

  // ====================================================
  // DEMO SAMPLE GENERATORS (in-code, instant, no assets)
  // ====================================================
  function createMockPhoto(extraTail) {
    // Programmatically build a valid JPEG with correct TIFF/EXIF/GPS structures.
    // All offsets are relative to tiffStart (byte 10 in the file).
    const exifBuf = new ArrayBuffer(512);
    const d = new DataView(exifBuf);
    const u = new Uint8Array(exifBuf);
    let p = 0;

    const w16 = (v) => { d.setUint16(p, v, true); p += 2; };
    const w32 = (v) => { d.setUint32(p, v, true); p += 4; };
    const wEntry = (tag, type, count, valOrOff) => { w16(tag); w16(type); w32(count); w32(valOrOff); };
    const wStr = (s) => { for (let i = 0; i < s.length; i++) { u[p++] = s.charCodeAt(i); } u[p++] = 0; };
    const wRational = (num, den) => { w32(num); w32(den); };

    // JPEG SOI + APP1 header
    p = 0;
    u[p++] = 0xFF; u[p++] = 0xD8; // SOI
    u[p++] = 0xFF; u[p++] = 0xE1; // APP1
    // APP1 length placeholder (fill later)
    const app1LenPos = p; p += 2;
    // "Exif\0\0"
    u[p++] = 0x45; u[p++] = 0x78; u[p++] = 0x69; u[p++] = 0x66; u[p++] = 0; u[p++] = 0;

    const tiffStart = p; // byte 10

    // TIFF header (little-endian)
    u[p++] = 0x49; u[p++] = 0x49; // 'II'
    w16(42);    // TIFF magic
    w32(8);     // offset to IFD0 (relative to tiffStart)

    // === IFD0: 3 entries (Make, Model, GPSInfoIFDPointer) ===
    // IFD0 starts at tiffStart + 8
    const ifd0Start = p;
    w16(3); // entry count

    // Strings and GPS IFD data will go after the IFD0 entries + next-IFD pointer
    // IFD0: 3 entries * 12 bytes = 36, plus 2 (count) + 4 (next IFD) = 42
    const dataAreaStart = (ifd0Start - tiffStart) + 2 + 3 * 12 + 4; // offset 50

    const makeStr = 'Apple\0';
    const modelStr = 'iPhone 15 Pro\0';
    const makeOff = dataAreaStart;
    const modelOff = makeOff + makeStr.length;
    const gpsIfdOff = modelOff + modelStr.length;

    // Entry 1: Make (tag 0x010F, type ASCII=2)
    wEntry(0x010F, 2, makeStr.length, makeOff);
    // Entry 2: Model (tag 0x0110, type ASCII=2)
    wEntry(0x0110, 2, modelStr.length, modelOff);
    // Entry 3: GPSInfo pointer (tag 0x8825, type LONG=4, count 1, value = offset)
    wEntry(0x8825, 4, 1, gpsIfdOff);

    // Next IFD offset = 0 (no more IFDs)
    w32(0);

    // === Data area: strings ===
    for (let i = 0; i < makeStr.length; i++) u[p++] = makeStr.charCodeAt(i);
    for (let i = 0; i < modelStr.length; i++) u[p++] = modelStr.charCodeAt(i);

    // === GPS IFD: 4 entries ===
    // GPS coords: 40°44'54.36"N, 73°59'8.40"W (Times Square, NYC)
    const gpsIfdStart = p;
    w16(4); // 4 GPS entries

    // GPS data area starts after GPS IFD entries + next-IFD pointer
    // 4 entries * 12 = 48, plus 2 (count) + 4 (next IFD) = 54
    const gpsDataStart = (gpsIfdStart - tiffStart) + 2 + 4 * 12 + 4;

    const latDataOff = gpsDataStart;
    const lonDataOff = latDataOff + 24; // 3 rationals = 24 bytes

    // GPS entry 1: GPSLatitudeRef (tag 1, ASCII, count 2, value inline 'N\0')
    wEntry(1, 2, 2, 0x004E); // 'N' + null, stored inline
    // GPS entry 2: GPSLatitude (tag 2, RATIONAL=5, count 3, offset)
    wEntry(2, 5, 3, latDataOff);
    // GPS entry 3: GPSLongitudeRef (tag 3, ASCII, count 2, value inline 'W\0')
    wEntry(3, 2, 2, 0x0057); // 'W' + null, stored inline
    // GPS entry 4: GPSLongitude (tag 4, RATIONAL=5, count 3, offset)
    wEntry(4, 5, 3, lonDataOff);

    w32(0); // next IFD = 0

    // Latitude rationals: 40/1, 44/1, 5436/100
    wRational(40, 1); wRational(44, 1); wRational(5436, 100);
    // Longitude rationals: 73/1, 59/1, 840/100
    wRational(73, 1); wRational(59, 1); wRational(840, 100);

    const exifEnd = p;

    // Fill APP1 length (includes everything after the APP1 marker bytes, i.e. from length field to end)
    const app1Len = exifEnd - (app1LenPos + 2) + 2; // +2 because length field itself is counted
    d.setUint16(app1LenPos, app1Len, false); // big-endian per JPEG spec

    // Build the full JPEG file
    const tail = extraTail ? new TextEncoder().encode(extraTail) : null;
    const imageDataLen = 3000;
    // SOS marker (2) + SOS header (3) + entropy data + EOI (2) + optional tail
    const totalLen = exifEnd + 2 + 3 + imageDataLen + 2 + (tail ? tail.length : 0);
    const jpeg = new Uint8Array(totalLen);
    jpeg.set(u.subarray(0, exifEnd), 0);

    let wp = exifEnd;
    jpeg[wp++] = 0xFF; jpeg[wp++] = 0xDA; // SOS marker
    jpeg[wp++] = 0x00; jpeg[wp++] = 0x03; // SOS length (includes length bytes + 1)
    jpeg[wp++] = 0x00;                    // number of components = 0
    // Entropy-coded data: avoid 0xFF to prevent premature marker detection
    for (let i = 0; i < imageDataLen; i++) jpeg[wp++] = Math.floor(Math.random() * 254);
    jpeg[wp++] = 0xFF; jpeg[wp++] = 0xD9; // EOI
    if (tail) jpeg.set(tail, wp);

    return jpeg.buffer;
  }

  function createMockMismatch() {
    const buffer = new Uint8Array(2048);
    buffer[0] = 0x4D; buffer[1] = 0x5A; // MZ header
    const planted = new TextEncoder().encode('This program cannot be run in DOS mode. \\\\10.0.0.4\\share\\payload.dll  http://malware-c2.example/beacon');
    for (let i = 2; i < buffer.length; i++) buffer[i] = Math.floor(Math.random() * 256);
    buffer.set(planted, 80);
    return buffer.buffer;
  }

  function createMockPDF() {
    const header = '%PDF-1.4\n%âãÏÓ\n';
    const body = `
1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj
2 0 obj <</Type /Pages /Kids [3 0 R 4 0 R] /Count 2>> endobj
3 0 obj <</Type /Page /Parent 2 0 R>> endobj
4 0 obj <</Type /Page /Parent 2 0 R>> endobj
5 0 obj
<<
  /Title (Confidential Q3 Financials Summary)
  /Author (Director of Security)
  /Creator (Acrobat Distiller 11.0)
  /Producer (macOS PDF Writer)
  /CreationDate (D:20260520034600Z)
  /ModDate (D:20260520034710Z)
>>
endobj
trailer
<</Root 1 0 R /Info 5 0 R>>
%%EOF
`;
    const encoder = new TextEncoder();
    const b1 = encoder.encode(header);
    const b2 = encoder.encode(body);
    const buffer = new Uint8Array(b1.length + b2.length);
    buffer.set(b1, 0); buffer.set(b2, b1.length);
    return buffer.buffer;
  }

  // A genuinely valid, metadata-free PNG drawn on a canvas.
  function createCleanImage() {
    return new Promise(resolve => {
      const size = 320;
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, size, size);
      grad.addColorStop(0, '#4A9EFF'); grad.addColorStop(0.5, '#30D158'); grad.addColorStop(1, '#0a0e16');
      g.fillStyle = grad; g.fillRect(0, 0, size, size);
      for (let i = 0; i < 40; i++) {
        g.beginPath();
        g.arc(Math.random() * size, Math.random() * size, Math.random() * 30 + 4, 0, Math.PI * 2);
        g.fillStyle = `rgba(255,255,255,${Math.random() * 0.15})`;
        g.fill();
      }
      c.toBlob(blob => { blob.arrayBuffer().then(resolve); }, 'image/png');
    });
  }

  async function triggerDemo(type) {
    let file, buffer;
    if (type === 'photo') {
      buffer = createMockPhoto();
      file = mockFile('paris_holiday.jpg', buffer);
    } else if (type === 'mismatch') {
      buffer = createMockMismatch();
      file = mockFile('invoice_receipt.txt', buffer);
    } else if (type === 'pdf') {
      buffer = createMockPDF();
      file = mockFile('confidential_q3.pdf', buffer);
    } else if (type === 'clean') {
      buffer = await createCleanImage();
      file = mockFile('vacation_safe.png', buffer);
    } else if (type === 'stego') {
      buffer = createMockPhoto('\n\n--HIDDEN PAYLOAD--\nuser=admin password=hunter2\nsecret note: meet at the docks midnight\n');
      file = mockFile('cat_meme.jpg', buffer);
    }
    if (file && buffer) reAnalyze(file, buffer);
  }

  function mockFile(name, buffer) {
    return { name, size: buffer.byteLength, arrayBuffer: async () => buffer };
  }

  // ====================================================
  // SCAN PIPELINE
  // ====================================================
  async function runForensicScan(file, buffer) {
    const overlay = document.getElementById('scanner-overlay');
    const statusText = document.getElementById('scanner-status');
    const progressBar = document.getElementById('scanner-progress');
    const dropzone = document.getElementById('dropzone');
    const results = document.getElementById('results');
    const redrop = document.getElementById('redrop-area');

    progressBar.style.width = '0%';
    statusText.textContent = 'Reading binary stream…';
    overlay.style.display = 'flex';
    overlay.style.opacity = '0';
    targetForceMultiplier = 12.0;
    playChime('click');

    requestAnimationFrame(() => { overlay.style.opacity = '1'; });

    const steps = [
      { text: 'Reading binary stream…', pct: '28%' },
      { text: 'Matching magic-byte signature…', pct: '52%' },
      { text: 'Computing Shannon entropy…', pct: '74%' },
      { text: 'Walking EXIF directory trees…', pct: '100%' }
    ];
    const stepDelay = REDUCED ? 40 : 150;
    for (const s of steps) {
      await sleep(stepDelay);
      statusText.textContent = s.text;
      progressBar.style.width = s.pct;
      playChime('click');
    }
    await sleep(REDUCED ? 20 : 120);

    const cards = buildResults(file, buffer);

    overlay.style.opacity = '0';
    setTimeout(() => {
      overlay.style.display = 'none';
      dropzone.classList.add('dissolving', 'hidden');
      results.classList.add('visible');
      redrop.style.display = 'flex';
      targetForceMultiplier = 1.0;

      const hasWarning = cards.some(c => c.classList.contains('verdict-exposed') || c.id === 'gps-card');
      requestAnimationFrame(() => {
        animateResultCards(cards);
        const delay = cards.length * 70 + 250;
        setTimeout(() => playChime(hasWarning ? 'warning' : 'complete'), delay);
      });
      isAnalyzing = false;
    }, REDUCED ? 0 : 320);
  }

  async function analyzeFile(file) {
    if (isAnalyzing) return;
    isAnalyzing = true;
    try {
      const buffer = await file.arrayBuffer();
      await runForensicScan(file, buffer);
    } catch (err) {
      showError();
    }
  }

  // Used by demos and re-drops: fade existing results then scan.
  function reAnalyze(file, prefetched) {
    if (isAnalyzing) return;
    isAnalyzing = true;
    if (activeMap) { activeMap.destroy(); activeMap = null; }
    const container = document.getElementById('results-container');
    const existing = container.querySelectorAll('.card');
    const go = async () => {
      container.innerHTML = '';
      try {
        const buffer = prefetched || await file.arrayBuffer();
        await runForensicScan(file, buffer);
      } catch (e) { showError(); }
    };
    if (existing.length > 0 && !REDUCED) {
      existing.forEach((c, i) => { c.style.transition = 'opacity .2s, transform .2s'; setTimeout(() => { c.style.opacity = '0'; c.style.transform = 'translateY(-8px)'; }, i * 25); });
      setTimeout(go, existing.length * 25 + 150);
    } else {
      go();
    }
  }

  function showError() {
    isAnalyzing = false;
    const overlay = document.getElementById('scanner-overlay');
    if (overlay) { overlay.style.display = 'none'; overlay.style.opacity = '0'; }
    const dropzone = document.getElementById('dropzone');
    const results = document.getElementById('results');
    const redrop = document.getElementById('redrop-area');
    const container = document.getElementById('results-container');
    container.innerHTML = '';
    const card = el(`
      <div class="card card-alert card-enter" role="alert">
        <div class="card-label">Analysis error</div>
        <div class="error-body">
          <span class="error-icon">⚠</span>
          <div>
            <div class="error-title">Could not analyze this file</div>
            <div class="error-text">The file could not be read or processed. It may be corrupted, too large for browser memory, or an unsupported format.</div>
            <button class="ghost-btn ghost-btn-accent" id="error-reset" style="margin-top:14px">Try another file</button>
          </div>
        </div>
      </div>
    `);
    container.appendChild(card);
    requestAnimationFrame(() => card.classList.add('card-in'));
    dropzone.classList.add('hidden');
    results.classList.add('visible');
    redrop.style.display = 'flex';
    targetForceMultiplier = 1.0;
    const btn = card.querySelector('#error-reset');
    if (btn) btn.addEventListener('click', resetToDropzone);
  }

  function resetToDropzone() {
    playChime('click');
    if (activeMap) { activeMap.destroy(); activeMap = null; }
    const dropzone = document.getElementById('dropzone');
    const results = document.getElementById('results');
    const redrop = document.getElementById('redrop-area');
    const container = document.getElementById('results-container');
    results.classList.remove('visible');
    redrop.style.display = 'none';
    container.innerHTML = '';
    currentReport = null;
    dropzone.classList.remove('dissolving', 'hidden');
    isAnalyzing = false;
  }

  // ====================================================
  // EVENT WIRING
  // ====================================================
  function init() {
    const dropzone = document.getElementById('dropzone');
    const frame = document.getElementById('dropzone-frame');
    const resetBtn = document.getElementById('reset-btn');
    const redrop = document.getElementById('redrop-area');
    const fileInput = document.getElementById('file-input');
    const soundBtn = document.getElementById('sound-btn');
    const btnExpert = document.getElementById('btn-expert');
    const btnSimple = document.getElementById('btn-simple');
    const results = document.getElementById('results');

    let dragCounter = 0;

    if (!REDUCED) initParticles();

    soundBtn.addEventListener('click', () => {
      soundMuted = !soundMuted;
      if (!soundMuted) {
        soundBtn.textContent = '🔊';
        soundBtn.setAttribute('aria-label', 'Sound is on. Click to mute.');
        getAudioContext(); playTone(600, 'sine', 0.1, 0.15);
      } else {
        soundBtn.textContent = '🔇';
        soundBtn.setAttribute('aria-label', 'Sound is off. Click to enable sound.');
      }
    });

    btnExpert.addEventListener('click', () => {
      playChime('click');
      btnExpert.classList.add('active'); btnExpert.setAttribute('aria-checked', 'true');
      btnSimple.classList.remove('active'); btnSimple.setAttribute('aria-checked', 'false');
      results.classList.remove('mode-simple');
    });
    btnSimple.addEventListener('click', () => {
      playChime('click');
      btnSimple.classList.add('active'); btnSimple.setAttribute('aria-checked', 'true');
      btnExpert.classList.remove('active'); btnExpert.setAttribute('aria-checked', 'false');
      results.classList.add('mode-simple');
    });

    frame.addEventListener('click', () => { playChime('click'); fileInput.click(); });
    frame.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playChime('click'); fileInput.click(); }
    });
    fileInput.addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) { playChime('drop'); analyzeFile(file); }
      fileInput.value = '';
    });

    document.querySelectorAll('.demo-btn').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); triggerDemo(btn.dataset.demo); });
    });

    dropzone.addEventListener('dragenter', e => { e.preventDefault(); e.stopPropagation(); dragCounter++; frame.classList.add('dragover'); targetForceMultiplier = 8.0; });
    dropzone.addEventListener('dragleave', e => { e.stopPropagation(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; frame.classList.remove('dragover'); targetForceMultiplier = 1.0; } });
    dropzone.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); });
    dropzone.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      dragCounter = 0; frame.classList.remove('dragover'); targetForceMultiplier = 1.0;
      const file = e.dataTransfer.files[0];
      if (file) { playChime('drop'); analyzeFile(file); }
    });

    let bodyDragCounter = 0;
    document.body.addEventListener('dragenter', e => {
      e.preventDefault(); bodyDragCounter++; targetForceMultiplier = 8.0;
      if (!dropzone.classList.contains('hidden')) return;
      redrop.classList.add('dragover');
    });
    document.body.addEventListener('dragleave', () => {
      bodyDragCounter--; if (bodyDragCounter <= 0) { bodyDragCounter = 0; targetForceMultiplier = 1.0; redrop.classList.remove('dragover'); }
    });
    document.body.addEventListener('dragover', e => e.preventDefault());
    document.body.addEventListener('drop', e => {
      e.preventDefault(); bodyDragCounter = 0; targetForceMultiplier = 1.0; redrop.classList.remove('dragover');
      if (dropzone.classList.contains('hidden')) {
        const file = e.dataTransfer.files[0];
        if (file && !isAnalyzing) { playChime('drop'); reAnalyze(file); }
      }
    });

    resetBtn.addEventListener('click', resetToDropzone);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
