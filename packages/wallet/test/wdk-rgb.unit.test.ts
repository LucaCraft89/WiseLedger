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

describe('WdkRgbWallet.btcBalance', () => {
  const bal = (n: number) => ({ settled: n, future: n, spendable: n });
  function withSdk(sdk: Record<string, unknown>) {
    const account = { getRgbWallet: () => sdk, getAddress: () => 'bcrt1qx' } as unknown as RgbAccount;
    const cfg = walletConfigFromEnv({ RGB_NETWORK: 'regtest', WALLET_DATA_DIR: '/nonexistent' });
    return new WdkRgbWallet(cfg, { account });
  }

  it('reads the last synced state (skip_sync) instead of syncing on every call', () => {
    const libGet = vi.fn(() => ({ vanilla: bal(1000), colored: bal(0) }));
    const sdkGet = vi.fn(() => ({ vanilla: bal(5), colored: bal(0) }));
    const w = withSdk({ client: { wallet: { getBtcBalance: libGet } }, getBtcBalance: sdkGet });
    expect(w.btcBalance().vanilla.spendable).toBe(1000);
    expect(libGet).toHaveBeenCalledWith(null, true);
    expect(sdkGet).not.toHaveBeenCalled();
  });

  it('falls back to the SDK call when the rgb-lib client is not reachable or fails', () => {
    const sdkGet = vi.fn(() => ({ vanilla: bal(5), colored: bal(0) }));
    expect(withSdk({ getBtcBalance: sdkGet }).btcBalance().vanilla.spendable).toBe(5);
    const failing = withSdk({
      client: {
        wallet: {
          getBtcBalance: () => {
            throw new Error('x');
          },
        },
      },
      getBtcBalance: sdkGet,
    });
    expect(failing.btcBalance().vanilla.spendable).toBe(5);
  });
});

describe('WdkRgbWallet.listTransfers settlement fields', () => {
  // Shapes copied from rgb-lib 0.3.0-beta.8 on Mutinynet (payer's send, payee's blinded receive), paths trimmed.
  const proxy = [{ endpoint: 'https://proxy.kaleidoswap.com/json-rpc', transportType: 'JsonRpc', used: true }];
  const real: SdkTransfer[] = [
    {
      idx: 17,
      batchTransferIdx: 17,
      createdAt: 1792248390,
      updatedAt: 1792248431,
      status: 'Settled',
      requestedAssignment: { Fungible: 25000000 },
      assignments: [{ Fungible: 737000000 }],
      kind: 'Send',
      txid: '633d92804f11322114117efa6281e47e57ae063fd42463123f1288cb19f9d89c',
      recipientId: 'sb:utxob:nWMregt9-EBzFwnn-3aQi_oq-9Rj413o-FBc7nor-tNzGWFr-~w8Ns',
      expiration: 1792251990,
      transportEndpoints: proxy,
      invoiceString: null,
    },
    {
      idx: 56,
      batchTransferIdx: 56,
      createdAt: 1792248303,
      updatedAt: 1792248435,
      status: 'WaitingConfirmations',
      requestedAssignment: { Fungible: 25000000 },
      assignments: [{ Fungible: 25000000 }],
      kind: 'ReceiveWitness',
      txid: null,
      recipientId: 'sb:wvout:abc',
      expiration: 1792334703,
      transportEndpoints: [{ endpoint: 'rpcs://other/json-rpc', used: false }, ...proxy],
    },
  ];
  const account = {
    getRgbWallet: () => ({ listTransfers: () => real }),
    getAddress: () => 'tb1q',
  } as unknown as RgbAccount;
  const wallet = new WdkRgbWallet(walletConfigFromEnv({ RGB_NETWORK: 'regtest', WALLET_DATA_DIR: '/nonexistent' }), {
    account,
  });

  it('maps seal type, transport endpoints (used first), expiry, settle time and schema', async () => {
    const [recv, send] = await wallet.listTransfers(ASSET);
    expect(send).toMatchObject({
      direction: 'outgoing',
      sealType: 'blinded',
      transportEndpoints: ['https://proxy.kaleidoswap.com/json-rpc'],
      expiresAt: '2026-10-17T15:46:30.000Z',
      settledAt: '2026-10-17T14:47:11.000Z',
      schema: 'NIA',
    });
    expect(recv).toMatchObject({
      direction: 'incoming',
      sealType: 'witness',
      transportEndpoints: ['https://proxy.kaleidoswap.com/json-rpc', 'rpcs://other/json-rpc'],
    });
    expect(recv?.settledAt).toBeUndefined();
  });
});
