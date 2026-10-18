import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { NetworkUnavailable, type OnboardingInfo, type WalletInfo, WalletLocked } from 'core';
import { MockWallet } from 'core/mocks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateMnemonic, normalizeMnemonic, readSeed, seedStatus, writeSeed } from 'wallet';
import { HINTS, RESTORE_NOTE, type WalletFactory } from '../src/onboarding.js';
import { ApiFailure } from '../src/orchestrator.js';
import { type App, createApp } from '../src/server.js';

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** MockWallet with the real seed files and the same onboarding/unlock behaviour as WdkRgbWallet (no native code). */
class SeedWallet extends MockWallet {
  private created = false;
  constructor(
    private readonly dir: string,
    private passphrase?: string,
  ) {
    super({ stepMs: 0 });
  }
  override async init(): Promise<WalletInfo> {
    this.created = loadOrCreateMnemonic(this.dir, this.passphrase ? { passphrase: this.passphrase } : {}).created;
    return { backend: 'mock', network: 'mock' };
  }
  async unlock(passphrase: string): Promise<WalletInfo> {
    readSeed(this.dir, passphrase);
    this.passphrase = passphrase;
    return this.init();
  }
  override async onboarding(opts: { reveal?: boolean } = {}): Promise<OnboardingInfo> {
    const marker = path.join(this.dir, 'seed-shown');
    const seedShown = fs.existsSync(marker);
    if (!opts.reveal || seedShown) return { walletCreated: this.created, seedShown };
    const mnemonic = readSeed(this.dir, this.passphrase);
    fs.writeFileSync(marker, 'x\n');
    return { walletCreated: this.created, seedShown: true, mnemonic };
  }
}

function fakeFactory(dir: string): WalletFactory {
  return {
    status: () => seedStatus(dir),
    openExisting: async () => new SeedWallet(dir),
    create: async (passphrase) => {
      const w = new SeedWallet(dir, passphrase);
      await w.init();
      return w;
    },
    restore: async (mnemonic, passphrase) => {
      let words: string;
      try {
        words = normalizeMnemonic(mnemonic);
      } catch {
        throw new ApiFailure(
          400,
          'INVALID_MNEMONIC',
          'These words are not a valid recovery phrase. Check each word and their order, then try again.',
        );
      }
      writeSeed(dir, words, passphrase);
      const w = new SeedWallet(dir, passphrase);
      await w.init();
      return w;
    },
  };
}

let tmp: string;
let walletDir: string;
let built: App;

async function boot(env: Record<string, string> = {}): Promise<App> {
  built = await createApp(
    { uploadDir: join(tmp, 'uploads'), dbPath: ':memory:', mockStepMs: 0, walletBackend: 'wdk-rgb' },
    { providers: { walletFactory: fakeFactory(walletDir), env } },
  );
  return built;
}

const post = (url: string, payload: unknown = {}) =>
  built.app.inject({ method: 'POST', url, payload: payload as object });
const get = (url: string) => built.app.inject({ method: 'GET', url });

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'wiseledger-onboarding-'));
  walletDir = join(tmp, 'wallet');
});

afterEach(async () => {
  await built?.app.close();
  await rm(tmp, { recursive: true, force: true });
});

