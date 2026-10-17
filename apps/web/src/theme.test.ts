import { describe, expect, it } from 'vitest';
import { initialTheme, savedTheme, saveTheme } from './lib/theme.js';

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('theme', () => {
  it('the user choice wins over the system and is remembered', () => {
    const s = memory();
    expect(savedTheme(s)).toBeNull();
    expect(['light', 'dark']).toContain(initialTheme(s)); // system (light in tests)
    saveTheme('dark', s);
    expect(initialTheme(s)).toBe('dark');
    saveTheme('light', s);
    expect(initialTheme(s)).toBe('light');
  });
  it('blocked or odd storage falls back to the system', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(savedTheme(blocked)).toBeNull();
    expect(() => saveTheme('dark', blocked)).not.toThrow();
    const odd = memory();
    odd.setItem('wiseledger.theme', 'purple');
    expect(savedTheme(odd)).toBeNull();
  });
});
