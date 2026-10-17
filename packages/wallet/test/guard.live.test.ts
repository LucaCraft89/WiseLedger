// Real chain (local regtest): one confirmed plan pays once; the second execution is refused by the guard.
// Run with LIVE_CHAIN=1 (needs `pnpm regtest start` and the funded wallets from `pnpm wallet:smoke -- --fund-regtest`
// + `pnpm -F wallet issue-asset`, all with RGB_NETWORK=regtest).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makePlan } from 'core';
import { describe, expect, it } from 'vitest';
import { WdkRgbWallet } from '../src/backend/wdk-rgb.js';
import { walletConfigFromEnv } from '../src/config.js';
import { executeGuarded, MemoryGuardStore, WalletGuard } from '../src/guard.js';

const live = process.env.LIVE_CHAIN === '1';
const root = path.resolve(import.meta.dirname, '../../..');
const regtest = (...args: string[]) =>
  execFileSync(path.join(root, 'infra/regtest/regtest.sh'), args, { stdio: 'ignore' });

describe.skipIf(!live)('PaymentGuard on the real chain (regtest)', () => {
  it('pays once, refuses the second execution of the same plan, settles', async () => {
    const assetId = (
      JSON.parse(fs.readFileSync(path.join(root, '.data/regtest/tusdt.json'), 'utf8')) as { assetId: string }
    ).assetId;
    const open = (dir: string) =>
      new WdkRgbWallet(walletConfigFromEnv({ RGB_NETWORK: 'regtest', WALLET_DATA_DIR: path.join(root, dir) }));
    const payer = open('.data/regtest/wallet');
    const payee = open('.data/regtest/payee');
    await payer.init();
    await payee.init();
    await Promise.all([payer.sync(), payee.sync()]);
    const inv = await payee.createReceiveInvoice({ amount: '1000000', expirySec: 600 });
    regtest('mine', '1');

    const plan = await makePlan({
      invoiceId: 'live-guard',
      rgbInvoice: inv.rgbInvoice,
      assetId,
      amount: '1000000',
      payee: { name: 'Payee test' },
      executeAt: 'now',
      labels: [],
    });
    const store = new MemoryGuardStore();
    store.put({
      plan,
      state: 'CONFIRMED',
      confirmation: { planId: plan.planId, confirmedAt: new Date().toISOString() },
    });
    const guard = new WalletGuard({
      store,
      wallet: payer,
      limits: { paymentCap: '100000000', assetAllowlist: [assetId] },
    });

    const first = await executeGuarded(plan.planId, { guard, wallet: payer });
    expect(first, JSON.stringify(first)).toMatchObject({ status: 'submitted', transferId: expect.any(String) });
    const second = await executeGuarded(plan.planId, { guard, wallet: payer });
    expect(second).toMatchObject({ status: 'failed', error: { code: 'already_executed' } });

    let status = '';
    for (let i = 0; i < 20 && status !== 'Settled'; i++) {
      await payee.sync();
      await payer.sync();
      regtest('mine', '1');
      status = (await payer.getTransfer(first.transferId as string))?.status ?? '';
    }
    expect(status).toBe('Settled');
    payer.close();
    payee.close();
  }, 180_000);
});
