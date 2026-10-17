// The Treasurer (tools, never sees invoice text): receives only the confirmed PaymentPlan.
// Skeleton (M1.S2): one forced tool call to execute_plan(planId); the handler resolves the plan, asks the guard, then pays.
import {
  type AgentChatTurn,
  type AgentReply,
  type AgentToolCallRecord,
  buildConfirmationSentence,
  type ChatMessage,
  type ChatStreamHooks,
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
  type ReceiveInvoice,
  type ToolDef,
  type TransferStatus,
  type TreasurerAgent,
  verifyPlanId,
  type WalletPort,
} from 'core';
import { z } from 'zod';
import { findInjection } from '../rules/r7-injection.js';
import { toBaseUnits } from '../rules/types.js';

/**
 * Asset and base-unit amount for a payment request from chat. The asset must be one this wallet holds, matched by
 * asset ID (never by ticker); with an amount and no asset, the wallet's only asset is used. Amounts come in tokens and
 * are converted here, because small models misread base units. Throws plain-language errors the model can relay.
 */
export async function receiveTarget(
  wallet: Pick<WalletPort, 'listAssets'>,
  args: { assetId?: string | undefined; amount?: string | undefined },
): Promise<{ assetId?: string; amount?: string }> {
  const assets = await wallet.listAssets();
  const held = assets.map((a) => `${a.ticker} (assetId=${a.assetId})`).join(', ') || 'no tokens yet';
  let asset = args.assetId ? assets.find((a) => a.assetId === args.assetId) : undefined;
  if (args.assetId && !asset) throw new Error(`This wallet can only ask for tokens it holds: ${held}.`);
  if (!asset && args.amount) {
    if (assets.length !== 1) throw new Error(`Which token should the request be in? This wallet holds: ${held}.`);
    asset = assets[0];
  }
  if (!asset) return {};
  if (!args.amount) return { assetId: asset.assetId };
  const amount = toBaseUnits(args.amount, asset.precision);
  if (!amount || amount === '0')
    throw new Error(`${args.amount} is not a valid amount of ${asset.ticker} (at most ${asset.precision} decimals).`);
  return { assetId: asset.assetId, amount };
}

/**
 * One chat turn through llm.stream(): reply text goes to the screen as it comes. A turn whose text starts like a
 * tool call ("{", "<tool", a code fence) is held back, so raw JSON never flashes in the chat.
 */
