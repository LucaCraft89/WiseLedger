// Pure helpers behind the confirmation dialog and the payment progress (tested in web.test.ts).
import {
  type AppEvent,
  buildConfirmationSentence,
  type ExecutionResult,
  formatAssetAmount,
  type InvoiceState,
  isLightningInvoice,
  type PaymentPlan,
  type TransferStatus,
  type Verdict,
} from '../api/contracts.js';

export interface AssetMeta {
  assetId: string;
  ticker: string;
  precision: number;
}

type PlanLike = Pick<PaymentPlan, 'amount' | 'assetId' | 'payee' | 'executeAt'> & { rgbInvoice?: string };

/** Asset of the plan, matched by asset ID only (never by ticker). */
export function findAsset(assetId: string, assets: readonly AssetMeta[]): AssetMeta | undefined {
  return assets.find((a) => a.assetId === assetId);
}

/** The sentence the dialog shows, always built by code from the plan. */
export function dialogSentence(plan: PlanLike, assets: readonly AssetMeta[]): string {
  return buildConfirmationSentence(plan, findAsset(plan.assetId, assets));
}

/** "25.00 TUSDT to Acme Srl" for the final result card. */
export function paidSentence(plan: PlanLike, assets: readonly AssetMeta[]): string {
  const asset = findAsset(plan.assetId, assets);
  const amount = asset
    ? `${formatAssetAmount(plan.amount, asset.precision)} ${asset.ticker}`
    : `${plan.amount} smallest units of an unknown token`;
  const rail = isLightningInvoice(plan.rgbInvoice) ? ' over Lightning' : '';
  return `${amount} (asset ${plan.assetId}) to ${plan.payee.name}${rail}`;
}

/** Shown under a sentence that names the asset ID ("(asset rgb:…)"), so the code is not a mystery. */
export const ASSET_ID_HINT =
  'The code after “asset” is the unique ID of the token. It makes sure the right token is paid, even if two tokens share a name.';

export function assetIdHint(sentence: string | undefined): string | null {
  return sentence && /\(asset [^)]+\)/.test(sentence) ? ASSET_ID_HINT : null;
}

export const BLOCK_EXPLANATION = 'This invoice was stopped because it looks unsafe. You cannot pay it from here.';
export const REVIEW_TICK_LABEL = 'I have read the warnings and want to pay anyway';

/** Whether "Pay" is enabled, and the override flag to send. */
export function confirmGate(verdict: Verdict, ticked: boolean): { canConfirm: boolean; override?: true } {
  if (verdict === 'block') return { canConfirm: false };
  if (verdict === 'review') return ticked ? { canConfirm: true, override: true } : { canConfirm: false };
  return { canConfirm: true };
}

/** The override rule in words, shown next to "Pay". */
export function gateHint(verdict: Verdict, ticked: boolean): string {
  if (verdict === 'block') return 'You cannot pay this invoice: it was stopped because it looks unsafe.';
  if (verdict === 'review')
    return ticked
      ? 'You read the warnings. You can pay now.'
      : 'Tick the box above to say you read the warnings. Then you can pay.';
  return 'I found nothing suspicious. Read the sentence above, then pay.';
}

export type ProgressStatus = 'pending' | 'running' | 'done';
export interface ProgressStep {
  label: string;
  status: ProgressStatus;
}
export interface PaymentProgress {
  steps: ProgressStep[];
  failed: boolean;
  errorMessage?: string;
  /** Typed error code (wallet, guard or Treasurer), when known. */
  errorCode?: string;
  transferId?: string;
  txid?: string;
  /** Lightning: the payment hash identifies the payment (there is no Bitcoin transaction). */
  paymentHash?: string;
}

/** Lightning settles in seconds with no block to wait for: three steps instead of four. */
export const LN_PROGRESS_LABELS = ['Submitted', 'Sending over Lightning', 'Paid'] as const;
const LN_RANK: Record<Exclude<TransferStatus, 'Failed'>, number> = {
  WaitingCounterparty: 1,
  WaitingConfirmations: 1,
  Settled: 3,
};

export const PROGRESS_LABELS = [
  'Submitted',
  "Waiting for the supplier's wallet",
  'Waiting for Bitcoin to confirm (about a minute)',
  'Paid',
] as const;

const TRANSFER_RANK: Record<Exclude<TransferStatus, 'Failed'>, number> = {
  WaitingCounterparty: 1,
  WaitingConfirmations: 2,
  Settled: 4,
};

/** States in which the payment progress is worth showing. */
export function showsProgress(state: InvoiceState, events: readonly AppEvent[]): boolean {
  return (
    state === 'CONFIRMED' ||
    state === 'EXECUTING' ||
    state === 'PAID' ||
    state === 'FAILED' ||
    events.some((e) => e.type === 'transfer')
  );
}

/**
 * Folds `transfer` and `state` events into the 4-step progress list.
 * Rank = number of steps done; the step at index `rank` is running while the payment is in flight.
 */
export function paymentProgress(
  state: InvoiceState,
  events: readonly AppEvent[],
  execution?: ExecutionResult,
  /** True when the plan pays an RGB Lightning invoice. */
  lightning = false,
): PaymentProgress {
  const labels: readonly string[] = lightning ? LN_PROGRESS_LABELS : PROGRESS_LABELS;
  const rankOf = lightning ? LN_RANK : TRANSFER_RANK;
  const paid = labels.length;
  let rank = 0;
  let failed = state === 'FAILED' || execution?.status === 'failed';
  let errorMessage: string | undefined;
  let errorCode: string | undefined;
  let transferId = execution?.transferId;
  let txid = execution?.txid;
  let paymentHash = execution?.paymentHash;
  let started = state === 'CONFIRMED' || state === 'EXECUTING';
  for (const e of events) {
    if (e.type === 'transfer') {
      started = true;
      transferId = e.transferId;
      if (e.txid) txid = e.txid;
      if (e.paymentHash) paymentHash = e.paymentHash;
      if (e.status === 'Failed') failed = true;
      else rank = Math.max(rank, rankOf[e.status]);
    } else if (e.type === 'state') {
      if (e.to === 'EXECUTING' || e.to === 'CONFIRMED') started = true;
      if (e.to === 'PAID') rank = paid;
      if (e.to === 'FAILED') failed = true;
    } else if (e.type === 'toolCall' && e.name === 'execute_plan' && e.status === 'ok') {
      started = true;
      rank = Math.max(rank, 1);
    } else if (e.type === 'error') {
      errorMessage = e.message;
      errorCode = e.code;
    }
  }
  if (state === 'PAID') rank = paid;
  // The execution result is the latest word on the payment.
  if (execution?.error) ({ code: errorCode, message: errorMessage } = execution.error);
  const inFlight = started && !failed && rank < paid;
  const steps = labels.map((label, i) => ({
    label,
    status: (i < rank ? 'done' : i === rank && inFlight ? 'running' : 'pending') as ProgressStatus,
  }));
  return { steps, failed, errorMessage, errorCode, transferId, txid, ...(paymentHash ? { paymentHash } : {}) };
}
