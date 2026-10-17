// Provider factory: LLM_PROVIDER (qvac | openai | mock) and WALLET_BACKEND (mock | wdk-rgb) → analyzer, treasurer,
// wallet and the background sync loop. The mock LLM path keeps core's MockAnalyzer/MockTreasurer so tests and
// `pnpm demo:mock` stay hermetic; qvac/openai build B's real Analyst and Treasurer on one shared model.
import { Analyst, confirmationGuard, createLlm, type RuleConfig, Treasurer } from 'ai';
import type {
  AnalysisReport,
  AnalyzeContext,
  Confirmation,
  EmitFn,
  ExecutionResult,
  HistoryPort,
  InvoiceAnalyzer,
  InvoiceSource,
  LlmInfo,
  LlmProvider,
  PaymentPlan,
  TreasurerAgent,
  WalletPort,
} from 'core';
import { MockAnalyzer, MockTreasurer, MockWallet } from 'core/mocks';
import { createWallet, type SyncLoop, startSyncLoop, walletConfigFromEnv } from 'wallet';
import { ConfigError, type ServerConfig } from './config.js';

export interface Providers {
  wallet: WalletPort;
  analyzer: InvoiceAnalyzer;
  treasurer: TreasurerAgent;
  llmInfo: () => LlmInfo;
  /** Background sync for the real wallet; null on the mock wallet. */
  sync: SyncLoop | null;
  /** Plain-language problems to show in /api/health. */
  problems: () => string[];
  close(): Promise<void>;
}

export interface ProviderOptions {
  history: HistoryPort;
  env?: NodeJS.ProcessEnv;
  log?: { info(msg: string): void; warn(obj: unknown, msg?: string): void };
  /** Test seams: use these instead of building from config. */
  llm?: LlmProvider;
  wallet?: WalletPort;
}

type AssetLike = Awaited<ReturnType<WalletPort['listAssets']>>[number];

/** Networks the rules accept for RGB invoices, as the wallet's decodeInvoice reports them. */
export function ruleNetworks(config: Pick<ServerConfig, 'walletBackend' | 'rgbNetwork'>): string[] {
  if (config.walletBackend === 'mock') return ['mock'];
  return config.rgbNetwork === 'mutinynet' ? ['signet'] : ['regtest'];
}

/** RuleConfig from env settings plus the wallet's assets. Empty allowlist + exactly one NIA asset held → that asset. */
export function buildRuleConfig(
  config: Pick<ServerConfig, 'walletBackend' | 'rgbNetwork' | 'assetAllowlist' | 'paymentCap'>,
  assets: readonly AssetLike[],
): RuleConfig {
  const nia = assets.filter((a) => a.schema === 'NIA');
  const only = nia.length === 1 ? nia[0] : undefined;
  return {
    assetAllowlist: config.assetAllowlist.length > 0 ? [...config.assetAllowlist] : only ? [only.assetId] : [],
    paymentCap: config.paymentCap,
    networks: ruleNetworks(config),
    assets: Object.fromEntries(assets.map((a) => [a.assetId, { ticker: a.ticker, precision: a.precision }])),
  };
}

/** The real Analyst with a RuleConfig rebuilt per invoice, so an asset issued after startup is known. */
class LiveAnalyst implements InvoiceAnalyzer {
  constructor(
    private readonly llm: LlmProvider,
    private readonly wallet: WalletPort,
    private readonly history: HistoryPort,
    private readonly config: ServerConfig,
  ) {}

  async analyze(src: InvoiceSource, ctx: AnalyzeContext, emit: EmitFn): Promise<AnalysisReport> {
    const rules = buildRuleConfig(this.config, await this.wallet.listAssets());
    return new Analyst({ llm: this.llm, wallet: this.wallet, history: this.history, config: rules }).analyze(
      src,
      ctx,
      emit,
    );
  }
}

/** Registers the confirmed plan with the guard stub (until A's PaymentGuard lands), then syncs after the payment. */
class GuardedTreasurer implements TreasurerAgent {
  constructor(
    private readonly inner: TreasurerAgent,
    private readonly beforeExecute: (plan: PaymentPlan, c: Confirmation) => Promise<void>,
    private readonly afterExecute: () => void,
  ) {}

  async execute(plan: PaymentPlan, confirmation: Confirmation, emit: EmitFn): Promise<ExecutionResult> {
    await this.beforeExecute(plan, confirmation);
    try {
      return await this.inner.execute(plan, confirmation, emit);
    } finally {
      this.afterExecute();
    }
  }

