// In-memory WalletPort for tests, demos and lane B. Statuses advance with time (no timers to clean up):
// WaitingCounterparty → WaitingConfirmations → Settled, each step `stepMs` long (0 = settle at once).
import {
  type AssetBalance,
  type AssetInfo,
  type CreateReceiveRequest,
  type DecodedInvoice,
  InsufficientFunds,
  InvalidInvoice,
  InvoiceExpired,
  type IssueNiaRequest,
  type LightningStatus,
  type OnboardingInfo,
  type PaymentRequest,
  type PayResult,
  type QuoteResult,
  type ReceiveInvoice,
  SubmitTimeout,
  TransferFailed,
  type TransferInfo,
  type TransferStatus,
  UnknownAsset,
  type WalletInfo,
  type WalletPort,
} from '../wallet.js';

export const MOCK_ASSET_ID = 'rgb:mock-tusdt';
export const MOCK_INVOICE_PREFIX = 'rgb:mock/';
/** Mock RGB Lightning invoice: same shape (`lnrgb:mock/<assetId>/<amount>/<expiry>`), paid instantly over a channel. */
export const MOCK_LN_INVOICE_PREFIX = 'lnrgb:mock/';
/** pay() with this amount throws TransferFailed. */
export const MOCK_FAIL_AMOUNT = '13130000';
/** pay() with this amount throws SubmitTimeout, but the transfer really goes out (as on chain). */
export const MOCK_TIMEOUT_AMOUNT = '13140000';

