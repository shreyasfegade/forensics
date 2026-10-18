// Location plate. OpenStreetMap tiles load only after an explicit click,
// which is the app's single optional network request.
import { h } from '../dom';
import type { GPSFix } from '../../core/types';

function project(lat: number, lon: number, z: number) {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * n * 256, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n * 256 };
}

export function mapPlate(gps: GPSFix): HTMLElement {
  const frame = h('div', { class: 'map-frame' });
  let zoom = 15;
  let canvas: HTMLCanvasElement | null = null;

  const draw = () => {
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = frame.clientWidth || 560, H = frame.clientHeight || 280;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = getComputedStyle(frame).getPropertyValue('--surface-2') || '#ddd';
    g.fillRect(0, 0, W, H);
    const c = project(gps.lat, gps.lon, zoom);
    const ox = c.x - W / 2, oy = c.y - H / 2, n = 2 ** zoom;
    const z = zoom;
    const pin = () => {
      g.strokeStyle = '#b3261e'; g.lineWidth = 2;
      g.beginPath(); g.arc(W / 2, H / 2, 9, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(W / 2 - 16, H / 2); g.lineTo(W / 2 - 5, H / 2); g.moveTo(W / 2 + 5, H / 2); g.lineTo(W / 2 + 16, H / 2);
      g.moveTo(W / 2, H / 2 - 16); g.lineTo(W / 2, H / 2 - 5); g.moveTo(W / 2, H / 2 + 5); g.lineTo(W / 2, H / 2 + 16); g.stroke();
    };
    for (let tx = Math.floor(ox / 256); tx <= Math.floor((ox + W) / 256); tx++) {
      for (let ty = Math.floor(oy / 256); ty <= Math.floor((oy + H) / 256); ty++) {
        if (ty < 0 || ty >= n) continue;
        const img = new Image();
        img.referrerPolicy = 'origin';
        img.onload = () => { if (z !== zoom) return; g.drawImage(img, tx * 256 - ox, ty * 256 - oy, 256, 256); pin(); };
        img.src = `https://tile.openstreetmap.org/${zoom}/${((tx % n) + n) % n}/${ty}.png`;
      }
    }
    pin();
  };

  const veil = h('div', { class: 'map-veil' },
    h('p', null, 'The map is not loaded yet. Showing it fetches map tiles for this area from OpenStreetMap. That is the only network request this app can make, and it reveals the area to their tile server.'),
    h('button', { class: 'btn', type: 'button', onclick: () => {
      veil.remove();
      canvas = h('canvas', { class: 'map-canvas', 'aria-label': `Map centred on ${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}` });
      frame.append(canvas, h('div', { class: 'map-zoom' },
        h('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Zoom in', onclick: () => { zoom = Math.min(19, zoom + 1); draw(); } }, '+'),
        h('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Zoom out', onclick: () => { zoom = Math.max(3, zoom - 1); draw(); } }, '−')),
        h('div', { class: 'map-credit' }, '© OpenStreetMap contributors'));
      draw();
    } }, 'Show on map'));
  frame.append(veil);
  return frame;
}
