// Provider factory: LLM_PROVIDER (qvac | openai | mock) and WALLET_BACKEND (mock | wdk-rgb) → analyzer, treasurer,
// wallet, PaymentGuard and the background sync loop. The mock LLM path keeps core's MockAnalyzer/MockTreasurer so
// tests and `pnpm demo:mock` stay hermetic; qvac/openai use B's createAiRuntime() (one shared model).
// Every execution goes through A's WalletGuard (SQLite claims = idempotency), on both paths.

import path from 'node:path';
import { type AiRuntime, type ChatInvoice, createAiRuntime, type RuleConfig, Treasurer } from 'ai';
import type {
  AnalysisReport,
  AnalyzeContext,
  Confirmation,
  EmitFn,
  ExecutionResult,
  FiscalService,
  GuardResult,
  HistoryPort,
  InvoiceAnalyzer,
  InvoiceSource,
  JobStore,
  LabelStore,
  LlmInfo,
  LlmProvider,
  PaymentGuard,
  PaymentPlan,
  ReceiveInvoice,
  TreasurerAgent,
  WalletPort,
} from 'core';
import { MemoryJobStore, MemoryLabelStore, MockAnalyzer, MockTreasurer, MockWallet } from 'core/mocks';
import {
  type GuardStore,
  LnNode,
  REPO_ROOT,
  requestLspChannel,
  type SyncLoop,
  startSyncLoop,
  WalletGuard,
  walletConfigFromEnv,
  withLightning,
} from 'wallet';
import { ConfigError, type ServerConfig } from './config.js';
import { WalletFiscalService } from './fiscal.js';
import { onboardingNetwork, realWalletFactory, type WalletFactory, WalletHolder } from './onboarding.js';
import type { ExecuteNowFn } from './orchestrator.js';

export interface Providers {
  wallet: WalletPort;
  analyzer: InvoiceAnalyzer;
  /** Guarded Treasurer; executeNow is what the Scheduler runs when a job is due. */
  treasurer: SchedulingTreasurer;
  /** The PaymentGuard every execution goes through. */
  guard: LiveGuard;
  /** Model status; warmUpMs once the model is warm (shown in the "Local AI" panel). */
  llmInfo: () => LlmInfo & { warmUpMs?: number };
  /** Background sync for the real wallet; null on the mock wallet and until the real wallet is ready. */
  readonly sync: SyncLoop | null;
  /** Onboarding state and the wallet swap (create / restore / unlock). `wallet` is its port on the real backend. */
  holder: WalletHolder;
  /** Labels (SqliteLabelStore in the server), for the Treasurer's label tools. */
  labels: LabelStore;
  /** Scheduled payments (SqliteJobStore in the server), for B's Scheduler. */
  jobs: JobStore;
  /** Fiscal report (WalletFiscalService in the server), for the Treasurer's report tool. */
  fiscal: FiscalService;
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
  /** A payment request made in the Treasurer chat (the server lists it under "Get paid"). */
  onReceiveCreated?: (inv: ReceiveInvoice) => void;
  /** Extra "keep syncing fast" signal from the server (open receive requests); pending transfers are checked here. */
  syncBusy?: () => boolean;
  /** Persistent stores from the server (in-memory ones when absent, e.g. in provider unit tests). */
  labels?: LabelStore;
  jobs?: JobStore;
  /** Builds the fiscal service once the wallet exists. */
  fiscalFor?: (wallet: WalletPort) => FiscalService;
  /** Open invoices for the Treasurer chat (IDs and short validated fields only). */
  chatInvoices?: () => Promise<ChatInvoice[]>;
  env?: NodeJS.ProcessEnv;
  log?: { info(msg: string): void; warn(obj: unknown, msg?: string): void };
  /** Test seams: use these instead of building from config. */
  llm?: LlmProvider;
  wallet?: WalletPort;
  /** Test seam for onboarding on the real backend (fake create / restore / unlock, no native code). */
  walletFactory?: WalletFactory;
}

type AssetLike = Awaited<ReturnType<WalletPort['listAssets']>>[number];

export interface SchedulingTreasurer extends TreasurerAgent {
  executeNow: ExecuteNowFn;
}

/** Networks the rules accept for RGB invoices, as the wallet's decodeInvoice reports them. */
export function ruleNetworks(config: Pick<ServerConfig, 'walletBackend' | 'rgbNetwork'>): string[] {
  if (config.walletBackend === 'mock') return ['mock'];
  return config.rgbNetwork === 'mutinynet' ? ['signet'] : ['regtest'];
}

