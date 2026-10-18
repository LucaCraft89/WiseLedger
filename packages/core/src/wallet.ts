// Wallet contract (lane A). Amounts are always base units as decimal strings
// (TUSDT precision 6: "5000000" = 5 tokens). Assets are identified by asset ID, never by ticker.
import { z } from 'zod';
import type { PaymentPlan } from './orchestrator.js';

/** Base units as a non-negative decimal integer string. */
export const AmountSchema = z.string().regex(/^(0|[1-9][0-9]*)$/, 'amount must be base units as a decimal string');
export type Amount = z.infer<typeof AmountSchema>;

export const TransferStatusSchema = z.enum(['WaitingCounterparty', 'WaitingConfirmations', 'Settled', 'Failed']);
export type TransferStatus = z.infer<typeof TransferStatusSchema>;

export const AssetBalanceSchema = z.object({
  settled: AmountSchema,
  future: AmountSchema,
  spendable: AmountSchema,
});
export type AssetBalance = z.infer<typeof AssetBalanceSchema>;

export const AssetInfoSchema = z.object({
  assetId: z.string(),
  ticker: z.string(),
  name: z.string(),
  precision: z.number().int().min(0).max(18),
  schema: z.literal('NIA'),
  balance: AssetBalanceSchema,
});
export type AssetInfo = z.infer<typeof AssetInfoSchema>;

