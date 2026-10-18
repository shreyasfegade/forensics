// Rasterises public/icons/icon.svg to the PNG sizes the manifest lists.
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

const svg = await readFile('public/icons/icon.svg', 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [192, 512]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}">`);
  await writeFile(`public/icons/icon-${size}.png`, await page.screenshot({ omitBackground: true }));
}
await browser.close();
