// Light / dark theme. Follows the system until the user flips the switch; the choice is kept in this browser.
export type Theme = 'light' | 'dark';
const KEY = 'wiseledger.theme';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const browserStore = (): Store | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

export function savedTheme(store: Store | undefined = browserStore()): Theme | null {
  try {
    const v = store?.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** The theme to show: the user's choice, else the system's. */
export const initialTheme = (store?: Store): Theme => savedTheme(store) ?? systemTheme();

export function applyTheme(theme: Theme): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme: Theme, store: Store | undefined = browserStore()): void {
  try {
    store?.setItem(KEY, theme);
  } catch {
    // blocked storage: the switch still works until reload
  }
}
