// Builds the evidence samples in samples/. Real JPEGs are rendered with
// headless Chromium's canvas encoder; metadata is then spliced in with the
// project's own byte writers (src/samples/builders.ts). Output is deterministic.
import * as esbuild from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';

await mkdir('.cache', { recursive: true });
await esbuild.build({ entryPoints: ['scripts/samples.ts'], bundle: true, platform: 'node', format: 'esm', outfile: '.cache/samples.mjs', external: ['@playwright/test'], logLevel: 'warning' });
const mod = await import(new URL('../.cache/samples.mjs', import.meta.url));
await mod.main();
await rm('.cache/samples.mjs');
