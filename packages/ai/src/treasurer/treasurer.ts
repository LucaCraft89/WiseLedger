// The Treasurer (tools, never sees invoice text): receives only the confirmed PaymentPlan.
// Skeleton (M1.S2): one forced tool call to execute_plan(planId); the handler resolves the plan, asks the guard, then pays.
import {
  type AgentChatTurn,
  type AgentReply,
  type AgentToolCallRecord,
  buildConfirmationSentence,
  type ChatMessage,
  type Confirmation,
  type EmitFn,
  type ExecutionResult,
  type FiscalService,
  formatAssetAmount,
  type LabelStore,
  type LlmProvider,
  type NeedsConfirmation,
  type PaymentGuard,
  type PaymentPlan,
  type ToolDef,
  type TransferStatus,
  type TreasurerAgent,
  verifyPlanId,
  type WalletPort,
} from 'core';
import { z } from 'zod';
import { findInjection } from '../rules/r7-injection.js';

export const TREASURER_SYSTEM = [
  'You are the Treasurer of a small business wallet. You move money only through tools.',
  'You receive a payment plan that a human has already confirmed. Execute exactly that plan by calling execute_plan with its planId.',
  'Never invent or change a planId.',
].join('\n');

export const ExecutePlanArgs = z.object({
  planId: z.string().min(1).max(100),
  /** Informational: the confirmed plan decides when it runs (scheduled plans go through the job runner). */
  executeAt: z.string().max(40).optional(),
  labels: z.array(z.string().max(40)).max(5).optional(),
});
export const GetBalanceArgs = z.object({ assetId: z.string().max(100).optional() });
export const CreateReceiveArgs = z.object({
  assetId: z.string().max(100).optional(),
  /** Base units as a decimal string. */
  amount: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
  expiryMinutes: z.number().int().min(1).max(10_080).optional(),
});

export const SchedulePaymentArgs = z.object({
  invoiceId: z.string().min(1).max(100),
  /** ISO date/time, e.g. 2026-10-23T09:00:00Z */
  executeAt: z.string().min(10).max(40),
});
export const LabelTransferArgs = z.object({ transferId: z.string().min(1).max(100), label: z.string().min(1).max(40) });
export const ListTransfersArgs = z.object({
  assetId: z.string().max(100).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
});
export const FiscalReportArgs = z.object({
  from: z.string().min(10).max(40),
  to: z.string().min(10).max(40),
  format: z.enum(['csv', 'json']).default('csv'),
});

export type TreasurerWallet = Pick<
  WalletPort,
  'pay' | 'getTransfer' | 'listAssets' | 'assetBalance' | 'createReceiveInvoice'
> &
  Partial<Pick<WalletPort, 'listTransfers'>>;

/** What chat may know about invoices: IDs and short validated fields only (never document text). */
export interface ChatInvoice {
  invoiceId: string;
  supplier?: string;
  total?: string;
  currency?: string;
  state: string;
  /** Present when a payment can be made: the code-built proposed payment. */
  payment?: { amount: string; assetId: string };
}
type AnyTool = ToolDef<Record<string, unknown>>;

export interface TreasurerDeps {
  llm: LlmProvider;
  wallet: TreasurerWallet;
  /** A's PaymentGuard (M2.S2). Until then use `confirmationGuard()`. */
  guard: PaymentGuard;
  /** Follow the transfer until Settled/Failed (default true, poll 1 s, give up after 120 s → 'submitted'). */
  follow?: boolean;
  pollMs?: number;
  followTimeoutMs?: number;
  maxRetries?: number;
  now?: () => Date;
  /** Chat tools (M3): labels and fiscal report are A's server services. */
  labels?: LabelStore;
  fiscal?: FiscalService;
  /** Open invoices for chat ("pay the Acme invoice on Friday"). */
  invoices?: () => Promise<ChatInvoice[]>;
}

