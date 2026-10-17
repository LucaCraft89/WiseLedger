// Wires config → providers (LLM, wallet, sync loop) → orchestrator → Fastify app. main.ts and the demo script
// both start the server from here.
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type ServerConfig } from './config.js';
import { SqliteGuardStore } from './guard-store.js';
import { StoreHistory } from './history.js';
import { Orchestrator } from './orchestrator.js';
import { createProviders, type ProviderOptions, type Providers } from './providers.js';
import { registerRoutes } from './routes.js';
import { InvoiceStore } from './store.js';

export interface App {
  app: FastifyInstance;
  orchestrator: Orchestrator;
  store: InvoiceStore;
  config: ServerConfig;
  providers: Providers;
}

export interface AppOptions {
  logger?: boolean;
  /** Test seams for the provider factory (an injected LLM or wallet). */
  providers?: Omit<ProviderOptions, 'history' | 'log' | 'guardStore' | 'onSynced'>;
}

export async function createApp(overrides: Partial<ServerConfig> = {}, opts: AppOptions = {}): Promise<App> {
  const config: ServerConfig = { ...loadConfig(), ...overrides };
  const maxUploadBytes = config.uploadMaxMb * 1024 * 1024;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: maxUploadBytes, forceCloseConnections: true });

  const store = new InvoiceStore(config.dbPath);
  // Bound once the orchestrator exists: every wallet sync settles EXECUTING invoices from the wallet's transfers.
  let settle: () => void = () => undefined;
  let providers: Providers;
  try {
    providers = await createProviders(config, {
      ...opts.providers,
      history: new StoreHistory(store),
      guardStore: new SqliteGuardStore(store),
      onSynced: () => settle(),
      log: { info: (m) => app.log.info(m), warn: (o, m) => app.log.warn(o, m) },
    });
  } catch (err) {
    store.close();
    throw err;
  }
  const { wallet, analyzer, treasurer } = providers;
  const orchestrator = new Orchestrator({ store, analyzer, treasurer, wallet, uploadDir: config.uploadDir });
  settle = () => {
    orchestrator.settleFromTransfers().catch((err: unknown) => app.log.warn({ err }, 'Settling payments failed'));
  };
  // The mock wallet has no sync loop: settle on a timer instead (e.g. a timed-out mock payment).
  const mockSettle = providers.sync ? null : setInterval(settle, Math.max(1000, config.mockStepMs));
  mockSettle?.unref();

  await app.register(multipart, { limits: { fileSize: maxUploadBytes, files: 1 } });
  registerRoutes(app, {
    store,
    orchestrator,
    wallet,
    treasurer,
    llmInfo: providers.llmInfo,
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
  app.addHook('onClose', async () => {
    if (mockSettle) clearInterval(mockSettle);
    await orchestrator.idle();
    await providers.close();
    store.close();
  });
  const recovery = await orchestrator.recover(app.log);
  const touched = Object.values(recovery).flat().length;
  if (touched > 0) app.log.info({ recovery }, 'Recovered invoices interrupted by the last shutdown');
  return { app, orchestrator, store, config, providers };
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
