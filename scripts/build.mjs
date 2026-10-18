// Build: bundles the UI and the analysis worker with esbuild, then copies
// static files. The output in dist/ has no runtime dependencies.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const serve = process.argv.includes('--serve');
const outdir = 'dist';

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp('public', outdir, { recursive: true });
await cp('samples', `${outdir}/samples`, { recursive: true });

const common = {
  bundle: true,
  format: 'esm',
  target: ['es2022', 'chrome110', 'firefox115', 'safari16.4'],
  sourcemap: true,
  minify: !serve,
  legalComments: 'none',
  logLevel: 'info',
};

const version = Date.now().toString(36);
const options = {
  ...common,
  define: { __BUILD__: JSON.stringify(version) },
  entryPoints: { app: 'src/main.ts', worker: 'src/worker/index.ts', sw: 'src/sw.ts' },
  outdir,
};

if (serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: outdir, port: 3000 });
  console.log(`Serving http://localhost:${port}`);
} else {
  await esbuild.build(options);
}
