import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiCallError, createHttpClient, READY_ONBOARDING } from './api/client.js';
import {
  API_ROUTES,
  HealthResponse,
  OnboardingCreateResponse,
  OnboardingRestoreResponse,
  OnboardingStatusResponse,
} from './api/contracts.js';
import { createFakeClient } from './api/fake.js';
import { FAKE_MAX_UNLOCK_TRIES, FAKE_MIN_PASSPHRASE } from './api/fake-onboarding.js';
import { aiRunStats, formatAiRun, lastAiRun, localAiSentence, recordAiRun } from './lib/ai-stats.js';
import { VERDICT_LABELS } from './lib/format.js';
import {
  checkWord,
  mnemonicProblem,
  normalizeMnemonic,
  passphraseProblem,
  pickCheckIndex,
  screenForOnboarding,
} from './lib/onboarding.js';
import {
  apiErrorWords,
  canRetry,
  ERROR_WORDS,
  errorWords,
  flagTitle,
  SEVERITY_ICON_WORD,
  splitFlags,
} from './lib/payment.js';
import { SetupScreen, UnlockScreen } from './OnboardingScreens.js';
import { LocalAiPanel } from './SettingsPage.js';
import { errorText } from './ui.js';

const at = '2026-10-17T10:00:00.000Z';

