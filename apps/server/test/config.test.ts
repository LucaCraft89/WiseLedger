import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('defaults to mocks on 127.0.0.1:8787', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ port: 8787, host: '127.0.0.1', llmProvider: 'mock', walletBackend: 'mock' });
  });

  it('names the variable when a backend is not supported yet', () => {
    expect(() => loadConfig({ WALLET_BACKEND: 'rgb-lib' })).toThrow(ConfigError);
    expect(() => loadConfig({ LLM_PROVIDER: 'ollama' })).toThrow(/LLM_PROVIDER=ollama/);
    expect(() => loadConfig({ RGB_NETWORK: 'mainnet' })).toThrow(/RGB_NETWORK/);
  });

  it('accepts the real backends and reads upload, allowlist and cap settings', () => {
    const c = loadConfig({
      LLM_PROVIDER: 'qvac',
      WALLET_BACKEND: 'wdk-rgb',
      RGB_NETWORK: 'regtest',
      UPLOAD_MAX_MB: '3',
      ASSET_ALLOWLIST: ' rgb:a , rgb:b,',
      PAYMENT_CAP: '5000000',
    });
    expect(c).toMatchObject({
      llmProvider: 'qvac',
      walletBackend: 'wdk-rgb',
      rgbNetwork: 'regtest',
      uploadMaxMb: 3,
      assetAllowlist: ['rgb:a', 'rgb:b'],
      paymentCap: '5000000',
    });
    expect(() => loadConfig({ PAYMENT_CAP: '5.5' })).toThrow(/PAYMENT_CAP/);
  });
});
