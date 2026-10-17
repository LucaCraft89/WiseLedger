import { describe, expect, it } from 'vitest';
import { createWallet, libNetwork, walletConfigFromEnv } from '../src/index.js';

describe('walletConfigFromEnv', () => {
  it('defaults to mock on Mutinynet with explicit KaleidoSwap endpoints', () => {
    const c = walletConfigFromEnv({});
    expect(c).toMatchObject({
      backend: 'mock',
      network: 'mutinynet',
      indexerUrl: 'https://esplora.signet.kaleidoswap.com',
      transportEndpoint: 'rpcs://proxy.kaleidoswap.com/json-rpc',
      feeRate: 2,
    });
    expect(libNetwork(c.network)).toBe('signet');
  });

  it('uses the local stack on regtest and honours overrides', () => {
    const c = walletConfigFromEnv({ RGB_NETWORK: 'regtest', RGB_FEE_RATE: '3', RGB_INDEXER_URL: 'tcp://x:1' });
    expect(c).toMatchObject({ network: 'regtest', indexerUrl: 'tcp://x:1', feeRate: 3 });
    expect(c.transportEndpoint).toBe('rpc://127.0.0.1:3000/json-rpc');
  });

  it('rejects unknown values with the variable name', () => {
    expect(() => walletConfigFromEnv({ WALLET_BACKEND: 'utexo' })).toThrow(/WALLET_BACKEND/);
    expect(() => walletConfigFromEnv({ RGB_NETWORK: 'mainnet' })).toThrow(/RGB_NETWORK/);
    expect(() => walletConfigFromEnv({ RGB_FEE_RATE: '0' })).toThrow(/RGB_FEE_RATE/);
  });

  it('createWallet returns the mock without loading native code', async () => {
    const w = await createWallet(walletConfigFromEnv({}));
    expect((await w.init()).backend).toBe('mock');
  });
});