describe('onboarding routing', () => {
  it('maps each state to a screen; unknown means the app', () => {
    expect(screenForOnboarding('needs_setup')).toBe('setup');
    expect(screenForOnboarding('locked')).toBe('unlock');
    expect(screenForOnboarding('ready')).toBe('app');
    expect(screenForOnboarding(undefined)).toBe('app');
  });

  it('an older server without /api/onboarding (404) counts as ready', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no route' } }), {
        status: 404,
      })) as typeof fetch;
    try {
      expect(await createHttpClient().onboarding()).toEqual(READY_ONBOARDING);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('other server errors are not hidden', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 500 })) as typeof fetch;
    try {
      await expect(createHttpClient().onboarding()).rejects.toMatchObject({ status: 500 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('onboarding helpers', () => {
  it('normalizes pasted recovery words (numbers, case, punctuation)', () => {
    expect(normalizeMnemonic(' 1. Owl  2. LEDGER,\n3) river ')).toEqual(['owl', 'ledger', 'river']);
  });

  it('accepts 12 or 24 words only', () => {
    expect(mnemonicProblem('')).toMatch(/12 or 24/);
    expect(mnemonicProblem('a b c')).toBe('You typed 3 words. A recovery phrase has 12 or 24 words.');
    expect(mnemonicProblem(Array(12).fill('word').join(' '))).toBeNull();
    expect(mnemonicProblem(Array(24).fill('word').join(' '))).toBeNull();
  });

  it('checks the passphrase length and the repeat', () => {
    expect(passphraseProblem('', 8)).toBeNull();
    expect(passphraseProblem('short', 8)).toBe('The passphrase must be at least 8 characters long.');
    expect(passphraseProblem('long enough', 8, 'long enougH')).toMatch(/different/);
    expect(passphraseProblem('long enough', 8, 'long enough')).toBeNull();
  });

  it('picks a word to type back and checks it', () => {
    expect(pickCheckIndex(12, () => 0)).toBe(0);
    expect(pickCheckIndex(12, () => 0.999)).toBe(11);
    expect(checkWord(['owl', 'ledger'], 1, ' Ledger ')).toBe(true);
    expect(checkWord(['owl', 'ledger'], 1, 'owl')).toBe(false);
    expect(checkWord(['owl'], 5, 'owl')).toBe(false);
  });
});

describe('onboarding contracts', () => {
  it('parses the onboarding shapes', () => {
    expect(
      OnboardingStatusResponse.parse({
        state: 'needs_setup',
        seedShown: false,
        network: 'mutinynet',
        walletBackend: 'wdk-rgb',
        minPassphrase: 8,
      }).state,
    ).toBe('needs_setup');
    expect(OnboardingStatusResponse.safeParse({ state: 'other', seedShown: false }).success).toBe(false);
    expect(OnboardingCreateResponse.parse({ mnemonic: 'a b', words: ['a', 'b'] }).words).toHaveLength(2);
    expect(OnboardingRestoreResponse.parse({ ok: true, note: 'Syncing' }).ok).toBe(true);
    expect(API_ROUTES.onboarding).toBe('GET /api/onboarding');
  });

  it('health: new fields are optional, so an older server still parses', () => {
    const old = {
      ok: true,
      time: at,
      llm: { provider: 'qvac', model: 'qwen', state: 'ready', onDevice: true },
      wallet: { backend: 'wdk-rgb', network: 'mutinynet', ready: true },
      problems: [],
    };
    expect(HealthResponse.safeParse(old).success).toBe(true);
    const next = HealthResponse.parse({ ...old, onboarding: 'locked', network: 'regtest', hints: ['Get coins'] });
    expect(next.hints).toEqual(['Get coins']);
  });
});

describe('fake onboarding', () => {
  it('ready by default (mock backend)', async () => {
    const api = createFakeClient();
    expect((await api.onboarding()).state).toBe('ready');
    expect((await api.health()).onboarding).toBe('ready');
    await expect(api.onboardingCreate({})).rejects.toMatchObject({ code: 'ALREADY_SET_UP' });
  });

  it('create shows the words once, then the wallet is ready', async () => {
    const api = createFakeClient({ onboarding: 'needs_setup' });
    await expect(api.onboardingCreate({ passphrase: 'abc' })).rejects.toMatchObject({ code: 'PASSPHRASE_TOO_SHORT' });
    const created = await api.onboardingCreate({ passphrase: 'x'.repeat(FAKE_MIN_PASSPHRASE) });
    expect(created.words).toHaveLength(12);
    expect((await api.onboarding()).seedShown).toBe(false);
    await api.onboardingSeedConfirmed();
    expect(await api.onboarding()).toMatchObject({ state: 'ready', seedShown: true });
    await expect(api.onboardingCreate({})).rejects.toMatchObject({ code: 'ALREADY_SET_UP' });
  });

  it('restore refuses bad words', async () => {
    const api = createFakeClient({ onboarding: 'needs_setup' });
    await expect(api.onboardingRestore({ mnemonic: 'one two' })).rejects.toMatchObject({ code: 'INVALID_MNEMONIC' });
    expect((await api.onboardingRestore({ mnemonic: Array(12).fill('word').join(' ') })).ok).toBe(true);
    expect((await api.onboarding()).state).toBe('ready');
  });

  it('unlock: wrong passphrase, then too many tries', async () => {
    const api = createFakeClient({ onboarding: 'locked' });
    for (let i = 0; i < FAKE_MAX_UNLOCK_TRIES; i++) {
      await expect(api.onboardingUnlock({ passphrase: 'nope' })).rejects.toMatchObject({ code: 'WalletLocked' });
    }
    const err = await api.onboardingUnlock({ passphrase: 'demo-passphrase' }).catch((e: unknown) => e);
    expect(errorText(err)).toBe(ERROR_WORDS.TOO_MANY_TRIES);
  });

  it('unlock with the right passphrase opens the wallet', async () => {
    const api = createFakeClient({ onboarding: 'locked' });
    expect((await api.onboardingUnlock({ passphrase: 'demo-passphrase' })).ok).toBe(true);
    expect((await api.onboarding()).state).toBe('ready');
  });
});

describe('error copy for the new codes', () => {
  it('has plain words for the wallet and onboarding codes', () => {
    expect(errorWords('NetworkUnavailable')).toBe(
      'We could not reach the Bitcoin test network. Nothing was sent. Check your internet and try again.',
    );
    expect(errorWords('WalletLocked')).toBe('Your wallet is locked. Enter your passphrase to unlock it.');
    for (const code of ['WALLET_NOT_READY', 'INVALID_MNEMONIC', 'PASSPHRASE_TOO_SHORT', 'ALREADY_SET_UP']) {
      expect(ERROR_WORDS[code], code).toBeTruthy();
    }
  });

  it('NetworkUnavailable and WalletLocked are not retried from the failure card', () => {
    expect(canRetry('NetworkUnavailable')).toBe(false);
    expect(canRetry('WalletLocked')).toBe(false);
  });

  it('server errors: our words for known codes, 429 as too many tries, else the server message', () => {
    expect(apiErrorWords('WALLET_NOT_READY', 'x')).toBe(ERROR_WORDS.WALLET_NOT_READY);
    expect(apiErrorWords('WHATEVER', 'x', 429)).toBe(ERROR_WORDS.TOO_MANY_TRIES);
    expect(apiErrorWords('NOT_FOUND', 'This invoice does not exist.')).toBe('This invoice does not exist.');
    expect(errorText(new ApiCallError('WalletLocked', 'raw'))).toBe(ERROR_WORDS.WalletLocked);
  });
});

describe('local AI numbers', () => {
  const token = { type: 'token' as const, invoiceId: 'i1', at, agent: 'analyst' as const, text: 'x' };
  const report = { invoiceId: 'i1', model: { name: 'qwen3.5-2b', provider: 'qvac' as const } };

  it('tokens per second from analyst tokens and model time', () => {
    const events = [token, token, token, token, { ...token, agent: 'treasurer' as const }];
    const s = aiRunStats(events, { ...report, timings: { extractMs: 1500, rulesMs: 999, summaryMs: 500 } });
    expect(s).toMatchObject({ tokens: 4, seconds: 2, tokensPerSecond: 2, model: 'qwen3.5-2b' });
    expect(s && formatAiRun(s)).toBe('2.0 tokens per second · 2.0 seconds of AI work');
  });

  it('nothing to show without timings; no speed without tokens', () => {
    expect(aiRunStats([token], report)).toBeNull();
    expect(aiRunStats([token], { ...report, timings: {} })).toBeNull();
    expect(aiRunStats([], { ...report, timings: { extractMs: 1000 } })?.tokensPerSecond).toBeUndefined();
  });

  it('keeps the last run in memory', () => {
    recordAiRun(null);
    const s = aiRunStats([token], { ...report, timings: { extractMs: 1000 } });
    recordAiRun(s);
    expect(lastAiRun()).toBe(s);
  });

  it('claims "on this computer" only for an on-device provider', () => {
    expect(localAiSentence({ provider: 'qvac', onDevice: true })).toBe(
      'The invoice is read by an AI model running on this computer. Nothing is sent to the internet.',
    );
    expect(localAiSentence({ provider: 'mock', onDevice: true })).toMatch(/^Demo mode: canned answers/);
    expect(localAiSentence({ provider: 'openai', onDevice: false })).toMatch(/another server/);
  });
});

describe('supplier check and calm info notes', () => {
  it('R5 is titled "Supplier check"; info flags are notes, apart from the checks', () => {
    expect(flagTitle('R5_NEW_PAYEE')).toBe('Supplier check');
    expect(SEVERITY_ICON_WORD.info).toBe('Note');
    const note = { severity: 'info' as const, code: 'R5_NEW_PAYEE' };
    const warn = { severity: 'warn' as const, code: 'R3_AMOUNT' };
    expect(splitFlags([note, warn])).toEqual({ alerts: [warn], notes: [note] });
    expect(splitFlags([note]).alerts).toHaveLength(0);
    expect(VERDICT_LABELS.ok).toBe('Looks fine');
  });
});

describe('first-run and settings screens render', () => {
  it('setup screen offers create and restore; unlock asks for the passphrase', () => {
    const api = createFakeClient({ onboarding: 'needs_setup' });
    const status = { ...READY_ONBOARDING, state: 'needs_setup' as const, minPassphrase: 8 };
    const setup = renderToStaticMarkup(createElement(SetupScreen, { api, status, onDone: () => {} }));
    expect(setup).toContain('Create a new wallet');
    expect(setup).toContain('Restore from 12 or 24 words');
    const unlock = renderToStaticMarkup(createElement(UnlockScreen, { api, onDone: () => {} }));
    expect(unlock).toMatch(/<label[^>]*>Passphrase<input[^>]*type="password"/);
  });

  it('Local AI panel states where the model runs', () => {
    const html = renderToStaticMarkup(
      createElement(LocalAiPanel, {
        llm: { provider: 'qvac', model: 'qwen3.5-2b-q4', state: 'ready', onDevice: true, warmUpMs: 4200 },
      }),
    );
    expect(html).toContain('running on this computer. Nothing is sent to the internet.');
    expect(html).toContain('qwen3.5-2b-q4');
    expect(html).toContain('loaded in 4.2 s');
  });
});