async function streamTurn(
  llm: LlmProvider,
  req: Parameters<LlmProvider['complete']>[0],
  hooks: ChatStreamHooks,
): Promise<Awaited<ReturnType<LlmProvider['complete']>>> {
  let seen = '';
  let live: boolean | undefined;
  for await (const e of llm.stream(req)) {
    if (e.type === 'token') {
      seen += e.text;
      if (live === undefined && seen.trim()) live = !/^\s*(\{|\[|<|```)/.test(seen);
      if (live) hooks.onToken(e.text === seen ? e.text.trimStart() : e.text);
    } else if (e.type === 'done') {
      return e.result;
    }
  }
  throw new Error('The local AI stopped without an answer.');
}

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
  /** Tokens as the user says them ("100", "12.50"); code converts to base units with the asset's precision. */
  amount: z
    .string()
    .regex(/^\d{1,12}(\.\d{1,18})?$/)
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
  /** ISO upload time: chat lists invoices newest first and marks the latest ("pay the latest invoice"). */
  createdAt?: string;
  /**
   * Present when a payment can be made: the code-built proposed payment. `rgbInvoice` only picks the rail for the
   * confirmation sentence ("via Lightning (instant)"); it never goes into a prompt.
   */
  payment?: { amount: string; assetId: string; rgbInvoice?: string };
  /** The Analyst's verdict, so chat can say why an invoice was stopped or needs review. */
  verdict?: 'ok' | 'review' | 'block';
  /** Codes of the warn/block flags (FLAG_CODES). Shown as fixed words from CHECK_WORDS, never as flag messages. */
  flagCodes?: string[];
}

/**
 * Plain words for each rule, written by us. Flag messages and evidence can quote the invoice (untrusted), so the
 * Treasurer only ever sees these fixed phrases; unknown codes are dropped.
 */
export const CHECK_WORDS: Record<string, string> = {
  R1_RGB_INVOICE: 'payment request problem',
  R2_ASSET: 'token not accepted',
  R3_AMOUNT: 'amount problem',
  R4_DUPLICATE: 'already received or paid',
  R5_NEW_PAYEE: 'new or look-alike supplier',
  R6_PRESSURE: 'pressure or changed bank details',
  R7_INJECTION: 'hidden orders to the AI',
  R8_CURRENCY: 'different currency',
  R9_MISSING_FIELDS: 'missing details',
  R10_DATES: 'strange dates',
  AI_UNAVAILABLE: 'the local AI could not check it',
};
const VERDICT_WORDS = { ok: 'looks fine', review: 'check before paying', block: 'do not pay' } as const;

/** " check=do not pay (already received or paid; amount problem)" — code-built, for the chat context. */
export function checkText(i: Pick<ChatInvoice, 'verdict' | 'flagCodes'>): string {
  if (!i.verdict) return '';
  const reasons = [...new Set((i.flagCodes ?? []).map((c) => CHECK_WORDS[c]).filter(Boolean))];
  return ` check="${VERDICT_WORDS[i.verdict]}"${reasons.length ? ` reasons="${reasons.join('; ')}"` : ''}`;
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
  /** IANA zone for dates in confirmation sentences (default: this machine's zone). */
  timeZone?: string;
  /** Called with every payment request made from chat, so the server lists it under "Get paid" like the UI's own. */
  onReceiveCreated?: (inv: ReceiveInvoice) => void | Promise<void>;
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
              // Display amounts formatted by code: small models misread base units (975000000 → "975,000,000 TUSDT").
              spendable: `${formatAssetAmount(a.balance.spendable, a.precision)} ${a.ticker}`,
              settled: `${formatAssetAmount(a.balance.settled, a.precision)} ${a.ticker}`,
            }));
        },
      } as ToolDef<never>,
      {
        name: 'create_receive_invoice',
        description:
          'Create an invoice (payment request) so someone can pay this wallet. Needs no address. Optional: amount in tokens as the user says it (e.g. "100" or "12.50"), assetId from CONTEXT, expiryMinutes (how long it stays valid).',
        params: CreateReceiveArgs as never,
        requiresConfirmation: false,
        handler: async (args: z.infer<typeof CreateReceiveArgs>) => {
          const { assetId, amount } = await receiveTarget(wallet, args);
          const inv = await wallet.createReceiveInvoice({
            ...(assetId ? { assetId } : {}),
            ...(amount ? { amount } : {}),
            expirySec: (args.expiryMinutes ?? 60) * 60,
          });
          await this.deps.onReceiveCreated?.(inv);
          return inv;
        },
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
          const assets = await wallet.listAssets().catch(() => []);
          const show = (amount: string, id?: string) => {
            const a = assets.find((x) => x.assetId === id);
            return a ? `${formatAssetAmount(amount, a.precision)} ${a.ticker}` : `${amount} base units`;
          };
          return Promise.all(
            rows.map(async (t) => ({
              transferId: t.transferId,
              date: t.createdAt.slice(0, 10),
              direction: t.direction,
              amount: show(t.amount, t.assetId),
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
    if (confirmation.planId !== plan.planId) {
      return fail(plan.planId, 'hash_mismatch', 'The confirmation does not match this payment.');
    }
    if (plan.executeAt !== 'now') {
      // The plan stays confirmed; the Scheduler runs it when due through executeNow (and the guard).
      return { planId: plan.planId, status: 'scheduled' };
    }
    return this.executeNow(plan, confirmation, emit);
  }

  /** Executes a confirmed plan now, whatever its executeAt (used by the Scheduler when the job is due). */
  async executeNow(plan: PaymentPlan, confirmation: Confirmation, emit: EmitFn): Promise<ExecutionResult> {
    const at = this.at;
    const invoiceId = plan.invoiceId;
    if (confirmation.planId !== plan.planId) {
      return fail(plan.planId, 'hash_mismatch', 'The confirmation does not match this payment.');
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
  async chat(message: string, history: AgentChatTurn[], emit: EmitFn, stream?: ChatStreamHooks): Promise<AgentReply> {
    const ctx = { emit };
    const tools = this.tools(ctx);
    const specs = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.params) as Record<string, unknown>,
    }));
    const messages: ChatMessage[] = [
      { role: 'system', content: await this.chatSystem() },
      ...history.slice(-10).map((h) => ({ role: h.role, content: h.text.slice(0, 600) }) as ChatMessage),
      { role: 'user', content: message.slice(0, 1000) },
    ];
    const records: AgentToolCallRecord[] = [];
    for (let turn = 1; turn <= 3; turn++) {
      let r: Awaited<ReturnType<LlmProvider['complete']>>;
      const req = { messages, tools: specs, toolChoice: 'auto' as const, temperature: 0.2, maxTokens: 300 };
      try {
        if (turn > 1) stream?.onReset?.();
        r = stream ? await streamTurn(this.deps.llm, req, stream) : await this.deps.llm.complete(req);
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
      // Read tools answer in one short call without tool schemas (much faster than another tool turn).
      return { text: await this.phrase(message, call.name, out, stream), toolCalls: records };
    }
    return { text: 'Done.', toolCalls: records };
  }

  /** One sentence in the user's language from the tool result (numbers already formatted by code). */
  private async phrase(
    question: string,
    tool: string,
    out: { ok: boolean; result?: unknown; error?: string },
    stream?: ChatStreamHooks,
  ): Promise<string> {
    const facts = JSON.stringify(out.ok ? out.result : { error: out.error }).slice(0, 1200);
    try {
      stream?.onReset?.();
      const complete = (req: Parameters<LlmProvider['complete']>[0]) =>
        stream ? streamTurn(this.deps.llm, req, stream) : this.deps.llm.complete(req);
      const r = await complete({
        messages: [
          {
            role: 'system',
            content:
              'Answer the question in one or two short sentences, in the same language as the question, using only the facts given. Copy amounts exactly as written.',
          },
          { role: 'user', content: `Question: ${question.slice(0, 300)}\nTool ${tool} result: ${facts}` },
        ],
        temperature: 0.2,
        maxTokens: 90,
      });
      return r.text.trim() || (out.ok ? 'Done.' : `That did not work: ${out.error ?? 'unknown error'}.`);
    } catch {
      return out.ok ? 'Done.' : `That did not work: ${out.error ?? 'unknown error'}.`;
    }
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
      // Small models get weekday arithmetic wrong ("Friday" → last Friday): give them the next 7 dates.
      `Next days: ${Array.from({ length: 7 }, (_, i) => {
        const d = new Date(now.getTime() + (i + 1) * 86_400_000);
        return `${d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })} ${d.toISOString().slice(0, 10)}`;
      }).join(', ')}. A payment "on <weekday>" means the next one, at 09:00.`,
      'Use IDs exactly as written in CONTEXT. Spend tools only prepare a payment; the user confirms it on screen.',
      'After a tool result, answer in one or two short sentences, in the same language as the user.',
      'The earlier messages of this conversation come before the last one, with "(done: …)" notes of the tools you used. Use them: "make it 50", "the same for Friday", "that one" refer to them.',
      'Each invoice shows the safety check (check, reasons). To say why an invoice was stopped or needs review, use them; you never see the document itself.',
      'Your tools: get_balance; create_receive_invoice ("create/make an invoice", "request a payment", "I want to get paid": a payment request someone else pays into this wallet; it needs no address); schedule_payment and execute_plan for uploaded invoices; label_transfer; list_transfers; fiscal_report. Never say you cannot do what a tool does: call it.',
      'Only the tokens under Assets exist in this wallet. If the user names another one (e.g. USDC), say this wallet holds only those and offer them. Paying a Bitcoin address is not possible here: payments go to invoices the user uploads.',
      'CONTEXT',
      `Assets: ${assets.map((a) => `${a.ticker} assetId=${a.assetId}`).join('; ') || 'none'}`,
      'Invoices (newest first; the first one is the latest):',
      ...(invoices.length
        ? newestFirst(invoices)
            .slice(0, 10)
            .map(
              (i, n) =>
                `- invoiceId=${i.invoiceId}${n === 0 ? ' (latest)' : ''}${i.createdAt ? ` uploaded=${i.createdAt.slice(0, 10)}` : ''} supplier="${safeName(i.supplier)}" total=${i.total ?? '?'} ${i.currency ?? ''} state=${i.state}${checkText(i)}${i.payment ? '' : ' (cannot be paid)'}`,
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
          ...(inv.payment.rgbInvoice ? { rgbInvoice: inv.payment.rgbInvoice } : {}),
          payee: { name: safeName(inv.supplier) },
          executeAt: new Date(t).toISOString(),
        },
        a ? { ticker: a.ticker, precision: a.precision } : undefined,
        this.deps.timeZone,
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
/** Newest first by createdAt; invoices without a date keep the order the server gave (already newest first). */
export function newestFirst(invoices: ChatInvoice[]): ChatInvoice[] {
  if (!invoices.every((i) => i.createdAt)) return invoices;
  return [...invoices].sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''));
}

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
