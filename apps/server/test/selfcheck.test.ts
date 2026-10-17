// Startup self-check: plain findings from a fake wallet and a fake network.
import type { AssetInfo, WalletPort } from 'core';
import { describe, expect, it } from 'vitest';
import { proxyHttpUrl, SelfCheck } from '../src/selfcheck.js';

const TUSDT: AssetInfo = {
  assetId: 'rgb:tusdt',
  ticker: 'TUSDT',
  name: 'Test USDT',
  precision: 6,
  schema: 'NIA',
  balance: { settled: '862000000', future: '862000000', spendable: '862000000' },
} as AssetInfo;

function wallet(opts: { sats: number; freeUtxos: number; assets?: AssetInfo[] }): WalletPort {
  return {
    btcBalance: () => ({ vanilla: { spendable: opts.sats } }),
    rgb: {
      listUnspents: () =>
        Array.from({ length: opts.freeUtxos }, () => ({ utxo: { colorable: true }, rgbAllocations: [] })),
    },
    receiveAddress: async () => 'tb1qtest',
    listAssets: async () => opts.assets ?? [TUSDT],
  } as unknown as WalletPort;
}

const up = (async () => new Response('1', { status: 200 })) as unknown as typeof fetch;
const down = (async () => {
  throw new Error('ECONNREFUSED');
}) as unknown as typeof fetch;

const base = {
  network: 'mutinynet' as const,
  indexerUrl: 'https://esplora.example',
  transportEndpoint: 'rpcs://proxy.example/json-rpc',
  assetAllowlist: [] as string[],
};

describe('SelfCheck', () => {
  it('a funded, connected wallet has no findings', async () => {
    const c = new SelfCheck({ ...base, wallet: () => wallet({ sats: 105_767, freeUtxos: 3 }), fetch: up });
    expect(await c.run()).toEqual([]);
  });

  it('low sats, no free UTXO, little asset, indexer and proxy down → five plain findings', async () => {
    const poor = { ...TUSDT, balance: { settled: '5000000', future: '5000000', spendable: '5000000' } };
    const c = new SelfCheck({
      ...base,
      wallet: () => wallet({ sats: 1_200, freeUtxos: 0, assets: [poor] }),
      fetch: down,
    });
    const f = await c.run();
    expect(f).toHaveLength(5);
    expect(f.join('\n')).toMatch(/indexer .*does not answer/);
    expect(f.join('\n')).toMatch(/proxy .*does not answer/);
    expect(f.join('\n')).toMatch(/1,200 test sats.*faucet\.mutinynet\.com for tb1qtest/);
    expect(f.join('\n')).toMatch(/No free RGB slot/);
    expect(f.join('\n')).toMatch(/Only 5\.00 TUSDT can be spent/);
    expect(c.problems()).toEqual(f);
  });

  it('nothing is checked before the wallet is ready, or on the mock backend', async () => {
    expect(await new SelfCheck({ ...base, wallet: () => undefined, fetch: down }).run()).toEqual([]);
    const mock = new SelfCheck({
      ...base,
      network: 'mock',
      wallet: () => wallet({ sats: 0, freeUtxos: 0 }),
      fetch: down,
    });
    expect(await mock.run()).toEqual([]);
  });

  it('no asset in the allowlist held → says so', async () => {
    const c = new SelfCheck({
      ...base,
      assetAllowlist: ['rgb:other'],
      wallet: () => wallet({ sats: 50_000, freeUtxos: 2 }),
      fetch: up,
    });
    expect(await c.run()).toEqual([expect.stringMatching(/does not hold the asset in ASSET_ALLOWLIST/)]);
  });

  it('maps the rpcs proxy endpoint to https', () => {
    expect(proxyHttpUrl('rpcs://proxy.kaleidoswap.com/json-rpc')).toBe('https://proxy.kaleidoswap.com/json-rpc');
    expect(proxyHttpUrl('tcp://x')).toBeUndefined();
  });
});
