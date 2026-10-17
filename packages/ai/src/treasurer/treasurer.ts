// The Treasurer (tools, never sees invoice text): receives only the confirmed PaymentPlan.
// Skeleton (M1.S2): one forced tool call to execute_plan(planId); the handler resolves the plan, asks the guard, then pays.
import {
  type AgentChatTurn,
  type AgentReply,
  type Confirmation,
  type EmitFn,
  type ExecutionResult,
  type LlmProvider,
  type PaymentGuard,
  type PaymentPlan,
  type ToolDef,
  type TransferStatus,
  type TreasurerAgent,
  verifyPlanId,
  type WalletPort,
} from 'core';
import { z } from 'zod';

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

export type TreasurerWallet = Pick<
  WalletPort,
  'pay' | 'getTransfer' | 'listAssets' | 'assetBalance' | 'createReceiveInvoice'
>;
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
      } as ToolDef<never>,
      {
        name: 'get_balance',
        description: 'Show the wallet balance, for one asset (assetId) or for all assets.',
        params: GetBalanceArgs as never,
        requiresConfirmation: false,
        handler: async (args: z.infer<typeof GetBalanceArgs>) => {
          const assets = await wallet.listAssets();
          return assets
            .filter((a) => !args.assetId || a.assetId === args.assetId)
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

  async chat(message: string, _history: AgentChatTurn[], _emit: EmitFn): Promise<AgentReply> {
    // Free-form chat and wallet tools arrive in M3.S1.
    return {
      text: `I can execute confirmed payments for now. Chat is coming soon. (You said: ${message.slice(0, 200)})`,
      toolCalls: [],
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

function fail(planId: string, code: string, message: string): ExecutionResult {
  return { planId, status: 'failed', error: { code, message } };
}
