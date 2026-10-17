// Pure helpers for the first-run screens (tested in onboarding.test.ts). The recovery words never leave memory.
import type { OnboardingState } from '../api/contracts.js';

/** Which top-level screen the app shows for a first-run state. */
export type AppScreen = 'setup' | 'unlock' | 'app';

export function screenForOnboarding(state: OnboardingState | undefined): AppScreen {
  if (state === 'needs_setup') return 'setup';
  if (state === 'locked') return 'unlock';
  return 'app';
}

/** Words of a typed recovery phrase: lower case, single spaces, numbers and punctuation from copy-paste removed. */
export function normalizeMnemonic(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\d+[.)]/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Plain-language problem with a typed recovery phrase, or null when it has the right shape (12 or 24 words). */
export function mnemonicProblem(text: string): string | null {
  const n = normalizeMnemonic(text).length;
  if (n === 0) return 'Type your 12 or 24 recovery words, separated by spaces.';
  if (n !== 12 && n !== 24)
    return `You typed ${n} ${n === 1 ? 'word' : 'words'}. A recovery phrase has 12 or 24 words.`;
  return null;
}

/** Plain-language problem with an optional passphrase, or null when it is fine (empty = no passphrase). */
export function passphraseProblem(passphrase: string, min: number, repeat?: string): string | null {
  if (passphrase === '') return repeat ? 'Type the passphrase in the first box too.' : null;
  if (passphrase.length < min) return `The passphrase must be at least ${min} characters long.`;
  if (repeat !== undefined && repeat !== passphrase) return 'The two passphrases are different. Type them again.';
  return null;
}

/** 0-based index of the word the user must type back to show they wrote the words down. */
export function pickCheckIndex(count: number, random: () => number = Math.random): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.floor(random() * count));
}

/** True when `typed` is the word at `index` (case and spaces ignored). */
export function checkWord(words: readonly string[], index: number, typed: string): boolean {
  const want = words[index];
  return !!want && typed.trim().toLowerCase() === want.toLowerCase();
}