export const TransferInfoSchema = z.object({
  transferId: z.string(),
  assetId: z.string().optional(),
  amount: AmountSchema,
  direction: z.enum(['outgoing', 'incoming', 'issuance']),
  status: TransferStatusSchema,
  txid: z.string().optional(),
  rgbInvoice: z.string().optional(),
  /** RGB recipient ID (blinded UTXO) the transfer pays; matches DecodedInvoice.recipientId of the invoice paid. */
  recipientId: z.string().optional(),
  /** How it moved; absent = onchain. Lightning payments have a paymentHash and no txid. */
  rail: z.enum(['onchain', 'lightning']).optional(),
  paymentHash: z.string().optional(),
  /**
   * RGB seal the asset moved to (on-chain only): `blinded` = the receiving UTXO is hidden behind a blinded ID,
   * `witness` = a new output of the payment transaction. From rgb-lib's kind (ReceiveBlind / ReceiveWitness) or,
   * for a send, the recipient ID (`utxob:` / `wvout:`).
   */
  sealType: z.enum(['blinded', 'witness']).optional(),
  /** RGB proxy endpoints the consignment travels through (rgb-lib transport_endpoints, the used ones first). */
  transportEndpoints: z.array(z.string()).optional(),
  /** ISO; rgb-lib `expiration`: after it a transfer still waiting for the counterparty fails. */
  expiresAt: z.string().optional(),
  /** ISO; when the transfer reached Settled (rgb-lib keeps no separate field: updatedAt at Settled). */
  settledAt: z.string().optional(),
  /** Asset schema (only NIA here). */
  schema: z.literal('NIA').optional(),
  /** ISO timestamps */
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TransferInfo = z.infer<typeof TransferInfoSchema>;

/** `sb:utxob:…` → blinded, `sb:wvout:…` → witness (rgb-lib recipient ID formats). */
export function sealTypeOfRecipient(recipientId: string | undefined): 'blinded' | 'witness' | undefined {
  if (!recipientId) return undefined;
  if (/(^|:)utxob:/.test(recipientId)) return 'blinded';
  if (/(^|:)wvout:/.test(recipientId)) return 'witness';
  return undefined;
}

export const DecodedInvoiceSchema = z.object({
  rgbInvoice: z.string(),
  recipientId: z.string(),
  /** Absent when the payer chooses the asset (our receive invoices are created without assetId). */
  assetId: z.string().optional(),
  amount: AmountSchema.optional(),
  network: z.string(),
  /** ISO timestamp; absent = no expiry */
  expiresAt: z.string().optional(),
  transportEndpoints: z.array(z.string()),
  /**
   * `lightning` for an RGB Lightning invoice (BOLT11 with RGB fields, paid over a channel, instant); absent = onchain.
   * The same `rgbInvoice` string travels through plan, guard and pay() either way.
   */
  rail: z.enum(['onchain', 'lightning']).optional(),
  paymentHash: z.string().optional(),
  /**
   * True when the request's RGB proxy already holds a payment for its recipient ID (someone paid it: a request is
   * paid once); false when the proxy has none; absent when not checked (Lightning, mock, proxy not answering).
   */
  alreadyPaid: z.boolean().optional(),
});
export type DecodedInvoice = z.infer<typeof DecodedInvoiceSchema>;

export const PaymentRequestSchema = z.object({
  rgbInvoice: z.string(),
  assetId: z.string(),
  amount: AmountSchema,
  /** sat/vB. Backends always pass one to the chain (the estimate is 0 on Mutinynet); default comes from config. */
  feeRate: z.number().positive().optional(),
});
export type PaymentRequest = z.infer<typeof PaymentRequestSchema>;

export const CreateReceiveRequestSchema = z.object({
  assetId: z.string().optional(),
  amount: AmountSchema.optional(),
  expirySec: z.number().int().positive(),
  /** `lightning`: an RGB Lightning invoice paid over a channel (needs assetId + amount); absent = on-chain. */
  rail: z.enum(['onchain', 'lightning']).optional(),
});
export type CreateReceiveRequest = z.infer<typeof CreateReceiveRequestSchema>;

export const ReceiveInvoiceSchema = z.object({
  rgbInvoice: z.string(),
  recipientId: z.string(),
  assetId: z.string().optional(),
  amount: AmountSchema.optional(),
  expiresAt: z.string(),
  /** Absent = on-chain. A Lightning request's recipientId is its payment hash. */
  rail: z.enum(['onchain', 'lightning']).optional(),
  paymentHash: z.string().optional(),
});
export type ReceiveInvoice = z.infer<typeof ReceiveInvoiceSchema>;

export interface IssueNiaRequest {
  /** Uppercase ticker, e.g. TUSDT */
  ticker: string;
  name: string;
  precision: number;
  amounts: Amount[];
}

export interface QuoteResult {
  /** Fee in sats, decimal string */
  fee: string;
  feeRate: number;
}

export interface PayResult {
  transferId: string;
  /** On-chain only. */
  txid?: string;
  /** Lightning only. */
  paymentHash?: string;
}

export interface LightningChannel {
  channelId: string;
  /** Peer node public key (the LSP for the app's node). */
  peer: string;
  /** Base units of the channel asset on our side / the peer's side. */
  localAsset: string;
  remoteAsset: string;
  assetId?: string;
  usable: boolean;
}

export interface LightningStatus {
  enabled: boolean;
  nodePubkey?: string;
  channels: LightningChannel[];
  /** Plain words when enabled but not working ("No channel yet: requested from the LSP"). */
  problem?: string;
}

/** First-run state. The mnemonic is revealed at most once (the backend records that it was shown). */
export interface OnboardingInfo {
  /** True when this process created the wallet (new seed) instead of opening an existing one. */
  walletCreated: boolean;
  /** True once the seed has been revealed to the user. */
  seedShown: boolean;
  /** Present only on the one call with `reveal: true` while `seedShown` was still false. */
  mnemonic?: string;
}

export interface WalletInfo {
  backend: 'mock' | 'wdk-rgb' | 'rgb-lib';
  network: string;
}

export interface WalletPort {
  init(): Promise<WalletInfo>;
  /** First-run info; `reveal: true` returns the mnemonic once and marks it shown. */
  onboarding(opts?: { reveal?: boolean }): Promise<OnboardingInfo>;
  /** Bitcoin address for funding. Real backends may return a new address on every call. */
  receiveAddress(): Promise<string>;
  listAssets(): Promise<AssetInfo[]>;
  /** Throws UnknownAsset. */
  assetBalance(assetId: string): Promise<AssetBalance>;
  /** Creates colorable UTXOs when fewer than needed are free; returns how many were created. */
  createUtxosIfNeeded(): Promise<{ created: number }>;
  issueAssetNia(req: IssueNiaRequest): Promise<AssetInfo>;
  createReceiveInvoice(req: CreateReceiveRequest): Promise<ReceiveInvoice>;
  /** Throws InvalidInvoice. Does not check expiry (pay() does). */
  decodeInvoice(rgbInvoice: string): Promise<DecodedInvoice>;
  quotePay(req: PaymentRequest): Promise<QuoteResult>;
  /**
   * Throws InsufficientFunds, InvoiceExpired, NoUtxo, UnknownAsset, InvalidInvoice, TransferFailed, SubmitTimeout.
   * After SubmitTimeout never retry automatically: sync() and inspect listTransfers().
   */
  pay(req: PaymentRequest): Promise<PayResult>;
  getTransfer(transferId: string): Promise<TransferInfo | null>;
  listTransfers(assetId?: string): Promise<TransferInfo[]>;
  sync(): Promise<void>;
  /**
   * Lightning node and channels, for the UI. Optional: backends without Lightning omit it. pay() dispatches by the
   * invoice's rail; a Lightning payment maps to TransferStatus (pending = WaitingCounterparty, Succeeded = Settled).
   */
  lightningStatus?(): Promise<LightningStatus>;
}

export type WalletErrorCode =
  | 'InsufficientFunds'
  | 'InvoiceExpired'
  | 'NoUtxo'
  | 'UnknownAsset'
  | 'InvalidInvoice'
  | 'TransferFailed'
  | 'SubmitTimeout'
  | 'PolicyDenied'
  | 'NetworkUnavailable'
  | 'WalletLocked';

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  constructor(code: WalletErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = code;
    this.code = code;
  }
}
export class InsufficientFunds extends WalletError {
  constructor(
    message = 'Not enough spendable balance for this payment. Receive more, or wait for pending payments to settle.',
  ) {
    super('InsufficientFunds', message);
  }
}
export class InvoiceExpired extends WalletError {
  constructor(message = 'The RGB invoice has expired. Ask the supplier for a new one.') {
    super('InvoiceExpired', message);
  }
}
export class NoUtxo extends WalletError {
  constructor(message = 'The wallet has no free coins for RGB right now. Wait for the next block and try again.') {
    super('NoUtxo', message);
  }
}
export class UnknownAsset extends WalletError {
  constructor(assetId: string) {
    super(
      'UnknownAsset',
      `The wallet does not hold asset ${assetId}. Ask for a payment request in a token your wallet holds.`,
    );
  }
}
export class InvalidInvoice extends WalletError {
  constructor(message = 'This is not a valid RGB invoice. Ask the supplier to send the payment request again.') {
    super('InvalidInvoice', message);
  }
}
export class TransferFailed extends WalletError {
  constructor(
    message = 'The transfer failed. Check the transfers list before trying again.',
    options?: { cause?: unknown },
  ) {
    super('TransferFailed', message, options);
  }
}
/** The send may or may not have gone out: sync and check the transfer state, never retry blindly. */
export class SubmitTimeout extends WalletError {
  /** Set when the post-timeout sync found the transfer the send created (it may still settle). */
  readonly transferId: string | undefined;
  constructor(
    message = 'The payment was submitted but no answer came back in time. Checking its state.',
    transferId?: string,
  ) {
    super('SubmitTimeout', message);
    this.transferId = transferId;
  }
}

/** A spend policy (WDK policy engine) refused the operation: over the limit or asset not approved. */
export class PolicyDenied extends WalletError {
  constructor(message = 'Your spending rules do not allow this payment.') {
    super('PolicyDenied', message);
  }
}

/** A read (sync, balance, transfer list) could not reach the indexer or proxy after retries. Nothing was sent. */
export class NetworkUnavailable extends WalletError {
  constructor(
    message = 'The Bitcoin network service is not answering right now. Nothing was sent; try again shortly.',
  ) {
    super('NetworkUnavailable', message);
  }
}
/** The seed is encrypted at rest and no (or a wrong) passphrase was given. */
export class WalletLocked extends WalletError {
  constructor(message = 'The wallet is locked. Enter your wallet passphrase to unlock it.') {
    super('WalletLocked', message);
  }
}

export function isWalletError(e: unknown): e is WalletError {
  return e instanceof WalletError;
}

export type GuardReason =
  | 'unknown_plan'
  | 'not_confirmed'
  | 'hash_mismatch'
  | 'over_cap'
  | 'asset_not_allowed'
  | 'insufficient_funds'
  | 'already_executed'
  | 'invoice_expired'
  | 'policy_denied';

export type GuardResult<TPlan> = { ok: true; plan: TPlan } | { ok: false; reason: GuardReason; message: string };

/** Deterministic check between the Treasurer and the wallet (implemented by lane A in M2.S2). */
export interface PaymentGuard<TPlan = PaymentPlan> {
  check(planId: string): Promise<GuardResult<TPlan>>;
}
