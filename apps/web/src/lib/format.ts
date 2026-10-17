import type {
  AppEvent,
  HealthResponse,
  InvoiceState,
  Severity,
  Stage,
  TransferStatus,
  Verdict,
} from '../api/contracts.js';

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
  UPLOADED: 'Reading…',
  EXTRACTED: 'Checking…',
  ANALYZED: 'Checked',
  AWAITING_CONFIRMATION: 'Waiting for your OK',
  CONFIRMED: 'Confirmed, paying soon',
  EXECUTING: 'Paying…',
  SCHEDULED: 'Payment scheduled',
  PAID: 'Paid',
  FAILED: 'Payment failed',
  REJECTED: 'You said no, not paid',
  BLOCKED: 'Stopped: looks unsafe',
};

/** Chip colour per state: green = done, amber = needs you, red = stopped/failed, grey = in progress. */
export function stateTone(state: InvoiceState): 'good' | 'attention' | 'bad' | 'neutral' {
  if (state === 'PAID' || state === 'SCHEDULED') return 'good';
  if (state === 'AWAITING_CONFIRMATION') return 'attention';
  if (state === 'BLOCKED' || state === 'FAILED') return 'bad';
  return 'neutral';
}

/** Brand functional colours (docs/BRAND.md): ok green, review amber, block red, neutral grey. */
export const TONE_COLORS = {
  good: '#e3f3e8',
  attention: '#fff1c7',
  bad: '#fbe3e1',
  neutral: '#eef1f4',
} as const;

export const VERDICT_LABELS: Record<Verdict, string> = {
  ok: 'Looks fine',
  review: 'Check before paying',
  block: 'Do not pay',
};

export const VERDICT_EXPLAIN: Record<Verdict, string> = {
  ok: 'We found nothing suspicious.',
  review: 'Some details look unusual. Read the warnings below before you pay.',
  block: 'This invoice looks dangerous. We will not pay it.',
};

export const VERDICT_COLORS: Record<Verdict, string> = { ok: '#e3f3e8', review: '#fff1c7', block: '#fbe3e1' };

/** Solid border/badge colour per verdict (white text on it is AA). */
export const VERDICT_ACCENT: Record<Verdict, string> = { ok: '#1e7b45', review: '#8a5a00', block: '#b3261e' };

/** Icon next to the verdict word, so colour is never the only signal. */
export const VERDICT_ICON: Record<Verdict, string> = { ok: '✓', review: '!', block: '✕' };

export const SEVERITY_WORDS: Record<Severity, string> = { info: 'Note', warn: 'Warning', block: 'Danger' };

/** info grey, warn amber, block red: background and left border. */
export const SEVERITY_COLORS: Record<Severity, { bg: string; border: string }> = {
  info: { bg: '#eef1f4', border: '#52606d' },
  warn: { bg: '#fff1c7', border: '#8a5a00' },
  block: { bg: '#fbe3e1', border: '#b3261e' },
};

const LLM_STATE_WORDS = { unloaded: 'not loaded', loading: 'loading…', ready: 'ready', error: 'not working' } as const;

/** Health → plain-language lines for the settings drawer. */
export function describeHealth(h: HealthResponse): { ai: string; wallet: string; overall: string } {
  const where = h.llm.onDevice ? 'running on this device' : 'running on a remote server';
  const provider = h.llm.provider === 'mock' ? 'pretend AI for testing' : h.llm.provider.toUpperCase();
  const ai = `AI: ${h.llm.model} (${provider}) ${where} (${LLM_STATE_WORDS[h.llm.state]})`;
  const backend = h.wallet.backend === 'mock' ? 'mock (pretend wallet, no real payments)' : h.wallet.backend;
  const height = h.wallet.blockHeight !== undefined ? ` · block ${h.wallet.blockHeight}` : '';
  const wallet = `Wallet: ${backend} · network ${h.wallet.network} · ${h.wallet.ready ? 'ready' : 'not ready'}${height}`;
  const overall = h.ok ? 'Everything is working.' : 'Something needs attention, see the problems below.';
  return { ai, wallet, overall };
}

export type StepStatus = 'pending' | 'running' | 'done' | 'error';
export interface TimelineStep {
  stage: Stage;
  label: string;
  status: StepStatus;
  message?: string;
}

/** The four analysis steps, always shown in this order. */
export const ANALYSIS_STAGES = ['reading', 'extracting', 'checking', 'summarizing'] as const satisfies readonly Stage[];

/** Folds stage events into an ordered list of steps (first-seen order, last status wins). */
export function buildTimeline(events: readonly AppEvent[]): TimelineStep[] {
  const steps = new Map<Stage, TimelineStep>();
  for (const e of events) {
    if (e.type !== 'stage' || e.stage === 'analyzed' || e.stage === 'done') continue;
    const status: StepStatus = e.status === 'start' ? 'running' : e.status === 'end' ? 'done' : 'error';
    steps.set(e.stage, { stage: e.stage, label: STAGE_LABELS[e.stage], status, message: e.message });
  }
  return [...steps.values()];
}

/**
 * Timeline for the detail page: the four analysis steps first (pending until their first event,
 * marked done once a later step started), then any later steps seen (planning, executing).
 */
export function buildFullTimeline(events: readonly AppEvent[]): TimelineStep[] {
  const seen = new Map(buildTimeline(events).map((s) => [s.stage, s]));
  const analysis: TimelineStep[] = ANALYSIS_STAGES.map(
    (stage) => seen.get(stage) ?? { stage, label: STAGE_LABELS[stage], status: 'pending' },
  );
  // A step still "running" while a later one has started actually finished (missed end event).
  for (let i = 0; i < analysis.length - 1; i++) {
    const cur = analysis[i];
    if (cur?.status === 'running' && analysis.slice(i + 1).some((s) => s.status !== 'pending')) {
      analysis[i] = { ...cur, status: 'done' };
    }
  }
  const later = [...seen.values()].filter((s) => !(ANALYSIS_STAGES as readonly Stage[]).includes(s.stage));
  return [...analysis, ...later];
}

/** State-change events as plain-language lines with their time. */
export function stateHistory(events: readonly AppEvent[]): { at: string; label: string }[] {
  return events.flatMap((e) => (e.type === 'state' ? [{ at: e.at, label: STATE_LABELS[e.to] }] : []));
}

/** ISO date → short local date and time. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Key for de-duplicating events replayed by both GET /invoices/:id and the SSE stream. */
export const eventKey = (e: AppEvent): string => JSON.stringify(e);
