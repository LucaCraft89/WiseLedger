// In-browser fake of A's first-run routes (/api/onboarding/*), so demo mode can show every screen.
// Default state is `ready` (like the mock wallet backend). VITE_FAKE_ONBOARDING=needs_setup|locked starts elsewhere.

import { ApiCallError, type ApiClient } from './client.js';
import type { OnboardingState, OnboardingStatusResponse } from './contracts.js';

/** Demo-only placeholder words: NOT a real recovery phrase, never used for any key. */
const DEMO_WORDS = [
  'owl',
  'ledger',
  'invoice',
  'river',
  'candle',
  'orbit',
  'meadow',
  'velvet',
  'harbor',
  'pencil',
  'tunnel',
  'garden',
];

export const FAKE_MIN_PASSPHRASE = 8;
export const FAKE_MAX_UNLOCK_TRIES = 5;

type OnboardingMethods = Pick<
  ApiClient,
  'onboarding' | 'onboardingCreate' | 'onboardingSeedConfirmed' | 'onboardingRestore' | 'onboardingUnlock'
>;

export function createFakeOnboarding(initial: OnboardingState = 'ready'): OnboardingMethods & {
  /** Current state, for the fake /api/health. */
  state(): OnboardingState;
} {
  let state: OnboardingState = initial;
  let seedShown = initial !== 'needs_setup';
  // A locked fake wallet opens with the demo passphrase; a created one with what the user chose.
  let passphrase = initial === 'locked' ? 'demo-passphrase' : '';
  let tries = 0;

  const checkPassphrase = (p: string | undefined) => {
    if (p && p.length < FAKE_MIN_PASSPHRASE) {
      throw new ApiCallError(
        'PASSPHRASE_TOO_SHORT',
        `The passphrase must be at least ${FAKE_MIN_PASSPHRASE} characters long.`,
      );
    }
  };
  const needsSetup = () => {
    if (state !== 'needs_setup') throw new ApiCallError('ALREADY_SET_UP', 'This wallet is already set up.');
  };

  return {
    state: () => state,
    async onboarding(): Promise<OnboardingStatusResponse> {
      return { state, seedShown, network: 'mock', walletBackend: 'mock', minPassphrase: FAKE_MIN_PASSPHRASE };
    },
    async onboardingCreate(req) {
      needsSetup();
      checkPassphrase(req.passphrase);
      passphrase = req.passphrase ?? '';
      state = 'ready';
      seedShown = false;
      return { mnemonic: DEMO_WORDS.join(' '), words: [...DEMO_WORDS] };
    },
    async onboardingSeedConfirmed() {
      seedShown = true;
      return { ok: true };
    },
    async onboardingRestore(req) {
      needsSetup();
      checkPassphrase(req.passphrase);
      const words = req.mnemonic.trim().toLowerCase().split(/\s+/);
      if (![12, 24].includes(words.length) || !words.every((w) => /^[a-z]+$/.test(w))) {
        throw new ApiCallError('INVALID_MNEMONIC', 'These recovery words are not valid.');
      }
      passphrase = req.passphrase ?? '';
      state = 'ready';
      seedShown = true;
      return { ok: true, note: 'Demo mode: the wallet was restored with pretend balances.' };
    },
    async onboardingUnlock(req) {
      if (state !== 'locked') return { ok: true };
      if (tries >= FAKE_MAX_UNLOCK_TRIES) {
        throw new ApiCallError('TOO_MANY_TRIES', 'Too many wrong tries. Wait a minute, then try again.', 429);
      }
      if (req.passphrase !== passphrase) {
        tries += 1;
        throw new ApiCallError('WalletLocked', 'Wrong passphrase.', 401);
      }
      tries = 0;
      state = 'ready';
      return { ok: true };
    },
  };
}
