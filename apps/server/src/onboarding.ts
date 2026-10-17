// First-run onboarding for the real wallet (WALLET_BACKEND=wdk-rgb): the server no longer creates a seed at boot.
// WalletHolder starts in `needs_setup` (no seed), `locked` (encrypted seed, no WALLET_PASSPHRASE) or `ready`, and
// swaps the wallet in once it is created, restored or unlocked. While not ready it is a WalletPort whose calls answer
// 409 WALLET_NOT_READY, so every wallet route (and the orchestrator) fails with plain words instead of crashing.
// The mnemonic is returned once by POST /api/onboarding/create and never logged.
import fs from 'node:fs';
import { isWalletError, type WalletPort } from 'core';
import type { FastifyInstance } from 'fastify';
import {
  createWallet,
  MIN_WALLET_PASSPHRASE,
  normalizeMnemonic,
  restoreWallet,
  type SeedStatus,
  seedStatus,
  type WalletConfig,
} from 'wallet';
import {
  M3_ONBOARDING_ROUTES,
  OnboardingCreateRequest,
  type OnboardingCreateResponse,
  type OnboardingNetwork,
  OnboardingRestoreRequest,
  type OnboardingRestoreResponse,
  OnboardingSeedConfirmedRequest,
  type OnboardingSeedConfirmedResponse,
  type OnboardingState,
  type OnboardingStatusResponse,
  OnboardingUnlockRequest,
  type OnboardingUnlockResponse,
} from './api-local.js';
import type { ServerConfig } from './config.js';
import { ApiFailure } from './orchestrator.js';

/** A wallet the holder can manage: WalletPort plus the optional WdkRgbWallet extras. */
export type ManagedWallet = WalletPort & {
  unlock?(passphrase: string): Promise<unknown>;
  close?(): void;
  btcBalance?(): unknown;
};

/** How the holder opens, creates and restores wallets (the real one uses the `wallet` package; tests inject fakes). */
export interface WalletFactory {
  status(): SeedStatus;
  /** The wallet over the existing seed, NOT initialised (the holder calls init() or unlock()). */
  openExisting(): Promise<ManagedWallet>;
  /** Creates a new seed (locked when a passphrase is given) and returns the initialised wallet. */
  create(passphrase?: string): Promise<ManagedWallet>;
  /** Restores from words into the empty data dir and returns the initialised wallet. Throws INVALID_MNEMONIC (400). */
  restore(mnemonic: string, passphrase?: string): Promise<ManagedWallet>;
}

export const NOT_READY_MESSAGES: Record<Exclude<OnboardingState, 'ready'>, string> = {
  needs_setup: 'The wallet is not set up yet. Create a new wallet or restore one from your recovery words first.',
  locked: 'The wallet is locked. Enter your wallet passphrase to unlock it.',
};

export const RESTORE_NOTE = 'Bitcoin comes back from the words; RGB assets need the wallet backup file.';
const INVALID_MNEMONIC = 'These words are not a valid recovery phrase.';

function invalidMnemonic(): ApiFailure {
  return new ApiFailure(400, 'INVALID_MNEMONIC', INVALID_MNEMONIC);
}

function setupFailed(err: unknown): ApiFailure {
  const msg = err instanceof Error ? err.message : String(err);
  return new ApiFailure(
    503,
    'SETUP_FAILED',
    `The wallet could not start: ${msg} Nothing was kept; check the network settings and try again.`,
  );
}

