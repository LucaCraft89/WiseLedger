// WalletPort on WDK core + @utexo/wdk-wallet-rgb (rgb-lib underneath). Pitfalls handled here (PLAN §3):
// feeRate always passed; some methods exist only on the rgb-sdk wallet (`getRgbWallet()`); receive invoices are
// created without assetId; dispose() throws "Invalid checksum" so it is guarded; amounts cross as base-unit strings.
import fs from 'node:fs';
import path from 'node:path';
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
  type OnboardingInfo,
  type PaymentRequest,
  type PayResult,
  type QuoteResult,
  type ReceiveInvoice,
  SubmitTimeout,
  sealTypeOfRecipient,
  TransferFailed,
  type TransferInfo,
  type TransferStatus,
  UnknownAsset,
  WalletError,
  type WalletInfo,
  type WalletPort,
} from 'core';
import { libNetwork, type WalletConfig } from '../config.js';
import { lockWalletDir, unlockWalletDir } from '../lock.js';
import { buildSpendPolicy, policyDenied } from '../policy.js';
import { type ReadRetryOptions, withReadRetry } from '../retry.js';
import { loadOrCreateMnemonic, readSeed } from '../seed.js';

/** The rgb-sdk WalletManager methods we use (wdk-wallet-rgb 2.0.3 exposes some only there). */
export interface RgbSdkWallet {
  registerWallet(): { address: string; btcBalance?: unknown };
  getBtcBalance(): { vanilla: SdkBalance; colored: SdkBalance };
  getAddress(): string;
  /** Plain BTC send (scripts only: test sats between our own wallets; RGB payments go through pay()). */
  sendBtc(p: { address: string; amount: number; feeRate: number; skipSync?: boolean }): Promise<string>;
  listUnspents(): { utxo: { colorable: boolean; btcAmount: number }; rgbAllocations: unknown[] }[];
  /** On-chain movements (BDK): `sent` = the wallet's inputs, `received` = outputs back to the wallet. */
  listTransactions(): SdkTransaction[];
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
  createBackup(p: { backupPath: string; password: string }): { message: string; backupPath: string };
}

/** rgb-sdk TransactionType: 0 RGB_SEND, 1 DRAIN, 2 CREATE_UTXOS, 3 USER. */
export interface SdkTransaction {
  transactionType: number;
  txid: string;
  received: number;
  sent: number;
  fee: number;
  confirmationTime?: { height: number; timestamp: number };
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

/** rgb-sdk's internal client: the rgb-lib binding and the transport endpoint it was built with. */
interface RgbLibClient {
  transportEndpoint: string;
  wallet: {
    /** rgb-lib: `online` may be null when `skipSync` is true (a local read of the last synced state). */
    getBtcBalance?(online: null, skipSync: boolean): { vanilla: SdkBalance; colored: SdkBalance };
    blindReceive(
      assetId: string | null,
      assignment: string,
      durationSeconds: string,
      transportEndpoints: string[],
      minConfirmations: string,
    ): ReturnType<RgbSdkWallet['blindReceive']>;
  };
}

export interface SdkTransfer {
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
  /** rgb-lib 0.3.0-beta.8: [{ endpoint: 'https://proxy…/json-rpc', transportType: 'JsonRpc', used: true }]. */
  transportEndpoints?: { endpoint: string; transportType?: unknown; used?: boolean }[];
}

/** ReceiveBlind / ReceiveWitness from the kind; a send's seal from the recipient ID it paid. */
function sealType(t: SdkTransfer): TransferInfo['sealType'] {
  const k = typeof t.kind === 'number' ? t.kind : t.kind.toLowerCase();
  if (k === 1 || k === 'receiveblind') return 'blinded';
  if (k === 2 || k === 'receivewitness') return 'witness';
  return toDirection(t.kind) === 'outgoing' ? sealTypeOfRecipient(t.recipientId ?? undefined) : undefined;
}

function endpoints(t: SdkTransfer): string[] {
  return [...(t.transportEndpoints ?? [])].sort((a, b) => Number(!!b.used) - Number(!!a.used)).map((e) => e.endpoint);
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
export interface RgbAccount {
  /** Async once the WDK policy proxy governs the account. */
  getRgbWallet(): RgbSdkWallet | Promise<RgbSdkWallet>;
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
  const denied = policyDenied(e);
  if (denied) return denied;
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

/** Rejects with SubmitTimeout after `ms` (the send may be out: callers never retry it). */
export function withSendTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SubmitTimeout(`The wallet did not answer within ${Math.round(ms / 1000)} s after sending.`)),
      ms,
    );
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

export class WdkRgbWallet implements WalletPort {
  private wdk: WDK | null = null;
  private account: RgbAccount | null = null;
  private registered = false;
  private created = false;
  /** Raw rgb-sdk wallet, fetched once through the governed account (governed calls are async). */
  private sdk: RgbSdkWallet | null = null;

