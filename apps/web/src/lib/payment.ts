// Pure helpers for flag cards, the result / failure cards and the invoice history (tested in web.test.ts).
import type { InvoiceState, InvoiceSummaryDto, Severity } from '../api/contracts.js';

/** Short title per rule code, in plain words. */
export const FLAG_TITLES: Record<string, string> = {
  R1_RGB_INVOICE: 'Payment request problem',
  R2_ASSET: 'Unexpected token',
  R3_AMOUNT: 'Amount problem',
  R4_DUPLICATE: 'Already received',
  R5_NEW_PAYEE: 'Supplier check',
  R6_PRESSURE: 'Pressure to pay fast',
  R7_INJECTION: 'Hidden orders to the AI',
  R8_CURRENCY: 'Different currency',
  R9_MISSING_FIELDS: 'Missing details',
  R10_DATES: 'Strange dates',
  R11_RGB_REQUEST: 'Payment request check',
  AI_UNAVAILABLE: 'The AI could not read this invoice',
};

export function flagTitle(code: string): string {
  return FLAG_TITLES[code] ?? 'Something to check';
}

/** The word next to the colour bar of a flag card. */
export const SEVERITY_ICON_WORD: Record<Severity, string> = { block: 'Stop', warn: 'Check', info: 'Note' };

/**
 * Warnings and stops (shown under "Checks") apart from calm info notes ("Good to know"), so an ok report
 * with only info flags still reads "All checks passed".
 */
export function splitFlags<T extends { severity: Severity }>(flags: readonly T[]): { alerts: T[]; notes: T[] } {
  return {
    alerts: flags.filter((f) => f.severity !== 'info'),
    notes: flags.filter((f) => f.severity === 'info'),
  };
}

const RESULT_ORDER = { block: 0, review: 1, ok: 2 } as const;

/** Payment request check lines: failures first, then checks to review, then passed (stable within a group). */
export function sortCheckLines<T extends { result: 'ok' | 'review' | 'block' }>(lines: readonly T[]): T[] {
  return [...lines].sort((a, b) => RESULT_ORDER[a.result] - RESULT_ORDER[b.result]);
}

export const EVIDENCE_MAX = 80;

/** Evidence snippet on one line, cut at ~80 characters. */
export function shortEvidence(text: string, max = EVIDENCE_MAX): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine;
}

/** Typed errors (wallet, guard, Treasurer) → one plain sentence. */
export const ERROR_WORDS: Record<string, string> = {
  InsufficientFunds: 'Not enough funds in the wallet.',
  InvoiceExpired: "The supplier's payment request expired — ask for a new one.",
  NoUtxo: 'The wallet is not ready to pay yet: it needs a few minutes to prepare its coins. Wait, then try again.',
  TransferFailed: 'The payment did not go through.',
  SubmitTimeout: 'The payment was sent but I have no answer yet. I am checking — do NOT pay again.',
  PolicyDenied:
    'Your spending rules do not allow this payment: the Tether WDK policy engine in the wallet refused it. Nothing was sent.',
  UnknownAsset: 'This wallet does not hold the token the supplier asks for.',
  InvalidInvoice: "The supplier's payment request is not valid. Ask them to send it again.",
  NetworkUnavailable:
    'I could not reach the Bitcoin test network. Nothing was sent. Check your internet and try again.',
  WalletLocked: 'Your wallet is locked. Enter your passphrase to unlock it.',
  WALLET_NOT_READY: 'Your wallet is not set up yet. Create or restore it first, then try again.',
  INVALID_MNEMONIC: 'These recovery words are not valid. Check the spelling and the order of each word.',
  PASSPHRASE_TOO_SHORT: 'This passphrase is too short. Choose a longer one.',
  ALREADY_SET_UP: 'This wallet is already set up. Reload the page to open it.',
  TOO_MANY_TRIES: 'Too many wrong passphrases. Wait a minute, then try again.',
  NETWORK: 'WiseLedger could not be reached on this computer. Check that it is running, then try again.',
  unknown_plan: 'This payment was not prepared by WiseLedger, so it was not sent.',
  not_confirmed: 'You have not confirmed this payment yet, so it was not sent.',
  hash_mismatch: 'The payment details changed after you confirmed, so nothing was sent. Please check them again.',
  already_executed: 'This payment was already sent. Do not pay again.',
  over_cap: 'This payment is above your spending limit, so it was not sent.',
  asset_not_allowed: 'Your spending rules do not allow this token, so nothing was sent.',
  insufficient_funds: 'Not enough funds in the wallet.',
  invoice_expired: "The supplier's payment request expired — ask for a new one.",
  policy_denied: 'Your spending rules do not allow this payment.',
  TREASURER_PARSE: 'The AI could not start the payment. Nothing was sent.',
};

/**
 * Server error → plain words: our copy for known codes (429 = too many tries), else the server's own message
 * (ApiError messages are written for the user).
 */
export function apiErrorWords(code: string, message: string, status?: number): string {
  const key = status === 429 ? 'TOO_MANY_TRIES' : code;
  return ERROR_WORDS[key] ?? message;
}

export function errorWords(code: string | undefined, fallback?: string): string {
  return (
    (code && ERROR_WORDS[code]) ||
    fallback ||
    'The payment failed. Nothing is retried automatically: check My invoices before paying again.'
  );
}

/** Failures before signing (the wallet's RELEASE_ON_FAILURE list) plus TREASURER_PARSE (nothing was sent). */
const RETRY_SAFE = new Set([
  'InsufficientFunds',
  'InvoiceExpired',
  'NoUtxo',
  'UnknownAsset',
  'InvalidInvoice',
  'PolicyDenied',
  'TREASURER_PARSE',
]);

/**
 * True only when trying again cannot pay twice: the error says nothing left the wallet
 * and no transfer exists. Never after SubmitTimeout or already_executed.
 */
export function canRetry(code: string | undefined, transferId?: string): boolean {
  if (!code || transferId) return false;
  return RETRY_SAFE.has(code);
}

export const DEFAULT_EXPLORER_URL = 'https://mutinynet.com';

/** Block explorer page of a Bitcoin transaction. */
export function explorerTxUrl(txid: string, base: string = DEFAULT_EXPLORER_URL): string {
  return `${base.replace(/\/+$/, '')}/tx/${encodeURIComponent(txid)}`;
}

/** "abcd1234…9f0e" for long IDs. */
export function shortId(id: string, keep = 8): string {
  return id.length > keep * 2 + 1 ? `${id.slice(0, keep)}…${id.slice(-keep)}` : id;
}

export const HISTORY_FILTERS = ['all', 'waiting', 'paid', 'stopped', 'failed'] as const;
export type HistoryFilter = (typeof HISTORY_FILTERS)[number];

export const HISTORY_FILTER_LABELS: Record<HistoryFilter, string> = {
  all: 'All',
  waiting: 'Waiting for you',
  paid: 'Paid',
  stopped: 'Stopped',
  failed: 'Failed',
};

const FILTER_STATES: Record<Exclude<HistoryFilter, 'all'>, readonly InvoiceState[]> = {
  waiting: ['AWAITING_CONFIRMATION'],
  paid: ['PAID'],
  stopped: ['BLOCKED', 'REJECTED'],
  failed: ['FAILED'],
};

export function filterInvoices<T extends Pick<InvoiceSummaryDto, 'state'>>(list: readonly T[], f: HistoryFilter): T[] {
  return f === 'all' ? [...list] : list.filter((i) => FILTER_STATES[f].includes(i.state));
}
