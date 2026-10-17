// Wires config → mocks → orchestrator → Fastify app. main.ts and the demo script both start the server from here.
import multipart from '@fastify/multipart';
import type { LlmInfo } from 'core';
import { MockAnalyzer, MockTreasurer, MockWallet } from 'core/mocks';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type ServerConfig } from './config.js';
import { Orchestrator } from './orchestrator.js';
import { registerRoutes } from './routes.js';
import { InvoiceStore } from './store.js';

export interface App {
  app: FastifyInstance;
  orchestrator: Orchestrator;
  store: InvoiceStore;
  config: ServerConfig;
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export async function createApp(overrides: Partial<ServerConfig> = {}, opts: { logger?: boolean } = {}): Promise<App> {
  const config: ServerConfig = { ...loadConfig(), ...overrides };
  const step = config.mockStepMs;

  const wallet = new MockWallet({ stepMs: step });
  await wallet.init();
  const analyzer = new MockAnalyzer({ stageDelayMs: Math.min(step, 300) });
  const treasurer = new MockTreasurer(wallet, { pollMs: Math.max(10, Math.min(step / 4, 250)) });
  const llmInfo = (): LlmInfo => ({ provider: 'mock', model: 'mock-analyzer', state: 'ready', onDevice: true });

  const store = new InvoiceStore(config.dbPath);
  const orchestrator = new Orchestrator({ store, analyzer, treasurer, wallet, uploadDir: config.uploadDir });

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: MAX_UPLOAD_BYTES, forceCloseConnections: true });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  registerRoutes(app, {
    store,
    orchestrator,
    wallet,
    treasurer,
    llmInfo,
    walletBackend: config.walletBackend,
    network: config.rgbNetwork,
    problems: () =>
      orchestrator
        .awaitingSync()
        .map(
          (inv) =>
            `Invoice ${inv.filename} (${inv.id}) was being paid when the app stopped. It was not sent again; a wallet sync will show whether the payment went through.`,
        ),
  });
  app.addHook('onClose', async () => {
    await orchestrator.idle();
    store.close();
  });
  const recovery = await orchestrator.recover(app.log);
  const touched = Object.values(recovery).flat().length;
  if (touched > 0) app.log.info({ recovery }, 'Recovered invoices interrupted by the last shutdown');
  return { app, orchestrator, store, config };
}

/** Starts listening; returns the base URL. */
export async function startServer(
  overrides: Partial<ServerConfig> = {},
  opts: { logger?: boolean } = {},
): Promise<App & { url: string }> {
  const built = await createApp(overrides, opts);
  await built.app.listen({ port: built.config.port, host: built.config.host });
  const addr = built.app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : built.config.port;
  return { ...built, url: `http://${built.config.host}:${port}` };
}
