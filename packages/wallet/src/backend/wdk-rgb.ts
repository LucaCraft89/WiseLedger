// WalletPort on WDK core + @utexo/wdk-wallet-rgb (rgb-lib underneath). Pitfalls handled here (PLAN §3):
// feeRate always passed; some methods exist only on the rgb-sdk wallet (`getRgbWallet()`); receive invoices are
// created without assetId; dispose() throws "Invalid checksum" so it is guarded; amounts cross as base-unit strings.
import WDK from '@tetherto/wdk';
import WalletManagerRgb from '@utexo/wdk-wallet-rgb';
import {
  type AssetBalance,
  type AssetInfo,
  type CreateReceiveRequest,
  type DecodedInvoice,
  InsufficientFunds,
  InvalidInvoice,
  InvoiceExpired,
  type IssueNiaRequest,
  NoUtxo,
  type PaymentRequest,
  type PayResult,
  type QuoteResult,
  type ReceiveInvoice,
  SubmitTimeout,
  TransferFailed,
  type TransferInfo,
  type TransferStatus,
  UnknownAsset,
  WalletError,
  type WalletInfo,
  type WalletPort,
} from 'core';
import { libNetwork, type WalletConfig } from '../config.js';
import { loadOrCreateMnemonic } from '../seed.js';

/** The rgb-sdk WalletManager methods we use (wdk-wallet-rgb 2.0.3 exposes some only there). */
interface RgbSdkWallet {
  registerWallet(): { address: string; btcBalance?: unknown };
  getBtcBalance(): { vanilla: SdkBalance; colored: SdkBalance };
  getAddress(): string;
  listUnspents(): { utxo: { colorable: boolean; btcAmount: number }; rgbAllocations: unknown[] }[];
  listAssets(): { nia?: SdkAsset[] };
  getAssetBalance(assetId: string): Partial<SdkBalance>;
  issueAssetNia(p: { ticker: string; name: string; amounts: number[]; precision: number }): SdkAsset;
  blindReceive(p: { assetId?: string; amount?: number; durationSeconds?: number; minConfirmations?: number }): {
    invoice: string;
    recipientId: string;
    expirationTimestamp: number;
    batchTransferIdx: number;
  };
  decodeRGBInvoice(p: { invoice: string }): {
    recipientId: string;
    assetId?: string;
    network: string;
    assignment: Record<string, unknown>;
    expirationTimestamp?: number;
    transportEndpoints: string[];
  };
  createUtxos(p: { upTo?: boolean; num?: number; size?: number; feeRate?: number }): Promise<number>;
  listTransfers(assetId?: string): SdkTransfer[];
  refreshWallet(): void;
  syncWallet(): void;
}

interface SdkBalance {
  settled: number;
  future: number;
  spendable: number;
}

interface SdkAsset {
  assetId?: string;
  ticker?: string;
  name?: string;
  precision?: number;
  balance?: Partial<SdkBalance>;
}

interface SdkTransfer {
  idx: number;
  batchTransferIdx: number;
  createdAt: number;
  updatedAt: number;
  status: number | string;
  /** Older rgb-sdk shape; 1.0.3 reports requestedAssignment + assignments instead. */
  amount?: number;
  requestedAssignment?: Record<string, unknown> | null;
  assignments?: Record<string, unknown>[];
  kind: number | string;
  txid: string | null;
  recipientId?: string | null;
  invoiceString?: string | null;
  expiration?: number | null;
}

/** Sent: the requested amount (assignments are our change). Issued/received: what was assigned to us. */
function transferAmount(t: SdkTransfer): string {
  if (typeof t.amount === 'number') return str(t.amount);
  const fungible = (a: Record<string, unknown> | null | undefined) =>
    typeof a?.Fungible === 'number' ? a.Fungible : typeof a?.fungible === 'number' ? a.fungible : 0;
  if (toDirection(t.kind) === 'outgoing') return str(fungible(t.requestedAssignment));
  const assigned = (t.assignments ?? []).reduce((sum, a) => sum + fungible(a), 0);
  return str(assigned || fungible(t.requestedAssignment));
}

