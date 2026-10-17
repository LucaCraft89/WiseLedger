// Wires config → providers (LLM, wallet, sync loop) → orchestrator → Fastify app. main.ts and the demo script
// both start the server from here.
import multipart from '@fastify/multipart';
import { Scheduler } from 'ai';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type ServerConfig } from './config.js';
import { WalletFiscalService } from './fiscal.js';
import { SqliteGuardStore } from './guard-store.js';
import { StoreHistory } from './history.js';
import { SqliteJobStore } from './jobs.js';
import { SqliteLabelStore } from './labels.js';
import { registerOnboardingRoutes } from './onboarding.js';
import { Orchestrator } from './orchestrator.js';
import { createProviders, type ProviderOptions, type Providers } from './providers.js';
import { registerRoutes } from './routes.js';
import { chatInvoices, InvoiceStore } from './store.js';

export interface App {
  app: FastifyInstance;
  orchestrator: Orchestrator;
  store: InvoiceStore;
  config: ServerConfig;
  providers: Providers;
  /** Persistent labels (per transfer / invoice / payee). Same instance as providers.labels. */
  labels: SqliteLabelStore;
  /** Persistent scheduled jobs. Same instance as providers.jobs. */
  jobs: SqliteJobStore;
  /** Fiscal report over the wallet's transfers. Same instance as providers.fiscal. */
  fiscal: WalletFiscalService;
  /** B's Scheduler on the SQLite jobs: due jobs pay through orchestrator.runScheduled (guarded). */
  scheduler: Scheduler;
}

export interface AppOptions {
  logger?: boolean;
  /** Test seams for the provider factory (an injected LLM or wallet). */
  providers?: Omit<
    ProviderOptions,
    'history' | 'log' | 'guardStore' | 'onSynced' | 'labels' | 'jobs' | 'fiscalFor' | 'chatInvoices'
  >;
  /** Scheduler runner period (default 30 s). */
  schedulerMs?: number;
}

export async function createApp(overrides: Partial<ServerConfig> = {}, opts: AppOptions = {}): Promise<App> {
  const config: ServerConfig = { ...loadConfig(), ...overrides };
  const maxUploadBytes = config.uploadMaxMb * 1024 * 1024;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: maxUploadBytes, forceCloseConnections: true });

  const store = new InvoiceStore(config.dbPath);
  const labels = new SqliteLabelStore(store);
  const jobs = new SqliteJobStore(store);
  const guardStore = new SqliteGuardStore(store);
  let fiscal: WalletFiscalService | undefined;
  // Bound once the orchestrator exists: every wallet sync settles EXECUTING invoices from the wallet's transfers.
  let settle: () => void = () => undefined;
  let providers: Providers;
  try {
    providers = await createProviders(config, {
      ...opts.providers,
      history: new StoreHistory(store),
      guardStore,
      onSynced: () => settle(),
      labels,
      jobs,
      chatInvoices: async () => chatInvoices(store),
      fiscalFor: (wallet) => {
        fiscal = new WalletFiscalService({ wallet, store, labels });
        return fiscal;
      },
      log: { info: (m) => app.log.info(m), warn: (o, m) => app.log.warn(o, m) },
    });
  } catch (err) {
    store.close();
    throw err;
  }
  const { wallet, analyzer, treasurer } = providers;
  const fiscalService = fiscal ?? new WalletFiscalService({ wallet, store, labels });
  let scheduler: Scheduler | undefined;
  const orchestrator = new Orchestrator({
    store,
    analyzer,
    treasurer,
    wallet,
    uploadDir: config.uploadDir,
    schedule: (input) => (scheduler as Scheduler).schedule(input),
  });
  scheduler = new Scheduler({
    jobs,
    // A job runs only for a plan with a stored human confirmation (the guard checks it again before paying).
    hasConfirmation: async (planId) => (await guardStore.find(planId))?.confirmation?.planId === planId,
    execute: (job) => orchestrator.runScheduled(job),
    ...(opts.schedulerMs ? { intervalMs: opts.schedulerMs } : {}),
    onResult: (job, result) =>
      app.log.info({ jobId: job.jobId, invoiceId: job.invoiceId, status: result.status }, 'Scheduled payment ran'),
  });
  settle = () => {
    orchestrator.settleFromTransfers().catch((err: unknown) => app.log.warn({ err }, 'Settling payments failed'));
  };
  // The mock wallet has no sync loop: settle on a timer instead (e.g. a timed-out mock payment). The real wallet
  // settles after each sync (its loop starts once onboarding has a ready wallet).
  const mockSettle =
    providers.sync || config.walletBackend !== 'mock' ? null : setInterval(settle, Math.max(1000, config.mockStepMs));
  mockSettle?.unref();

  await app.register(multipart, { limits: { fileSize: maxUploadBytes, files: 1 } });
  registerRoutes(app, {
    store,
    orchestrator,
    wallet,
    treasurer,
    labels,
    jobs,
    fiscal: fiscalService,
    llmInfo: providers.llmInfo,
    holder: providers.holder,
    walletBackend: config.walletBackend,
    network: config.rgbNetwork,
    uploadMaxMb: config.uploadMaxMb,
    walletSync: () => ({
      lastSyncAt: providers.sync?.lastSyncAt?.toISOString() ?? null,
      lastError: providers.sync?.lastError ?? null,
    }),
    problems: () => [
      ...orchestrator
        .awaitingSync()
        .map(
          (inv) =>
            `Invoice ${inv.filename} (${inv.id}) was being paid when the app stopped. It was not sent again; a wallet sync will show whether the payment went through.`,
        ),
      ...providers.problems(),
    ],
  });
  registerOnboardingRoutes(app, providers.holder);
  app.addHook('onClose', async () => {
    scheduler.stop();
    if (mockSettle) clearInterval(mockSettle);
    await orchestrator.idle();
    await providers.close();
    store.close();
  });
  const recovery = await orchestrator.recover(app.log);
  const touched = Object.values(recovery).flat().length;
  if (touched > 0) app.log.info({ recovery }, 'Recovered invoices interrupted by the last shutdown');
  // After recovery: jobs missed while the app was down run once now, then every interval.
  scheduler.start();
  return { app, orchestrator, store, config, providers, labels, jobs, fiscal: fiscalService, scheduler };
}

/** Starts listening; returns the base URL. */
export async function startServer(
  overrides: Partial<ServerConfig> = {},
  opts: AppOptions = {},
): Promise<App & { url: string }> {
  const built = await createApp(overrides, opts);
  await built.app.listen({ port: built.config.port, host: built.config.host });
  const addr = built.app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : built.config.port;
  return { ...built, url: `http://${built.config.host}:${port}` };
}
