import { useState } from 'react';
import { applyTheme, saveTheme, type Theme } from './lib/theme.js';

/** Dark mode on/off. Applied to <html data-theme>, remembered in this browser. */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  );
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      className="wl-theme-switch"
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => {
        const next: Theme = dark ? 'light' : 'dark';
        applyTheme(next);
        saveTheme(next);
        setTheme(next);
      }}
    >
      <span className="wl-theme-track" aria-hidden="true">
        <span className="wl-theme-thumb" />
      </span>
      <span aria-hidden="true">{dark ? '☾' : '☀'}</span>
      <span className="wl-visually-hidden">Dark mode</span>
    </button>
  );
}
