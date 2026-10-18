// Per-device preferences. Storage can be unavailable (private mode), so every
// access is guarded and the app works with defaults.

export interface Prefs {
  theme: 'paper' | 'lab';
  mode: 'plain' | 'technical';
  sound: boolean;
}

const KEY = 'forensics.prefs';

function systemTheme(): Prefs['theme'] {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'lab' : 'paper';
}

export function loadPrefs(): Prefs {
  const base: Prefs = { theme: systemTheme(), mode: 'technical', sound: false };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...base, ...JSON.parse(raw) };
  } catch { /* storage unavailable */ }
  return base;
}

export function savePrefs(p: Prefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

export function applyPrefs(p: Prefs): void {
  document.documentElement.dataset.theme = p.theme;
  document.documentElement.dataset.mode = p.mode;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', p.theme === 'lab' ? '#141516' : '#efeae0');
}
