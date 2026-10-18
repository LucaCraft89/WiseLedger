// Pure helpers for the wallet screens: labels, transfers, scheduled payments, chat and the fiscal report.
import type { ApiClient } from '../api/client.js';
import type { ChatResponse, FiscalQuery, Job, TransferDto } from '../api/contracts.js';
import { TOOL_WORDS } from './live.js';

// ---------- labels ----------

export const LABEL_MAX_LEN = 40;
export const LABEL_MAX_COUNT = 10;

/** Trim and lower-case, like the server and the Treasurer's label_transfer tool. */
export const normalizeLabel = (raw: string): string => raw.trim().toLowerCase();

export type LabelResult = { ok: true; labels: string[] } | { ok: false; error: string };

/** Adds one label to a list, checking the same limits as `LabelsPutRequest`. Duplicates are ignored. */
export function addLabel(labels: readonly string[], raw: string): LabelResult {
  const label = normalizeLabel(raw);
  if (!label) return { ok: false, error: 'Type a label first.' };
  if (label.length > LABEL_MAX_LEN) return { ok: false, error: `A label can be at most ${LABEL_MAX_LEN} characters.` };
  if (labels.includes(label)) return { ok: true, labels: [...labels] };
  if (labels.length >= LABEL_MAX_COUNT) {
    return { ok: false, error: `At most ${LABEL_MAX_COUNT} labels per transfer. Remove one first.` };
  }
  return { ok: true, labels: [...labels, label] };
}

export const removeLabel = (labels: readonly string[], label: string): string[] => labels.filter((l) => l !== label);

/** Inline label editor state: idle (chips) → editing (input) → saving → idle, or an error shown under the input. */
export type LabelEditState =
  | { mode: 'idle' }
  | { mode: 'editing'; draft: string; error?: string }
  | { mode: 'saving'; draft: string };

export type LabelEditAction =
  | { type: 'start' }
  | { type: 'type'; draft: string }
  | { type: 'cancel' }
  | { type: 'save' }
  | { type: 'saved' }
  | { type: 'failed'; error: string };

export function labelEditReducer(s: LabelEditState, a: LabelEditAction): LabelEditState {
  switch (a.type) {
    case 'start':
      return { mode: 'editing', draft: '' };
    case 'type':
      return s.mode === 'editing' ? { mode: 'editing', draft: a.draft } : s;
    case 'cancel':
      return s.mode === 'saving' ? s : { mode: 'idle' };
    case 'save':
      return s.mode === 'editing' ? { mode: 'saving', draft: s.draft } : s;
    case 'saved':
      return { mode: 'idle' };
    case 'failed':
      return { mode: 'editing', draft: s.mode === 'idle' ? '' : s.draft, error: a.error };
  }
}

// ---------- transfers ----------

export const DIRECTION_WORDS: Record<TransferDto['direction'], string> = { in: 'Received', out: 'Sent' };

/** Chip colours of transfer statuses (theme tokens: readable in light and dark). */
export const TRANSFER_STATUS_TONE: Record<TransferDto['status'], { bg: string; fg: string }> = {
  WaitingCounterparty: { bg: 'var(--wl-c-pending-bg)', fg: 'var(--wl-c-warn-text)' },
  WaitingConfirmations: { bg: 'var(--wl-c-running-bg)', fg: 'var(--wl-c-strong)' },
  Settled: { bg: 'var(--wl-c-ok-bg)', fg: 'var(--wl-c-ok-text)' },
  Failed: { bg: 'var(--wl-c-error-bg)', fg: 'var(--wl-c-error)' },
};

export const TRANSFER_STATUS_WORDS: Record<TransferDto['status'], string> = {
  WaitingCounterparty: 'Waiting for the other wallet',
  WaitingConfirmations: 'Waiting for a block confirmation',
  Settled: 'Completed',
  Failed: 'Failed',
};