/** The WDK account surface we use (WalletAccountRgb from wdk-wallet-rgb). */
interface RgbAccount {
  getRgbWallet(): RgbSdkWallet;
  getAddress(): Promise<string> | string;
  quoteTransfer(o: { token: string; recipient: string; amount: number; feeRate: number }): Promise<{ fee: bigint }>;
  transfer(o: { token: string; recipient: string; amount: number; feeRate: number }): Promise<{
    hash: string;
    fee: bigint;
  }>;
}

const STATUS: Record<number, TransferStatus> = {
  0: 'WaitingCounterparty',
  1: 'WaitingConfirmations',
  2: 'Settled',
  3: 'Failed',
};
const KIND: Record<number, TransferInfo['direction']> = {
  0: 'issuance',
  1: 'incoming',
  2: 'incoming',
  3: 'outgoing',
  4: 'issuance',
};

function toStatus(s: number | string): TransferStatus {
  if (typeof s === 'number') return STATUS[s] ?? 'Failed';
  const k = s.toLowerCase().replace(/[_\s]/g, '');
  if (k === 'waitingcounterparty') return 'WaitingCounterparty';
  if (k === 'waitingconfirmations') return 'WaitingConfirmations';
  if (k === 'settled') return 'Settled';
  return 'Failed';
}

function toDirection(k: number | string): TransferInfo['direction'] {
  if (typeof k === 'number') return KIND[k] ?? 'incoming';
  const s = k.toLowerCase();
  if (s.includes('send')) return 'outgoing';
  if (s.includes('issu') || s.includes('inflat')) return 'issuance';
  return 'incoming';
}

/** rgb-lib timestamps are seconds. */
const iso = (sec: number) => new Date(sec * 1000).toISOString();

function toNumber(amount: string): number {
  const n = Number(amount);
  if (!Number.isSafeInteger(n)) throw new TransferFailed(`Amount ${amount} is too large for this wallet.`);
  return n;
}

function str(n: number | undefined): string {
  return String(Math.trunc(n ?? 0));
}

/** Maps rgb-lib / WDK error text to our typed errors (messages stay plain for the UI). */
export function mapWalletError(e: unknown): WalletError {
  if (e instanceof WalletError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/InsufficientSpendableAssets|InsufficientTotalAssets|InsufficientAssignments/i.test(msg))
    return new InsufficientFunds();
  if (/InsufficientBitcoins|InsufficientAllocationSlots|NoAvailableUtxos|InsufficientFunds/i.test(msg))
    return new NoUtxo('The wallet needs more bitcoin or a free UTXO for this RGB operation.');
  if (/AssetNotFound|UnknownRgbSchema/i.test(msg)) return new UnknownAsset(/rgb:[\w-]+/.exec(msg)?.[0] ?? 'requested');
  if (/InvoiceExpired|expired/i.test(msg)) return new InvoiceExpired();
  if (/InvalidInvoice|InvalidRecipient|invalid.*invoice/i.test(msg)) return new InvalidInvoice();
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg)) return new SubmitTimeout();
  return new TransferFailed(msg, { cause: e });
}

export class WdkRgbWallet implements WalletPort {
  private wdk: WDK | null = null;
  private account: RgbAccount | null = null;
  private registered = false;

  constructor(private readonly cfg: WalletConfig) {}

  /** The rgb-sdk wallet, for scripts that need BTC-level calls. */
  get rgb(): RgbSdkWallet {
    if (!this.account) throw new Error('Wallet not initialised: call init() first.');
    return this.account.getRgbWallet();
  }

  async init(): Promise<WalletInfo> {
    if (!this.account) {
      const { mnemonic } = loadOrCreateMnemonic(this.cfg.dataDir);
      // WDK's generic WalletManager typing does not know the RGB config shape.
      const Manager = WalletManagerRgb as unknown as Parameters<WDK['registerWallet']>[1];
      this.wdk = new WDK(mnemonic).registerWallet('rgb', Manager, {
        network: libNetwork(this.cfg.network),
        dataDir: this.cfg.dataDir,
        indexerUrl: this.cfg.indexerUrl,
        transportEndpoint: this.cfg.transportEndpoint,
      } as never);
      this.account = (await this.wdk.getAccount('rgb', 0)) as unknown as RgbAccount;
    }
    if (!this.registered) {
      this.rgb.registerWallet();
      this.registered = true;
    }
    return { backend: 'wdk-rgb', network: this.cfg.network };
  }