  /** `deps.account` injects a fake WDK account in tests (no native code, no chain). */
  constructor(
    private readonly cfg: WalletConfig,
    deps: { account?: RgbAccount; retry?: ReadRetryOptions } = {},
  ) {
    this.passphrase = cfg.seedPassphrase;
    this.retry = deps.retry ?? {};
    if (deps.account) {
      this.account = deps.account;
      this.sdk = deps.account.getRgbWallet() as RgbSdkWallet;
      this.registered = true;
    }
  }

  /** Backoff for network reads (sync/refresh); a test seam. */
  private readonly retry: ReadRetryOptions;
  /** Seed passphrase (wallet lock), from WALLET_PASSPHRASE or unlock(). */
  private passphrase: string | undefined;

  /** Unlocks an encrypted seed and opens the wallet (WalletLocked on a wrong passphrase). */
  async unlock(passphrase: string): Promise<WalletInfo> {
    readSeed(this.cfg.dataDir, passphrase);
    this.passphrase = passphrase;
    return this.init();
  }

  /** The configuration this wallet was opened with (scripts: restore drill). */
  get config(): WalletConfig {
    return this.cfg;
  }

  /** The rgb-sdk wallet, for scripts that need BTC-level calls. */
  get rgb(): RgbSdkWallet {
    if (!this.sdk) throw new Error('Wallet not initialised: call init() first.');
    return this.sdk;
  }

  async init(): Promise<WalletInfo> {
    if (!this.account) {
      lockWalletDir(this.cfg.dataDir);
      const { mnemonic, created } = loadOrCreateMnemonic(this.cfg.dataDir, { passphrase: this.passphrase });
      this.created = created;
      // WDK's generic WalletManager typing does not know the RGB config shape.
      const Manager = WalletManagerRgb as unknown as Parameters<WDK['registerWallet']>[1];
      this.wdk = new WDK(mnemonic).registerWallet('rgb', Manager, {
        network: libNetwork(this.cfg.network),
        dataDir: this.cfg.dataDir,
        indexerUrl: this.cfg.indexerUrl,
        transportEndpoint: this.cfg.transportEndpoint,
      } as never);
      // Spend limits live in WDK: every transfer passes the policy engine before signing.
      this.wdk.registerPolicy([buildSpendPolicy(this.cfg, (assetId) => this.spentLast24h(assetId))] as never);
      this.account = (await this.wdk.getAccount('rgb', 0)) as unknown as RgbAccount;
      this.sdk = await this.account.getRgbWallet();
    }
    if (!this.registered) {
      this.rgb.registerWallet();
      this.registered = true;
    }
    return { backend: 'wdk-rgb', network: this.cfg.network };
  }

  async onboarding(opts: { reveal?: boolean } = {}): Promise<OnboardingInfo> {
    const marker = path.join(this.cfg.dataDir, 'seed-shown');
    const seedShown = fs.existsSync(marker);
    if (!opts.reveal || seedShown) return { walletCreated: this.created, seedShown };
    const mnemonic = readSeed(this.cfg.dataDir, this.passphrase);
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
    return { walletCreated: this.created, seedShown: true, mnemonic };
  }

  async receiveAddress(): Promise<string> {
    return this.rgb.getAddress();
  }

  /**
   * BTC balance as of the last sync. rgb-sdk's getBtcBalance() runs a full indexer sync on every call (skip_sync =
   * false), a blocking native call of ~3 s on Mutinynet that froze the whole server on each /api/health and
   * /api/wallet. The background sync loop (and the kick after a payment) keep the local state fresh, so read it
   * with skip_sync = true; fall back to the SDK call only if the rgb-lib client is not reachable.
   */
  btcBalance(): { vanilla: SdkBalance; colored: SdkBalance } {
    const lib = (this.rgb as unknown as { client?: RgbLibClient }).client?.wallet;
    if (lib?.getBtcBalance) {
      try {
        return lib.getBtcBalance(null, true);
      } catch {
        // fall through to the syncing call
      }
    }
    return this.rgb.getBtcBalance();
  }

