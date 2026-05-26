  (() => {
    'use strict';

    // ====================================================
    // GLOBAL STATE
    // ====================================================
    let leafletMap = null;
    let isAnalyzing = false;

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

    function formatHexRow(bytes, start, count) {
      const parts = [];
      for (let i = start; i < start + count && i < bytes.length; i++) {
        parts.push(toHex(bytes[i]));
      }
      return parts.join(' ');
    }

    function getExtension(filename) {
      const dot = filename.lastIndexOf('.');
      return dot >= 0 ? filename.substring(dot + 1).toLowerCase() : '';
    }

    function escapeHTML(str) {
      const d = document.createElement('div');
      d.textContent = str;
      return d.innerHTML;
    }

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
        // Check for common text formats
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

    function readSRational(view, offset, le) {
      if (offset + 8 > view.byteLength) return 0;
      const num = view.getInt32(offset, le);
      const den = view.getInt32(offset + 4, le);
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

      if (totalSize <= 4) {
        return valueFieldOffset;
      } else {
        return tiffStart + view.getUint32(valueFieldOffset, le);
      }
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
            case 0x8827: // ISOSpeedRatings
              result.iso = type === 3 ? view.getUint16(dataOff, le) : view.getUint32(dataOff, le);
              result.hasAnyData = true; break;
            case 0x9003: // DateTimeOriginal (prefer over DateTime)
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

      // Verify JPEG SOI
      if (view.byteLength < 4) return null;
      if (view.getUint16(0, false) !== 0xFFD8) return null;

      let offset = 2;
      while (offset < view.byteLength - 4) {
        // Find next FF marker
        if (view.getUint8(offset) !== 0xFF) { offset++; continue; }

        // Skip padding FF bytes
        while (offset < view.byteLength - 1 && view.getUint8(offset + 1) === 0xFF) { offset++; }
        if (offset >= view.byteLength - 1) break;

        const markerType = view.getUint8(offset + 1);

        // APP1 = 0xE1
        if (markerType === 0xE1) {
          if (offset + 4 > view.byteLength) break;
          const segLength = view.getUint16(offset + 2, false);

          // Check "Exif\0\0"
          if (offset + 10 <= view.byteLength) {
            const e1 = view.getUint8(offset + 4);
            const e2 = view.getUint8(offset + 5);
            const e3 = view.getUint8(offset + 6);
            const e4 = view.getUint8(offset + 7);
            const e5 = view.getUint8(offset + 8);
            const e6 = view.getUint8(offset + 9);

            if (e1 === 0x45 && e2 === 0x78 && e3 === 0x69 && e4 === 0x66 && e5 === 0x00 && e6 === 0x00) {
              const tiffStart = offset + 10;

              // Read byte order
              if (tiffStart + 8 > view.byteLength) break;
              const byteOrder = view.getUint16(tiffStart, false);
              const le = (byteOrder === 0x4949); // 'II' = little-endian

              // Verify TIFF magic 42
              const magic = view.getUint16(tiffStart + 2, le);
              if (magic !== 42) break;

              // First IFD offset
              const ifd0Ptr = view.getUint32(tiffStart + 4, le);
              parseIFD(view, tiffStart, tiffStart + ifd0Ptr, le, result, 'ifd0');

              // Validate GPS
              if (result.gps) {
                if (typeof result.gps.lat !== 'number' || typeof result.gps.lon !== 'number' ||
                    (result.gps.lat === 0 && result.gps.lon === 0 && !result.gps.latRef)) {
                  result.gps = null;
                } else {
                  result.hasAnyData = true;
                  // Apply N/S E/W
                  if (result.gps.latRef === 'S') result.gps.lat = -result.gps.lat;
                  if (result.gps.lonRef === 'W') result.gps.lon = -result.gps.lon;
                  if (result.gps.altRef === 1 && result.gps.alt) result.gps.alt = -result.gps.alt;
                }
              }

              return result.hasAnyData ? result : null;
            }
          }

          // Not EXIF APP1 (maybe XMP), skip it
          offset += 2 + segLength;
          continue;
        }

        // SOS marker — no more metadata after this
        if (markerType === 0xDA) break;
        // EOI
        if (markerType === 0xD9) break;

        // Skip other markers with length fields
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

      // Verify PNG signature
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
      for (let i = 0; i < bytes.length; i++) {
        freq[bytes[i]]++;
      }

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
      return 'Encrypted / Scrambled — completely random byte patterns';
    }

    // ====================================================
    // HIDDEN DATA SCANNER
    // ====================================================
    function findJPEGEnd(bytes) {
      if (bytes.length < 4) return bytes.length;
      if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return bytes.length;

      let i = 2;
      while (i < bytes.length - 1) {
        if (bytes[i] !== 0xFF) { i++; continue; }

        // Skip padding FFs
        while (i < bytes.length - 1 && bytes[i + 1] === 0xFF) i++;
        if (i >= bytes.length - 1) break;

        const marker = bytes[i + 1];

        if (marker === 0xD9) return i + 2; // EOI

        if (marker === 0xDA) {
          // SOS — scan entropy-coded data
          if (i + 4 > bytes.length) break;
          const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
          i += 2 + segLen;

          // Walk through entropy-coded data
          while (i < bytes.length - 1) {
            if (bytes[i] === 0xFF) {
              const next = bytes[i + 1];
              if (next === 0x00) { i += 2; continue; } // byte stuffing
              if (next >= 0xD0 && next <= 0xD7) { i += 2; continue; } // restart
              if (next === 0xFF) { i++; continue; } // padding
              if (next === 0xD9) return i + 2; // EOI
              break; // other marker
            }
            i++;
          }
          continue;
        }

        // Standalone markers (no length field)
        if (marker === 0x00 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
          i += 2;
          continue;
        }

        // Markers with length
        if (i + 4 > bytes.length) break;
        const len = (bytes[i + 2] << 8) | bytes[i + 3];
        i += 2 + len;
      }

      return bytes.length;
    }

    function findPNGEnd(bytes) {
      if (bytes.length < 12) return bytes.length;
      // Look for IEND chunk: 00 00 00 00 [I E N D] [CRC 4 bytes]
      for (let i = 8; i < bytes.length - 11; i++) {
        if (bytes[i+4] === 0x49 && bytes[i+5] === 0x45 && bytes[i+6] === 0x4E && bytes[i+7] === 0x44) {
          return i + 12; // length(4) + type(4) + CRC(4)
        }
      }
      return bytes.length;
    }

    function scanHiddenData(bytes, fileType) {
      let endPos = bytes.length;

      if (fileType.ext === 'jpg') {
        endPos = findJPEGEnd(bytes);
      } else if (fileType.ext === 'png') {
        endPos = findPNGEnd(bytes);
      } else {
        return null;
      }

      if (endPos < bytes.length) {
        const hiddenLen = bytes.length - endPos;
        const preview = bytes.slice(endPos, Math.min(endPos + 128, bytes.length));
        return { offset: endPos, length: hiddenLen, preview };
      }

      return null;
    }

    // ====================================================
    // PDF PARSER
    // ====================================================
    function parsePDF(buffer) {
      const bytes = new Uint8Array(buffer);
      const searchLimit = Math.min(bytes.length, 2 * 1024 * 1024);

      // Fast binary-to-string conversion in chunks
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

      // Also search the tail for cross-reference and info dict
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
          if (val) {
            result[field.key] = val;
            result.hasAnyData = true;
          }
        }
      }

      // Check JavaScript
      result.hasJavaScript = text.includes('/JavaScript') || text.includes('/JS ') || text.includes('/JS\n') || text.includes('/JS>>');

      // Count pages — /Type /Page but not /Type /Pages
      const pageRegex = /\/Type\s*\/Page(?![s])/g;
      let m;
      while ((m = pageRegex.exec(text)) !== null) {
        result.pageCount++;
      }

      // Format dates
      if (result.creationDate) result.creationDate = formatPDFDate(result.creationDate);
      if (result.modDate) result.modDate = formatPDFDate(result.modDate);

      return result.hasAnyData || result.pageCount > 0 || result.hasJavaScript ? result : null;
    }

    function extractPDFValue(text, startIdx) {
      let i = startIdx;
      // Skip whitespace
      while (i < text.length && (text[i] === ' ' || text[i] === '\r' || text[i] === '\n' || text[i] === '\t')) i++;
      if (i >= text.length) return null;

      if (text[i] === '(') {
        // Literal string
        let depth = 1, result = '';
        i++;
        while (i < text.length && depth > 0) {
          if (text[i] === '\\') {
            i++;
            if (i < text.length) result += text[i];
          } else if (text[i] === '(') {
            depth++; result += '(';
          } else if (text[i] === ')') {
            depth--;
            if (depth > 0) result += ')';
          } else {
            result += text[i];
          }
          i++;
        }
        return result.trim() || null;
      }

      if (text[i] === '<') {
        // Hex string
        if (text[i + 1] === '<') return null; // dictionary, not hex string
        let hex = '';
        i++;
        while (i < text.length && text[i] !== '>') {
          if (/[0-9A-Fa-f]/.test(text[i])) hex += text[i];
          i++;
        }
        if (!hex) return null;
        let result = '';
        // UTF-16BE with BOM
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
      } catch (e) {
        return dateStr;
      }
    }

    // ====================================================
    // ENTROPY CHART RENDERER
    // ====================================================
    function renderEntropyChart(canvas, frequencies, maxFreq) {
      const dpr = window.devicePixelRatio || 1;
      const logicalW = 640;
      const logicalH = 160;
      canvas.width = logicalW * dpr;
      canvas.height = logicalH * dpr;
      canvas.style.width = logicalW + 'px';
      canvas.style.height = logicalH + 'px';
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      let hoverByte = -1;
      let progress = 0;

      const anim = { progress: 0 };
      gsap.to(anim, {
        progress: 1,
        duration: 0.6,
        ease: 'power2.out',
        onUpdate: () => {
          progress = anim.progress;
          drawBars(ctx, frequencies, maxFreq, logicalW, logicalH, progress, hoverByte);
        }
      });

      // Create interactive tooltip below canvas
      const wrap = canvas.parentNode;
      let tooltip = wrap.querySelector('.entropy-tooltip');
      if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'entropy-tooltip';
        wrap.appendChild(tooltip);
      }
      tooltip.textContent = 'Hover over the chart to explore byte distribution';

      canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        // Scale mouseX according to canvas logical width vs offsetWidth
        const mouseX = ((e.clientX - rect.left) / rect.width) * logicalW;

        const barW = 2;
        const gap = 0.5;
        const step = barW + gap;

        const byteVal = Math.floor(mouseX / step);
        if (byteVal >= 0 && byteVal < 256) {
          if (hoverByte !== byteVal) {
            hoverByte = byteVal;
            drawBars(ctx, frequencies, maxFreq, logicalW, logicalH, progress, hoverByte);

            const freq = frequencies[byteVal];
            const char = (byteVal >= 32 && byteVal <= 126) ? String.fromCharCode(byteVal) : '·';
            const total = frequencies.reduce((a, b) => a + b, 0);
            const pct = total > 0 ? ((freq / total) * 100).toFixed(2) : 0;
            const hex = '0x' + byteVal.toString(16).toUpperCase().padStart(2, '0');

            tooltip.innerHTML = `Byte: <span class="mono">${byteVal}</span> (${hex}) &nbsp;·&nbsp; Count: <span class="mono" style="color:var(--accent)">${freq.toLocaleString()}</span> (${pct}%) &nbsp;·&nbsp; Char: <span class="mono">${escapeHTML(char)}</span>`;
          }
        }
      });

      canvas.addEventListener('mouseleave', () => {
        hoverByte = -1;
        drawBars(ctx, frequencies, maxFreq, logicalW, logicalH, progress, hoverByte);
        tooltip.textContent = 'Hover over the chart to explore byte distribution';
      });
    }

    function drawBars(ctx, frequencies, maxFreq, w, h, progress, hoverByte = -1) {
      ctx.clearRect(0, 0, w, h);
      if (maxFreq === 0) return;

      const barW = 2;
      const gap = 0.5;
      const step = barW + gap;
      const pad = 8;
      const chartH = h - pad;

      // 1. Draw bars
      for (let i = 0; i < 256; i++) {
        const barDelay = (i / 255) * 0.4;
        const barProg = Math.max(0, Math.min(1, (progress - barDelay) / 0.6));
        const eased = 1 - Math.pow(1 - barProg, 3); // cubic ease out

        const normH = (frequencies[i] / maxFreq) * chartH;
        const barH = normH * eased;
        const x = i * step;

        const t = i / 255;
        const r = 74;
        const g = 158;
        const b = 255;

        let alpha = (0.25 + t * 0.75) * (0.45 + eased * 0.55);
        if (hoverByte !== -1) {
          if (i === hoverByte) {
            alpha = 1.0;
            ctx.fillStyle = `rgba(255, 255, 255, 1.0)`;
          } else {
            alpha *= 0.25; // dim other bars more heavily
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
          }
        } else {
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        ctx.fillRect(x, h - barH, barW, barH);
      }

      // 2. Draw rolling average spectral envelope (if progress is significant)
      if (progress > 0.5) {
        ctx.beginPath();
        let first = true;
        const windowSize = 4;

        for (let i = 0; i < 256; i++) {
          let sum = 0;
          let count = 0;
          for (let j = i - windowSize; j <= i + windowSize; j++) {
            if (j >= 0 && j < 256) {
              sum += frequencies[j];
              count++;
            }
          }
          const avgFreq = sum / count;

          const barDelay = (i / 255) * 0.4;
          const barProg = Math.max(0, Math.min(1, (progress - barDelay) / 0.6));
          const eased = 1 - Math.pow(1 - barProg, 3);

          const normH = (avgFreq / maxFreq) * chartH;
          const barH = normH * eased;
          const x = i * step + (barW / 2);
          const y = h - barH;

          if (first) {
            ctx.moveTo(x, y);
            first = false;
          } else {
            ctx.lineTo(x, y);
          }
        }

        ctx.strokeStyle = hoverByte !== -1 ? 'rgba(74, 158, 255, 0.3)' : 'rgba(255, 255, 255, 0.45)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // 3. Draw vertical hover line if hoverByte is active
      if (hoverByte !== -1) {
        const x = hoverByte * step + (barW / 2);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.lineWidth = 0.5;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]); // Reset dash
      }
    }

    // ====================================================
    // COUNT-UP ANIMATION
    // ====================================================
    function animateCountUp(element, target, decimals = 0, suffix = '') {
      const obj = { v: 0 };
      gsap.to(obj, {
        v: target,
        duration: 0.7,
        ease: 'power4.out',
        onUpdate: () => {
          element.textContent = obj.v.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + suffix;
        }
      });
    }

    // ====================================================
    // FORMAT HELPERS
    // ====================================================
    function formatExposure(val) {
      if (!val) return '—';
      if (val >= 1) return val.toFixed(1) + 's';
      const denom = Math.round(1 / val);
      return '1/' + denom + 's';
    }

    function formatFNumber(val) {
      if (!val) return '—';
      return '\u0192/' + val.toFixed(1);
    }

    function formatFocalLength(val) {
      if (!val) return '—';
      return val.toFixed(0) + 'mm';
    }

    function formatISO(val) {
      if (!val) return '—';
      return 'ISO ' + val;
    }

    function formatDateTime(str) {
      if (!str) return '—';
      // EXIF format: "YYYY:MM:DD HH:MM:SS"
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
    // UI BUILDER
    // ====================================================
    function buildResults(file, buffer) {
      const container = document.getElementById('results-container');
      container.innerHTML = '';
      const cards = [];

      const bytes = new Uint8Array(buffer);
      const fileExt = getExtension(file.name);

      // --- Identify file type ---
      const fileType = identifyFileType(bytes);
      const isMismatch = fileExt && fileType.ext && fileExt !== fileType.ext &&
                         !(fileExt === 'jpeg' && fileType.ext === 'jpg') &&
                         !(fileExt === 'htm' && fileType.ext === 'html') &&
                         !(fileExt === 'tif' && fileType.ext === 'tiff') &&
                         !((fileExt === 'docx' || fileExt === 'xlsx' || fileExt === 'pptx' || fileExt === 'jar' || fileExt === 'apk') && fileType.ext === 'zip');

      // --- Compute entropy ---
      const entropyData = computeEntropy(bytes);

      // --- Parse EXIF ---
      let exifData = null;
      if (fileType.ext === 'jpg') {
        exifData = parseExif(buffer);
      } else if (fileType.ext === 'png') {
        exifData = parsePNGExif(buffer);
      }

      // --- Parse PDF ---
      let pdfData = null;
      if (fileType.ext === 'pdf') {
        pdfData = parsePDF(buffer);
      }

      // --- Scan hidden data ---
      const hiddenData = scanHiddenData(bytes, fileType);

      // --- Determine privacy risk ---
      const hasGPS = !!(exifData && exifData.gps);
      const hasPersonalMeta = !!(exifData && (exifData.make || exifData.model)) ||
                               !!(pdfData && pdfData.author);
      const hasSensitive = hasGPS || hasPersonalMeta;

      // ============ SUMMARY CARD ============
      const summaryCard = document.createElement('div');
      summaryCard.className = 'card';
      summaryCard.id = 'summary-card';

      let badgeHTML;
      if (hasGPS) {
        badgeHTML = '<span class="badge badge-warning">⚠ Location Data Exposed</span>';
      } else if (hasPersonalMeta) {
        badgeHTML = '<span class="badge badge-warning">Sensitive Metadata Found</span>';
      } else {
        badgeHTML = '<span class="badge badge-safe">✓ No Sensitive Metadata</span>';
      }

      summaryCard.innerHTML = `
        <div class="card-label">Summary</div>
        <div class="filename">${escapeHTML(file.name)}</div>
        <div class="summary-grid">
          <div class="summary-item">
            <span class="summary-item-label technical-explain">True File Type</span>
            <span class="summary-item-label simple-explain">Detected Format</span>
            <span class="summary-item-value">${escapeHTML(fileType.name)}</span>
            ${isMismatch ? '<div class="badge-mismatch" role="alert">⚠ Extension .' + escapeHTML(fileExt) + ' does not match true type</div>' : ''}
          </div>
          <div class="summary-item">
            <span class="summary-item-label technical-explain">File Size</span>
            <span class="summary-item-label simple-explain">File Size</span>
            <span class="summary-item-value" id="size-value" data-target="${bytes.length}">${formatFileSize(bytes.length)}</span>
            <span class="summary-item-sub">${bytes.length.toLocaleString()} bytes</span>
          </div>
          <div class="summary-item">
            <span class="summary-item-label technical-explain">Shannon Entropy</span>
            <span class="summary-item-label simple-explain">Complexity / Randomness</span>
            <span class="summary-item-value mono" id="entropy-summary" data-target="${entropyData.entropy}">${entropyData.entropy.toFixed(4)}</span>
            <span class="summary-item-sub technical-explain">${escapeHTML(interpretEntropy(entropyData.entropy))}</span>
            <span class="summary-item-sub simple-explain">${escapeHTML(interpretEntropySimple(entropyData.entropy))}</span>
          </div>
          <div class="summary-item">
            <span class="summary-item-label technical-explain">Privacy Risk</span>
            <span class="summary-item-label simple-explain">Privacy Risk</span>
            ${badgeHTML}
          </div>
        </div>
      `;
      cards.push(summaryCard);

      // ============ GPS / LOCATION CARD ============
      if (hasGPS) {
        const gpsCard = document.createElement('div');
        gpsCard.className = 'card';
        gpsCard.id = 'gps-card';

        const lat = exifData.gps.lat;
        const lon = exifData.gps.lon;
        const alt = exifData.gps.alt;

        let coordsHTML = `
          <div class="gps-coord">
            <span class="gps-coord-label">Latitude</span>
            <span class="gps-coord-value">${lat.toFixed(6)}°</span>
          </div>
          <div class="gps-coord">
            <span class="gps-coord-label">Longitude</span>
            <span class="gps-coord-value">${lon.toFixed(6)}°</span>
          </div>
        `;
        if (alt && alt !== 0) {
          coordsHTML += `
            <div class="gps-coord">
              <span class="gps-coord-label">Altitude</span>
              <span class="gps-coord-value">${alt.toFixed(1)}m</span>
            </div>
          `;
        }

        gpsCard.innerHTML = `
          <div class="card-label technical-explain">Location</div>
          <div class="card-label simple-explain">Photo Location Leak</div>
          <div class="gps-warning" role="alert">
            <span class="gps-warning-icon">⚠</span>
            <div>
              <div class="gps-warning-title">Location Data Found</div>
              <div class="gps-warning-text technical-explain">This file contains embedded GPS coordinates that reveal exactly where the photo was taken. Anyone who receives this file can extract this location data.</div>
              <div class="gps-warning-text simple-explain">This photo has GPS coordinates attached to it. Anyone you send this photo to can see the exact spot where it was taken on a map.</div>
            </div>
          </div>
          <div class="gps-coords">${coordsHTML}</div>
          <div class="map-container" id="map-container" role="region" aria-label="Location map">
            <div id="map" style="width:100%;height:100%;" role="application" aria-label="Interactive map showing GPS coordinates"></div>
          </div>
        `;

        gpsCard._gpsData = { lat, lon };
        cards.push(gpsCard);
      }

      // ============ MAGIC BYTES CARD ============
      const magicCard = document.createElement('div');
      magicCard.className = 'card';
      magicCard.id = 'magic-card';

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
          gridHTML += `
            <div class="hex-cell ${byteClass}${isMagic}" 
                 data-offset="${i}" 
                 data-val="${b}" 
                 data-hex="${hex}"
                 data-ascii="${b >= 32 && b <= 126 ? String.fromCharCode(b) : '·'}">
              ${hex}
            </div>`;
        } else {
          gridHTML += `<div class="hex-cell byte-empty">—</div>`;
        }
      }
      gridHTML += '</div>';

      magicCard.innerHTML = `
        <div class="card-label technical-explain">Magic Bytes & Hex Grid</div>
        <div class="card-label simple-explain">File Digital Fingerprint</div>
        <div class="magic-result">Identified as <strong>${escapeHTML(fileType.name)}</strong></div>
        ${isMismatch ? '<div class="badge-mismatch" style="display:inline-flex;margin-bottom:12px;" role="alert">⚠ File extension .' + escapeHTML(fileExt) + ' does not match true type</div>' : ''}
        ${gridHTML}
        <div class="hex-grid-tooltip" id="hex-tooltip">Hover over a byte to inspect</div>
        <div class="magic-note technical-explain">The first 256 bytes represent the file's binary header. The first 16 bytes (highlighted with a blue outline) contain the magic signature used to identify the format.</div>
        <div class="magic-note simple-explain">Every file starts with a signature sequence of bytes that acts like a fingerprint. This grid shows the first 256 bytes. The first 16 bytes (outlined in blue) show the signature we used to verify what this file actually is.</div>
      `;

      // Attach hover listeners for hex cells
      setTimeout(() => {
        const cells = magicCard.querySelectorAll('.hex-cell[data-offset]');
        const hexTooltip = magicCard.querySelector('#hex-tooltip');
        if (hexTooltip) {
          cells.forEach(cell => {
            cell.setAttribute('tabindex', '0');
            cell.setAttribute('role', 'button');
            cell.setAttribute('aria-label', 'Byte at offset ' + cell.dataset.offset + ': value ' + cell.dataset.val + ' (hex ' + cell.dataset.hex + ')');

            const showInfo = (target) => {
              const offset = parseInt(target.dataset.offset);
              const val = parseInt(target.dataset.val);
              const hex = target.dataset.hex;
              const ascii = target.dataset.ascii;

              const offsetHex = '0x' + offset.toString(16).toUpperCase().padStart(2, '0');
              const binary = val.toString(2).padStart(8, '0');

              hexTooltip.innerHTML = `Offset: <span class="mono">${offset}</span> (${offsetHex}) &nbsp;·&nbsp; Val: <span class="mono" style="color:var(--accent)">${val}</span> (0b${binary}) &nbsp;·&nbsp; Char: <span class="mono">${escapeHTML(ascii)}</span>`;
            };

            cell.addEventListener('mouseenter', (e) => showInfo(e.target));
            cell.addEventListener('focus', (e) => showInfo(e.target));

            cell.addEventListener('mouseleave', () => {
              hexTooltip.textContent = 'Hover over a byte to inspect';
            });
            cell.addEventListener('blur', () => {
              hexTooltip.textContent = 'Hover over a byte to inspect';
            });

            cell.addEventListener('keydown', (e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                const next = cell.nextElementSibling;
                if (next && next.dataset.offset) next.focus();
              }
              if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                const prev = cell.previousElementSibling;
                if (prev && prev.dataset.offset) prev.focus();
              }
            });
          });
        }
      }, 50);

      cards.push(magicCard);

      // ============ EXIF CARD ============
      if (exifData && (exifData.make || exifData.model || exifData.dateTime || exifData.exposureTime || exifData.software || exifData.lensModel)) {
        const exifCard = document.createElement('div');
        exifCard.className = 'card';
        exifCard.id = 'exif-card';

        let gridItems = '';
        if (exifData.make || exifData.model) {
          gridItems += `<div class="exif-item"><span class="exif-item-label">Camera</span><span class="exif-item-value">${escapeHTML((exifData.make || '') + ' ' + (exifData.model || '')).trim()}</span></div>`;
        }
        if (exifData.lensModel) {
          gridItems += `<div class="exif-item"><span class="exif-item-label">Lens</span><span class="exif-item-value">${escapeHTML(exifData.lensModel)}</span></div>`;
        }
        if (exifData.dateTime) {
          gridItems += `<div class="exif-item"><span class="exif-item-label">Captured</span><span class="exif-item-value">${escapeHTML(formatDateTime(exifData.dateTime))}</span></div>`;
        }
        if (exifData.exposureTime || exifData.fNumber || exifData.iso) {
          const parts = [];
          if (exifData.exposureTime) parts.push(formatExposure(exifData.exposureTime));
          if (exifData.fNumber) parts.push(formatFNumber(exifData.fNumber));
          if (exifData.iso) parts.push(formatISO(exifData.iso));
          gridItems += `<div class="exif-item"><span class="exif-item-label">Exposure</span><span class="exif-item-value mono">${escapeHTML(parts.join('  ·  '))}</span></div>`;
        }
        if (exifData.focalLength) {
          gridItems += `<div class="exif-item"><span class="exif-item-label">Focal Length</span><span class="exif-item-value mono">${escapeHTML(formatFocalLength(exifData.focalLength))}</span></div>`;
        }
        if (exifData.software) {
          gridItems += `<div class="exif-item"><span class="exif-item-label">Software</span><span class="exif-item-value">${escapeHTML(exifData.software)}</span></div>`;
        }

        exifCard.innerHTML = `
          <div class="card-label technical-explain">Camera Metadata</div>
          <div class="card-label simple-explain">Photo & Camera Settings</div>
          <div class="exif-grid">${gridItems}</div>
        `;
        cards.push(exifCard);
      }

      // ============ PDF CARD ============
      if (pdfData) {
        const pdfCard = document.createElement('div');
        pdfCard.className = 'card';
        pdfCard.id = 'pdf-card';

        let gridItems = '';
        if (pdfData.title) gridItems += `<div class="pdf-item"><span class="pdf-item-label">Title</span><span class="pdf-item-value">${escapeHTML(pdfData.title)}</span></div>`;
        if (pdfData.author) gridItems += `<div class="pdf-item"><span class="pdf-item-label">Author</span><span class="pdf-item-value">${escapeHTML(pdfData.author)}</span></div>`;
        if (pdfData.creator) gridItems += `<div class="pdf-item"><span class="pdf-item-label">Creator Tool</span><span class="pdf-item-value">${escapeHTML(pdfData.creator)}</span></div>`;
        if (pdfData.producer) gridItems += `<div class="pdf-item"><span class="pdf-item-label">Producer</span><span class="pdf-item-value">${escapeHTML(pdfData.producer)}</span></div>`;
        if (pdfData.creationDate) gridItems += `<div class="pdf-item"><span class="pdf-item-label">Created</span><span class="pdf-item-value">${escapeHTML(pdfData.creationDate)}</span></div>`;
        if (pdfData.modDate) gridItems += `<div class="pdf-item"><span class="pdf-item-label">Modified</span><span class="pdf-item-value">${escapeHTML(pdfData.modDate)}</span></div>`;
        if (pdfData.pageCount > 0) gridItems += `<div class="pdf-item"><span class="pdf-item-label">Pages</span><span class="pdf-item-value" id="pdf-pages" data-target="${pdfData.pageCount}">${pdfData.pageCount}</span></div>`;

        let jsWarning = '';
        if (pdfData.hasJavaScript) {
          jsWarning = `<div class="pdf-js-warning">⚠ This PDF contains embedded JavaScript</div>`;
        }

        let pagesVisualHTML = '';
        if (pdfData.pageCount > 0) {
          pagesVisualHTML = '<div class="pdf-pages-visual">';
          const limit = Math.min(12, pdfData.pageCount);
          for (let p = 1; p <= limit; p++) {
            pagesVisualHTML += `<div class="pdf-page-icon" title="Page ${p}">${p}</div>`;
          }
          if (pdfData.pageCount > 12) {
            pagesVisualHTML += `<div class="pdf-page-icon" title="${pdfData.pageCount - 12} more pages">+${pdfData.pageCount - 12}</div>`;
          }
          pagesVisualHTML += '</div>';
        }

        pdfCard.innerHTML = `
          <div class="card-label technical-explain">Document Metadata</div>
          <div class="card-label simple-explain">Document History & Creator Details</div>
          <div class="pdf-grid">${gridItems}</div>
          ${pagesVisualHTML}
          ${jsWarning}
        `;
        cards.push(pdfCard);
      }

      // ============ ENTROPY CARD ============
      const entropyCard = document.createElement('div');
      entropyCard.className = 'card';
      entropyCard.id = 'entropy-card';

      const canvas = document.createElement('canvas');
      canvas.id = 'entropy-canvas';

      entropyCard.innerHTML = `
        <div class="card-label technical-explain">Byte Distribution</div>
        <div class="card-label simple-explain">Data Density & Patterns</div>
        <div class="entropy-header">
          <span class="entropy-value" id="entropy-value" data-target="${entropyData.entropy}">${entropyData.entropy.toFixed(4)}</span>
          <span class="entropy-unit technical-explain">bits / byte (of 8.0 max)</span>
          <span class="entropy-unit simple-explain">Complexity Score (out of 8.0 max)</span>
        </div>
        <div class="entropy-interpretation technical-explain">${escapeHTML(interpretEntropy(entropyData.entropy))}</div>
        <div class="entropy-interpretation simple-explain">${escapeHTML(interpretEntropySimple(entropyData.entropy))}</div>
        <div class="entropy-canvas-wrap" id="entropy-canvas-wrap"></div>
        <div class="entropy-legend">
          <span>0x00</span>
          <span>0x80</span>
          <span>0xFF</span>
        </div>
      `;

      entropyCard._entropyData = entropyData;
      entropyCard._canvas = canvas;
      cards.push(entropyCard);

      // ============ HIDDEN DATA CARD ============
      if (hiddenData) {
        const hiddenCard = document.createElement('div');
        hiddenCard.className = 'card';
        hiddenCard.id = 'hidden-card';

        let hexPreview = '';
        const previewBytes = hiddenData.preview;
        for (let i = 0; i < previewBytes.length; i += 16) {
          const rowBytes = [];
          for (let j = i; j < i + 16 && j < previewBytes.length; j++) {
            rowBytes.push(toHex(previewBytes[j]));
          }
          hexPreview += rowBytes.join(' ') + '\n';
        }

        hiddenCard.innerHTML = `
          <div class="card-label technical-explain">Hidden Data</div>
          <div class="card-label simple-explain">Secret Appended Content</div>
          <div class="hidden-data-alert">⚠ ${hiddenData.length.toLocaleString()} bytes found after end-of-file marker</div>
          <div class="hidden-data-hex">${escapeHTML(hexPreview.trim())}</div>
          <div class="hidden-data-note technical-explain">Data exists at offset 0x${hiddenData.offset.toString(16).toUpperCase()} beyond the file's official end marker. This could indicate appended data, steganography, or file corruption.</div>
          <div class="hidden-data-note simple-explain">Extra bytes were found attached to the very end of this file (after the stop marker). This is a common way to hide data inside images or documents without breaking them.</div>
        `;
        cards.push(hiddenCard);
      }

      // ============ APPEND CARDS ============
      cards.forEach(card => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(16px)';
        container.appendChild(card);
      });

      return cards;
    }

    // ====================================================
    // ANIMATION ORCHESTRATOR
    // ====================================================
    function animateResultCards(cards) {
      // Staggered card entrance
      gsap.fromTo(cards,
        { opacity: 0, y: 16 },
        {
          opacity: 1,
          y: 0,
          duration: 0.5,
          stagger: 0.08,
          ease: 'power4.out',
          onStart: function() {
            // Animate count-up values
            const entropySummary = document.getElementById('entropy-summary');
            if (entropySummary) {
              const target = parseFloat(entropySummary.dataset.target);
              animateCountUp(entropySummary, target, 4);
            }
          },
          onComplete: () => {
            // Animate entropy chart
            const entropyCard = cards.find(c => c.id === 'entropy-card');
            if (entropyCard && entropyCard._entropyData) {
              const wrap = document.getElementById('entropy-canvas-wrap');
              if (wrap) {
                wrap.appendChild(entropyCard._canvas);
                renderEntropyChart(entropyCard._canvas, entropyCard._entropyData.frequencies, entropyCard._entropyData.maxFreq);
              }
            }
          }
        }
      );

      // Animate entropy card value
      setTimeout(() => {
        const entropyValue = document.getElementById('entropy-value');
        if (entropyValue) {
          const target = parseFloat(entropyValue.dataset.target);
          animateCountUp(entropyValue, target, 4);
        }

        const pdfPages = document.getElementById('pdf-pages');
        if (pdfPages) {
          const target = parseInt(pdfPages.dataset.target);
          animateCountUp(pdfPages, target, 0);
        }
      }, cards.length * 80 + 200);

      // GPS map — delayed reveal
      const gpsCard = cards.find(c => c.id === 'gps-card');
      if (gpsCard && gpsCard._gpsData) {
        const { lat, lon } = gpsCard._gpsData;
        const mapDelay = cards.indexOf(gpsCard) * 80 + 1200;

        setTimeout(() => {
          const mapContainer = document.getElementById('map-container');
          if (!mapContainer) return;

          // Destroy previous map if it exists
          if (leafletMap) {
            leafletMap.remove();
            leafletMap = null;
          }

          // Fix Leaflet's default marker image path resolution for local pages (file://)
          if (typeof L !== 'undefined' && L.Icon && L.Icon.Default) {
            delete L.Icon.Default.prototype._getIconUrl;
            L.Icon.Default.mergeOptions({
              iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
              iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
              shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
            });
          }

          leafletMap = L.map('map', {
            zoomControl: true,
            attributionControl: true
          }).setView([lat, lon], 15);

          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors',
            maxZoom: 19
          }).addTo(leafletMap);

          // Fade in the map container
          mapContainer.classList.add('visible');

          // Drop the marker after the map is visible
          setTimeout(() => {
            const marker = L.marker([lat, lon]).addTo(leafletMap);

            // Animate the marker icon
            setTimeout(() => {
              const icon = marker.getElement ? marker.getElement() : marker._icon;
              if (icon) {
                icon.classList.add('leaflet-marker-drop');
              }
            }, 50);

            // Fix map sizing
            leafletMap.invalidateSize();
          }, 400);
        }, mapDelay);
      }
    }

    // ====================================================
    // MAIN ANALYSIS PIPELINE
    // ====================================================

    // ====================================================
    // HAPTIC SOUND ENGINE (WEB AUDIO API)
    // ====================================================
    let audioCtx = null;
    let soundMuted = true; // default to muted for autoplay policies

    function getAudioContext() {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      return audioCtx;
    }

    function playTone(freq, type, duration, gainStart) {
      if (soundMuted) return;
      try {
        const ctx = getAudioContext();
        const osc = ctx.createOscillator();
        const gainNode = ctx.createGain();
        
        osc.connect(gainNode);
        gainNode.connect(ctx.destination);
        
        osc.type = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        
        gainNode.gain.setValueAtTime(gainStart, ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
        
        osc.start();
        osc.stop(ctx.currentTime + duration);
      } catch (e) {
        console.warn('Audio feedback failed', e);
      }
    }

    function playChime(type) {
      if (soundMuted) return;
      if (type === 'drop') {
        // Soft bass click sweep
        playTone(180, 'sine', 0.12, 0.25);
        setTimeout(() => playTone(120, 'sine', 0.1, 0.2), 30);
      } else if (type === 'click') {
        // High tick
        playTone(800, 'triangle', 0.03, 0.1);
      } else if (type === 'complete') {
        // Apple-style bell sweep C5 -> E5 -> G5
        playTone(523.25, 'sine', 0.4, 0.15); // C5
        setTimeout(() => playTone(659.25, 'sine', 0.4, 0.15), 100); // E5
        setTimeout(() => playTone(783.99, 'sine', 0.5, 0.15), 200); // G5
      } else if (type === 'warning') {
        // Double tone warning chime
        playTone(330, 'triangle', 0.25, 0.2); // E4
        setTimeout(() => playTone(311.13, 'triangle', 0.35, 0.25), 120); // D#4
      }
    }

    // ====================================================
    // REACTIVE DUST PARTICLES BACKDROP
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
      const numParticles = 40;
      
      class Particle {
        constructor() {
          this.x = Math.random() * w;
          this.y = Math.random() * h;
          this.r = Math.random() * 1.5 + 0.5;
          this.vx = Math.random() * 0.4 - 0.2;
          this.vy = Math.random() * 0.4 - 0.2;
          this.alpha = Math.random() * 0.3 + 0.1;
        }
        
        update() {
          this.x += this.vx * forceMultiplier;
          this.y += this.vy * forceMultiplier;
          
          if (this.x < 0) this.x = w;
          if (this.x > w) this.x = 0;
          if (this.y < 0) this.y = h;
          if (this.y > h) this.y = 0;
        }
        
        draw() {
          ctx.beginPath();
          ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 255, 255, ${this.alpha})`;
          ctx.fill();
        }
      }
      
      for (let i = 0; i < numParticles; i++) {
        particles.push(new Particle());
      }
      
      function animate() {
        ctx.clearRect(0, 0, w, h);
        
        // Smoothly interpolate force multiplier
        forceMultiplier += (targetForceMultiplier - forceMultiplier) * 0.08;
        
        particles.forEach(p => {
          p.update();
          p.draw();
        });
        requestAnimationFrame(animate);
      }
      
      animate();
      
      window.addEventListener('resize', () => {
        w = canvas.width = window.innerWidth;
        h = canvas.height = window.innerHeight;
      });
    }

    // ====================================================
    // DEMO SANDBOX MOCK GENERATORS
    // ====================================================
    function createMockPhoto() {
      const parts = [
        0xFF, 0xD8,
        0xFF, 0xE1, 0x00, 0x94,
        0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
        0x49, 0x49, 0x2A, 0x00,
        0x08, 0x00, 0x00, 0x00,
        0x03, 0x00,
        0x0F, 0x01, 0x02, 0x00, 0x06, 0x00, 0x00, 0x00, 0x30, 0x00, 0x00, 0x00,
        0x10, 0x01, 0x02, 0x00, 0x0E, 0x00, 0x00, 0x00, 0x36, 0x00, 0x00, 0x00,
        0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x44, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x41, 0x70, 0x70, 0x6C, 0x65, 0x00,
        0x69, 0x50, 0x68, 0x6F, 0x6E, 0x65, 0x20, 0x31, 0x35, 0x20, 0x50, 0x72, 0x6F, 0x00,
        0x04, 0x00,
        0x01, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00, 0x00, 0x4E, 0x00, 0x00, 0x00,
        0x02, 0x00, 0x05, 0x00, 0x03, 0x00, 0x00, 0x00, 0x7A, 0x00, 0x00, 0x00,
        0x03, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00, 0x00, 0x57, 0x00, 0x00, 0x00,
        0x04, 0x00, 0x05, 0x00, 0x03, 0x00, 0x00, 0x00, 0x92, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        40, 0, 0, 0, 1, 0, 0, 0,
        44, 0, 0, 0, 1, 0, 0, 0,
        0x6C, 0x15, 0, 0, 100, 0, 0, 0,
        73, 0, 0, 0, 1, 0, 0, 0,
        59, 0, 0, 0, 1, 0, 0, 0,
        0x48, 0x03, 0, 0, 100, 0, 0, 0
      ];
      
      const buffer = new Uint8Array(4000);
      buffer.set(parts, 0);
      buffer[148] = 0xFF; buffer[149] = 0xDA; // SOS
      for (let i = 150; i < 3998; i++) {
        buffer[i] = Math.floor(Math.random() * 256);
      }
      buffer[3998] = 0xFF; buffer[3999] = 0xD9; // EOI
      return buffer.buffer;
    }

    function createMockMismatch() {
      const buffer = new Uint8Array(2048);
      buffer[0] = 0x4D; buffer[1] = 0x5A; // MZ header
      for (let i = 2; i < buffer.length; i++) {
        buffer[i] = Math.floor(Math.random() * 256);
      }
      return buffer.buffer;
    }

    function createMockPDF() {
      const header = "%PDF-1.4\n%âãÏÓ\n";
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
      const bytes1 = encoder.encode(header);
      const bytes2 = encoder.encode(body);
      const buffer = new Uint8Array(bytes1.length + bytes2.length);
      buffer.set(bytes1, 0);
      buffer.set(bytes2, bytes1.length);
      return buffer.buffer;
    }

    function triggerDemo(type) {
      let file, buffer;
      if (type === 'photo') {
        buffer = createMockPhoto();
        file = { name: 'travel_photo_ny.jpg', size: buffer.byteLength, arrayBuffer: async () => buffer };
      } else if (type === 'mismatch') {
        buffer = createMockMismatch();
        file = { name: 'invoice_receipt.txt', size: buffer.byteLength, arrayBuffer: async () => buffer };
      } else if (type === 'pdf') {
        buffer = createMockPDF();
        file = { name: 'confidential_budget.pdf', size: buffer.byteLength, arrayBuffer: async () => buffer };
      }
      
      if (file && buffer) {
        runForensicScan(file, buffer);
      }
    }

    // ====================================================
    // FORENSIC SCAN OVERLAY CONTROLLER
    // ====================================================
    async function runForensicScan(file, buffer) {
      if (isAnalyzing) return;
      isAnalyzing = true;

      const overlay = document.getElementById('scanner-overlay');
      const statusText = document.getElementById('scanner-status');
      const progressBar = document.getElementById('scanner-progress');
      const dropzone = document.getElementById('dropzone');
      const results = document.getElementById('results');
      const redrop = document.getElementById('redrop-area');

      // Reset overlay states
      progressBar.style.width = '0%';
      statusText.textContent = 'Reading binary stream...';
      overlay.style.display = 'flex';
      
      // Speed up background particles to simulate computer processing load
      targetForceMultiplier = 15.0;

      // Soft click start
      playChime('click');

      gsap.killTweensOf(overlay);
      gsap.to(overlay, { opacity: 1, duration: 0.3 });

      const steps = [
        { text: 'Reading binary stream...', pct: '25%' },
        { text: 'Analyzing file signature & magic bytes...', pct: '50%' },
        { text: 'Calculating Shannon entropy distribution...', pct: '75%' },
        { text: 'Extracting EXIF metadata directory trees...', pct: '100%' }
      ];

      for (let i = 0; i < steps.length; i++) {
        await new Promise(resolve => setTimeout(resolve, 350));
        statusText.textContent = steps[i].text;
        progressBar.style.width = steps[i].pct;
        playChime('click');
      }

      await new Promise(resolve => setTimeout(resolve, 250));

      // Build cards
      const cards = buildResults(file, buffer);

      // Transition to results screen
      gsap.to(overlay, {
        opacity: 0,
        duration: 0.4,
        onComplete: () => {
          overlay.style.display = 'none';
          dropzone.classList.add('dissolving', 'hidden');
          results.classList.add('visible');
          redrop.style.display = 'flex';

          targetForceMultiplier = 1.0; // Restore particle speed

          // Determine chimes based on warnings
          const hasGPS = cards.some(c => c.id === 'gps-card');

          requestAnimationFrame(() => {
            animateResultCards(cards);
            if (hasGPS) {
              setTimeout(() => {
                playChime('warning');
              }, cards.length * 80 + 350);
            } else {
              setTimeout(() => {
                playChime('complete');
              }, cards.length * 80 + 150);
            }
          });

          isAnalyzing = false;
        }
      });
    }

    // ====================================================
    // MAIN ANALYSIS PIPELINE
    // ====================================================
    async function analyzeFile(file) {
      if (isAnalyzing) return;
      isAnalyzing = true;
      try {
        const buffer = await file.arrayBuffer();
        await runForensicScan(file, buffer);
      } catch (err) {
        console.warn('Forensics: Analysis error', err);
        isAnalyzing = false;

        const dropzone = document.getElementById('dropzone');
        const results = document.getElementById('results');
        const redrop = document.getElementById('redrop-area');
        const container = document.getElementById('results-container');

        // Hide overlay if visible
        const overlay = document.getElementById('scanner-overlay');
        if (overlay) {
          overlay.style.display = 'none';
          overlay.style.opacity = '0';
        }

        container.innerHTML = '';
        const errorCard = document.createElement('div');
        errorCard.className = 'card';
        errorCard.setAttribute('role', 'alert');
        errorCard.innerHTML = `
          <div class="card-label">Analysis Error</div>
          <div style="display:flex;align-items:flex-start;gap:14px;padding:18px 0;">
            <span style="font-size:20px;flex-shrink:0;">⚠</span>
            <div>
              <div style="font-size:15px;font-weight:600;color:var(--warning);margin-bottom:4px;">Could not analyze this file</div>
              <div style="font-size:13px;color:var(--text-secondary);line-height:1.55;">
                The file could not be read or processed. It may be corrupted, too large for browser memory, or an unsupported format.
              </div>
              <button class="results-reset" id="error-reset-btn2" style="margin-top:14px;display:inline-block;">Try another file</button>
            </div>
          </div>
        `;
        container.appendChild(errorCard);
        dropzone.classList.add('hidden');
        results.classList.add('visible');
        redrop.style.display = 'flex';
        targetForceMultiplier = 1.0;

        setTimeout(() => {
          const errReset = document.getElementById('error-reset-btn2');
          if (errReset) errReset.addEventListener('click', () => resetToDropzone());
        }, 50);
      }
    }

    function resetToDropzone() {
      playChime('click');
      const dropzone = document.getElementById('dropzone');
      const results = document.getElementById('results');
      const redrop = document.getElementById('redrop-area');
      const container = document.getElementById('results-container');

      // Destroy map
      if (leafletMap) {
        leafletMap.remove();
        leafletMap = null;
      }

      // Reset UI
      results.classList.remove('visible');
      redrop.style.display = 'none';
      container.innerHTML = '';

      dropzone.classList.remove('dissolving', 'hidden');
      isAnalyzing = false;
    }

    function reAnalyzeFile(file) {
      const container = document.getElementById('results-container');

      if (leafletMap) {
        leafletMap.remove();
        leafletMap = null;
      }

      // Quick fade out existing cards, then perform scan
      const existingCards = container.querySelectorAll('.card');
      if (existingCards.length > 0) {
        gsap.to(existingCards, {
          opacity: 0,
          y: -8,
          duration: 0.2,
          stagger: 0.03,
          onComplete: async () => {
            container.innerHTML = '';
            try {
              const buffer = await file.arrayBuffer();
              await runForensicScan(file, buffer);
            } catch (e) {
              console.warn(e);
            }
          }
        });
      } else {
        (async () => {
          container.innerHTML = '';
          try {
            const buffer = await file.arrayBuffer();
            await runForensicScan(file, buffer);
          } catch (e) {
            console.warn(e);
          }
        })();
      }
    }

    // ====================================================
    // EVENT HANDLERS
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

      // Init particles (skip if reduced motion)
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        initParticles();
      }

      // === Sound toggle ===
      soundBtn.addEventListener('click', () => {
        soundMuted = !soundMuted;
        if (!soundMuted) {
          soundBtn.textContent = '🔊';
          soundBtn.title = 'Sound On';
          soundBtn.setAttribute('aria-label', 'Sound is on. Click to mute.');
          getAudioContext();
          playTone(600, 'sine', 0.1, 0.15);
        } else {
          soundBtn.textContent = '🔇';
          soundBtn.title = 'Sound Muted';
          soundBtn.setAttribute('aria-label', 'Sound is off. Click to enable sound.');
        }
      });

      // === Mode Toggle (Expert vs Simple) ===
      btnExpert.addEventListener('click', () => {
        playChime('click');
        btnExpert.classList.add('active');
        btnExpert.setAttribute('aria-checked', 'true');
        btnSimple.classList.remove('active');
        btnSimple.setAttribute('aria-checked', 'false');
        results.classList.remove('mode-simple');
      });

      btnSimple.addEventListener('click', () => {
        playChime('click');
        btnSimple.classList.add('active');
        btnSimple.setAttribute('aria-checked', 'true');
        btnExpert.classList.remove('active');
        btnExpert.setAttribute('aria-checked', 'false');
        results.classList.add('mode-simple');
      });

      // === Click-to-browse file loading ===
      frame.addEventListener('click', () => {
        playChime('click');
        fileInput.click();
      });

      frame.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          playChime('click');
          fileInput.click();
        }
      });

      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          playChime('drop');
          analyzeFile(file);
        }
        fileInput.value = '';
      });

      // === Live Demo Sandbox Buttons ===
      const demoBtns = document.querySelectorAll('.demo-btn');
      demoBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation(); // Avoid triggering frame click
          const type = btn.dataset.demo;
          triggerDemo(type);
        });
      });

      // === Initial drop zone ===
      dropzone.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter++;
        frame.classList.add('dragover');
        targetForceMultiplier = 8.0;
      });

      dropzone.addEventListener('dragleave', (e) => {
        e.stopPropagation();
        dragCounter--;
        if (dragCounter <= 0) {
          dragCounter = 0;
          frame.classList.remove('dragover');
          targetForceMultiplier = 1.0;
        }
      });

      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });

      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter = 0;
        frame.classList.remove('dragover');
        targetForceMultiplier = 1.0;

        const file = e.dataTransfer.files[0];
        if (file) {
          playChime('drop');
          analyzeFile(file);
        }
      });

      // === Body-level drop (for re-analysis) ===
      let bodyDragCounter = 0;

      document.body.addEventListener('dragenter', (e) => {
        e.preventDefault();
        bodyDragCounter++;
        targetForceMultiplier = 8.0;
        if (!dropzone.classList.contains('hidden')) return;
        redrop.classList.add('dragover');
      });

      document.body.addEventListener('dragleave', (e) => {
        bodyDragCounter--;
        if (bodyDragCounter <= 0) {
          bodyDragCounter = 0;
          targetForceMultiplier = 1.0;
          redrop.classList.remove('dragover');
        }
      });

      document.body.addEventListener('dragover', (e) => {
        e.preventDefault();
      });

      document.body.addEventListener('drop', (e) => {
        e.preventDefault();
        bodyDragCounter = 0;
        targetForceMultiplier = 1.0;
        redrop.classList.remove('dragover');

        if (dropzone.classList.contains('hidden')) {
          const file = e.dataTransfer.files[0];
          if (file && !isAnalyzing) {
            playChime('drop');
            reAnalyzeFile(file);
          }
        }
      });

      // === Reset button ===
      resetBtn.addEventListener('click', () => {
        resetToDropzone();
      });
    }

    // Start
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }

  })();
