// Entry point: `pnpm -F server dev` / `start`. Fails fast with a plain message on bad config.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError } from './config.js';
import { startServer } from './server.js';

// <repo>/.env (git-ignored) fills variables the shell did not set.
const dotEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(dotEnv)) process.loadEnvFile(dotEnv);

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
