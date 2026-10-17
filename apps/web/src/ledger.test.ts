import { describe, expect, it } from 'vitest';
import { ChatResponse, type InvoiceState, type Job, ScheduleListResponse, TransfersResponse } from './api/contracts.js';
import { createFakeClient, monthRange, nextFriday } from './api/fake.js';
import {
  addLabel,
  CHAT_SUGGESTIONS,
  canCancelJob,
  chatHistory,
  confirmScheduleFromChat,
  defaultFiscalRange,
  fiscalFromToolCall,
  fiscalRangeError,
  fiscalUrl,
  formatRunAt,
  labelEditReducer,
  recentTransfers,
  scheduleExecuteAt,
  sortJobs,
  toolChipText,
} from './lib/ledger.js';

const fast = () => createFakeClient({ stageDelayMs: 0, transferStepMs: 0, pollMs: 1 });

async function waitForState(api: ReturnType<typeof fast>, id: string, state: InvoiceState) {
  for (let i = 0; i < 200; i++) {
    if ((await api.getInvoice(id)).invoice.state === state) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${state}`);
}

describe('labels', () => {
  it('trims, lower-cases, ignores duplicates and enforces the limits', () => {
    expect(addLabel([], '  Hosting ')).toEqual({ ok: true, labels: ['hosting'] });
    expect(addLabel(['hosting'], 'HOSTING')).toEqual({ ok: true, labels: ['hosting'] });
    expect(addLabel([], '   ').ok).toBe(false);
    expect(addLabel([], 'x'.repeat(41)).ok).toBe(false);
    expect(addLabel([], 'x'.repeat(40)).ok).toBe(true);
    const ten = Array.from({ length: 10 }, (_, i) => `l${i}`);
    expect(addLabel(ten, 'one-more').ok).toBe(false);
  });

  it('editor: start → type → Enter saves; Esc cancels; failure keeps the draft', () => {
    let s = labelEditReducer({ mode: 'idle' }, { type: 'start' });
    s = labelEditReducer(s, { type: 'type', draft: 'rent' });
    expect(labelEditReducer(s, { type: 'cancel' })).toEqual({ mode: 'idle' });
    const saving = labelEditReducer(s, { type: 'save' });
    expect(saving).toEqual({ mode: 'saving', draft: 'rent' });
    expect(labelEditReducer(saving, { type: 'cancel' })).toBe(saving);
    expect(labelEditReducer(saving, { type: 'failed', error: 'no' })).toEqual({
      mode: 'editing',
      draft: 'rent',
      error: 'no',
    });
    expect(labelEditReducer(saving, { type: 'saved' })).toEqual({ mode: 'idle' });
  });
});

describe('scheduled payments helpers', () => {
  const job = (jobId: string, status: Job['status'], runAt: string): Job => ({
    jobId,
    planId: 'p',
    invoiceId: 'i',
    runAt,
    status,
    createdAt: runAt,
    updatedAt: runAt,
  });

  it('only pending jobs can be cancelled', () => {
    expect(canCancelJob({ status: 'pending' })).toBe(true);
    for (const s of ['running', 'done', 'cancelled', 'failed'] as const)
      expect(canCancelJob({ status: s })).toBe(false);
  });

  it('sorts open jobs first (soonest first), then the rest (latest first)', () => {
    const jobs = [
      job('done-old', 'done', '2026-10-01T09:00:00Z'),
      job('pend-late', 'pending', '2026-10-30T09:00:00Z'),
      job('canc-new', 'cancelled', '2026-10-10T09:00:00Z'),
      job('pend-soon', 'pending', '2026-10-20T09:00:00Z'),
    ];
    expect(sortJobs(jobs).map((j) => j.jobId)).toEqual(['pend-soon', 'pend-late', 'canc-new', 'done-old']);
  });

  it('formats the run time as "Fri 23 Oct, 09:00" (local)', () => {
    expect(formatRunAt(new Date(2026, 9, 23, 9, 0).toISOString())).toBe('Fri 23 Oct, 09:00');
  });

  it('next Friday at 09:00, never today', () => {
    const f = nextFriday(new Date(2026, 9, 17, 15, 0)); // Sat 17 Oct
    expect([f.getDate(), f.getMonth(), f.getHours(), f.getMinutes()]).toEqual([23, 9, 9, 0]);
    expect(nextFriday(new Date(2026, 9, 23, 8, 0)).getDate()).toBe(30);
  });
});

describe('chat helpers', () => {
  it('shows tool calls as chips with ✓ / ✗', () => {
    expect(toolChipText({ name: 'get_balance', ok: true })).toBe('Checking the balance ✓');
    expect(toolChipText({ name: 'label_transfer', ok: false })).toBe('Labelling a payment ✗ failed');
    expect(toolChipText({ name: 'new_tool', ok: true })).toBe('new_tool ✓');
  });

  it('takes executeAt from the schedule_payment call', () => {
    const at = '2026-10-23T07:00:00.000Z';
    expect(
      scheduleExecuteAt([
        { name: 'list_transfers', args: {}, ok: true },
        { name: 'schedule_payment', args: { invoiceId: 'i', executeAt: at }, ok: true },
      ]),
    ).toBe(at);
    expect(scheduleExecuteAt([{ name: 'schedule_payment', args: { executeAt: 'friday' }, ok: true }])).toBeUndefined();
    expect(scheduleExecuteAt([])).toBeUndefined();
  });

  it('turns a fiscal_report result into a download query', () => {
    const call = {
      name: 'fiscal_report',
      args: {},
      ok: true,
      result: { filename: 'r.csv', format: 'csv', from: '2026-09-01', to: '2026-09-30' },
    };
    const q = fiscalFromToolCall(call);
    expect(q).toEqual({ from: '2026-09-01', to: '2026-09-30', format: 'csv' });
    expect(fiscalUrl({ from: '2026-09-01', to: '2026-09-30', format: 'csv' })).toBe(
      '/api/fiscal?from=2026-09-01&to=2026-09-30&format=csv',
    );
    expect(fiscalFromToolCall({ ...call, ok: false })).toBeUndefined();
  });

  it('sends the last 10 turns; assistant turns carry what their tools did', () => {
    const turns = Array.from({ length: 12 }, (_, i) => ({ role: 'user' as const, text: `m${i}` }));
    expect(chatHistory(turns).map((t) => t.text)).toEqual([
      'm2',
      'm3',
      'm4',
      'm5',
      'm6',
      'm7',
      'm8',
      'm9',
      'm10',
      'm11',
    ]);
    const withTool = chatHistory([
      { role: 'user', text: 'request 100 TUSDT for 30 minutes' },
      {
        role: 'assistant',
        text: 'Here is your payment request.',
        reply: {
          toolCalls: [{ name: 'create_receive_invoice', args: { amount: '100', expiryMinutes: 30 }, ok: true }],
        },
      },
    ]);
    expect(withTool[1]?.text).toBe(
      'Here is your payment request.\n(done: create_receive_invoice {"amount":"100","expiryMinutes":30} ok)',
    );
  });
});

describe('fiscal report form', () => {
  it('defaults to the previous month', () => {
    expect(defaultFiscalRange(new Date(2026, 9, 17))).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(defaultFiscalRange(new Date(2026, 0, 5))).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(defaultFiscalRange(new Date(2028, 2, 1))).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('checks the range in plain words', () => {
    expect(fiscalRangeError('2026-09-01', '2026-09-30')).toBeNull();
    expect(fiscalRangeError('2026-10-01', '2026-09-30')).toMatch(/before/);
    expect(fiscalRangeError('', '2026-09-30')).toMatch(/both dates/);
  });

  it('names the month asked for (most recent past one)', () => {
    expect(monthRange('Report for September', new Date(2026, 9, 17))).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(monthRange('Report for November', new Date(2026, 9, 17)).from).toBe('2025-11-01');
  });
});

describe('fake wallet tools', () => {
  it('lists transfers newest first and saves labels', async () => {
    const api = fast();
    const t = TransfersResponse.parse(await api.transfers());
    expect(t.transfers.length).toBeGreaterThanOrEqual(3);
    const lastOut = recentTransfers(t.transfers, 10).find((x) => x.direction === 'out');
    expect(lastOut?.amount).toBe('25000000');
    const saved = await api.setLabels(lastOut?.transferId ?? '', { labels: ['Hosting', 'hosting', 'it'] });
    expect(saved.labels).toEqual(['hosting', 'it']);
    await expect(api.setLabels(lastOut?.transferId ?? '', { labels: ['x'.repeat(41)] })).rejects.toThrow();
    expect(api.fiscalUrl({ from: '2026-09-01', to: '2026-09-30', format: 'csv' })).toBeNull();
  });

  it('answers the 4 example prompts; Friday schedules after the confirmation card; cancel works', async () => {
    const api = fast();
    expect(CHAT_SUGGESTIONS).toHaveLength(4);
    const [balanceQ, labelQ, reportQ, payQ] = CHAT_SUGGESTIONS;

    const balance = ChatResponse.parse(await api.chat({ message: balanceQ }));
    expect(balance.toolCalls[0]).toMatchObject({ name: 'get_balance', ok: true });
    expect(balance.text).toMatch(/TUSDT/);

    const label = ChatResponse.parse(await api.chat({ message: labelQ }));
    expect(label.toolCalls.map((c) => c.name)).toEqual(['list_transfers', 'label_transfer']);
    const labelled = (await api.transfers()).transfers.find((x) => x.labels.includes('hosting'));
    expect(labelled?.amount).toBe('25000000');

    const report = ChatResponse.parse(await api.chat({ message: reportQ }));
    const fiscalCall = report.toolCalls[0];
    expect(fiscalCall && fiscalFromToolCall(fiscalCall)?.from).toMatch(/-09-01$/);

    // No invoice yet → a plain answer, no confirmation.
    const none = ChatResponse.parse(await api.chat({ message: payQ }));
    expect(none.needsConfirmation).toBeUndefined();

    const { invoiceId } = await api.createInvoice({ text: 'acme', filename: 'acme-hosting.txt' });
    await waitForState(api, invoiceId, 'AWAITING_CONFIRMATION');
    const pay = ChatResponse.parse(await api.chat({ message: payQ }));
    expect(pay.needsConfirmation).toMatchObject({ kind: 'schedule', invoiceId });
    const executeAt = scheduleExecuteAt(pay.toolCalls);
    expect(new Date(executeAt ?? '').getDay()).toBe(5);

    const nc = pay.needsConfirmation;
    if (!nc) throw new Error('missing confirmation');
    const sentence = await confirmScheduleFromChat(api, nc, pay.toolCalls);
    expect(sentence).toMatch(/^Scheduled for Fri \d+ \w+, 09:00\.$/);
    expect((await api.getInvoice(invoiceId)).invoice.state).toBe('SCHEDULED');
    const jobs = ScheduleListResponse.parse(await api.schedule()).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ invoiceId, status: 'pending', runAt: executeAt });
    expect(await api.cancelJob(jobs[0]?.jobId ?? '')).toEqual({ ok: true });
    expect(await api.cancelJob(jobs[0]?.jobId ?? '')).toEqual({ ok: false });
    expect((await api.schedule()).jobs[0]?.status).toBe('cancelled');
    expect((await api.getInvoice(invoiceId)).invoice.state).toBe('AWAITING_CONFIRMATION');
  });
});

describe('unpaid payment requests', () => {
  it('are not recent transfers (they live under Get paid)', async () => {
    const { recentTransfers, isUnpaidRequest } = await import('./lib/ledger.js');
    const base = { assetId: 'a', labels: [], createdAt: '2026-10-17T10:00:00Z' };
    const list = [
      { ...base, transferId: '1', amount: '1', direction: 'in' as const, status: 'WaitingCounterparty' as const },
      { ...base, transferId: '2', amount: '1', direction: 'in' as const, status: 'Settled' as const },
      { ...base, transferId: '3', amount: '1', direction: 'out' as const, status: 'WaitingCounterparty' as const },
    ];
    expect(recentTransfers(list).map((t) => t.transferId)).toEqual(['2', '3']);
    expect(isUnpaidRequest(list[0] as (typeof list)[number])).toBe(true);
  });
});

describe('table dates', () => {
  it('short: day, month and 24 h time; the year only when it differs', async () => {
    const { shortDate } = await import('./lib/format.js');
    const now = new Date('2026-10-17T12:00:00');
    expect(shortDate('2026-10-17T16:46:00', now)).toBe('17 Oct, 16:46');
    expect(shortDate('2025-03-02T09:05:00', now)).toBe('2 Mar 2025, 09:05');
    expect(shortDate('not a date', now)).toBe('not a date');
  });
});
