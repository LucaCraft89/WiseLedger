// PaymentGuard: money moves only for a plan a human confirmed, exactly as confirmed, once.
// check(planId) → plan exists · invoice CONFIRMED/EXECUTING · confirmation is for this planId · plan fields still hash
// to planId · amount ≤ cap · asset allowed · not executed before (atomic claim = idempotency key) · spendable ≥ amount.
// The WDK spend policy checks cap and asset again at signing time (a-002).
import {
  type Confirmation,
  type ExecutionResult,
  type GuardResult,
  type InvoiceState,
  isWalletError,
  type PaymentGuard,
  type PaymentPlan,
  SubmitTimeout,
  verifyPlanId,
  type WalletPort,
} from 'core';
import type { SpendLimits } from './policy.js';

export interface GuardRecord {
  plan: PaymentPlan;
  state: InvoiceState;
  confirmation?: Confirmation;
}

/** What the guard needs from the app's store (SQLite in apps/server, in memory in tests). */
export interface GuardStore {
  find(planId: string): Promise<GuardRecord | null>;
  /** Atomically marks planId as executing; false when it was claimed before (the idempotency key). */
  claim(planId: string): Promise<boolean>;
  /** Frees a claim after a failure where nothing left the wallet, so the user can try again. */
  release(planId: string): Promise<void>;
}

/** Failures that happen before anything is signed: safe to let the same plan run again. Never SubmitTimeout. */
export const RELEASE_ON_FAILURE: ReadonlySet<string> = new Set([
  'InsufficientFunds',
  'InvoiceExpired',
  'NoUtxo',
  'UnknownAsset',
  'InvalidInvoice',
  'PolicyDenied',
]);

/**
 * Error codes after which the user may confirm the same plan again: the wallet failures above, plus every guard
 * refusal except already_executed (the guard refused before anything was sent).
 */
export const RETRY_SAFE: ReadonlySet<string> = new Set([
  ...RELEASE_ON_FAILURE,
  'unknown_plan',
  'not_confirmed',
  'hash_mismatch',
  'over_cap',
  'asset_not_allowed',
  'insufficient_funds',
  'invoice_expired',
  'policy_denied',
]);

const EXECUTABLE: ReadonlySet<InvoiceState> = new Set(['CONFIRMED', 'EXECUTING']);

export class WalletGuard implements PaymentGuard {
  constructor(
    private readonly deps: {
      store: GuardStore;
      wallet: Pick<WalletPort, 'assetBalance'>;
      limits: SpendLimits;
    },
  ) {}

  async check(planId: string): Promise<GuardResult<PaymentPlan>> {
    const no = (reason: Extract<GuardResult<PaymentPlan>, { ok: false }>['reason'], message: string) =>
      ({ ok: false, reason, message }) as const;
    const rec = await this.deps.store.find(planId);
    if (!rec) return no('unknown_plan', 'This payment was never prepared. Nothing was sent.');
    const { plan, state, confirmation } = rec;
    if (!EXECUTABLE.has(state)) return no('not_confirmed', 'This payment is not confirmed. Nothing was sent.');
    if (confirmation?.planId !== planId) return no('not_confirmed', 'You did not confirm this exact payment.');
    if (plan.planId !== planId || !(await verifyPlanId(plan)))
      return no('hash_mismatch', 'The payment changed after you confirmed it. Nothing was sent.');
    const amount = BigInt(plan.amount);
    if (amount > BigInt(this.deps.limits.paymentCap)) return no('over_cap', 'The amount is above your payment limit.');
    const allow = this.deps.limits.assetAllowlist;
    if (allow.length > 0 && !allow.includes(plan.assetId))
      return no('asset_not_allowed', 'This asset is not on your list of approved assets.');
    // Claim before the balance check: a paid plan must answer "already made", even while its change is locked.
    if (!(await this.deps.store.claim(planId)))
      return no('already_executed', 'This payment was already made (or is being made). It will not be sent twice.');
    let spendable: bigint | undefined;
    try {
      spendable = BigInt((await this.deps.wallet.assetBalance(plan.assetId)).spendable);
    } catch {
      spendable = undefined;
    }
    if (spendable === undefined || amount > spendable) {
      await this.deps.store.release(planId);
      return no(
        'insufficient_funds',
        spendable === undefined
          ? 'We could not read your balance for this asset. Nothing was sent.'
          : 'You do not have enough funds for this payment.',
      );
    }
    return { ok: true, plan };
  }

  /** Call with every execution outcome: frees the claim only when nothing can have left the wallet. */
  async recordOutcome(result: ExecutionResult): Promise<void> {
    if (result.status === 'failed' && result.error && RELEASE_ON_FAILURE.has(result.error.code)) {
      await this.deps.store.release(result.planId);
    }
  }
}

/**
 * The execution wrapper: guard → pay → outcome. A send timeout is never retried: the result is 'submitted' with the
 * transfer ID the wallet found after syncing (or none), and the claim stays, so the plan cannot be paid twice.
 */
export async function executeGuarded(
  planId: string,
  deps: { guard: WalletGuard; wallet: Pick<WalletPort, 'pay'> },
): Promise<ExecutionResult> {
  const g = await deps.guard.check(planId);
  if (!g.ok) return { planId, status: 'failed', error: { code: g.reason, message: g.message } };
  const { plan } = g;
  let result: ExecutionResult;
  try {
    const sent = await deps.wallet.pay({ rgbInvoice: plan.rgbInvoice, assetId: plan.assetId, amount: plan.amount });
    result = { planId, status: 'submitted', transferId: sent.transferId, ...(sent.txid ? { txid: sent.txid } : {}) };
  } catch (e) {
    if (e instanceof SubmitTimeout) {
      result = { planId, status: 'submitted', ...(e.transferId ? { transferId: e.transferId } : {}) };
    } else {
      const code = isWalletError(e) ? e.code : 'TransferFailed';
      const message = e instanceof Error ? e.message : String(e);
      result = { planId, status: 'failed', error: { code, message } };
    }
  }
  await deps.guard.recordOutcome(result);
  return result;
}

/** In-memory GuardStore for tests and scripts. */
export class MemoryGuardStore implements GuardStore {
  private readonly records = new Map<string, GuardRecord>();
  private readonly claimed = new Set<string>();

  put(rec: GuardRecord): void {
    this.records.set(rec.plan.planId, rec);
  }

  async find(planId: string): Promise<GuardRecord | null> {
    return this.records.get(planId) ?? null;
  }

  async claim(planId: string): Promise<boolean> {
    if (this.claimed.has(planId)) return false;
    this.claimed.add(planId);
    return true;
  }

  async release(planId: string): Promise<void> {
    this.claimed.delete(planId);
  }
}
