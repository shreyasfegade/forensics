import { writeFile, mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { buildDocx, buildMov, buildPdf, buildPe, buildTiff, embedLsb, encodePng, gpsIfd, jpegWith, landscape } from '../src/samples/builders';
import { latin1 } from '../src/util/bytes';

type Scene = 'harbor' | 'paris' | 'cat';

// Drawn in the page. Deterministic (seeded) so samples rebuild identically.
const draw = (scene: Scene, w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  let seed = 42;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  if (scene === 'cat') {
    const bg = g.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, '#d9c6a5'); bg.addColorStop(1, '#a88f6a');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.fillStyle = '#3b332c';
    g.beginPath(); g.ellipse(w / 2, h * 0.62, w * 0.22, h * 0.24, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(w / 2, h * 0.36, w * 0.14, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(w / 2 - w * 0.13, h * 0.3); g.lineTo(w / 2 - w * 0.09, h * 0.14); g.lineTo(w / 2 - w * 0.03, h * 0.25); g.fill();
    g.beginPath(); g.moveTo(w / 2 + w * 0.13, h * 0.3); g.lineTo(w / 2 + w * 0.09, h * 0.14); g.lineTo(w / 2 + w * 0.03, h * 0.25); g.fill();
    g.fillStyle = '#d6c14a'; g.beginPath(); g.arc(w / 2 - w * 0.05, h * 0.35, w * 0.018, 0, 7); g.arc(w / 2 + w * 0.05, h * 0.35, w * 0.018, 0, 7); g.fill();
    g.fillStyle = '#fff'; g.font = `bold ${Math.round(h * 0.09)}px Impact, sans-serif`; g.textAlign = 'center';
    g.strokeStyle = '#000'; g.lineWidth = h * 0.012;
    g.strokeText('I CAN HAS PRIVACY', w / 2, h * 0.94); g.fillText('I CAN HAS PRIVACY', w / 2, h * 0.94);
  } else {
    const sky = g.createLinearGradient(0, 0, 0, h * 0.6);
    if (scene === 'harbor') { sky.addColorStop(0, '#5b7da6'); sky.addColorStop(1, '#f0b980'); }
    else { sky.addColorStop(0, '#8fb3d9'); sky.addColorStop(1, '#e8e2d4'); }
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    if (scene === 'harbor') {
      g.fillStyle = '#f7d9a0'; g.beginPath(); g.arc(w * 0.78, h * 0.44, h * 0.07, 0, 7); g.fill();
      const sea = g.createLinearGradient(0, h * 0.55, 0, h); sea.addColorStop(0, '#41607e'); sea.addColorStop(1, '#1d2f40');
      g.fillStyle = sea; g.fillRect(0, h * 0.55, w, h * 0.45);
      for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(255,220,170,${rnd() * 0.25})`; g.fillRect(w * 0.45 + rnd() * w * 0.55, h * 0.56 + rnd() * h * 0.4, rnd() * 40, 2); }
      // Houses along the quay on the left: this is the part that gets cropped out.
      const colors = ['#c9b79c', '#b5654a', '#e2d3b5', '#7d8c7a'];
      for (let i = 0; i < 4; i++) {
        const x = w * 0.02 + i * w * 0.095, bw = w * 0.09, bh = h * (0.28 + (i % 2) * 0.06);
        g.fillStyle = colors[i]; g.fillRect(x, h * 0.55 - bh, bw, bh);
        g.fillStyle = '#3a2f28'; g.beginPath(); g.moveTo(x - 6, h * 0.55 - bh); g.lineTo(x + bw / 2, h * 0.55 - bh - h * 0.06); g.lineTo(x + bw + 6, h * 0.55 - bh); g.fill();
        g.fillStyle = '#2a3440';
        for (let r = 0; r < 3; r++) for (let k = 0; k < 2; k++) g.fillRect(x + bw * 0.18 + k * bw * 0.42, h * 0.55 - bh + 20 + r * bh * 0.26, bw * 0.22, bh * 0.14);
      }
      g.fillStyle = '#1f4f7a'; g.fillRect(w * 0.12, h * 0.2, w * 0.17, h * 0.07);
      g.fillStyle = '#fff'; g.font = `bold ${Math.round(h * 0.04)}px sans-serif`; g.textAlign = 'center';
      g.fillText('14 HARBOUR ROW', w * 0.205, h * 0.25);
      g.fillStyle = '#20262b'; g.beginPath(); g.ellipse(w * 0.66, h * 0.62, w * 0.012, h * 0.05, 0, 0, 7); g.fill();
      g.beginPath(); g.arc(w * 0.66, h * 0.555, w * 0.009, 0, 7); g.fill();
    } else {
      g.fillStyle = '#6f7d8c';
      for (let i = 0; i < 40; i++) { const bw = 20 + rnd() * 60, bh = 40 + rnd() * h * 0.25; g.fillRect(rnd() * w, h * 0.72 - bh, bw, bh); }
      g.strokeStyle = '#3d4650'; g.lineWidth = 3;
      const tx = w * 0.62, base = h * 0.72, top = h * 0.1;
      g.beginPath(); g.moveTo(tx - w * 0.09, base); g.quadraticCurveTo(tx - w * 0.015, h * 0.45, tx - 3, top); g.lineTo(tx + 3, top); g.quadraticCurveTo(tx + w * 0.015, h * 0.45, tx + w * 0.09, base); g.closePath();
      g.fillStyle = '#4b5560'; g.fill();
      for (let k = 0; k < 18; k++) { const y = base - (base - top) * (k / 18); const half = (w * 0.09) * Math.pow(1 - k / 18, 1.8) + 3; g.beginPath(); g.moveTo(tx - half, y); g.lineTo(tx + half, y - 12); g.moveTo(tx + half, y); g.lineTo(tx - half, y - 12); g.stroke(); }
      g.fillStyle = '#e8e2d4'; g.beginPath(); g.ellipse(tx, base - 4, w * 0.04, h * 0.06, 0, Math.PI, 0); g.fill();
      g.fillStyle = '#5d6b49'; g.fillRect(0, h * 0.72, w, h * 0.28);
      for (let i = 0; i < 3000; i++) { g.fillStyle = `rgba(30,50,20,${rnd() * 0.3})`; g.fillRect(rnd() * w, h * 0.72 + rnd() * h * 0.28, 3, 3); }
    }
  }
  // Sensor-like grain so the JPEG looks photographic.
  const img = g.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) { const n = (rnd() - 0.5) * 10; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
  g.putImageData(img, 0, 0);
  return c;
};

async function render(page: import('@playwright/test').Page, scene: Scene, w: number, h: number, opts: { crop?: [number, number, number, number]; thumb?: [number, number]; q?: number } = {}): Promise<{ main: Uint8Array; thumb?: Uint8Array }> {
  const res = await page.evaluate(async ({ src, scene, w, h, opts }) => {
    const drawFn = new Function(`return (${src})`)() as typeof draw;
    const full = drawFn(scene, w, h);
    const toBytes = async (c: HTMLCanvasElement, q: number) => Array.from(new Uint8Array(await (await new Promise<Blob>(r => c.toBlob(b => r(b!), 'image/jpeg', q))).arrayBuffer()));
    let main = full;
    if (opts.crop) {
      const [x, y, cw, ch] = opts.crop;
      main = document.createElement('canvas'); main.width = cw; main.height = ch;
      main.getContext('2d')!.drawImage(full, x, y, cw, ch, 0, 0, cw, ch);
    }
    let thumb: number[] | undefined;
    if (opts.thumb) {
      const t = document.createElement('canvas'); t.width = opts.thumb[0]; t.height = opts.thumb[1];
      t.getContext('2d')!.drawImage(full, 0, 0, opts.thumb[0], opts.thumb[1]);
      thumb = await toBytes(t, 0.7);
    }
    return { main: await toBytes(main, opts.q ?? 0.86), thumb };
  }, { src: draw.toString(), scene, w, h, opts });
  return { main: Uint8Array.from(res.main), thumb: res.thumb ? Uint8Array.from(res.thumb) : undefined };
}

const S = (s: string) => ({ type: 2 as const, value: s });
const R = (n: number, d = 1) => ({ type: 5 as const, value: [[n, d]] as [number, number][] });

export async function main(): Promise<void> {
  await mkdir('samples', { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const out: Record<string, Uint8Array> = {};

  // 1. Thumbnail mismatch: cropped photo, uncropped preview.
  {
    const { main, thumb } = await render(page, 'harbor', 1500, 1000, { crop: [600, 0, 900, 1000], thumb: [160, 107] });
    const exif = buildTiff({
      ifd0: { 0x010f: S('Canon'), 0x0110: S('Canon EOS R6m2'), 0x0131: S('Adobe Photoshop Lightroom Classic 13.2 (Windows)'), 0x0132: S('2026:07:21 21:14:09'), 0x0112: { type: 3, value: [1] } },
      exif: { 0x829a: R(1, 160), 0x829d: R(56, 10), 0x8827: { type: 3, value: [400] }, 0x9003: S('2026:07:19 20:47:31'), 0x9011: S('+01:00'), 0x920a: R(35), 0xa434: S('RF24-105mm F4 L IS USM'), 0xa431: S('112033004517') },
      thumbnail: thumb,
    });
    out['harbor_cropped.jpg'] = jpegWith(main, { exif });
  }
  // 2. GPS photo.
  {
    const { main } = await render(page, 'paris', 1200, 900);
    const exif = buildTiff({
      ifd0: { 0x010f: S('Apple'), 0x0110: S('iPhone 15 Pro'), 0x0131: S('17.5.1'), 0x0112: { type: 3, value: [1] }, 0x0132: S('2026:06:14 19:02:11') },
      exif: { 0x829a: R(1, 1200), 0x829d: R(178, 100), 0x8827: { type: 3, value: [64] }, 0x9003: S('2026:06:14 19:02:11'), 0x9011: S('+02:00'), 0xa433: S('Apple'), 0xa434: S('iPhone 15 Pro back triple camera 6.765mm f/1.78') },
      gps: gpsIfd(48.85837, 2.294481, 41.2),
    });
    out['paris_holiday.jpg'] = jpegWith(main, { exif });
  }
  // 3. Appended payload.
  {
    const { main } = await render(page, 'cat', 600, 600);
    out['cat_meme.jpg'] = jpegWith(main, { trailing: latin1('\n--BEGIN NOTE--\nuser=admin password=hunter2\nmeet at pier 9, 23:00. bring the drive.\n--END NOTE--\n') });
  }
  await browser.close();

  // 4. Phone video with location.
  out['IMG_4127.MOV'] = buildMov({ iso6709: '+51.5007-000.1246+011.000/', make: 'Apple', model: 'iPhone 14', software: '17.5.1', created: '2026-08-03T18:22:40+0100' });

  // 5. DOCX with tracked changes and a comment.
  out['offer_letter_final.docx'] = buildDocx({
    creator: 'Maria Chen', lastModifiedBy: 'Tom Becker', revision: 14, company: 'Northwind Recruiting', totalTime: 312,
    template: 'C:\\Users\\tbecker\\AppData\\Roaming\\Microsoft\\Templates\\Offer.dotm',
    paragraphs: [
      'Dear Ms. Alvarez,',
      'We are pleased to offer you the position of Senior Analyst, starting 1 November 2026.',
      { before: 'Your base salary will be ', del: '$140,000 (approved band up to $150,000)', ins: '$120,000', author: 'Tom Becker', date: '2026-09-28T16:02:00Z', after: ' per year.' },
      { before: 'You will report to ', del: 'Daniel Ross, who is leaving in December', ins: 'the Head of Analytics', author: 'Tom Becker', date: '2026-09-28T16:05:00Z', after: '.' },
      'Please confirm your acceptance by 10 October.',
    ],
    comments: [{ author: 'Maria Chen', date: '2026-09-27T10:11:00Z', text: 'We can go to 150 if she pushes back. Do not put that in writing.' }],
  });

  // 6. Disguised executable.
  out['invoice_receipt.txt'] = buildPe({ pdbPath: 'C:\\Users\\dkowalski\\source\\repos\\InvoiceViewer\\x64\\Release\\updater.pdb', timestamp: Date.UTC(2026, 3, 9, 14, 5, 22) / 1000, planted: 'http://cdn-update.example-invoices.net/beacon?id=%s' });

  // 7. LSB steganography (message in the low bits of the first ~55% of samples).
  {
    const W = 400, H = 260;
    const px = landscape(W, H, 23);
    const note = 'The meeting moved to Thursday. Use the north entrance. Burn this after reading. ';
    const msg = new TextEncoder().encode(note.repeat(Math.ceil((W * H * 3 * 0.55) / 8 / note.length))).slice(0, Math.floor((W * H * 3 * 0.55) / 8));
    out['mountains.png'] = await encodePng(W, H, embedLsb(px, msg));
    out['vacation_safe.png'] = await encodePng(W, H, landscape(W, H, 31));
  }

  // 8. PDF with an earlier saved version and an invisible text layer.
  out['contract_v3.pdf'] = buildPdf([
    { info: { Title: 'Supply agreement - DRAFT', Author: 'Alex Kim', Creator: 'Microsoft Word for Microsoft 365', Producer: 'macOS Version 14.5 Quartz PDFContext', CreationDate: "D:20260901093000+02'00'", ModDate: "D:20260901093000+02'00'" }, pageText: 'Unit price: 48.00 EUR. Penalty clause: none.' },
    { info: { Title: 'Supply agreement', Author: 'Alex Kim', Creator: 'Microsoft Word for Microsoft 365', Producer: 'Adobe Acrobat Pro (64-bit) 24.2', CreationDate: "D:20260901093000+02'00'", ModDate: "D:20260914170512+02'00'" }, pageText: 'Unit price: 52.00 EUR. Penalty clause: 2% per week.', invisible: 'internal: walk-away price 45 EUR' },
  ]);

  for (const [name, data] of Object.entries(out)) {
    await writeFile(`samples/${name}`, data);
    console.log(`samples/${name}  ${data.length.toLocaleString()} B`);
  }
}