/** Real factory over the `wallet` package. On a failed create/restore a data dir that was empty before is removed. */
export function realWalletFactory(cfg: WalletConfig): WalletFactory {
  const dir = cfg.dataDir;
  const isEmpty = () => !fs.existsSync(dir) || fs.readdirSync(dir).length === 0;
  const startFresh = async (build: () => Promise<ManagedWallet>): Promise<ManagedWallet> => {
    const wasEmpty = isEmpty();
    let wallet: ManagedWallet | undefined;
    try {
      wallet = await build();
      await wallet.init();
      return wallet;
    } catch (err) {
      try {
        wallet?.close?.();
      } catch {
        // already closed
      }
      // The words were never shown (create) or the user still has them (restore): safe to start over.
      if (wasEmpty) fs.rmSync(dir, { recursive: true, force: true });
      if (err instanceof ApiFailure) throw err;
      throw setupFailed(err);
    }
  };
  return {
    status: () => seedStatus(dir),
    openExisting: async () => (await createWallet(cfg)) as ManagedWallet,
    create: (passphrase) =>
      startFresh(
        async () =>
          (await createWallet(
            passphrase === undefined ? cfg : { ...cfg, seedPassphrase: passphrase },
          )) as ManagedWallet,
      ),
    restore: (mnemonic, passphrase) => {
      try {
        normalizeMnemonic(mnemonic);
      } catch {
        return Promise.reject(invalidMnemonic());
      }
      return startFresh(() =>
        restoreWallet({ cfg, mnemonic, ...(passphrase === undefined ? {} : { lockPassphrase: passphrase }) }),
      );
    },
  };
}

export interface WalletHolderOptions {
  walletBackend: ServerConfig['walletBackend'];
  network: OnboardingNetwork;
  /** WALLET_PASSPHRASE from env: a locked seed opens at boot when present. */
  envPassphrase?: string;
  /** Called once when the wallet becomes ready (boot, create, restore or unlock). */
  onReady?: (wallet: ManagedWallet) => void;
}

/**
 * Holds the wallet and the onboarding state. `port` is a WalletPort that forwards to the wallet once ready and throws
 * 409 WALLET_NOT_READY before.
 */
export class WalletHolder {
  private wallet: ManagedWallet | null = null;
  /** The not-yet-unlocked wallet in state `locked`. */
  private pending: ManagedWallet | null = null;
  private busy = false;
  private failures = 0;
  private blockedUntil = 0;
  readonly port: ManagedWallet;

  constructor(
    private readonly factory: WalletFactory | null,
    readonly opts: WalletHolderOptions,
  ) {
    this.port = this.makePort();
  }

  /** A holder that is ready from the start (mock backend, injected test wallets). */
  static ready(wallet: ManagedWallet, opts: WalletHolderOptions): WalletHolder {
    const h = new WalletHolder(null, opts);
    h.wallet = wallet;
    return h;
  }

  get state(): OnboardingState {
    if (this.wallet) return 'ready';
    return this.pending ? 'locked' : 'needs_setup';
  }

  /** The ready wallet, or null. */
  get current(): ManagedWallet | null {
    return this.wallet;
  }

  notReady(): ApiFailure {
    const state = this.state;
    return new ApiFailure(
      409,
      'WALLET_NOT_READY',
      state === 'ready' ? 'The wallet is ready.' : NOT_READY_MESSAGES[state],
    );
  }

  /** Boot: decides the state from the seed on disk. Never creates a seed. */
  async boot(): Promise<void> {
    if (this.wallet) {
      await this.wallet.init();
      this.becomeReady(this.wallet);
      return;
    }
    if (!this.factory) throw new Error('WalletHolder needs a factory or a wallet.');
    const status = this.factory.status();
    if (status === 'none') return;
    const wallet = await this.factory.openExisting();
    if (status === 'locked' && !this.opts.envPassphrase) {
      this.pending = wallet;
      return;
    }
    try {
      if (status === 'locked' && this.opts.envPassphrase && wallet.unlock) await wallet.unlock(this.opts.envPassphrase);
      else await wallet.init();
    } catch (err) {
      // A wrong WALLET_PASSPHRASE: wait for the user to unlock instead of failing the boot.
      if (isWalletError(err) && err.code === 'WalletLocked') {
        this.pending = wallet;
        return;
      }
      throw err;
    }
    this.becomeReady(wallet);
  }

