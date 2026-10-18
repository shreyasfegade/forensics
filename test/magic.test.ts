import { identify, isMismatch, extensionOf } from '../src/core/magic';
import { latin1 } from '../src/util/bytes';

describe('identify', () => {
  const cases: [number[] | string, string][] = [
    [[0xff, 0xd8, 0xff, 0xe0], 'jpg'],
    [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'png'],
    ['%PDF-1.7', 'pdf'],
    [[0x4d, 0x5a, 0x90, 0], 'exe'],
    [[0x50, 0x4b, 0x03, 0x04], 'zip'],
    ['\0\0\0\x18ftypheic\0\0\0\0', 'heic'],
    ['\0\0\0\x14ftypqt  \0\0\0\0', 'mov'],
    ['\0\0\0\x18ftypisom\0\0\0\0', 'mp4'],
    ['RIFF\0\0\0\0WEBPVP8 ', 'webp'],
    ['II*\0\x10\0\0\0CR', 'cr2'],
    ['II*\0\x08\0\0\0', 'tiff'],
    ['ID3\x04\0', 'mp3'],
    ['{"a": 1}', 'json'],
    ['#!/bin/sh\necho', 'sh'],
    ['hello world, this is text', 'txt'],
  ];
  for (const [sig, ext] of cases) {
    it(ext, () => {
      const bytes = typeof sig === 'string' ? latin1(sig.padEnd(32, ' ')) : Uint8Array.from([...sig, ...new Array(28).fill(0)]);
      expect(identify(bytes).ext).toBe(ext);
    });
  }
});

describe('isMismatch', () => {
  it('accepts aliases and flags disguises', () => {
    expect(isMismatch('jpeg', { name: '', ext: 'jpg', category: 'image' })).toBe(false);
    expect(isMismatch('docx', { name: '', ext: 'zip', category: 'archive' })).toBe(false);
    expect(isMismatch('dng', { name: '', ext: 'tiff', category: 'image' })).toBe(false);
    expect(isMismatch('txt', { name: '', ext: 'exe', category: 'executable' })).toBe(true);
    expect(isMismatch('jpg', { name: '', ext: 'png', category: 'image' })).toBe(true);
    expect(isMismatch('', { name: '', ext: 'png', category: 'image' })).toBe(false);
  });
  it('extension parsing ignores dotfiles', () => {
    expect(extensionOf('.bashrc')).toBe('');
    expect(extensionOf('a.tar.GZ')).toBe('gz');
  });
});