  async receiveAddress(): Promise<string> {
    return this.rgb.getAddress();
  }

  btcBalance(): { vanilla: SdkBalance; colored: SdkBalance } {
    return this.rgb.getBtcBalance();
  }

  async listAssets(): Promise<AssetInfo[]> {
    const nia = this.rgb.listAssets().nia ?? [];
    return nia
      .filter((a): a is SdkAsset & { assetId: string } => Boolean(a.assetId))
      .map((a) => ({
        assetId: a.assetId,
        ticker: a.ticker ?? '',
        name: a.name ?? '',
        precision: a.precision ?? 0,
        schema: 'NIA' as const,
        balance: this.balanceFrom(a.balance ?? this.rgb.getAssetBalance(a.assetId)),
      }));
  }

  async assetBalance(assetId: string): Promise<AssetBalance> {
    try {
      return this.balanceFrom(this.rgb.getAssetBalance(assetId));
    } catch (e) {
      throw mapWalletError(e);
    }
  }

  async createUtxosIfNeeded(): Promise<{ created: number }> {
    const free = this.rgb.listUnspents().filter((u) => u.utxo.colorable && u.rgbAllocations.length === 0).length;
    if (free >= 2) return { created: 0 };
    try {
      const created = await this.rgb.createUtxos({ upTo: true, num: 5, size: 1000, feeRate: this.cfg.feeRate });
      return { created };
    } catch (e) {
      if (/AllocationsAlreadyAvailable/i.test(String(e))) return { created: 0 };
      throw mapWalletError(e);
    }
  }

  async issueAssetNia(req: IssueNiaRequest): Promise<AssetInfo> {
    if (req.ticker !== req.ticker.toUpperCase()) throw new Error('NIA ticker must be uppercase.');
    try {
      const a = this.rgb.issueAssetNia({
        ticker: req.ticker,
        name: req.name,
        precision: req.precision,
        amounts: req.amounts.map(toNumber),
      });
      if (!a.assetId) throw new TransferFailed('Issuance returned no asset ID.');
      return {
        assetId: a.assetId,
        ticker: a.ticker ?? req.ticker,
        name: a.name ?? req.name,
        precision: a.precision ?? req.precision,
        schema: 'NIA',
        balance: this.balanceFrom(this.rgb.getAssetBalance(a.assetId)),
      };
    } catch (e) {
      throw mapWalletError(e);
    }
  }

  async createReceiveInvoice(req: CreateReceiveRequest): Promise<ReceiveInvoice> {
    try {
      // A receiver cannot name an asset it has never seen (AssetNotFound): the payer names it.
      const r = this.rgb.blindReceive({
        ...(req.assetId ? { assetId: req.assetId } : {}),
        ...(req.amount ? { amount: toNumber(req.amount) } : {}),
        durationSeconds: req.expirySec,
        minConfirmations: 1,
      });
      return {
        rgbInvoice: r.invoice,
        recipientId: r.recipientId,
        ...(req.assetId ? { assetId: req.assetId } : {}),
        ...(req.amount ? { amount: req.amount } : {}),
        expiresAt: iso(r.expirationTimestamp),
      };
    } catch (e) {
      throw mapWalletError(e);
    }
  }

  async decodeInvoice(rgbInvoice: string): Promise<DecodedInvoice> {
    let d: ReturnType<RgbSdkWallet['decodeRGBInvoice']>;
    try {
      d = this.rgb.decodeRGBInvoice({ invoice: rgbInvoice });
    } catch {
      throw new InvalidInvoice();
    }
    const amount = assignmentAmount(d.assignment);
    return {
      rgbInvoice,
      recipientId: d.recipientId,
      ...(d.assetId ? { assetId: d.assetId } : {}),
      ...(amount ? { amount } : {}),
      network: String(d.network),
      ...(d.expirationTimestamp ? { expiresAt: iso(d.expirationTimestamp) } : {}),
      transportEndpoints: d.transportEndpoints ?? [],
    };
  }

