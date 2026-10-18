import type { AnalysisStep, AppEvent, Stage, ToolCallEvent } from '../api/contracts.js';
import { eventKey } from './format.js';

/** Characters of live AI text kept on screen (the tail). */
export const LIVE_TEXT_CAP = 600;

/** Analyst stages that get a live box, with a plain "what is happening" line. */
export const LIVE_STAGE_TEXT: Partial<Record<Stage, { title: string; detail: string }>> = {
  reading: { title: 'Reading the document…', detail: 'Opening the file and getting its text.' },
  extracting: {
    title: 'Extracting the details…',
    detail: 'The local AI is reading the invoice fields: supplier, amount, due date, payment details.',
  },
  checking: { title: 'Checking the safety rules…', detail: 'Comparing the invoice with your history and my rules.' },
  summarizing: { title: 'Writing the summary…', detail: 'The local AI is writing a summary in plain words.' },
};

export interface LiveAiView {
  /** Stage the Analyst is working on now; undefined when it is not working. */
  stage?: Stage;
  /** The finer Analyst step (A's StageEvent.step), when the server sends it. */
  step?: AnalysisStep;
  /** Analyst tokens received during the current stage (last LIVE_TEXT_CAP chars). */
  text: string;
  /** True once the analysis finished (or failed). */
  finished: boolean;
}

/** Folds events into the live Analyst view: the text resets at every stage start. */
export function liveAiView(events: readonly AppEvent[]): LiveAiView {
  let view: LiveAiView = { text: '', finished: false };
  for (const e of events) {
    if (e.type === 'stage') {
      if (e.stage === 'analyzed' || e.status === 'error') {
        view = { ...view, stage: undefined, step: undefined, finished: true };
      } else if (e.status === 'start' && LIVE_STAGE_TEXT[e.stage]) {
        view = { stage: e.stage, ...(e.step ? { step: e.step } : {}), text: '', finished: false };
      } else if (e.status === 'start') {
        // Later stages (planning, executing) belong to the Treasurer.
        view = { ...view, stage: undefined, step: undefined };
      }
    } else if (e.type === 'token' && e.agent === 'analyst') {
      view = { ...view, text: (view.text + e.text).slice(-LIVE_TEXT_CAP) };
    }
  }
  return view;
}

/** Plain words for the Treasurer's tools; unknown tools fall back to their name. */
export const TOOL_WORDS: Record<string, string> = {
  execute_plan: 'Sending the payment you confirmed',
  get_balance: 'Checking the balance',
  create_receive_invoice: 'Creating a payment request',
  check_payment_request: 'Opening the payment request for checking',
  schedule_payment: 'Scheduling a payment',
  label_transfer: 'Labelling a payment',
  list_transfers: 'Looking up past payments',
  fiscal_report: 'Preparing the report',
};

/** Plain words first, then the technical call (long IDs shortened, so the line wraps on a narrow window). */
export function toolCallParts(e: ToolCallEvent): { text: string; tech: string } {
  const who = e.agent === 'treasurer' ? 'Treasurer' : 'Analyst';
  const args = Object.entries(e.args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? shortId(v, 6) : JSON.stringify(v)}`)
    .join(', ');
  const status = { called: 'started', ok: 'done', rejected: 'refused', error: 'failed' }[e.status];
  const what = TOOL_WORDS[e.name] ?? `Using the tool ${e.name}`;
  return { text: `${who}: ${what}: ${status}${e.message ? `, ${e.message}` : ''}`, tech: `${e.name}(${args})` };
}

/** "Treasurer: Sending the payment you confirmed: done (execute_plan(planId=plan_1))". */
export function toolCallLine(e: ToolCallEvent): string {
  const p = toolCallParts(e);
  return `${p.text} (${p.tech})`;
}

/**
 * Merges events into the list without duplicates. Batches replayed by GET /invoices/:id are compared as
 * multisets (two identical tokens stay two tokens); a single live token is always appended, because the
 * model can stream the same text twice in the same millisecond.
 */
export function mergeEvents(prev: readonly AppEvent[], incoming: readonly AppEvent[], live = false): AppEvent[] {
  if (live && incoming.every((e) => e.type === 'token')) return [...prev, ...incoming];
  const have = new Map<string, number>();
  for (const e of prev) have.set(eventKey(e), (have.get(eventKey(e)) ?? 0) + 1);
  const fresh: AppEvent[] = [];
  for (const e of incoming) {
    const k = eventKey(e);
    const n = have.get(k) ?? 0;
    if (n > 0) have.set(k, n - 1);
    else fresh.push(e);
  }
  return fresh.length ? [...prev, ...fresh] : (prev as AppEvent[]);
}

/**
 * Tokens typed by the user ("12.5") → base units string at `precision` ("12500000" at 6).
 * Empty input → undefined (any amount). Returns an error message for invalid input.
 */
export function toBaseUnits(
  tokens: string,
  precision: number,
): { ok: true; value?: string } | { ok: false; error: string } {
  const t = tokens.trim().replace(',', '.');
  if (t === '') return { ok: true };
  if (!/^\d+(\.\d+)?$/.test(t)) return { ok: false, error: 'Write the amount as a number, for example 12.50.' };
  const [whole = '0', frac = ''] = t.split('.');
  if (frac.length > precision) {
    return { ok: false, error: `This asset allows at most ${precision} decimals.` };
  }
  const value = (whole + frac.padEnd(precision, '0')).replace(/^0+(?=\d)/, '');
  if (/^0+$/.test(value)) return { ok: false, error: 'The amount must be more than zero.' };
  return { ok: true, value };
}

/** "rgb:abcdef…uvwxyz" for display; the full ID stays copyable. */
export function shortId(id: string, keep = 10): string {
  return id.length <= keep * 2 + 1 ? id : `${id.slice(0, keep)}…${id.slice(-keep)}`;
}

export const BACKEND_WORDS = {
  mock: 'pretend wallet for testing, no real payments',
  'wdk-rgb': 'Tether WDK wallet with RGB (self-custodial: your keys stay on this computer)',
  'rgb-lib': 'rgb-lib wallet',
} as const;

export const NETWORK_WORDS = {
  mutinynet: 'Mutinynet (Bitcoin test network, no real money)',
  regtest: 'local test network (no real money)',
  mock: 'no network (demo)',
} as const;
