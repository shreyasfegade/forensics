import { test, expect, type Page } from '@playwright/test';

// Fail any test that makes a network request off this origin.
async function guard(page: Page): Promise<string[]> {
  const external: string[] = [];
  page.on('request', r => { const u = r.url(); if (!u.startsWith('http://localhost') && !u.startsWith('blob:') && !u.startsWith('data:')) external.push(u); });
  return external;
}

async function openSample(page: Page, name: string) {
  await page.goto(`/#sample=${name}`);
  await expect(page.locator('.case-head')).toBeVisible({ timeout: 30_000 });
}

test('intake lists every evidence sample', async ({ page }) => {
  const external = await guard(page);
  await page.goto('/');
  await expect(page.locator('.ledger tbody tr')).toHaveCount(9);
  expect(external).toEqual([]);
});

test('thumbnail mismatch is detected in the browser', async ({ page }) => {
  const external = await guard(page);
  await openSample(page, 'harbor_cropped.jpg');
  await expect(page.locator('.stamp')).toHaveText(/exposed/i);
  await expect(page.locator('#f-thumbnail h3')).toHaveText('Thumbnail shows a different picture');
  await expect(page.locator('.plate-compare canvas')).toBeVisible();
  expect(external).toEqual([]);
});

test('GPS photo: redacted until revealed, map only on request', async ({ page }) => {
  const external = await guard(page);
  await openSample(page, 'paris_holiday.jpg');
  const bar = page.locator('.record-table .redact').first();
  await expect(bar).toHaveAttribute('aria-pressed', 'false');
  await bar.click();
  await expect(bar).toHaveAttribute('aria-pressed', 'true');
  expect(external).toEqual([]);
});

test('finding evidence jumps to the bytes', async ({ page }) => {
  await openSample(page, 'cat_meme.jpg');
  await page.locator('#f-trailing .evidence-link').first().click();
  await expect(page.locator('.hex-rows .hb.sel').first()).toBeVisible();
  await expect(page.locator('.hex-status')).toContainText('selected');
});

test('clean a copy removes GPS and reports the diff', async ({ page }) => {
  await openSample(page, 'paris_holiday.jpg');
  await page.locator('#clean .btn-primary').first().click();
  await expect(page.locator('.diff')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.diff tr.gone', { hasText: 'Exact location embedded' })).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.clean-result .btn-primary').click()]);
  expect(dl.suggestedFilename()).toBe('paris_holiday.clean.jpg');
});

test('steganalysis and bit planes on the PNG sample', async ({ page }) => {
  await openSample(page, 'mountains.png');
  await expect(page.locator('#f-stego')).toBeVisible();
  await expect(page.locator('.plane-view canvas')).toBeVisible({ timeout: 20_000 });
});

test('DOCX tracked changes are recovered', async ({ page }) => {
  await openSample(page, 'offer_letter_final.docx');
  await expect(page.locator('#f-office-changes h3')).toHaveText('Deleted text is still in the file');
});

test('ELA renders for JPEG', async ({ page }) => {
  await openSample(page, 'paris_holiday.jpg');
  await page.getByRole('button', { name: 'Run error level analysis' }).click();
  await expect(page.locator('.plate .plane-view canvas')).toBeVisible({ timeout: 20_000 });
});

test('batch: several files examined and cleaned into a ZIP', async ({ page }) => {
  await page.goto('/');
  const names = ['paris_holiday.jpg', 'offer_letter_final.docx', 'vacation_safe.png'];
  const files = await Promise.all(names.map(async n => ({ name: n, mimeType: 'application/octet-stream', buffer: Buffer.from(await (await page.request.get(`/samples/${n}`)).body()) })));
  await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(files);
  await expect(page.locator('.batch-table tbody tr .stamp-mini')).toHaveCount(3, { timeout: 30_000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Clean all and download ZIP' }).click()]);
  expect(dl.suggestedFilename()).toBe('forensics-clean.zip');
});

test('a large file stays responsive while it is analysed', async ({ page }) => {
  await page.goto('/');
  // 64 MB of pseudo-random bytes built in the page, analysed by the worker.
  const longTasks = await page.evaluate(async () => {
    const size = 64 * 1024 * 1024;
    const buf = new Uint8Array(size);
    for (let o = 0; o < size; o += 65536) crypto.getRandomValues(buf.subarray(o, o + 65536));
    const file = new File([buf], 'random.bin');
    const obs: number[] = [];
    new PerformanceObserver(l => l.getEntries().forEach(e => obs.push(e.duration))).observe({ type: 'longtask', buffered: false });
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    await new Promise<void>(r => { const t = setInterval(() => { if (document.querySelector('.case-head')) { clearInterval(t); r(); } }, 100); });
    return obs;
  });
  await expect(page.locator('.case-meta')).toContainText('64.00 MB');
  // Rendering the case can take one long task; analysis itself must not block.
  expect(longTasks.filter(d => d > 200).length).toBeLessThanOrEqual(2);
});

test('plain mode hides the byte viewer; mobile has no horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSample(page, 'paris_holiday.jpg');
  await page.getByRole('radio', { name: 'Plain' }).click();
  await expect(page.locator('.case-index a[href="#bytes"]')).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