  async quotePay(req: PaymentRequest): Promise<QuoteResult> {
    const feeRate = req.feeRate ?? this.cfg.feeRate;
    await this.precheck(req);
    try {
      const { fee } = await this.acct().quoteTransfer({
        token: req.assetId,
        recipient: req.rgbInvoice,
        amount: toNumber(req.amount),
        feeRate,
      });
      return { fee: fee.toString(), feeRate };
    } catch (e) {
      throw mapWalletError(e);
    }
  }

  async pay(req: PaymentRequest): Promise<PayResult> {
    const feeRate = req.feeRate ?? this.cfg.feeRate;
    await this.precheck(req);
    const before = new Set(this.rgb.listTransfers(req.assetId).map((t) => t.batchTransferIdx));
    let hash: string;
    try {
      ({ hash } = await this.acct().transfer({
        token: req.assetId,
        recipient: req.rgbInvoice,
        amount: toNumber(req.amount),
        feeRate,
      }));
    } catch (e) {
      throw mapWalletError(e);
    }
    const created = this.rgb
      .listTransfers(req.assetId)
      .find((t) => !before.has(t.batchTransferIdx) && toDirection(t.kind) === 'outgoing');
    const transferId = created ? String(created.batchTransferIdx) : `tx:${hash}`;
    return { transferId, ...(hash && hash !== 'unknown' ? { txid: hash } : {}) };
  }

  async getTransfer(transferId: string): Promise<TransferInfo | null> {
    return (await this.listTransfers()).find((t) => t.transferId === transferId) ?? null;
  }

  async listTransfers(assetId?: string): Promise<TransferInfo[]> {
    const assetIds = assetId
      ? [assetId]
      : (this.rgb.listAssets().nia ?? []).flatMap((a) => (a.assetId ? [a.assetId] : []));
    const out: TransferInfo[] = [];
    for (const id of assetIds) {
      for (const t of this.rgb.listTransfers(id)) {
        out.push({
          transferId: String(t.batchTransferIdx),
          assetId: id,
          amount: transferAmount(t),
          direction: toDirection(t.kind),
          status: toStatus(t.status),
          ...(t.txid ? { txid: t.txid } : {}),
          ...(t.invoiceString ? { rgbInvoice: t.invoiceString } : {}),
          createdAt: iso(t.createdAt),
          updatedAt: iso(t.updatedAt),
        });
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Refreshes pending transfers (exchanges consignments with the proxy) and syncs with the indexer. */
  async sync(): Promise<void> {
    try {
      this.rgb.refreshWallet();
    } finally {
      this.rgb.syncWallet();
    }
  }

  /** Never call the library dispose(): it throws "Invalid checksum" in 2.0.3. */
  close(): void {
    this.account = null;
    this.wdk = null;
  }

  private acct(): RgbAccount {
    if (!this.account) throw new Error('Wallet not initialised: call init() first.');
    return this.account;
  }

  private async precheck(req: PaymentRequest): Promise<void> {
    const inv = await this.decodeInvoice(req.rgbInvoice);
    if (inv.expiresAt && Date.parse(inv.expiresAt) <= Date.now()) throw new InvoiceExpired();
    if (inv.assetId && inv.assetId !== req.assetId)
      throw new TransferFailed(`The invoice asks for asset ${inv.assetId}, not ${req.assetId}.`);
    if (inv.amount && inv.amount !== req.amount)
      throw new TransferFailed(`The invoice asks for ${inv.amount}, not ${req.amount}.`);
    if (BigInt(req.amount) <= 0n) throw new TransferFailed('The amount must be greater than zero.');
    const bal = await this.assetBalance(req.assetId);
    if (BigInt(req.amount) > BigInt(bal.spendable)) throw new InsufficientFunds();
  }

  private balanceFrom(b: Partial<SdkBalance>): AssetBalance {
    return { settled: str(b.settled), future: str(b.future), spendable: str(b.spendable) };
  }
}

/** rgb-lib Assignment: { Fungible: n } (or { type, value } in some bindings); returns base units or undefined. */
function assignmentAmount(a: Record<string, unknown> | undefined): string | undefined {
  if (!a) return undefined;
  const v = a.Fungible ?? a.fungible ?? (a.type === 'Fungible' ? a.value : undefined);
  return typeof v === 'number' && v > 0 ? String(v) : undefined;
}
