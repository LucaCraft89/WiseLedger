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

export const ExecutePlanArgs = z.object({ planId: z.string().min(1).max(100) });

export interface TreasurerDeps {
  llm: LlmProvider;
  wallet: Pick<WalletPort, 'pay' | 'getTransfer'>;
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

  /** The tools the model can call (more in M3: balance, receive, schedule, labels, report). */
  tools(ctx: { invoiceId?: string; emit: EmitFn }): ToolDef<{ planId: string }>[] {
    return [
      {
        name: 'execute_plan',
        description: 'Execute a payment plan the user has confirmed. Argument: the planId.',
        params: ExecutePlanArgs,
        requiresConfirmation: true,
        handler: (args) => this.executePlan(args.planId, ctx),
      },
    ];
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
    const tool = this.tools({ invoiceId, emit })[0] as ToolDef<{ planId: string }>;
    const facts = [
      `Confirmed payment plan: planId=${plan.planId}`,
      `Pay ${plan.amount} base units of asset ${plan.assetId} to ${plan.payee.name.slice(0, 60)}, now.`,
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
      return (await tool.handler(args.data)) as ExecutionResult;
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
      emit({ type: 'toolCall', ...base, at: at(), status: 'error', message });
      // SubmitTimeout: never retried here; the caller syncs and checks the transfer state.
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