  /** On-chain Bitcoin movements (not RGB transfers); duck-typed by the server like btcBalance(). */
  btcTransactions(): SdkTransaction[] {
    return this.rgb.listTransactions();
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

  /**
   * Creates colorable UTXOs when fewer than 2 look free. `force` creates more even then: pending receive invoices
   * reserve UTXOs that still show no allocation, so a NoUtxo from rgb-lib is the reliable signal.
   */
  async createUtxosIfNeeded(force = false): Promise<{ created: number }> {
    const free = this.rgb.listUnspents().filter((u) => u.utxo.colorable && u.rgbAllocations.length === 0).length;
    if (free >= 2 && !force) return { created: 0 };
    try {
      const created = await this.rgb.createUtxos({ upTo: !force, num: 5, size: 1000, feeRate: this.cfg.feeRate });
      return { created };
    } catch (e) {
      if (/AllocationsAlreadyAvailable/i.test(String(e))) return { created: 0 };
      throw mapWalletError(e);
    }
  }

  /** Runs an RGB operation; on NoUtxo creates UTXOs once and retries (never used for sends, see pay()). */
  private async withUtxos<T>(op: () => T): Promise<T> {
    try {
      return op();
    } catch (e) {
      if (!(mapWalletError(e) instanceof NoUtxo)) throw e;
      await this.createUtxosIfNeeded(true);
      return op();
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
      const r = await this.withUtxos(() =>
        req.amount
          ? this.rgb.blindReceive({
              ...(req.assetId ? { assetId: req.assetId } : {}),
              amount: toNumber(req.amount),
              durationSeconds: req.expirySec,
              minConfirmations: 1,
            })
          : this.blindReceiveAny(req.assetId, req.expirySec),
      );
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
    // The library call can hang after signing (seen on Mutinynet with a slow proxy): cap it. The call keeps running
    // in the background; the transfer it created is found by the sync below and settled by the sync loop.
    const send = () =>
      withSendTimeout(
        this.acct().transfer({ token: req.assetId, recipient: req.rgbInvoice, amount: toNumber(req.amount), feeRate }),
        this.cfg.sendTimeoutMs ?? 120_000,
      );
    try {
      try {
        ({ hash } = await send());
      } catch (e) {
        // NoUtxo comes from sendBegin, before anything is signed: create UTXOs and try once more.
        if (!(mapWalletError(e) instanceof NoUtxo)) throw e;
        await this.createUtxosIfNeeded(true);
        ({ hash } = await send());
      }
    } catch (e) {
      const err = mapWalletError(e);
      if (!(err instanceof SubmitTimeout)) throw err;
      // The send may already be out: never retry. Sync once and report the transfer if it exists.
      try {
        await this.sync();
      } catch {
        // offline: the caller checks the state later
      }
      const found = this.newOutgoing(req.assetId, before);
      throw new SubmitTimeout(err.message, found ? String(found.batchTransferIdx) : undefined);
    }
    const created = this.newOutgoing(req.assetId, before);
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
        const status = toStatus(t.status);
        const seal = sealType(t);
        const ends = endpoints(t);
        out.push({
          transferId: String(t.batchTransferIdx),
          assetId: id,
          amount: transferAmount(t),
          direction: toDirection(t.kind),
          status,
          ...(t.txid ? { txid: t.txid } : {}),
          ...(t.invoiceString ? { rgbInvoice: t.invoiceString } : {}),
          ...(t.recipientId ? { recipientId: t.recipientId } : {}),
          ...(seal ? { sealType: seal } : {}),
          ...(ends.length ? { transportEndpoints: ends } : {}),
          ...(t.expiration ? { expiresAt: iso(t.expiration) } : {}),
          ...(status === 'Settled' ? { settledAt: iso(t.updatedAt) } : {}),
          schema: 'NIA',
          createdAt: iso(t.createdAt),
          updatedAt: iso(t.updatedAt),
        });
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Refreshes pending transfers (exchanges consignments with the proxy) and syncs with the indexer. Both are reads:
   * a flaky indexer/proxy is retried with backoff, then NetworkUnavailable. A refresh failure still lets the sync run.
   */
  async sync(): Promise<void> {
    let refreshError: unknown;
    try {
      await withReadRetry(() => this.rgb.refreshWallet(), this.retry);
    } catch (e) {
      refreshError = e;
    }
    await withReadRetry(() => this.rgb.syncWallet(), this.retry);
    if (refreshError) throw refreshError;
  }

  /** Never call the library dispose(): it throws "Invalid checksum" in 2.0.3. */
  close(): void {
    this.account = null;
    this.wdk = null;
    unlockWalletDir(this.cfg.dataDir);
  }

  private acct(): RgbAccount {
    if (!this.account) throw new Error('Wallet not initialised: call init() first.');
    return this.account;
  }

  /**
   * Open-amount invoice. rgb-sdk 1.0.3 always builds `{"Fungible":amount}` (undefined → rgb-lib JSONConversion error),
   * so call the rgb-lib binding underneath with the `"Any"` assignment.
   */
  private blindReceiveAny(assetId: string | undefined, expirySec: number): ReturnType<RgbSdkWallet['blindReceive']> {
    const client = (this.rgb as unknown as { client?: RgbLibClient }).client;
    if (!client?.wallet) throw new TransferFailed('This wallet cannot create an open-amount invoice; set an amount.');
    return client.wallet.blindReceive(assetId ?? null, '"Any"', String(expirySec), [client.transportEndpoint], '1');
  }

  /** Sent (not failed) base units of an asset in the last 24 h, from rgb-lib's transfer list. */
  spentLast24h(assetId: string): number {
    const since = Date.now() / 1000 - 86_400;
    let sum = 0;
    for (const t of this.rgb.listTransfers(assetId)) {
      if (toDirection(t.kind) !== 'outgoing' || toStatus(t.status) === 'Failed' || t.createdAt < since) continue;
      sum += Number(transferAmount(t));
    }
    return sum;
  }

  private newOutgoing(assetId: string, before: Set<number>): SdkTransfer | undefined {
    return this.rgb
      .listTransfers(assetId)
      .find((t) => !before.has(t.batchTransferIdx) && toDirection(t.kind) === 'outgoing');
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
