// One contract for every WalletPort backend. MockWallet always runs; the real WDK backend runs on local regtest
// with LIVE_WALLET=1 (needs `infra/regtest/regtest.sh start`; uses a fresh temp data dir and the local miner).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isWalletError, type WalletErrorCode, type WalletPort } from 'core';
import { MockWallet } from 'core/mocks';
import { beforeAll, describe, expect, it } from 'vitest';
import { walletConfigFromEnv } from '../src/config.js';

const live = process.env.LIVE_WALLET === '1';
const regtestSh = path.resolve(import.meta.dirname, '../../../infra/regtest/regtest.sh');

async function errorCode(p: Promise<unknown>): Promise<WalletErrorCode | 'ok' | 'other'> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return isWalletError(e) ? e.code : 'other';
  }
}

interface Backend {
  name: string;
  make: () => Promise<WalletPort>;
  /** Funds the wallet and mines, so it can create UTXOs and issue (no-op for the mock). */
  prepare: (w: WalletPort) => Promise<void>;
}

const backends: Backend[] = [
  { name: 'mock', make: async () => new MockWallet({ stepMs: 0 }), prepare: async () => {} },
];
if (live) {
  backends.push({
    name: 'wdk-rgb (regtest)',
    make: async () => {
      const { WdkRgbWallet } = await import('../src/backend/wdk-rgb.js');
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-contract-'));
      return new WdkRgbWallet(walletConfigFromEnv({ RGB_NETWORK: 'regtest', WALLET_DATA_DIR: dataDir }));
    },
    prepare: async (w) => {
      execFileSync(regtestSh, ['fund', await w.receiveAddress(), '0.5'], { stdio: 'ignore' });
      await w.sync();
      await w.createUtxosIfNeeded();
      execFileSync(regtestSh, ['mine', '1'], { stdio: 'ignore' });
      await w.sync();
    },
  });
}

describe.each(backends)('WalletPort contract: $name', ({ make, prepare }) => {
  let w: WalletPort;
  let assetId: string;

  beforeAll(async () => {
    w = await make();
    await w.init();
    await prepare(w);
    const a = await w.issueAssetNia({
      ticker: 'CTEST',
      name: 'Contract test asset',
      precision: 6,
      amounts: ['7000000'],
    });
    assetId = a.assetId;
  }, 120_000);

  it('gives a funding address', async () => {
    expect(await w.receiveAddress()).toMatch(/^(tb1|bcrt1)\w+/);
  });

  it('lists the issued NIA asset with precision and balances as base-unit strings', async () => {
    const a = (await w.listAssets()).find((x) => x.assetId === assetId);
    expect(a).toMatchObject({ ticker: 'CTEST', precision: 6, schema: 'NIA' });
    expect(await w.assetBalance(assetId)).toEqual({ settled: '7000000', future: '7000000', spendable: '7000000' });
  });

  it('creates a receive invoice without asset and decodes it', async () => {
    const r = await w.createReceiveInvoice({ amount: '5000000', expirySec: 600 });
    expect(Date.parse(r.expiresAt)).toBeGreaterThan(Date.now());
    const d = await w.decodeInvoice(r.rgbInvoice);
    expect(d.assetId).toBeUndefined();
    expect(d.amount).toBe('5000000');
    expect(d.expiresAt && Date.parse(d.expiresAt)).toBeGreaterThan(Date.now());
    expect(d.recipientId).toBeTruthy();
  });

  it('rejects garbage invoices and unknown assets with typed errors', async () => {
    expect(await errorCode(w.decodeInvoice('not-an-invoice'))).toBe('InvalidInvoice');
    expect(await errorCode(w.assetBalance('rgb:unknownAsset-xxxxxxx-xxxxxxx-xxxxxxx-xxxxxxx-xxxxxxx'))).toBe(
      'UnknownAsset',
    );
  });

  it('refuses a nonsense ticker', async () => {
    await expect(w.issueAssetNia({ ticker: 'lower', name: 'x', precision: 6, amounts: ['1'] })).rejects.toThrow();
  });

  it('lists the issuance among transfers', async () => {
    const t = await w.listTransfers(assetId);
    expect(t.some((x) => x.direction === 'issuance' && x.status === 'Settled' && x.amount === '7000000')).toBe(true);
  });
});
