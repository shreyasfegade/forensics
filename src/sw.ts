/// <reference lib="webworker" />
// Offline support: precache the app shell and samples, serve them cache-first.
// The cache name changes with every build, so a new deploy replaces the old cache.
declare const self: ServiceWorkerGlobalScope;
export {};

declare const __BUILD__: string;
const VERSION = __BUILD__;
const CACHE = `forensics-${VERSION}`;
const ASSETS = ['./', 'index.html', 'app.js', 'worker.js', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'samples/harbor_cropped.jpg', 'samples/paris_holiday.jpg', 'samples/IMG_4127.MOV', 'samples/offer_letter_final.docx', 'samples/invoice_receipt.txt',
  'samples/mountains.png', 'samples/contract_v3.pdf', 'samples/cat_meme.jpg', 'samples/vacation_safe.png'];

self.addEventListener('install', (e: ExtendableEvent) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e: ExtendableEvent) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('forensics-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e: FetchEvent) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit ?? fetch(e.request)));
});