  chat: TreasurerAgent['chat'] = (message, history, emit) => this.inner.chat(message, history, emit);
}

async function openWallet(config: ServerConfig, env: NodeJS.ProcessEnv): Promise<WalletPort> {
  if (config.walletBackend === 'mock') return new MockWallet({ stepMs: config.mockStepMs });
  try {
    const wallet = await createWallet(
      walletConfigFromEnv({ ...env, WALLET_BACKEND: config.walletBackend, RGB_NETWORK: config.rgbNetwork }),
    );
    await wallet.init();
    return wallet;
  } catch (err) {
    throw new ConfigError(
      `The wallet could not start (WALLET_BACKEND=${config.walletBackend}, RGB_NETWORK=${config.rgbNetwork}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Everything the server needs from B's `ai` package, behind one small interface, so the wiring can move to
 * `createAiRuntime()` without touching the rest of the server.
 */
export interface AiProviders {
  analyzer: InvoiceAnalyzer;
  treasurer: TreasurerAgent;
  /** Called with the human-confirmed plan before treasurer.execute (registers it with the guard). */
  beforeExecute: (plan: PaymentPlan, confirmation: Confirmation) => Promise<void>;
  llmStatus: () => LlmInfo;
  /** Starts loading the model in the background; never rejects. */
  warmUp: () => void;
  close: () => Promise<void>;
}

/** Hermetic path: core's MockAnalyzer + MockTreasurer (tests, `pnpm demo:mock`). */
function mockAi(config: ServerConfig, wallet: WalletPort): AiProviders {
  const step = config.mockStepMs;
  return {
    analyzer: new MockAnalyzer({ stageDelayMs: Math.min(step, 300) }),
    treasurer: new MockTreasurer(wallet, { pollMs: Math.max(10, Math.min(step / 4, 250)) }),
    beforeExecute: async () => undefined,
    llmStatus: () => ({ provider: 'mock', model: 'mock-analyzer', state: 'ready', onDevice: true }),
    warmUp: () => undefined,
    close: async () => undefined,
  };
}

/** B's real Analyst + Treasurer on one shared model (qvac | openai, or an injected test LLM). */
function realAi(config: ServerConfig, wallet: WalletPort, opts: ProviderOptions): AiProviders {
  const model = opts.llm ?? createLlm(config.llmProvider);
  const guard = confirmationGuard();
  return {
    analyzer: new LiveAnalyst(model, wallet, opts.history, config),
    treasurer: new Treasurer({ llm: model, wallet, guard }),
    beforeExecute: (plan, c) => guard.add(plan, c),
    llmStatus: () => model.info(),
    warmUp: () => {
      model.warmUp?.().then(
        () => opts.log?.info(`Model ${model.info().model} is ready`),
        (err: unknown) => opts.log?.warn({ err }, 'Model warm-up failed'),
      );
    },
    close: async () => {
      await model.unload?.().catch(() => undefined);
    },
  };
}

export async function createProviders(config: ServerConfig, opts: ProviderOptions): Promise<Providers> {
  const env = opts.env ?? process.env;
  const wallet = opts.wallet ?? (await openWallet(config, env));
  if (opts.wallet) await wallet.init();

  const sync =
    config.walletBackend === 'mock'
      ? null
      : startSyncLoop(wallet, {
          intervalMs: config.walletSyncMs,
          onError: (err, next) => opts.log?.warn({ err, nextDelayMs: next }, 'Wallet sync failed; will retry'),
        });
  const kick = () => {
    void sync?.kick().catch(() => undefined);
  };
  // First sync right away (background), so /api/health shows a sync time without waiting a full interval.
  kick();

  const ai = opts.llm || config.llmProvider !== 'mock' ? realAi(config, wallet, opts) : mockAi(config, wallet);
  const treasurer = new GuardedTreasurer(ai.treasurer, ai.beforeExecute, kick);
  // Load the model in the background: /api/health shows `loading` until it is warm.
  ai.warmUp();
  const llmInfo = ai.llmStatus;
  const analyzer = ai.analyzer;

  return {
    wallet,
    analyzer,
    treasurer,
    llmInfo,
    sync,
    problems: () => {
      const out: string[] = [];
      if (sync?.lastError) out.push(`The last wallet sync failed: ${sync.lastError}. It will be retried.`);
      const info = llmInfo();
      if (info.state === 'error') out.push(`The local AI model is not working: ${info.error ?? 'unknown error'}.`);
      return out;
    },
    async close() {
      sync?.stop();
      await ai.close();
      (wallet as { close?: () => void }).close?.();
    },
  };
}