/** Newest first, at most `limit`. */
/** An unpaid payment request: rgb-lib lists it as an incoming transfer still waiting for the payer. */
export const isUnpaidRequest = (t: Pick<TransferDto, 'direction' | 'status'>): boolean =>
  t.direction === 'in' && t.status === 'WaitingCounterparty';

/** Newest first, money that moved only (unpaid payment requests live under Wallet → Get paid). */
export function recentTransfers(list: readonly TransferDto[], limit = 10): TransferDto[] {
  return [...list]
    .filter((t) => !isUnpaidRequest(t))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);
}

// ---------- scheduled payments ----------

export const JOB_STATUS_WORDS: Record<Job['status'], string> = {
  pending: 'Waiting',
  running: 'Paying now',
  done: 'Paid',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export const JOB_STATUS_COLORS: Record<Job['status'], string> = {
  pending: 'var(--wl-c-pending-bg)',
  running: 'var(--wl-c-running-bg)',
  done: 'var(--wl-c-ok-bg)',
  cancelled: 'var(--wl-c-neutral-bg)',
  failed: 'var(--wl-c-error-bg)',
};

export const canCancelJob = (job: Pick<Job, 'status'>): boolean => job.status === 'pending';

/** Pending and running first (soonest first), then the rest (most recent first). */
export function sortJobs(jobs: readonly Job[]): Job[] {
  const open = (j: Job) => j.status === 'pending' || j.status === 'running';
  return [...jobs].sort((a, b) => {
    if (open(a) !== open(b)) return open(a) ? -1 : 1;
    return open(a) ? Date.parse(a.runAt) - Date.parse(b.runAt) : Date.parse(b.runAt) - Date.parse(a.runAt);
  });
}

/** "Fri 23 Oct, 09:00" in local time. */
export function formatRunAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day}, ${time}`;
}

export const scheduledSentence = (iso: string): string => `Scheduled for ${formatRunAt(iso)}.`;

// ---------- chat ----------

export type ToolCall = ChatResponse['toolCalls'][number];
export type NeedsConfirmation = NonNullable<ChatResponse['needsConfirmation']>;

/** Small chip text for a tool call in plain words: "Checking the balance ✓" or "… ✗ failed". */
export const toolChipText = (c: Pick<ToolCall, 'name' | 'ok'>): string =>
  `${TOOL_WORDS[c.name] ?? c.name} ${c.ok ? '✓' : '✗ failed'}`;

/** Where to see what a tool made or read ("See it in Wallet"); null when there is nothing to open. */
export function toolLink(c: Pick<ToolCall, 'name' | 'ok' | 'result'>): { href: string; label: string } | null {
  if (!c.ok) return null;
  // The payment request card under the reply links to it already.
  if (c.name === 'create_receive_invoice') return null;
  if (c.name === 'check_payment_request') {
    const id = (c.result as { invoiceId?: unknown } | undefined)?.invoiceId;
    return typeof id === 'string' ? { href: `#/invoice/${encodeURIComponent(id)}`, label: 'Open the check' } : null;
  }
  if (c.name === 'label_transfer' || c.name === 'list_transfers')
    return { href: '#/transfers', label: 'See transfers' };
  if (c.name === 'get_balance') return { href: '#/wallet', label: 'Open Wallet' };
  return null;
}

/** The payment request a create_receive_invoice call returned, for a copy button in chat. */
export function receiveFromToolCall(c: Pick<ToolCall, 'name' | 'ok' | 'result'>): string | undefined {
  if (c.name !== 'create_receive_invoice' || !c.ok) return undefined;
  const inv = (c.result as { rgbInvoice?: unknown } | undefined)?.rgbInvoice;
  return typeof inv === 'string' ? inv : undefined;
}

/** executeAt of the schedule_payment call that asked for the confirmation (last one wins). */
export function scheduleExecuteAt(calls: readonly ToolCall[]): string | undefined {
  for (const c of [...calls].reverse()) {
    if (c.name !== 'schedule_payment') continue;
    const at = c.args.executeAt;
    if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) return at;
  }
  return undefined;
}

