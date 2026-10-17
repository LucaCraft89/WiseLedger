// Owner: B. Canned TreasurerAgent: execute() pays the confirmed plan through WalletPort, chat() echoes.
import type { EmitFn } from '../analysis.js';
import type { AgentChatTurn, AgentReply, TreasurerAgent } from '../llm.js';
import type { Confirmation, ExecutionResult, PaymentPlan } from '../orchestrator.js';
import type { TransferStatus, WalletPort } from '../wallet.js';

export interface MockTreasurerOptions {
  /** Poll getTransfer until Settled/Failed and return 'settled'. Default true. */
  follow?: boolean;
  /** Poll interval while following. Default 250 ms. */
  pollMs?: number;
  /** Give up following after this long and return 'submitted'. Default 60 s. */
  followTimeoutMs?: number;
  now?: () => Date;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL: TransferStatus[] = ['Settled', 'Failed'];

export class MockTreasurer implements TreasurerAgent {
  constructor(
    private readonly wallet: WalletPort,
    private readonly opts: MockTreasurerOptions = {},
  ) {}

  async execute(plan: PaymentPlan, confirmation: Confirmation, emit: EmitFn): Promise<ExecutionResult> {
    const at = () => (this.opts.now ?? (() => new Date()))().toISOString();
    const invoiceId = plan.invoiceId;
    const args = { planId: plan.planId };

    if (confirmation.planId !== plan.planId) {
      emit({ type: 'toolCall', invoiceId, at: at(), agent: 'treasurer', name: 'execute_plan', args, status: 'rejected', message: 'Confirmation does not match the plan.' });
      return { planId: plan.planId, status: 'failed', error: 'Confirmation does not match the plan.' };
    }
    if (plan.executeAt !== 'now') {
      emit({ type: 'toolCall', invoiceId, at: at(), agent: 'treasurer', name: 'schedule_payment', args: { ...args, executeAt: plan.executeAt }, status: 'ok' });
      return { planId: plan.planId, status: 'scheduled' };
    }

    emit({ type: 'toolCall', invoiceId, at: at(), agent: 'treasurer', name: 'execute_plan', args, status: 'called' });
    let transferId: string;
    let txid: string | undefined;
    try {
      const sent = await this.wallet.pay({ rgbInvoice: plan.rgbInvoice, assetId: plan.assetId, amount: plan.amount });
      transferId = sent.transferId;
      txid = sent.txid;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: 'toolCall', invoiceId, at: at(), agent: 'treasurer', name: 'execute_plan', args, status: 'error', message });
      return { planId: plan.planId, status: 'failed', error: message };
    }
    emit({ type: 'toolCall', invoiceId, at: at(), agent: 'treasurer', name: 'execute_plan', args, status: 'ok' });
    emit({ type: 'transfer', invoiceId, at: at(), transferId, status: 'WaitingCounterparty', txid });

    if (this.opts.follow === false) return { planId: plan.planId, status: 'submitted', transferId, txid };

    const deadline = Date.now() + (this.opts.followTimeoutMs ?? 60_000);
    let last: TransferStatus = 'WaitingCounterparty';
    while (Date.now() < deadline) {
      await sleep(this.opts.pollMs ?? 250);
      const t = await this.wallet.getTransfer(transferId);
      txid = t.txid ?? txid;
      if (t.status !== last) {
        last = t.status;
        emit({ type: 'transfer', invoiceId, at: at(), transferId, status: last, txid });
      }
      if (TERMINAL.includes(last)) break;
    }
    if (last === 'Settled') return { planId: plan.planId, status: 'settled', transferId, txid };
    if (last === 'Failed') return { planId: plan.planId, status: 'failed', transferId, txid, error: 'The transfer failed.' };
    return { planId: plan.planId, status: 'submitted', transferId, txid };
  }

  async chat(message: string, _history: AgentChatTurn[], _emit: EmitFn): Promise<AgentReply> {
    return { text: `You said: ${message}`, toolCalls: [] };
  }
}
