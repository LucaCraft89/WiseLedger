import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('defaults to mocks on 127.0.0.1:8787', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ port: 8787, host: '127.0.0.1', llmProvider: 'mock', walletBackend: 'mock' });
  });

  it('names the variable when a backend is not supported yet', () => {
    expect(() => loadConfig({ WALLET_BACKEND: 'wdk-rgb' })).toThrow(ConfigError);
    expect(() => loadConfig({ LLM_PROVIDER: 'qvac' })).toThrow(/LLM_PROVIDER=qvac/);
    expect(() => loadConfig({ RGB_NETWORK: 'mainnet' })).toThrow(/RGB_NETWORK/);
  });
});