describe('onboarding on the real backend (fake wallet factory)', () => {
  it('needs_setup: no seed is created at boot; wallet routes answer 409 WALLET_NOT_READY; health has hints', async () => {
    await boot();
    expect(seedStatus(walletDir)).toBe('none');
    const status = (await get('/api/onboarding')).json();
    expect(status).toEqual({
      state: 'needs_setup',
      seedShown: false,
      network: 'mutinynet',
      walletBackend: 'wdk-rgb',
      minPassphrase: 8,
    });
    for (const url of ['/api/wallet', '/api/transfers']) {
      const res = await get(url);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('WALLET_NOT_READY');
    }
    const receive = await post('/api/wallet/receive', {});
    expect(receive.statusCode).toBe(409);
    const health = (await get('/api/health')).json();
    expect(health.onboarding).toBe('needs_setup');
    expect(health.network).toBe('mutinynet');
    expect(health.wallet.ready).toBe(false);
    expect(health.hints).toEqual([HINTS.needs_setup]);
    expect(built.providers.sync).toBeNull();
    const seed = await post('/api/onboarding/seed-confirmed', { confirmed: true });
    expect(seed.statusCode).toBe(409);
  });

  it('create returns 12 words once, then 409; seed-confirmed is idempotent; wallet routes work', async () => {
    await boot();
    const res = await post('/api/onboarding/create', {});
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body.words).toHaveLength(12);
    expect(body.mnemonic).toBe(body.words.join(' '));
    expect(readSeed(walletDir)).toBe(body.mnemonic);

    const again = await post('/api/onboarding/create', {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ALREADY_SET_UP');
    expect(again.body).not.toContain(body.mnemonic);

    const status = (await get('/api/onboarding')).json();
    expect(status).toMatchObject({ state: 'ready', seedShown: true });
    for (let i = 0; i < 2; i++) {
      const ok = await post('/api/onboarding/seed-confirmed', { confirmed: true });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ ok: true });
    }
    expect((await get('/api/wallet')).statusCode).toBe(200);
    expect(built.providers.sync).not.toBeNull();
    const health = (await get('/api/health')).json();
    expect(health.onboarding).toBe('ready');
    expect(health.hints).toContain(HINTS.faucet);
  });

  it('create with a short passphrase → 400 PASSPHRASE_TOO_SHORT; with a good one the seed is locked', async () => {
    await boot();
    const short = await post('/api/onboarding/create', { passphrase: 'abc' });
    expect(short.statusCode).toBe(400);
    expect(short.json().error.code).toBe('PASSPHRASE_TOO_SHORT');
    expect(seedStatus(walletDir)).toBe('none');
    const ok = await post('/api/onboarding/create', { passphrase: 'correct horse' });
    expect(ok.statusCode).toBe(201);
    expect(seedStatus(walletDir)).toBe('locked');
  });

  it('restore rejects bad words with 400 and restores into an empty folder', async () => {
    await boot();
    const bad = await post('/api/onboarding/restore', { mnemonic: 'apple banana cherry' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toEqual({
      code: 'INVALID_MNEMONIC',
      message: 'These words are not a valid recovery phrase. Check each word and their order, then try again.',
    });
    const empty = await post('/api/onboarding/restore', { mnemonic: '   ' });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe('INVALID_MNEMONIC');

    const ok = await post('/api/onboarding/restore', { mnemonic: `  ${WORDS.toUpperCase()} ` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, note: RESTORE_NOTE });
    expect(readSeed(walletDir)).toBe(WORDS);
    expect((await get('/api/onboarding')).json()).toMatchObject({ state: 'ready', seedShown: true });
    expect((await post('/api/onboarding/restore', { mnemonic: WORDS })).statusCode).toBe(409);
  });

  it('locked seed without WALLET_PASSPHRASE: unlock wrong → 401, 5 wrong → 429, right → ready', async () => {
    writeSeed(walletDir, WORDS, 'correct horse');
    await boot();
    expect((await get('/api/onboarding')).json().state).toBe('locked');
    expect((await get('/api/health')).json().hints).toContain(HINTS.locked);
    expect((await get('/api/transfers')).statusCode).toBe(409);

    const wrong = await post('/api/onboarding/unlock', { passphrase: 'wrong one' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toEqual({
      code: 'WalletLocked',
      message: 'Wrong wallet passphrase. Check it and try again.',
    });
    for (let i = 0; i < 4; i++) await post('/api/onboarding/unlock', { passphrase: 'wrong one' });
    const limited = await post('/api/onboarding/unlock', { passphrase: 'correct horse' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('unlock with the right passphrase makes the wallet ready; a second unlock is 409', async () => {
    writeSeed(walletDir, WORDS, 'correct horse');
    await boot();
    const ok = await post('/api/onboarding/unlock', { passphrase: 'correct horse' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect((await get('/api/wallet')).statusCode).toBe(200);
    expect((await post('/api/onboarding/unlock', { passphrase: 'correct horse' })).statusCode).toBe(409);
  });

  it('locked seed with WALLET_PASSPHRASE opens at boot', async () => {
    writeSeed(walletDir, WORDS, 'correct horse');
    await boot({ WALLET_PASSPHRASE: 'correct horse' });
    expect((await get('/api/onboarding')).json().state).toBe('ready');
  });

  it('regtest health hint', async () => {
    built = await createApp(
      { uploadDir: join(tmp, 'uploads'), dbPath: ':memory:', walletBackend: 'wdk-rgb', rgbNetwork: 'regtest' },
      { providers: { walletFactory: fakeFactory(walletDir), env: {} } },
    );
    const health = (await get('/api/health')).json();
    expect(health.network).toBe('regtest');
    expect(health.hints).toEqual([HINTS.needs_setup, HINTS.regtest]);
  });
});

describe('onboarding on the mock wallet', () => {
  it('is ready; create/restore → 409 ALREADY_SET_UP; seed-confirmed ok; health unchanged plus fields', async () => {
    built = await createApp({ uploadDir: join(tmp, 'uploads'), dbPath: ':memory:', mockStepMs: 0 });
    expect((await get('/api/onboarding')).json()).toEqual({
      state: 'ready',
      seedShown: true,
      network: 'mock',
      walletBackend: 'mock',
      minPassphrase: 8,
    });
    const create = await post('/api/onboarding/create', {});
    expect(create.statusCode).toBe(409);
    expect(create.json().error.code).toBe('ALREADY_SET_UP');
    expect((await post('/api/onboarding/restore', { mnemonic: WORDS })).statusCode).toBe(409);
    expect((await post('/api/onboarding/seed-confirmed', { confirmed: true })).json()).toEqual({ ok: true });
    expect((await post('/api/onboarding/unlock', { passphrase: 'whatever1' })).statusCode).toBe(409);
    const health = (await get('/api/health')).json();
    expect(health).toMatchObject({ ok: true, onboarding: 'ready', network: 'mock', hints: [] });
    expect(health.wallet.ready).toBe(true);
  });
});

describe('wallet error mapping', () => {
  it('WalletLocked → 401 and NetworkUnavailable → 503 with plain messages', async () => {
    const wallet = new MockWallet({ stepMs: 0 });
    wallet.listTransfers = async () => {
      throw new NetworkUnavailable();
    };
    wallet.receiveAddress = async () => {
      throw new WalletLocked();
    };
    built = await createApp(
      { uploadDir: join(tmp, 'uploads'), dbPath: ':memory:', mockStepMs: 0 },
      { providers: { wallet } },
    );
    const net = await get('/api/transfers');
    expect(net.statusCode).toBe(503);
    expect(net.json().error.code).toBe('NetworkUnavailable');
    const locked = await get('/api/wallet');
    expect(locked.statusCode).toBe(401);
    expect(locked.json().error).toEqual({ code: 'WalletLocked', message: new WalletLocked().message });
  });
});
