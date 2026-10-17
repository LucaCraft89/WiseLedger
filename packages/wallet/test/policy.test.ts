// The spend policy on the real WDK policy engine, with a fake RGB wallet manager (no native code, no chain).
import WDK from '@tetherto/wdk';
import { isWalletError } from 'core';
import { describe, expect, it, vi } from 'vitest';
import { mapWalletError } from '../src/backend/wdk-rgb.js';
import { buildSpendPolicy, policyDenied } from '../src/policy.js';

const ASSET = 'rgb:tusdt-test';
const SEED = WDK.getRandomSeedPhrase(12);
const send = (amount: number, token = ASSET) => ({ token, recipient: 'rgb:~/~/x', amount, feeRate: 2 });
type Send = ReturnType<typeof send>;

function governedAccount(
  limits: { paymentCap: string; assetAllowlist: string[]; dailyCap?: string },
  spent?: (assetId: string) => number,
) {
  const transfer = vi.fn(async (_o: Send) => ({ hash: 'ab'.repeat(32), fee: 300n }));
  const rgbWallet = { listAssets: () => ({ nia: [] }) };
  const account = {
    getRgbWallet: () => rgbWallet,
    getAddress: () => 'bcrt1qfake',
    transfer,
    issueAssetNia: vi.fn((_o?: unknown) => ({})),
    toReadOnlyAccount: () => ({ getAddress: () => 'bcrt1qfake' }),
  };
  class FakeRgbManager {
    async getAccount() {
      return account;
    }
    dispose() {}
  }
  const wdk = new WDK(SEED).registerWallet('rgb', FakeRgbManager as never, {} as never);
  wdk.registerPolicy([buildSpendPolicy(limits, spent)] as never);
  return { get: () => wdk.getAccount('rgb', 0) as unknown as Promise<typeof account>, transfer, rgbWallet };
}

describe('WDK spend policy on the RGB account', () => {
  it('lets a payment under the cap through', async () => {
    const g = governedAccount({ paymentCap: '100000000', assetAllowlist: [ASSET] });
    const acct = await g.get();
    await expect(acct.transfer(send(25_000_000))).resolves.toMatchObject({ fee: 300n });
    expect(g.transfer).toHaveBeenCalledTimes(1);
  });

  it('refuses a payment over the cap before it reaches the wallet', async () => {
    const g = governedAccount({ paymentCap: '100000000', assetAllowlist: [ASSET] });
    const acct = await g.get();
    const err = await acct.transfer(send(100_000_001)).catch((e: unknown) => e);
    expect((err as Error).name).toBe('PolicyViolationError');
    const mapped = mapWalletError(err);
    expect(isWalletError(mapped) && mapped.code).toBe('PolicyDenied');
    expect(mapped.message).toBe('The amount is above your payment limit.');
    expect(g.transfer).not.toHaveBeenCalled();
  });

  it('refuses an asset outside the allowlist', async () => {
    const g = governedAccount({ paymentCap: '100000000', assetAllowlist: [ASSET] });
    const acct = await g.get();
    const err = await acct.transfer(send(1_000_000, 'rgb:other')).catch((e: unknown) => e);
    expect(policyDenied(err)?.message).toBe('This asset is not on your list of approved assets.');
    expect(g.transfer).not.toHaveBeenCalled();
  });

  it('with an empty allowlist only the cap applies', async () => {
    const g = governedAccount({ paymentCap: '5000000', assetAllowlist: [] });
    const acct = await g.get();
    await expect(acct.transfer(send(5_000_000, 'rgb:any'))).resolves.toBeDefined();
    await expect(acct.transfer(send(5_000_001, 'rgb:any'))).rejects.toThrow(/payment limit/);
  });

  it('allows getRgbWallet and keeps unlisted write methods denied', async () => {
    const g = governedAccount({ paymentCap: '100000000', assetAllowlist: [] });
    const acct = await g.get();
    expect(await acct.getRgbWallet()).toBe(g.rgbWallet);
    await expect(Promise.resolve().then(() => acct.issueAssetNia({}))).rejects.toThrow(
      /no policy rule explicitly allowed/,
    );
  });

  it('refuses a payment that would go over the rolling daily limit', async () => {
    let spent = 0;
    const g = governedAccount({ paymentCap: '100000000', assetAllowlist: [], dailyCap: '150000000' }, () => spent);
    const acct = await g.get();
    await expect(acct.transfer(send(100_000_000))).resolves.toBeDefined();
    spent = 100_000_000; // the wallet now reports what was sent in the last 24 h
    const err = await acct.transfer(send(60_000_000)).catch((e: unknown) => e);
    expect(policyDenied(err)?.message).toBe('This payment would go over your daily spending limit.');
    await expect(acct.transfer(send(50_000_000))).resolves.toBeDefined();
    expect(g.transfer).toHaveBeenCalledTimes(2);
  });

  it('rejects a nonsense cap', () => {
    expect(() => buildSpendPolicy({ paymentCap: '0', assetAllowlist: [] })).toThrow(/PAYMENT_CAP/);
  });
});
