import type { AppEvent, InvoiceState, Stage, TransferStatus } from '../api/contracts.js';

/** Base units (decimal string) → human amount with 2..precision decimals. "25000000", 6 → "25.00". */
export function formatAmount(baseUnits: string, precision: number): string {
  if (!/^\d+$/.test(baseUnits)) return baseUnits;
  const padded = baseUnits.padStart(precision + 1, '0');
  const whole = padded.slice(0, padded.length - precision).replace(/^0+(?=\d)/, '');
  let frac = precision > 0 ? padded.slice(padded.length - precision) : '';
  frac = frac.replace(/0+$/, '');
  if (frac.length < 2 && precision >= 2) frac = frac.padEnd(2, '0');
  return frac ? `${whole}.${frac}` : whole;
}

export const STAGE_LABELS: Record<Stage, string> = {
  reading: 'Reading the invoice',
  extracting: 'Extracting the details',
  checking: 'Checking the rules',
  summarizing: 'Writing the summary',
  analyzed: 'Analysis finished',
  planning: 'Preparing the payment',
  executing: 'Sending the payment',
  done: 'Done',
};

export const TRANSFER_LABELS: Record<TransferStatus, string> = {
  WaitingCounterparty: 'Payment sent, waiting for the receiver',
  WaitingConfirmations: 'Waiting for the Bitcoin network to confirm',
  Settled: 'Payment completed',
  Failed: 'Payment failed',
};

export const STATE_LABELS: Record<InvoiceState, string> = {
  UPLOADED: 'Uploaded',
  EXTRACTED: 'Details extracted',
  ANALYZED: 'Analyzed',
  AWAITING_CONFIRMATION: 'Waiting for your confirmation',
  CONFIRMED: 'Confirmed',
  EXECUTING: 'Paying…',
  SCHEDULED: 'Payment scheduled',
  PAID: 'Paid',
  FAILED: 'Something went wrong',
  REJECTED: 'Rejected, not paid',
  BLOCKED: 'Blocked, not paid',
};

export type StepStatus = 'running' | 'done' | 'error';
export interface TimelineStep {
  stage: Stage;
  label: string;
  status: StepStatus;
}

/** Folds stage events into an ordered list of steps (first-seen order, last status wins). */
export function buildTimeline(events: readonly AppEvent[]): TimelineStep[] {
  const steps = new Map<Stage, TimelineStep>();
  for (const e of events) {
    if (e.type !== 'stage' || e.stage === 'analyzed' || e.stage === 'done') continue;
    const status: StepStatus = e.status === 'start' ? 'running' : e.status === 'end' ? 'done' : 'error';
    steps.set(e.stage, { stage: e.stage, label: STAGE_LABELS[e.stage], status });
  }
  return [...steps.values()];
}

/** Key for de-duplicating events replayed by both GET /invoices/:id and the SSE stream. */
export const eventKey = (e: AppEvent): string => JSON.stringify(e);