/** RuleConfig from env settings plus the wallet's assets. Empty allowlist + exactly one NIA asset held → that asset. */
export function buildRuleConfig(
  config: Pick<ServerConfig, 'walletBackend' | 'rgbNetwork' | 'assetAllowlist' | 'paymentCap' | 'transportAllowlist'>,
  assets: readonly AssetLike[],
): RuleConfig {
  const nia = assets.filter((a) => a.schema === 'NIA');
  const only = nia.length === 1 ? nia[0] : undefined;
  return {
    assetAllowlist: config.assetAllowlist.length > 0 ? [...config.assetAllowlist] : only ? [only.assetId] : [],
    paymentCap: config.paymentCap,
    networks: ruleNetworks(config),
    assets: Object.fromEntries(assets.map((a) => [a.assetId, { ticker: a.ticker, precision: a.precision }])),
    ...(config.transportAllowlist ? { transportAllowlist: [...config.transportAllowlist] } : {}),
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
      config: Pick<ServerConfig, 'walletBackend' | 'rgbNetwork' | 'assetAllowlist' | 'paymentCap'> & {
        dailyCap?: string;
      };
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
    return new WalletGuard({
      store,
      wallet,
      limits: {
        paymentCap: config.paymentCap,
        assetAllowlist,
        ...(config.dailyCap ? { dailyCap: config.dailyCap } : {}),
      },
    });
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
export class GuardedMockTreasurer implements SchedulingTreasurer {
  constructor(
    private readonly inner: TreasurerAgent,
    private readonly guard: PaymentGuard,
  ) {}

  async execute(plan: PaymentPlan, confirmation: Confirmation, emit: EmitFn): Promise<ExecutionResult> {
    // Scheduling moves no money; the job runner goes through the guard when the payment is due.
    if (plan.executeAt !== 'now') return this.inner.execute(plan, confirmation, emit);
    return this.executeNow(plan, confirmation, emit);
  }

  /** Pays now whatever executeAt says (a due scheduled job): guard first, then the mock pays the guard's plan. */
  async executeNow(plan: PaymentPlan, confirmation: Confirmation, emit: EmitFn): Promise<ExecutionResult> {
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
    // MockTreasurer only schedules when executeAt is a date; the planId (and so the claim) stays the guard's.
    return this.inner.execute({ ...g.plan, executeAt: 'now' }, confirmation, emit);
  }

  chat: TreasurerAgent['chat'] = (message, history, emit, stream) => this.inner.chat(message, history, emit, stream);
}

/** Records every outcome with the guard (frees the claim when nothing was sent), then syncs after the payment. */
class GuardedTreasurer implements SchedulingTreasurer {
  constructor(
    private readonly inner: SchedulingTreasurer,
    private readonly guard: LiveGuard,
    private readonly afterExecute: () => void,
  ) {}

  execute(plan: PaymentPlan, confirmation: Confirmation, emit: EmitFn): Promise<ExecutionResult> {
    return this.recorded(() => this.inner.execute(plan, confirmation, emit));
  }

  executeNow(plan: PaymentPlan, confirmation: Confirmation, emit: EmitFn): Promise<ExecutionResult> {
    return this.recorded(() => this.inner.executeNow(plan, confirmation, emit));
  }

  private async recorded(run: () => Promise<ExecutionResult>): Promise<ExecutionResult> {
    try {
      const result = await run();
      await this.guard.recordOutcome(result);
      return result;
    } finally {
      this.afterExecute();
    }
  }

  chat: TreasurerAgent['chat'] = (message, history, emit, stream) => this.inner.chat(message, history, emit, stream);
}

/** Opens the wallet holder: mock and injected wallets are ready at once; the real backend may wait for onboarding. */
async function openHolder(
  config: ServerConfig,
  env: NodeJS.ProcessEnv,
  opts: ProviderOptions,
  onReady: (wallet: WalletPort) => void,
): Promise<WalletHolder> {
  const base = { walletBackend: config.walletBackend, network: onboardingNetwork(config), onReady };
  if (opts.wallet || config.walletBackend === 'mock') {
    const wallet = opts.wallet ?? new MockWallet({ stepMs: config.mockStepMs });
    const holder = WalletHolder.ready(wallet, base);
    await holder.boot();
    return holder;
  }
  try {
    let factory = opts.walletFactory;
    let envPassphrase: string | undefined = env.WALLET_PASSPHRASE;
    if (!factory) {
      const cfg = walletConfigFromEnv({ ...env, WALLET_BACKEND: config.walletBackend, RGB_NETWORK: config.rgbNetwork });
      envPassphrase = cfg.seedPassphrase;
      factory = realWalletFactory(cfg);
    }
    const holder = new WalletHolder(factory, { ...base, ...(envPassphrase ? { envPassphrase } : {}) });
    await holder.boot();
    return holder;
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
  treasurer: SchedulingTreasurer;
  llmStatus: () => LlmInfo & { warmUpMs?: number };
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
function realAi(
  config: ServerConfig,
  wallet: WalletPort,
  guard: PaymentGuard,
  opts: ProviderOptions,
  stores: { labels: LabelStore; fiscal: FiscalService },
): AiProviders {
  const runtime = createAiRuntime({ provider: config.llmProvider, ...(opts.llm ? { llm: opts.llm } : {}) });
  return {
    analyzer: new LiveAnalyst(runtime, wallet, opts.history, config),
    // Built directly (same shared model as runtime.treasurer) to pass the chat tools' stores.
    treasurer: new Treasurer({
      llm: runtime.llm,
      wallet,
      guard,
      labels: stores.labels,
      fiscal: stores.fiscal,
      ...(opts.chatInvoices ? { invoices: opts.chatInvoices } : {}),
      ...(opts.onReceiveCreated ? { onReceiveCreated: opts.onReceiveCreated } : {}),
    }),
    llmStatus: () => {
      return runtime.status();
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

/** Opens the app's Lightning node when LN_ENABLED=true; failures become a plain problem, never a crash. */
async function openLightning(
  config: ServerConfig,
  env: NodeJS.ProcessEnv,
  opts: ProviderOptions,
): Promise<{ node?: LnNode; problem?: string }> {
  if (!/^(1|true|yes)$/i.test(env.LN_ENABLED ?? '') || config.walletBackend === 'mock' || opts.wallet) return {};
  const out: { node?: LnNode; problem?: string } = {};
  try {
    out.node = await LnNode.open({
      name: 'app',
      dataDir: path.resolve(REPO_ROOT, env.LN_DATA_DIR || '.data/ln', 'c'),
      peerPort: Number(env.LN_PEER_PORT ?? 9737),
    });
    opts.log?.info(`Lightning node ${out.node.pubkey} is up`);
  } catch (err) {
    out.problem = `Lightning is on (LN_ENABLED) but its node did not start: ${err instanceof Error ? err.message : err}`;
    opts.log?.warn({ err }, 'Lightning node failed to start');
    return out;
  }
  const url = env.LN_LSP_URL;
  if (url) {
    void requestLspChannel(out.node, { url, log: (m) => opts.log?.info(m) }).catch((err: unknown) => {
      out.problem = `Lightning: ${err instanceof Error ? err.message : err}`;
    });
  }
  return out;
}

export async function createProviders(config: ServerConfig, opts: ProviderOptions): Promise<Providers> {
  const env = opts.env ?? process.env;
  let sync: SyncLoop | null = null;
  const kick = () => {
    void sync?.kick().catch(() => undefined);
  };
  // The real wallet syncs in the background once it is ready (at boot, or after create / restore / unlock).
  const onReady = (ready: WalletPort) => {
    if (config.walletBackend === 'mock' || sync) return;
    sync = startSyncLoop(ready, {
      intervalMs: config.walletSyncMs,
      idleIntervalMs: Math.max(config.walletSyncIdleMs, config.walletSyncMs),
      // Fast while a transfer is on its way (local read, no network) or the server waits for an incoming payment.
      isBusy: async () =>
        (opts.syncBusy?.() ?? false) ||
        (await ready.listTransfers()).some(
          (t) => t.status === 'WaitingCounterparty' || t.status === 'WaitingConfirmations',
        ),
      onSynced: () => opts.onSynced?.(),
      onError: (err, next) => opts.log?.warn({ err, nextDelayMs: next }, 'Wallet sync failed; will retry'),
    });
    // First sync right away (background), so /api/health shows a sync time without waiting a full interval.
    kick();
  };
  const holder = await openHolder(config, env, opts, onReady);
  // Mock and injected wallets are used directly (unchanged mock path); the real backend goes through the holder.
  const base: WalletPort =
    (opts.wallet || config.walletBackend === 'mock') && holder.current ? holder.current : holder.port;
  // Lightning rail (LN_ENABLED=true, real backend only): the app's own RGB Lightning node, channel from our LSP.
  const ln = await openLightning(config, env, opts);
  const wallet: WalletPort = ln.node ? withLightning(base, ln.node) : base;

  const labels = opts.labels ?? new MemoryLabelStore();
  const jobs = opts.jobs ?? new MemoryJobStore();
  const fiscal = opts.fiscalFor?.(wallet) ?? new WalletFiscalService({ wallet });
  const guard = new LiveGuard({ store: opts.guardStore, wallet, config });
  const ai =
    opts.llm || config.llmProvider !== 'mock'
      ? realAi(config, wallet, guard, opts, { labels, fiscal })
      : mockAi(config, wallet, guard);
  const treasurer = new GuardedTreasurer(ai.treasurer, guard, kick);
  // Load the model in the background: /api/health shows `loading` until it is warm.
  ai.warmUp();
  const llmInfo = ai.llmStatus;

  return {
    labels,
    jobs,
    fiscal,
    wallet,
    holder,
    get sync() {
      return sync;
    },
    analyzer: ai.analyzer,
    treasurer,
    guard,
    llmInfo,
    problems: () => {
      const out: string[] = [];
      if (sync?.lastError) out.push(`The last wallet sync failed: ${sync.lastError}. It will be retried.`);
      const info = llmInfo();
      if (info.state === 'error') out.push(`The local AI model is not working: ${info.error ?? 'unknown error'}.`);
      if (ln.problem) out.push(ln.problem);
      return out;
    },
    async close() {
      sync?.stop();
      await ai.close();
      await ln.node?.close();
      holder.close();
    },
  };
}