/** Fiscal query from a successful fiscal_report call ({filename, format, from, to}), else undefined. */
export function fiscalFromToolCall(c: ToolCall): FiscalQuery | undefined {
  if (c.name !== 'fiscal_report' || !c.ok || !c.result || typeof c.result !== 'object') return undefined;
  const r = c.result as Record<string, unknown>;
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof r.from !== 'string' || typeof r.to !== 'string' || !date.test(r.from) || !date.test(r.to))
    return undefined;
  return { from: r.from, to: r.to, format: r.format === 'json' ? 'json' : 'csv' };
}

/**
 * "Confirm" on a schedule card: reads the invoice for its current planId, then confirms with executeAt
 * (taken from the schedule_payment call). override only when the verdict is review. Returns a plain sentence.
 */
export async function confirmScheduleFromChat(
  api: Pick<ApiClient, 'getInvoice' | 'confirm'>,
  nc: NeedsConfirmation,
  calls: readonly ToolCall[],
): Promise<string> {
  const executeAt = scheduleExecuteAt(calls);
  if (!executeAt) throw new Error('The payment date is missing. Please ask the Treasurer again.');
  if (!nc.invoiceId) throw new Error('The invoice is missing. Please ask the Treasurer again.');
  const d = await api.getInvoice(nc.invoiceId);
  const planId = d.plan?.planId;
  if (!planId) throw new Error('This invoice has no payment ready. Open the invoice to check it.');
  const verdict = d.report?.verdict;
  if (verdict === 'block') throw new Error('This invoice was stopped because it looks unsafe. It cannot be paid.');
  await api.confirm(nc.invoiceId, { planId, executeAt, ...(verdict === 'review' ? { override: true } : {}) });
  return scheduledSentence(executeAt);
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** "(done: create_receive_invoice {"amount":"100"} ok)" — what the Treasurer did in a turn, so a follow-up can refer to it. */
export function toolNote(calls: readonly Pick<ToolCall, 'name' | 'args' | 'ok'>[] | undefined): string {
  if (!calls?.length) return '';
  const parts = calls.map((c) => `${c.name} ${JSON.stringify(c.args).slice(0, 120)} ${c.ok ? 'ok' : 'failed'}`);
  return `\n(done: ${parts.join('; ')})`;
}

/** The history sent with each message: the last 10 turns, assistant turns with what their tools did. */
export const chatHistory = (
  turns: readonly (ChatTurn & { reply?: Pick<ChatResponse, 'toolCalls'> })[],
  max = 10,
): ChatTurn[] =>
  turns
    .slice(-max)
    .map(({ role, text, reply }) => ({ role, text: role === 'assistant' ? text + toolNote(reply?.toolCalls) : text }));

export const CHAT_SUGGESTIONS = [
  'What is my TUSDT balance?',
  'Label my last payment as hosting',
  'Report for September',
  'Pay the Acme invoice on Friday',
] as const;

// ---------- fiscal report ----------

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** First and last day of the month before `now` (local dates). */
export function defaultFiscalRange(now: Date = new Date()): { from: string; to: string } {
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  return { from: ymd(first), to: ymd(last) };
}

/** Plain-language problem with a range, or null when it is fine. */
export function fiscalRangeError(from: string, to: string): string | null {
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (!date.test(from) || !date.test(to)) return 'Choose both dates.';
  if (from > to) return 'The start date must be before the end date.';
  return null;
}

export function fiscalUrl(q: FiscalQuery, base = ''): string {
  const p = new URLSearchParams({ from: q.from, to: q.to, format: q.format });
  return `${base}/api/fiscal?${p.toString()}`;
}

export const fiscalFilename = (q: FiscalQuery): string => `wiseledger-report-${q.from}_${q.to}.${q.format}`;
