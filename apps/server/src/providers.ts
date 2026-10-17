// Provider factory: LLM_PROVIDER (qvac | openai | mock) and WALLET_BACKEND (mock | wdk-rgb) → analyzer, treasurer,
// wallet, PaymentGuard and the background sync loop. The mock LLM path keeps core's MockAnalyzer/MockTreasurer so
// tests and `pnpm demo:mock` stay hermetic; qvac/openai use B's createAiRuntime() (one shared model).
// Every execution goes through A's WalletGuard (SQLite claims = idempotency), on both paths.
import { type AiRuntime, createAiRuntime, type RuleConfig } from 'ai';
import type {
  AnalysisReport,
  AnalyzeContext,
  Confirmation,
  EmitFn,
  ExecutionResult,
  GuardResult,
  HistoryPort,
  InvoiceAnalyzer,
  InvoiceSource,
  LlmInfo,
  LlmProvider,
  PaymentGuard,
  PaymentPlan,
  TreasurerAgent,
  WalletPort,
} from 'core';
import { MockAnalyzer, MockTreasurer, MockWallet } from 'core/mocks';
import { createWallet, type GuardStore, type SyncLoop, startSyncLoop, WalletGuard, walletConfigFromEnv } from 'wallet';
import { ConfigError, type ServerConfig } from './config.js';

export interface Providers {
  wallet: WalletPort;
  analyzer: InvoiceAnalyzer;
  treasurer: TreasurerAgent;
  /** The PaymentGuard every execution goes through. */
  guard: LiveGuard;
  llmInfo: () => LlmInfo;
  /** Background sync for the real wallet; null on the mock wallet. */
  sync: SyncLoop | null;
  /** Plain-language problems to show in /api/health. */
  problems: () => string[];
  close(): Promise<void>;
}

export interface ProviderOptions {
  history: HistoryPort;
  /** Where the guard reads plans/confirmations and keeps its claims (SqliteGuardStore in the server). */
  guardStore: GuardStore;
  /** Called after every successful wallet sync (the orchestrator settles EXECUTING invoices). */
  onSynced?: () => void;
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

/**
 * A's WalletGuard with limits from the server config. The allowlist is resolved per check with the same fallback as
 * buildRuleConfig (empty ASSET_ALLOWLIST + one NIA asset held → that asset), so an asset issued later is known.
 */
export class LiveGuard implements PaymentGuard {
  constructor(
    private readonly deps: {
      store: GuardStore;
      wallet: WalletPort;
      config: Pick<ServerConfig, 'walletBackend' | 'rgbNetwork' | 'assetAllowlist' | 'paymentCap'>;
    },
  ) {}

  private async guard(): Promise<WalletGuard> {
    const { store, wallet, config } = this.deps;
    let assetAllowlist = [...config.assetAllowlist];
    if (assetAllowlist.length === 0) {
      try {
        assetAllowlist = buildRuleConfig(config, await wallet.listAssets()).assetAllowlist;
      } catch {
        // Could not read the assets: the cap still applies and the balance check fails closed.
      }
    }
    return new WalletGuard({ store, wallet, limits: { paymentCap: config.paymentCap, assetAllowlist } });
  }

  async check(planId: string): Promise<GuardResult<PaymentPlan>> {
    return (await this.guard()).check(planId);
  }

  /** Frees the claim only when nothing can have left the wallet (wallet RELEASE_ON_FAILURE). */
  async recordOutcome(result: ExecutionResult): Promise<void> {
    await (await this.guard()).recordOutcome(result);
  }
}

/** The real Analyst with a RuleConfig rebuilt per invoice, so an asset issued after startup is known. */
class LiveAnalyst implements InvoiceAnalyzer {
  constructor(
    private readonly runtime: AiRuntime,
    private readonly wallet: WalletPort,
    private readonly history: HistoryPort,
    private readonly config: ServerConfig,
  ) {}

  async analyze(src: InvoiceSource, ctx: AnalyzeContext, emit: EmitFn): Promise<AnalysisReport> {
    const rules = buildRuleConfig(this.config, await this.wallet.listAssets());
    return this.runtime.analyst({ wallet: this.wallet, history: this.history, config: rules }).analyze(src, ctx, emit);
  }
}

/**
 * Mock path: MockTreasurer pays without a guard, so the plan goes through the guard first (confirmed, hash, cap,
 * asset, balance, claimed once). The plan paid is the one the guard resolved from the store.
 */
export class GuardedMockTreasurer implements TreasurerAgent {
  constructor(
    private readonly inner: TreasurerAgent,
    private readonly guard: PaymentGuard,
  ) {}