  private becomeReady(wallet: ManagedWallet): void {
    this.wallet = wallet;
    this.pending = null;
    this.opts.onReady?.(wallet);
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new ApiFailure(409, 'SETUP_IN_PROGRESS', 'The wallet is being set up. Please wait a moment.');
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  private requireSetup(): WalletFactory {
    if (this.state !== 'needs_setup' || !this.factory) {
      throw new ApiFailure(
        409,
        'ALREADY_SET_UP',
        'This app already has a wallet. Restart with an empty data folder to start over.',
      );
    }
    return this.factory;
  }

  async seedShown(): Promise<boolean> {
    if (!this.wallet) return false;
    try {
      return (await this.wallet.onboarding()).seedShown;
    } catch {
      return false;
    }
  }

  async create(passphrase?: string): Promise<string> {
    const factory = this.requireSetup();
    return this.exclusive(async () => {
      const wallet = await factory.create(passphrase);
      const info = await wallet.onboarding({ reveal: true });
      this.becomeReady(wallet);
      if (!info.mnemonic) throw new ApiFailure(500, 'INTERNAL', 'The new wallet did not return its recovery words.');
      return info.mnemonic;
    });
  }

  async restore(mnemonic: string, passphrase?: string): Promise<void> {
    const factory = this.requireSetup();
    await this.exclusive(async () => {
      const wallet = await factory.restore(mnemonic, passphrase);
      // The user already has the words: mark them shown without returning them.
      await wallet.onboarding({ reveal: true });
      this.becomeReady(wallet);
    });
  }

  async confirmSeed(): Promise<void> {
    if (!this.wallet) throw this.notReady();
    await this.wallet.onboarding({ reveal: true });
  }

  async unlock(passphrase: string, now = Date.now()): Promise<void> {
    const pending = this.pending;
    if (!pending) {
      if (this.wallet) throw new ApiFailure(409, 'NOT_LOCKED', 'The wallet is not locked.');
      throw this.notReady();
    }
    if (now < this.blockedUntil) {
      const s = Math.ceil((this.blockedUntil - now) / 1000);
      throw new ApiFailure(429, 'TOO_MANY_ATTEMPTS', `Too many wrong passphrases. Wait ${s} seconds and try again.`);
    }
    await this.exclusive(async () => {
      try {
        if (!pending.unlock) throw new Error('This wallet cannot be unlocked.');
        await pending.unlock(passphrase);
      } catch (err) {
        if (isWalletError(err) && err.code === 'WalletLocked') {
          this.failures += 1;
          if (this.failures >= MAX_UNLOCK_FAILURES) {
            this.failures = 0;
            this.blockedUntil = now + UNLOCK_BLOCK_MS;
          }
          throw new ApiFailure(401, 'WalletLocked', 'Wrong wallet passphrase.');
        }
        throw err;
      }
      this.failures = 0;
      this.becomeReady(pending);
    });
  }

  close(): void {
    for (const w of [this.wallet, this.pending]) {
      try {
        w?.close?.();
      } catch {
        // closing is best effort
      }
    }
  }

  private makePort(): ManagedWallet {
    const ready = (): ManagedWallet => {
      if (!this.wallet) throw this.notReady();
      return this.wallet;
    };
    return {
      init: async () => ready().init(),
      onboarding: async (o) => ready().onboarding(o),
      receiveAddress: async () => ready().receiveAddress(),
      listAssets: async () => ready().listAssets(),
      assetBalance: async (id) => ready().assetBalance(id),
      createUtxosIfNeeded: async () => ready().createUtxosIfNeeded(),
      issueAssetNia: async (r) => ready().issueAssetNia(r),
      createReceiveInvoice: async (r) => ready().createReceiveInvoice(r),
      decodeInvoice: async (i) => ready().decodeInvoice(i),
      quotePay: async (r) => ready().quotePay(r),
      pay: async (r) => ready().pay(r),
      getTransfer: async (id) => ready().getTransfer(id),
      listTransfers: async (id) => ready().listTransfers(id),
      sync: async () => ready().sync(),
      // Duck-typed by routes (BTC balance in /api/wallet and the faucet hint); undefined while not ready.
      btcBalance: () => this.wallet?.btcBalance?.(),
    };
  }
}

export const MAX_UNLOCK_FAILURES = 5;
export const UNLOCK_BLOCK_MS = 30_000;

function checkPassphrase(passphrase: string | undefined): void {
  if (passphrase !== undefined && passphrase.length < MIN_WALLET_PASSPHRASE) {
    throw new ApiFailure(
      400,
      'PASSPHRASE_TOO_SHORT',
      `The wallet passphrase must be at least ${MIN_WALLET_PASSPHRASE} characters.`,
    );
  }
}

/** The network name the UI shows: the RGB network, or `mock` on the mock wallet. */
export function onboardingNetwork(config: Pick<ServerConfig, 'walletBackend' | 'rgbNetwork'>): OnboardingNetwork {
  return config.walletBackend === 'mock' ? 'mock' : config.rgbNetwork;
}

export const HINTS = {
  faucet: 'Get free test bitcoin at https://faucet.mutinynet.com (GitHub login), then wait ~30 s for one block.',
  noAsset: 'No test asset yet: run `pnpm -F wallet issue-asset` or ask the supplier for TUSDT.',
  regtest: 'Local regtest: `pnpm regtest start` and `pnpm wallet:smoke -- --fund-regtest`.',
  needs_setup: 'Set up the wallet first: create a new one or restore it from your recovery words.',
  locked: 'The wallet is locked: enter your wallet passphrase to unlock it (or set WALLET_PASSPHRASE).',
} as const;

/** Plain network and faucet hints for /api/health. Never throws. */
export async function healthHints(holder: WalletHolder, btcSats: () => string | undefined): Promise<string[]> {
  const out: string[] = [];
  try {
    const { network } = holder.opts;
    const state = holder.state;
    if (state !== 'ready') out.push(HINTS[state]);
    if (network === 'regtest') out.push(HINTS.regtest);
    const wallet = holder.current;
    if (!wallet || network === 'mock') return out;
    if (network === 'mutinynet') {
      let sats: string | undefined;
      try {
        sats = btcSats();
      } catch {
        sats = undefined;
      }
      if (sats === undefined || sats === '0') out.push(HINTS.faucet);
    }
    let held = false;
    try {
      const assets = await wallet.listAssets();
      held = assets.some((a) => a.balance.settled !== '0' || a.balance.future !== '0');
    } catch {
      held = false;
    }
    if (!held) out.push(HINTS.noAsset);
  } catch {
    // hints are best effort
  }
  return out;
}

const url = (spec: string): string => spec.split(' ')[1] as string;

export function registerOnboardingRoutes(app: FastifyInstance, holder: WalletHolder): void {
  const { walletBackend, network } = holder.opts;

  app.get(
    url(M3_ONBOARDING_ROUTES.status),
    async (): Promise<OnboardingStatusResponse> => ({
      state: holder.state,
      seedShown: await holder.seedShown(),
      network,
      walletBackend,
      minPassphrase: MIN_WALLET_PASSPHRASE,
    }),
  );

  app.post(url(M3_ONBOARDING_ROUTES.create), async (req, reply): Promise<OnboardingCreateResponse> => {
    const body = OnboardingCreateRequest.parse(req.body ?? {});
    checkPassphrase(body.passphrase);
    const mnemonic = await holder.create(body.passphrase);
    reply.status(201).header('cache-control', 'no-store');
    return { mnemonic, words: mnemonic.split(' ') };
  });

  app.post(url(M3_ONBOARDING_ROUTES.seedConfirmed), async (req): Promise<OnboardingSeedConfirmedResponse> => {
    OnboardingSeedConfirmedRequest.parse(req.body ?? {});
    await holder.confirmSeed();
    return { ok: true };
  });

  app.post(url(M3_ONBOARDING_ROUTES.restore), async (req): Promise<OnboardingRestoreResponse> => {
    const parsed = OnboardingRestoreRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      if (parsed.error.issues.some((i) => i.path[0] === 'mnemonic')) throw invalidMnemonic();
      throw parsed.error;
    }
    checkPassphrase(parsed.data.passphrase);
    await holder.restore(parsed.data.mnemonic, parsed.data.passphrase);
    return { ok: true, note: RESTORE_NOTE };
  });

  app.post(url(M3_ONBOARDING_ROUTES.unlock), async (req): Promise<OnboardingUnlockResponse> => {
    const body = OnboardingUnlockRequest.parse(req.body ?? {});
    await holder.unlock(body.passphrase);
    return { ok: true };
  });
}