/** Deterministic fake payment hash (64 hex) for a mock Lightning invoice. */
function mockHash(invoice: string): string {
  let out = '';
  for (let k = 0; k < 8; k++) {
    let h = 2166136261 ^ k;
    for (const c of invoice) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

export interface MockWalletOptions {
  /** Duration of each status step in ms (default 3000, 0 = settled immediately). */
  stepMs?: number;
  /** Initial settled TUSDT balance in base units (default 1000 tokens). */
  balance?: string;
  failAmount?: string;
  timeoutAmount?: string;
  /** Clock, for tests. */
  now?: () => number;
}

interface MockAsset {
  info: Omit<AssetInfo, 'balance'>;
}

interface MockTransfer {
  transferId: string;
  assetId: string;
  amount: bigint;
  direction: TransferInfo['direction'];
  rgbInvoice?: string;
  txid?: string;
  paymentHash?: string;
  createdAt: number;
  failed: boolean;
}

/** Builds a mock RGB invoice: `rgb:mock/<assetId|any>/<amount|any>/<expiryEpochSec>`. */
export function mockInvoice(assetId: string | undefined, amount: string | undefined, expiryEpochSec: number): string {
  return `${MOCK_INVOICE_PREFIX}${assetId ?? 'any'}/${amount ?? 'any'}/${expiryEpochSec}`;
}

export class MockWallet implements WalletPort {
  private readonly stepMs: number;
  private readonly failAmount: string;
  private readonly timeoutAmount: string;
  private readonly now: () => number;
  private readonly assets = new Map<string, MockAsset>();
  private readonly transfers: MockTransfer[] = [];
  private seq = 0;

  constructor(opts: MockWalletOptions = {}) {
    this.stepMs = opts.stepMs ?? 3000;
    this.failAmount = opts.failAmount ?? MOCK_FAIL_AMOUNT;
    this.timeoutAmount = opts.timeoutAmount ?? MOCK_TIMEOUT_AMOUNT;
    this.now = opts.now ?? Date.now;
    const balance = BigInt(opts.balance ?? '1000000000');
    this.assets.set(MOCK_ASSET_ID, {
      info: { assetId: MOCK_ASSET_ID, ticker: 'TUSDT', name: 'Test USDT (mock)', precision: 6, schema: 'NIA' },
    });
    this.record(MOCK_ASSET_ID, balance, 'issuance');
  }

  async init(): Promise<WalletInfo> {
    return { backend: 'mock', network: 'mock' };
  }

  async onboarding(_opts?: { reveal?: boolean }): Promise<OnboardingInfo> {
    return { walletCreated: false, seedShown: true };
  }

  async receiveAddress(): Promise<string> {
    return `tb1qmock${(++this.seq).toString().padStart(8, '0')}`;
  }

  async listAssets(): Promise<AssetInfo[]> {
    return [...this.assets.values()].map((a) => ({ ...a.info, balance: this.balanceOf(a.info.assetId) }));
  }

  async assetBalance(assetId: string): Promise<AssetBalance> {
    if (!this.assets.has(assetId)) throw new UnknownAsset(assetId);
    return this.balanceOf(assetId);
  }

  async createUtxosIfNeeded(): Promise<{ created: number }> {
    return { created: 0 };
  }

  async issueAssetNia(req: IssueNiaRequest): Promise<AssetInfo> {
    if (req.ticker !== req.ticker.toUpperCase()) throw new Error('NIA ticker must be uppercase');
    const assetId = `rgb:mock-${req.ticker.toLowerCase()}`;
    const total = req.amounts.reduce((s, a) => s + BigInt(a), 0n);
    if (!this.assets.has(assetId))
      this.assets.set(assetId, {
        info: { assetId, ticker: req.ticker, name: req.name, precision: req.precision, schema: 'NIA' },
      });
    this.record(assetId, total, 'issuance');
    const info = this.assets.get(assetId)?.info;
    if (!info) throw new Error('unreachable');
    return { ...info, balance: this.balanceOf(assetId) };
  }

  async createReceiveInvoice(req: CreateReceiveRequest): Promise<ReceiveInvoice> {
    const expiry = Math.floor(this.now() / 1000) + req.expirySec;
    const rgbInvoice = mockInvoice(req.assetId, req.amount, expiry);
    return {
      rgbInvoice,
      recipientId: `mock-recipient-${++this.seq}`,
      ...(req.assetId ? { assetId: req.assetId } : {}),
      ...(req.amount ? { amount: req.amount } : {}),
      expiresAt: new Date(expiry * 1000).toISOString(),
    };
  }

  async decodeInvoice(rgbInvoice: string): Promise<DecodedInvoice> {
    const ln = rgbInvoice.startsWith(MOCK_LN_INVOICE_PREFIX);
    if (!ln && !rgbInvoice.startsWith(MOCK_INVOICE_PREFIX)) throw new InvalidInvoice();
    const parts = rgbInvoice.slice((ln ? MOCK_LN_INVOICE_PREFIX : MOCK_INVOICE_PREFIX).length).split('/');
    const [assetId, amount, expiry] = parts;
    if (parts.length !== 3 || !assetId || !amount || !expiry || !/^\d+$/.test(expiry)) throw new InvalidInvoice();
    if (amount !== 'any' && !/^(0|[1-9]\d*)$/.test(amount)) throw new InvalidInvoice();
    return {
      rgbInvoice,
      recipientId: `mock-recipient-${expiry}`,
      ...(assetId !== 'any' ? { assetId } : {}),
      ...(amount !== 'any' ? { amount } : {}),
      network: 'mock',
      expiresAt: new Date(Number(expiry) * 1000).toISOString(),
      transportEndpoints: ln ? [] : ['mock://transport'],
      ...(ln ? { rail: 'lightning' as const, paymentHash: mockHash(rgbInvoice) } : {}),
    };
  }

  async quotePay(req: PaymentRequest): Promise<QuoteResult> {
    await this.validate(req);
    return { fee: '300', feeRate: req.feeRate ?? 2 };
  }

  async pay(req: PaymentRequest): Promise<PayResult> {
    await this.validate(req);
    if (req.rgbInvoice.startsWith(MOCK_LN_INVOICE_PREFIX)) {
      const local = BigInt((await this.lightningStatus()).channels[0]?.localAsset ?? '0');
      if (BigInt(req.amount) > local) {
        throw new InsufficientFunds('Not enough in the Lightning channel for this payment. Pay on-chain instead.');
      }
    }
    if (req.amount === this.failAmount) throw new TransferFailed('Simulated transfer failure (mock failure amount).');
    const t = this.record(req.assetId, BigInt(req.amount), 'outgoing', req.rgbInvoice);
    if (req.amount === this.timeoutAmount) throw new SubmitTimeout();
    return {
      transferId: t.transferId,
      ...(t.txid ? { txid: t.txid } : {}),
      ...(t.paymentHash ? { paymentHash: t.paymentHash } : {}),
    };
  }

  async getTransfer(transferId: string): Promise<TransferInfo | null> {
    const t = this.transfers.find((x) => x.transferId === transferId);
    return t ? this.view(t) : null;
  }

  async listTransfers(assetId?: string): Promise<TransferInfo[]> {
    return this.transfers.filter((t) => !assetId || t.assetId === assetId).map((t) => this.view(t));
  }

  async sync(): Promise<void> {}

  /** One usable mock channel to a mock LSP, its TUSDT on our side minus what was paid over Lightning. */
  async lightningStatus(): Promise<LightningStatus> {
    const paid = this.transfers
      .filter((t) => t.paymentHash && t.direction === 'outgoing' && !t.failed)
      .reduce((s, t) => s + t.amount, 0n);
    const local = 50_000_000n - paid;
    return {
      enabled: true,
      nodePubkey: `02${'c'.repeat(64)}`,
      channels: [
        {
          channelId: 'mock-channel-1',
          peer: `03${'a'.repeat(64)}`,
          assetId: MOCK_ASSET_ID,
          localAsset: (local > 0n ? local : 0n).toString(),
          remoteAsset: paid.toString(),
          usable: true,
        },
      ],
    };
  }

  private async validate(req: PaymentRequest): Promise<void> {
    const inv = await this.decodeInvoice(req.rgbInvoice);
    if (inv.expiresAt && Date.parse(inv.expiresAt) <= this.now()) throw new InvoiceExpired();
    if (!this.assets.has(req.assetId)) throw new UnknownAsset(req.assetId);
    if (inv.assetId && inv.assetId !== req.assetId)
      throw new TransferFailed(`The invoice asks for asset ${inv.assetId}, not ${req.assetId}.`);
    if (inv.amount && inv.amount !== req.amount)
      throw new TransferFailed(`The invoice asks for ${inv.amount}, not ${req.amount}.`);
    const amount = BigInt(req.amount);
    if (amount <= 0n) throw new TransferFailed('The amount must be greater than zero.');
    if (amount > BigInt(this.balanceOf(req.assetId).spendable)) throw new InsufficientFunds();
  }

  private record(assetId: string, amount: bigint, direction: TransferInfo['direction'], rgbInvoice?: string) {
    const n = ++this.seq;
    const t: MockTransfer = {
      transferId: `mock-transfer-${n}`,
      assetId,
      amount,
      direction,
      createdAt: this.now(),
      failed: false,
      ...(rgbInvoice ? { rgbInvoice } : {}),
      ...(rgbInvoice?.startsWith(MOCK_LN_INVOICE_PREFIX)
        ? { paymentHash: mockHash(rgbInvoice) }
        : direction !== 'issuance'
          ? { txid: n.toString(16).padStart(64, 'a') }
          : {}),
    };
    this.transfers.push(t);
    return t;
  }

  private status(t: MockTransfer): TransferStatus {
    if (t.failed) return 'Failed';
    if (t.direction === 'issuance' || t.paymentHash) return 'Settled'; // Lightning: instant
    const elapsed = this.now() - t.createdAt;
    if (elapsed < this.stepMs) return 'WaitingCounterparty';
    if (elapsed < 2 * this.stepMs) return 'WaitingConfirmations';
    return 'Settled';
  }

  private view(t: MockTransfer): TransferInfo {
    const status = this.status(t);
    const stepsDone = status === 'WaitingCounterparty' ? 0 : status === 'WaitingConfirmations' ? 1 : 2;
    return {
      transferId: t.transferId,
      assetId: t.assetId,
      amount: t.amount.toString(),
      direction: t.direction,
      status,
      ...(t.txid ? { txid: t.txid } : {}),
      ...(t.paymentHash ? { rail: 'lightning' as const, paymentHash: t.paymentHash } : {}),
      ...(t.rgbInvoice
        ? { rgbInvoice: t.rgbInvoice, recipientId: `mock-recipient-${t.rgbInvoice.split('/').at(-1)}` }
        : {}),
      createdAt: new Date(t.createdAt).toISOString(),
      updatedAt: new Date(
        t.direction === 'issuance' ? t.createdAt : t.createdAt + stepsDone * this.stepMs,
      ).toISOString(),
    };
  }

  private balanceOf(assetId: string): AssetBalance {
    let settled = 0n;
    let future = 0n;
    for (const t of this.transfers) {
      if (t.assetId !== assetId || t.failed) continue;
      const sign = t.direction === 'outgoing' ? -1n : 1n;
      future += sign * t.amount;
      if (this.status(t) === 'Settled') settled += sign * t.amount;
    }
    // Pending outgoing amounts are locked: spendable never exceeds what remains after them.
    const spendable = future < settled ? future : settled;
    return { settled: settled.toString(), future: future.toString(), spendable: spendable.toString() };
  }
}