  async execute(plan: PaymentPlan, confirmation: Confirmation, emit: EmitFn): Promise<ExecutionResult> {
    // Scheduling moves no money; the job runner goes through the guard when the payment is due.
    if (plan.executeAt !== 'now') return this.inner.execute(plan, confirmation, emit);
    const g = await this.guard.check(plan.planId);
    if (!g.ok) {
      emit({
        type: 'toolCall',
        invoiceId: plan.invoiceId,
        at: new Date().toISOString(),
        agent: 'treasurer',
        name: 'execute_plan',
        args: { planId: plan.planId },
        status: 'rejected',
        message: g.message,
      });
      return { planId: plan.planId, status: 'failed', error: { code: g.reason, message: g.message } };
    }
    return this.inner.execute(g.plan, confirmation, emit);
  }

  chat: TreasurerAgent['chat'] = (message, history, emit) => this.inner.chat(message, history, emit);
}

/** Records every outcome with the guard (frees the claim when nothing was sent), then syncs after the payment. */
class GuardedTreasurer implements TreasurerAgent {
  constructor(
    private readonly inner: TreasurerAgent,
    private readonly guard: LiveGuard,
    private readonly afterExecute: () => void,
  ) {}

  async execute(plan: PaymentPlan, confirmation: Confirmation, emit: EmitFn): Promise<ExecutionResult> {
    try {
      const result = await this.inner.execute(plan, confirmation, emit);
      await this.guard.recordOutcome(result);
      return result;
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
 * Everything the server needs from B's `ai` package, behind one small interface (createAiRuntime() on the real path,
 * core mocks on the hermetic one).
 */
export interface AiProviders {
  analyzer: InvoiceAnalyzer;
  treasurer: TreasurerAgent;
  llmStatus: () => LlmInfo;
  /** Starts loading the model in the background; never rejects. */
  warmUp: () => void;
  close: () => Promise<void>;
}

/** Hermetic path: core's MockAnalyzer + MockTreasurer (tests, `pnpm demo:mock`), behind the guard. */
function mockAi(config: ServerConfig, wallet: WalletPort, guard: PaymentGuard): AiProviders {
  const step = config.mockStepMs;
  const inner = new MockTreasurer(wallet, { pollMs: Math.max(10, Math.min(step / 4, 250)) });
  return {
    analyzer: new MockAnalyzer({ stageDelayMs: Math.min(step, 300) }),
    treasurer: new GuardedMockTreasurer(inner, guard),
    llmStatus: () => ({ provider: 'mock', model: 'mock-analyzer', state: 'ready', onDevice: true }),
    warmUp: () => undefined,
    close: async () => undefined,
  };
}

/** B's real Analyst + Treasurer on one shared model via createAiRuntime() (qvac | openai, or an injected test LLM). */
function realAi(config: ServerConfig, wallet: WalletPort, guard: PaymentGuard, opts: ProviderOptions): AiProviders {
  const runtime = createAiRuntime({ provider: config.llmProvider, ...(opts.llm ? { llm: opts.llm } : {}) });
  return {
    analyzer: new LiveAnalyst(runtime, wallet, opts.history, config),
    treasurer: runtime.treasurer({ wallet, guard }),
    llmStatus: () => {
      const { warmUpMs: _ms, ...info } = runtime.status();
      return info;
    },
    warmUp: () => {
      void runtime.warmUp().then(() => {
        const info = runtime.status();
        if (info.state === 'error') opts.log?.warn({ err: info.error }, 'Model warm-up failed');
        else opts.log?.info(`Model ${info.model} is ready${info.warmUpMs ? ` (warm-up ${info.warmUpMs} ms)` : ''}`);
      });
    },
    close: async () => {
      await runtime.close().catch(() => undefined);
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
          onSynced: () => opts.onSynced?.(),
          onError: (err, next) => opts.log?.warn({ err, nextDelayMs: next }, 'Wallet sync failed; will retry'),
        });
  const kick = () => {
    void sync?.kick().catch(() => undefined);
  };
  // First sync right away (background), so /api/health shows a sync time without waiting a full interval.
  kick();

  const guard = new LiveGuard({ store: opts.guardStore, wallet, config });
  const ai =
    opts.llm || config.llmProvider !== 'mock' ? realAi(config, wallet, guard, opts) : mockAi(config, wallet, guard);
  const treasurer = new GuardedTreasurer(ai.treasurer, guard, kick);
  // Load the model in the background: /api/health shows `loading` until it is warm.
  ai.warmUp();
  const llmInfo = ai.llmStatus;

  return {
    wallet,
    analyzer: ai.analyzer,
    treasurer,
    guard,
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
