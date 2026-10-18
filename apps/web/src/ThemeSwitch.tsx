import { useState } from 'react';
import { applyTheme, saveTheme, type Theme } from './lib/theme.js';

const SUN = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const MOON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M21 13.2A8.5 8.5 0 1 1 10.8 3a6.8 6.8 0 0 0 10.2 10.2z" />
  </svg>
);

/** Dark mode on/off: a 44 px icon button. Applied to <html data-theme>, remembered in this browser. */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  );
  const dark = theme === 'dark';
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <button
      type="button"
      className="wl-theme-icon"
      aria-label={label}
      title={label}
      onClick={() => {
        const next: Theme = dark ? 'light' : 'dark';
        applyTheme(next);
        saveTheme(next);
        setTheme(next);
      }}
    >
      {dark ? SUN : MOON}
    </button>
  );
}