/** Guard stub: knows the confirmed plans, checks the hash and executes each plan once. */
export function confirmationGuard(): PaymentGuard & { add(plan: PaymentPlan, c: Confirmation): Promise<void> } {
  const plans = new Map<string, PaymentPlan>();
  const done = new Set<string>();
  return {
    async add(plan, c) {
      if (c.planId === plan.planId && (await verifyPlanId(plan))) plans.set(plan.planId, plan);
    },
    async check(planId) {
      const plan = plans.get(planId);
      if (!plan) return { ok: false, reason: 'unknown_plan', message: 'This payment was not confirmed.' };
      if (done.has(planId)) return { ok: false, reason: 'already_executed', message: 'This payment was already made.' };
      done.add(planId);
      return { ok: true, plan };
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Treasurer implements TreasurerAgent {
  constructor(private readonly deps: TreasurerDeps) {}

  /** The tools the model can call. Arguments are short IDs and numbers; handlers resolve everything else. */
  tools(ctx: { invoiceId?: string; emit: EmitFn }): AnyTool[] {
    const { wallet } = this.deps;
    const tools: ToolDef<never>[] = [
      {
        name: 'execute_plan',
        description: 'Execute a payment plan the user has confirmed. Arguments: planId (required).',
        params: ExecutePlanArgs as never,
        requiresConfirmation: true,
        handler: (args: z.infer<typeof ExecutePlanArgs>) => this.executePlan(args.planId, ctx),
        // In chat, execute_plan is intercepted before the handler and turned into a confirmation request.
      } as ToolDef<never>,
      {
        name: 'get_balance',
        description: 'Show the wallet balance, for one asset (assetId) or for all assets.',
        params: GetBalanceArgs as never,
        requiresConfirmation: false,
        handler: async (args: z.infer<typeof GetBalanceArgs>) => {
          const assets = await wallet.listAssets();
          return assets
            .filter(
              (a) =>
                !args.assetId || a.assetId === args.assetId || a.ticker.toUpperCase() === args.assetId.toUpperCase(),
            )
            .map((a) => ({
              assetId: a.assetId,
              ticker: a.ticker,
              precision: a.precision,
              spendable: a.balance.spendable,
              settled: a.balance.settled,
            }));
        },
      } as ToolDef<never>,
      {
        name: 'create_receive_invoice',
        description:
          'Create an RGB invoice so someone can pay this wallet. Optional: assetId, amount (base units), expiryMinutes.',
        params: CreateReceiveArgs as never,
        requiresConfirmation: false,
        handler: async (args: z.infer<typeof CreateReceiveArgs>) =>
          wallet.createReceiveInvoice({
            ...(args.assetId ? { assetId: args.assetId } : {}),
            ...(args.amount ? { amount: args.amount } : {}),
            expirySec: (args.expiryMinutes ?? 60) * 60,
          }),
      } as ToolDef<never>,
      {
        name: 'schedule_payment',
        description:
          'Prepare a payment of an invoice for a later date. Arguments: invoiceId, executeAt (ISO date-time). The user confirms it on screen.',
        params: SchedulePaymentArgs as never,
        requiresConfirmation: true,
        // Never schedules by itself: returns what the user must confirm (the server schedules after the confirmation).
        handler: (args: z.infer<typeof SchedulePaymentArgs>) =>
          this.prepareConfirmation('schedule', args.invoiceId, args.executeAt),
      } as ToolDef<never>,
      {
        name: 'label_transfer',
        description: 'Add a label to a transfer (e.g. "hosting"). Arguments: transferId, label.',
        params: LabelTransferArgs as never,
        requiresConfirmation: false,
        handler: async (args: z.infer<typeof LabelTransferArgs>) => {
          if (!this.deps.labels) throw new Error('Labels are not available.');
          const current = (await this.deps.labels.get(args.transferId))?.labels ?? [];
          const label = args.label.trim().toLowerCase();
          return this.deps.labels.set(args.transferId, [...new Set([...current, label])]);
        },
      } as ToolDef<never>,
      {
        name: 'list_transfers',
        description: 'List recent transfers, newest first. Optional: assetId, from, to (ISO dates).',
        params: ListTransfersArgs as never,
        requiresConfirmation: false,
        handler: async (args: z.infer<typeof ListTransfersArgs>) => {
          if (!wallet.listTransfers) throw new Error('Transfers are not available.');
          const from = args.from ? Date.parse(args.from) : -Infinity;
          const to = args.to ? Date.parse(args.to) + 86_399_999 : Infinity;
          const all = await wallet.listTransfers(args.assetId);
          const rows = all
            .filter((t) => t.direction !== 'issuance')
            .filter((t) => Date.parse(t.createdAt) >= from && Date.parse(t.createdAt) <= to)
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
            .slice(0, 10);
          const labels = this.deps.labels;
          return Promise.all(
            rows.map(async (t) => ({
              transferId: t.transferId,
              date: t.createdAt.slice(0, 10),
              direction: t.direction,
              amount: t.amount,
              assetId: t.assetId,
              status: t.status,
              labels: labels ? ((await labels.get(t.transferId))?.labels ?? []) : [],
            })),
          );
        },
      } as ToolDef<never>,
      {
        name: 'fiscal_report',
        description:
          'Prepare the fiscal report of transfers between two dates. Arguments: from, to (ISO dates), format csv or json.',
        params: FiscalReportArgs as never,
        requiresConfirmation: false,
        handler: async (args: z.infer<typeof FiscalReportArgs>) => {
          if (!this.deps.fiscal) throw new Error('The fiscal report is not available.');
          const r = await this.deps.fiscal.report(args.from.slice(0, 10), args.to.slice(0, 10), args.format);
          // The file itself is downloaded from the UI; the model only gets the summary.
          return {
            filename: r.filename,
            format: r.format,
            rows: r.rows.length,
            from: args.from.slice(0, 10),
            to: args.to.slice(0, 10),
          };
        },
      } as ToolDef<never>,
    ];
    return tools as unknown as AnyTool[];
  }

  /** Validates the model's arguments with the tool's schema and runs it, emitting toolCall events. */
  async runTool(
    name: string,
    rawArgs: Record<string, unknown>,
    ctx: { invoiceId?: string; emit: EmitFn },
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const tool = this.tools(ctx).find((t) => t.name === name);
    const base = {
      ...(ctx.invoiceId ? { invoiceId: ctx.invoiceId } : {}),
      agent: 'treasurer' as const,
      name,
      args: rawArgs,
    };
    if (!tool) {
      ctx.emit({ type: 'toolCall', ...base, at: this.at(), status: 'rejected', message: 'Unknown tool.' });
      return { ok: false, error: `Unknown tool ${name}` };
    }
    const parsed = tool.params.safeParse(rawArgs);
    if (!parsed.success) {
      ctx.emit({ type: 'toolCall', ...base, at: this.at(), status: 'rejected', message: 'Invalid arguments.' });
      return { ok: false, error: 'Invalid arguments' };
    }
    try {
      const result = await tool.handler(parsed.data as Record<string, unknown>);
      if (name !== 'execute_plan') ctx.emit({ type: 'toolCall', ...base, at: this.at(), status: 'ok' });
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.emit({ type: 'toolCall', ...base, at: this.at(), status: 'error', message });
      return { ok: false, error: message };
    }
  }

  async execute(plan: PaymentPlan, confirmation: Confirmation, emit: EmitFn): Promise<ExecutionResult> {
    const at = this.at;
    const invoiceId = plan.invoiceId;
    if (confirmation.planId !== plan.planId) {
      return fail(plan.planId, 'hash_mismatch', 'The confirmation does not match this payment.');
    }
    if (plan.executeAt !== 'now') {
      // Scheduler lands in M3; the plan stays confirmed and is executed by the job runner through the guard.
      return { planId: plan.planId, status: 'scheduled' };
    }
    const tool = this.tools({ invoiceId, emit }).find((t) => t.name === 'execute_plan') as AnyTool;
    const facts = [
      `Confirmed payment plan: planId=${plan.planId}`,
      // No payee name or other invoice text here: the tool-calling prompt sees only IDs and numbers.
      `Pay ${plan.amount} base units of asset ${plan.assetId}, now.`,
    ].join('\n');

    const maxRetries = this.deps.maxRetries ?? 2;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      let call: { name: string; arguments: Record<string, unknown> } | undefined;
      try {
        const r = await this.deps.llm.complete({
          messages: [
            { role: 'system', content: TREASURER_SYSTEM },
            { role: 'user', content: facts },
          ],
          temperature: 0,
          tools: [
            {
              name: tool.name,
              description: tool.description,
              parameters: z.toJSONSchema(ExecutePlanArgs) as Record<string, unknown>,
            },
          ],
          toolChoice: { name: tool.name },
        });
        call = r.toolCalls[0];
      } catch {
        call = undefined;
      }
      const args = call?.name === tool.name ? ExecutePlanArgs.safeParse(call.arguments) : undefined;
      if (!args?.success || args.data.planId !== plan.planId) {
        emit({
          type: 'toolCall',
          invoiceId,
          at: at(),
          agent: 'treasurer',
          name: call?.name ?? tool.name,
          args: (call?.arguments ?? {}) as Record<string, unknown>,
          status: 'rejected',
          message: 'The AI did not call the payment with the confirmed plan; asking again.',
        });
        continue;
      }
      return (await tool.handler(args.data as Record<string, unknown>)) as ExecutionResult;
    }
    return fail(plan.planId, 'TREASURER_PARSE', 'The AI could not start the payment. Nothing was sent.');
  }

  /**
   * Plain-language wallet chat. One model call picks a tool (tool_choice auto), at most 3 tool turns. Spend tools never
   * run from chat: they come back as a NeedsConfirmation whose sentence is built by code, and the UI asks the user.
   */
  async chat(message: string, history: AgentChatTurn[], emit: EmitFn): Promise<AgentReply> {
    const ctx = { emit };
    const tools = this.tools(ctx);
    const specs = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.params) as Record<string, unknown>,
    }));
    const messages: ChatMessage[] = [
      { role: 'system', content: await this.chatSystem() },
      ...history.slice(-6).map((h) => ({ role: h.role, content: h.text.slice(0, 500) }) as ChatMessage),
      { role: 'user', content: message.slice(0, 1000) },
    ];
    const records: AgentToolCallRecord[] = [];
    for (let turn = 1; turn <= 3; turn++) {
      let r: Awaited<ReturnType<LlmProvider['complete']>>;
      try {
        r = await this.deps.llm.complete({
          messages,
          tools: specs,
          toolChoice: 'auto',
          temperature: 0.2,
          maxTokens: 300,
        });
      } catch (err) {
        return { text: 'The local AI is not available right now. Try again in a minute.', toolCalls: records };
      }
      const call = r.toolCalls[0];
      if (!call) return { text: r.text.trim() || 'Done.', toolCalls: records };

      if (call.name === 'execute_plan' || call.name === 'schedule_payment') {
        const parsed = (call.name === 'execute_plan' ? ExecutePlanArgs : SchedulePaymentArgs).safeParse(call.arguments);
        if (!parsed.success) {
          records.push({ name: call.name, args: call.arguments, ok: false, error: 'Invalid arguments' });
          messages.push({ role: 'tool', content: '{"error":"invalid arguments"}', toolCallId: call.id });
          continue;
        }
        const nc =
          call.name === 'schedule_payment'
            ? await this.prepareConfirmation(
                'schedule',
                (parsed.data as z.infer<typeof SchedulePaymentArgs>).invoiceId,
                (parsed.data as z.infer<typeof SchedulePaymentArgs>).executeAt,
              )
            : await this.prepareConfirmation(
                'payment',
                undefined,
                undefined,
                (parsed.data as z.infer<typeof ExecutePlanArgs>).planId,
              );
        records.push({ name: call.name, args: call.arguments, ok: !('error' in nc), result: nc });
        emit({
          type: 'toolCall',
          at: this.at(),
          agent: 'treasurer',
          name: call.name,
          args: call.arguments,
          status: 'error' in nc ? 'rejected' : 'ok',
          message: 'error' in nc ? nc.error : 'Waiting for your confirmation.',
        });
        if ('error' in nc) return { text: nc.error, toolCalls: records };
        return { text: `Please confirm: ${nc.sentence}`, toolCalls: records, needsConfirmation: nc };
      }

      const out = await this.runTool(call.name, call.arguments, ctx);
      records.push({
        name: call.name,
        args: call.arguments,
        ok: out.ok,
        ...(out.ok ? { result: out.result } : { error: out.error ?? 'failed' }),
      });
      messages.push({
        role: 'assistant',
        content: `Calling ${call.name} ${JSON.stringify(call.arguments).slice(0, 200)}`,
      });
      messages.push({
        role: 'tool',
        content: JSON.stringify(out.ok ? out.result : { error: out.error }).slice(0, 1500),
        toolCallId: call.id,
      });
    }
    return { text: 'Done.', toolCalls: records };
  }

  /** System prompt with today's date and the context the model may refer to (IDs + short validated fields). */
  private async chatSystem(): Promise<string> {
    const now = (this.deps.now ?? (() => new Date()))();
    const assets = await this.deps.wallet.listAssets().catch(() => []);
    const invoices = (await this.deps.invoices?.().catch(() => [])) ?? [];
    const transfers = this.deps.wallet.listTransfers ? await this.deps.wallet.listTransfers().catch(() => []) : [];
    const recent = transfers
      .filter((t) => t.direction !== 'issuance')
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 5);
    const asset = (id?: string) => assets.find((a) => a.assetId === id);
    const fmt = (amount: string, id?: string) => {
      const a = asset(id);
      return a ? `${formatAssetAmount(amount, a.precision)} ${a.ticker}` : `${amount} base units`;
    };
    return [
      'You are the Treasurer of a small business wallet (RGB assets on Bitcoin). You act only through tools.',
      `Today is ${now.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })} ${now.toISOString().slice(0, 10)}. Dates for tools are ISO (YYYY-MM-DD or full ISO time).`,
      'Use IDs exactly as written in CONTEXT. Spend tools only prepare a payment; the user confirms it on screen.',
      'After a tool result, answer in one or two short sentences, in the same language as the user.',
      'CONTEXT',
      `Assets: ${assets.map((a) => `${a.ticker} assetId=${a.assetId}`).join('; ') || 'none'}`,
      'Invoices:',
      ...(invoices.length
        ? invoices
            .slice(0, 10)
            .map(
              (i) =>
                `- invoiceId=${i.invoiceId} supplier="${safeName(i.supplier)}" total=${i.total ?? '?'} ${i.currency ?? ''} state=${i.state}${i.payment ? '' : ' (cannot be paid)'}`,
            )
        : ['- none']),
      'Recent transfers (newest first):',
      ...(recent.length
        ? recent.map(
            (t) =>
              `- transferId=${t.transferId} ${t.createdAt.slice(0, 10)} ${t.direction} ${fmt(t.amount, t.assetId)} ${t.status}`,
          )
        : ['- none']),
    ].join('\n');
  }

  /** Builds by code what the user must confirm for a spend tool. Never moves money. */
  async prepareConfirmation(
    kind: 'payment' | 'schedule',
    invoiceId?: string,
    executeAt?: string,
    planId?: string,
  ): Promise<NeedsConfirmation | { error: string }> {
    const invoices = (await this.deps.invoices?.().catch(() => [])) ?? [];
    const inv = invoiceId ? invoices.find((i) => i.invoiceId === invoiceId) : undefined;
    if (kind === 'schedule') {
      if (!inv) return { error: 'I could not find that invoice.' };
      if (!inv.payment)
        return { error: 'That invoice cannot be paid from here (it was stopped or is not checked yet).' };
      const t = executeAt ? Date.parse(executeAt) : Number.NaN;
      const now = (this.deps.now ?? (() => new Date()))().getTime();
      if (Number.isNaN(t)) return { error: 'I did not understand the date.' };
      if (t < now - 60_000) return { error: 'That date is in the past.' };
      const assets = await this.deps.wallet.listAssets().catch(() => []);
      const a = assets.find((x) => x.assetId === inv.payment?.assetId);
      const sentence = buildConfirmationSentence(
        {
          amount: inv.payment.amount,
          assetId: inv.payment.assetId,
          payee: { name: safeName(inv.supplier) },
          executeAt: new Date(t).toISOString(),
        },
        a ? { ticker: a.ticker, precision: a.precision } : undefined,
      );
      return { needsConfirmation: true, kind: 'schedule', invoiceId: inv.invoiceId, sentence };
    }
    if (!planId) return { error: 'I need the payment to confirm.' };
    return {
      needsConfirmation: true,
      kind: 'payment',
      planId,
      sentence: 'Open the invoice and confirm the payment there.',
    };
  }

  private at = () => (this.deps.now ?? (() => new Date()))().toISOString();

  /** Tool handler: resolve the plan through the guard (never from model arguments), then pay. */
  private async executePlan(planId: string, ctx: { invoiceId?: string; emit: EmitFn }): Promise<ExecutionResult> {
    const { emit } = ctx;
    const at = this.at;
    const base = {
      ...(ctx.invoiceId ? { invoiceId: ctx.invoiceId } : {}),
      agent: 'treasurer' as const,
      name: 'execute_plan',
      args: { planId },
    };
    emit({ type: 'toolCall', ...base, at: at(), status: 'called' });

    const g = await this.deps.guard.check(planId);
    if (!g.ok) {
      emit({ type: 'toolCall', ...base, at: at(), status: 'rejected', message: g.message });
      return fail(planId, g.reason, g.message);
    }
    const plan = g.plan;
    let transferId: string;
    let txid: string | undefined;
    try {
      const sent = await this.deps.wallet.pay({
        rgbInvoice: plan.rgbInvoice,
        assetId: plan.assetId,
        amount: plan.amount,
      });
      transferId = sent.transferId;
      txid = sent.txid;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: unknown })?.code;
      // SubmitTimeout: the send may have gone out. Never retried: report it as submitted so nobody offers a retry,
      // and let the wallet sync settle it.
      if (code === 'SubmitTimeout') {
        const tid = (err as { transferId?: unknown }).transferId;
        emit({ type: 'toolCall', ...base, at: at(), status: 'ok', message });
        return { planId, status: 'submitted', ...(typeof tid === 'string' ? { transferId: tid } : {}) };
      }
      emit({ type: 'toolCall', ...base, at: at(), status: 'error', message });
      return fail(planId, typeof code === 'string' ? code : 'TransferFailed', message);
    }
    emit({ type: 'toolCall', ...base, at: at(), status: 'ok' });
    emit({
      type: 'transfer',
      ...(ctx.invoiceId ? { invoiceId: ctx.invoiceId } : {}),
      at: at(),
      transferId,
      status: 'WaitingCounterparty',
      ...(txid ? { txid } : {}),
    });
    if (this.deps.follow === false) return { planId, status: 'submitted', transferId, ...(txid ? { txid } : {}) };
    return this.follow(planId, transferId, txid, ctx);
  }

  private async follow(
    planId: string,
    transferId: string,
    txid: string | undefined,
    ctx: { invoiceId?: string; emit: EmitFn },
  ): Promise<ExecutionResult> {
    const deadline = Date.now() + (this.deps.followTimeoutMs ?? 120_000);
    let last: TransferStatus = 'WaitingCounterparty';
    while (Date.now() < deadline) {
      await sleep(this.deps.pollMs ?? 1000);
      const t = await this.deps.wallet.getTransfer(transferId).catch(() => null);
      if (!t) continue;
      txid = t.txid ?? txid;
      if (t.status !== last) {
        last = t.status;
        ctx.emit({
          type: 'transfer',
          ...(ctx.invoiceId ? { invoiceId: ctx.invoiceId } : {}),
          at: this.at(),
          transferId,
          status: last,
          ...(txid ? { txid } : {}),
        });
      }
      if (last === 'Settled') return { planId, status: 'settled', transferId, ...(txid ? { txid } : {}) };
      if (last === 'Failed')
        return { ...fail(planId, 'TransferFailed', 'The transfer failed.'), transferId, ...(txid ? { txid } : {}) };
    }
    return { planId, status: 'submitted', transferId, ...(txid ? { txid } : {}) };
  }
}

/** Supplier names go into the tool prompt only as short, cleaned, validated fields; anything instruction-like is hidden. */
export function safeName(name: string | undefined): string {
  const clean = (name ?? 'Unknown supplier')
    .replace(/["\n\r\t<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return findInjection(clean) ? '[name hidden]' : clean || 'Unknown supplier';
}

function fail(planId: string, code: string, message: string): ExecutionResult {
  return { planId, status: 'failed', error: { code, message } };
}
