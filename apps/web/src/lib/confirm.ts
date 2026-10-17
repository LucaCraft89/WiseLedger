// Pure helpers behind the confirmation dialog and the payment progress (tested in web.test.ts).
import {
  type AppEvent,
  buildConfirmationSentence,
  type ExecutionResult,
  formatAssetAmount,
  type InvoiceState,
  type PaymentPlan,
  type TransferStatus,
  type Verdict,
} from '../api/contracts.js';

export interface AssetMeta {
  assetId: string;
  ticker: string;
  precision: number;
}

type PlanLike = Pick<PaymentPlan, 'amount' | 'assetId' | 'payee' | 'executeAt'>;

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
    : `${plan.amount} base units`;
  return `${amount} (asset ${plan.assetId}) to ${plan.payee.name}`;
}

export const BLOCK_EXPLANATION = 'This invoice was stopped because it looks unsafe. You cannot pay it from here.';
export const REVIEW_TICK_LABEL = 'I have read the warnings and want to pay anyway';

/** Whether "Confirm and pay" is enabled, and the override flag to send. */
export function confirmGate(verdict: Verdict, ticked: boolean): { canConfirm: boolean; override?: true } {
  if (verdict === 'block') return { canConfirm: false };
  if (verdict === 'review') return ticked ? { canConfirm: true, override: true } : { canConfirm: false };
  return { canConfirm: true };
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
  transferId?: string;
  txid?: string;
}

export const PROGRESS_LABELS = [
  'Sent to the network',
  "Waiting for the supplier's wallet",
  'Waiting for a block confirmation',
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
): PaymentProgress {
  let rank = 0;
  let failed = state === 'FAILED' || execution?.status === 'failed';
  let errorMessage = execution?.error?.message;
  let transferId = execution?.transferId;
  let txid = execution?.txid;
  let started = state === 'CONFIRMED' || state === 'EXECUTING';
  for (const e of events) {
    if (e.type === 'transfer') {
      started = true;
      transferId = e.transferId;
      if (e.txid) txid = e.txid;
      if (e.status === 'Failed') failed = true;
      else rank = Math.max(rank, TRANSFER_RANK[e.status]);
    } else if (e.type === 'state') {
      if (e.to === 'EXECUTING' || e.to === 'CONFIRMED') started = true;
      if (e.to === 'PAID') rank = 4;
      if (e.to === 'FAILED') failed = true;
    } else if (e.type === 'error') {
      errorMessage = e.message;
    }
  }
  if (state === 'PAID') rank = 4;
  const inFlight = started && !failed && rank < 4;
  const steps = PROGRESS_LABELS.map((label, i) => ({
    label,
    status: (i < rank ? 'done' : i === rank && inFlight ? 'running' : 'pending') as ProgressStatus,
  }));
  return { steps, failed, errorMessage, transferId, txid };
}
