// Entry point: `pnpm -F server dev` / `start`. Fails fast with a plain message on bad config.
import { ConfigError } from './config.js';
import { startServer } from './server.js';

try {
  const { url, config, app } = await startServer({}, { logger: true });
  app.log.info(
    `WiseLedger server on ${url} (LLM_PROVIDER=${config.llmProvider}, WALLET_BACKEND=${config.walletBackend}, RGB_NETWORK=${config.rgbNetwork})`,
  );
  const shutdown = () => {
    app.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
