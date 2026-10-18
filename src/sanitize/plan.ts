// What the sanitizer would do for a given file, stated before it runs.
import type { FileType, Finding, ParseResult, SanitizePlan } from '../core/types';

export function sanitizePlan(type: FileType, parsed: ParseResult, findings: Finding[]): SanitizePlan {
  const fixable = findings.filter(f => f.fixable);
  const has = (tag: Finding['tag']) => findings.some(f => f.tag === tag);
  switch (type.ext) {
    case 'jpg':
      return {
        supported: true, method: 'Removes metadata segments. The compressed image data is copied byte for byte, with no re-encode.',
        removes: ['EXIF (GPS, device, serials, timestamps, thumbnail)', 'XMP and edit history', 'IPTC / Photoshop blocks', 'Comment segments', 'Data after the end-of-image marker', 'Vendor APP segments (MPF and maker data)'],
        keeps: ['Image data, quantisation and Huffman tables', 'ICC colour profile', 'JFIF and Adobe colour markers', 'Orientation (rewritten as a one-tag EXIF block)'],
      };
    case 'png':
      return {
        supported: true, method: 'Drops ancillary chunks. Pixel data (IDAT) is copied untouched.',
        removes: ['tEXt / zTXt / iTXt text and XMP', 'eXIf block', 'tIME timestamp', 'Unknown private chunks', 'Data after IEND'],
        keeps: ['Pixels and palette', 'Transparency', 'Gamma, chromaticity, sRGB and ICC colour chunks', 'Pixel density', 'Animation chunks'],
      };
    case 'webp':
      return { supported: true, method: 'Drops the EXIF and XMP chunks and updates the header flags. Image chunks are untouched.', removes: ['EXIF chunk', 'XMP chunk'], keeps: ['Image data', 'ICC profile', 'Animation frames'] };
    case 'docx': case 'xlsx': case 'pptx':
      return {
        supported: true, method: 'Rewrites document properties inside the ZIP. Every other part is copied with its original compressed bytes.',
        removes: ['Author, last-modified-by, company, manager', 'Revision count, editing time, template path', 'Created / modified / printed dates', 'Custom properties', 'Saved preview thumbnail', 'ZIP entry timestamps'],
        keeps: ['All document content and formatting'],
        reason: has('COMMENT') || has('HISTORY') ? 'Comments, tracked changes, speaker notes and hidden text are part of the content and are NOT removed. Accept or reject them in the Office app first.' : undefined,
      };
    case 'pdf': {
      const inObjStm = parsed.notes?.some(n => n.includes('object stream'));
      return {
        supported: true, method: 'Blanks metadata values in place with same-length padding, so internal byte offsets (xref) stay valid. Applied to every saved revision.',
        removes: ['Author, Creator, Producer, Company, Keywords', 'Creation and modification dates', 'Uncompressed XMP packet'],
        keeps: ['Pages and content', 'Title and Subject', 'Earlier revisions\' page content (to discard old versions, "Print to PDF" to flatten)'],
        reason: inObjStm ? 'Metadata stored inside compressed object streams can\'t be blanked in place and will remain.' : undefined,
      };
    }
    case 'mp4': case 'mov': case '3gp': case 'm4a': case 'heic': case 'heif': case 'avif': {
      const n = (parsed as ParseResult & { scrub?: unknown[] }).scrub?.length ?? 0;
      if (!n) return { supported: true, method: 'No location or identity boxes were found to remove.', removes: [], keeps: ['Everything'] };
      return {
        supported: true, method: type.category === 'image' ? 'Zeroes the EXIF and XMP items in place. Item offsets and image data are unchanged.' : 'Turns location and identity atoms into "free" padding of the same size and zeroes their contents, so no offsets move.',
        removes: type.category === 'image' ? ['EXIF item (GPS, device, timestamps)', 'XMP item'] : ['©xyz GPS atom', 'Apple / Android location keys', 'Author and comment atoms'],
        keeps: ['Video, audio and image data', 'Device make/model keys (in videos)'],
      };
    }
    case 'tiff':
      return { supported: true, method: 'Blanks sensitive TIFF tag values in place. Image strips are untouched.', removes: ['GPS values', 'Artist, copyright, owner, host computer', 'Serial numbers and unique IDs', 'Comments'], keeps: ['Image data', 'Camera make/model and capture settings'] };
  }
  if (!fixable.length) return { supported: false, method: '', removes: [], keeps: [], reason: `Nothing to clean for ${type.name} files.` };
  return { supported: false, method: '', removes: [], keeps: [], reason: `Cleaning isn't available for ${type.name} files yet. Findings are reported only.` };
}
