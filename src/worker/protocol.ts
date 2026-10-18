import type { Report } from '../core/types';
import type { Progress } from '../core/analyze';

export type Request =
  | { id: number; type: 'analyze'; file: Blob; name: string; lastModified?: number }
  | { id: number; type: 'sanitize'; file: Blob; name: string }
  | { id: number; type: 'bitplane'; file: Blob; channel: number; bit: number }
  | { id: number; type: 'ela'; file: Blob; quality: number }
  | { id: number; type: 'thumbnail'; file: Blob; offset: number; length: number };

export type Response =
  | { id: number; type: 'progress'; progress: Progress }
  | { id: number; type: 'report'; report: Report }
  | { id: number; type: 'sanitized'; data: Uint8Array; actions: string[]; removed: number; after: Report }
  | { id: number; type: 'image'; width: number; height: number; pixels: Uint8ClampedArray; meta?: Record<string, number | boolean> }
  | { id: number; type: 'error'; message: string };
