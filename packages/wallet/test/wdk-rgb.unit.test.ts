// WdkRgbWallet logic with a fake WDK account: no chain, no funds. Live behaviour is in walletport.contract.test.ts.
import { isWalletError, SubmitTimeout } from 'core';
import { describe, expect, it, vi } from 'vitest';
import { mapWalletError, type RgbAccount, type SdkTransfer, WdkRgbWallet } from '../src/backend/wdk-rgb.js';
import { walletConfigFromEnv } from '../src/config.js';

const ASSET = 'rgb:asset-test';
const now = Math.floor(Date.now() / 1000);

function fake(opts: {
  spendable?: number;
  expiry?: number;
  transfer?: () => Promise<{ hash: string; fee: bigint }>;
  noUtxoFirst?: boolean;
  sendTimeoutMs?: number;
}) {
  let noUtxo = opts.noUtxoFirst ?? false;
  const transfers: SdkTransfer[] = [];
  const send: SdkTransfer = {
    idx: 7,
    batchTransferIdx: 7,
    createdAt: now,
    updatedAt: now,
    status: 'WaitingCounterparty',
    requestedAssignment: { Fungible: 5000000 },
    assignments: [],
    kind: 'Send',
    txid: 'ab'.repeat(32),
  };
  const sdk = {
    decodeRGBInvoice: () => ({
      recipientId: 'utxob:x',
      network: 'Regtest',
      assignment: { Fungible: 5000000 },
      expirationTimestamp: opts.expiry ?? now + 600,
      transportEndpoints: [],
    }),
    getAssetBalance: () => ({ settled: 10_000_000, future: 10_000_000, spendable: opts.spendable ?? 10_000_000 }),
    listTransfers: () => [...transfers],
    refreshWallet: vi.fn(),
    syncWallet: vi.fn(),
    listUnspents: () => [],
    createUtxos: vi.fn(async () => 5),
  };
  const transfer = vi.fn(async () => {
    if (noUtxo) {
      noUtxo = false;
      throw new Error('InsufficientAllocationSlots');
    }
    transfers.push(send); // the send went out, whatever the call returns
    if (opts.transfer) return opts.transfer();
    return { hash: send.txid as string, fee: 155n };
  });
  const account = {
    getRgbWallet: () => sdk,
    getAddress: () => 'bcrt1qx',
    quoteTransfer: vi.fn(async () => ({ fee: 155n })),
    transfer,
  } as unknown as RgbAccount;
  const cfg = walletConfigFromEnv({ RGB_NETWORK: 'regtest', WALLET_DATA_DIR: '/nonexistent' });
  const wallet = new WdkRgbWallet(opts.sendTimeoutMs ? { ...cfg, sendTimeoutMs: opts.sendTimeoutMs } : cfg, {
    account,
  });
  return { wallet, transfer, sdk };
}

const req = { rgbInvoice: 'rgb:~/~/x', assetId: ASSET, amount: '5000000' };

describe('WdkRgbWallet.pay', () => {
  it('passes an explicit feeRate and returns transfer ID and txid', async () => {
    const { wallet, transfer } = fake({});
    const r = await wallet.pay(req);
    expect(r).toEqual({ transferId: '7', txid: 'ab'.repeat(32) });
    expect(transfer).toHaveBeenCalledWith({ token: ASSET, recipient: req.rgbInvoice, amount: 5000000, feeRate: 2 });
  });

  it('a send that hangs after signing → SubmitTimeout after WALLET_SEND_TIMEOUT_MS, with the transfer found', async () => {
    const { wallet, transfer, sdk } = fake({ transfer: () => new Promise(() => undefined), sendTimeoutMs: 1000 });
    const t = Date.now();
    const err = await wallet.pay(req).catch((e: unknown) => e);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(err).toBeInstanceOf(SubmitTimeout);
    expect((err as SubmitTimeout).transferId).toBe('7');
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(sdk.syncWallet).toHaveBeenCalled();
  });

  it('after a timeout: no second send, one sync, SubmitTimeout carries the transfer found', async () => {
    const { wallet, transfer, sdk } = fake({ transfer: async () => Promise.reject(new Error('request timed out')) });
    const err = await wallet.pay(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmitTimeout);
    expect((err as SubmitTimeout).transferId).toBe('7');
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(sdk.syncWallet).toHaveBeenCalledTimes(1);
  });

  it('on NoUtxo before signing: creates UTXOs and sends once more', async () => {
    const { wallet, transfer, sdk } = fake({ noUtxoFirst: true });
    expect(await wallet.pay(req)).toMatchObject({ transferId: '7' });
    expect(sdk.createUtxos).toHaveBeenCalledTimes(1);
    expect(transfer).toHaveBeenCalledTimes(2);
  });

  it('refuses an expired invoice before sending', async () => {
    const { wallet, transfer } = fake({ expiry: now - 1 });
    const err = await wallet.pay(req).catch((e: unknown) => e);
    expect(isWalletError(err) && err.code).toBe('InvoiceExpired');
    expect(transfer).not.toHaveBeenCalled();
  });

  it('refuses insufficient funds before sending', async () => {
    const { wallet, transfer } = fake({ spendable: 4_999_999 });
    const err = await wallet.pay(req).catch((e: unknown) => e);
    expect(isWalletError(err) && err.code).toBe('InsufficientFunds');
    expect(transfer).not.toHaveBeenCalled();
  });

  it('refuses an amount that differs from the invoice', async () => {
    const { wallet, transfer } = fake({});
    const err = await wallet.pay({ ...req, amount: '6000000' }).catch((e: unknown) => e);
    expect(isWalletError(err) && err.code).toBe('TransferFailed');
    expect(transfer).not.toHaveBeenCalled();
  });

  it('maps outgoing transfers with the requested amount', async () => {
    const { wallet } = fake({});
    await wallet.pay(req);
    const [t] = await wallet.listTransfers(ASSET);
    expect(t).toMatchObject({
      transferId: '7',
      direction: 'outgoing',
      amount: '5000000',
      status: 'WaitingCounterparty',
    });
  });
});

describe('mapWalletError', () => {
  it.each([
    ['InsufficientSpendableAssets', 'InsufficientFunds'],
    ['InsufficientBitcoins: needed 1000', 'NoUtxo'],
    ['AssetNotFound: rgb:abc-def', 'UnknownAsset'],
    ['InvalidInvoice', 'InvalidInvoice'],
    ['connect ETIMEDOUT', 'SubmitTimeout'],
    ['something else', 'TransferFailed'],
  ])('%s → %s', (msg, code) => {
    expect(mapWalletError(new Error(msg)).code).toBe(code);
  });
});
