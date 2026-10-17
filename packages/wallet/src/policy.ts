// Spend policy enforced by the WDK core policy engine on the RGB account (B.7: it governs wdk-wallet-rgb).
// Rules: DENY a transfer above the payment cap, DENY a transfer of an asset outside the allowlist, ALLOW the rest of
// what we call on the account. Once a policy is registered WDK denies every unlisted method, so the ALLOW list is
// explicit. Sends only go through the governed `transfer`; the raw rgb-sdk wallet is used for reads, receive, issue.
import { PolicyDenied } from 'core';

export interface SpendLimits {
  /** Max base units per transfer. */
  paymentCap: string;
  /** Allowed asset IDs; empty = any asset (cap still applies). */
  assetAllowlist: string[];
  /** Max base units sent per asset in any rolling 24 h (optional). */
  dailyCap?: string;
}

/** Base units of an asset already sent (not failed) in the last 24 h; read from the wallet, so it survives restarts. */
export type SpentLast24h = (assetId: string) => number;

/** Account methods the backend calls through WDK (everything else stays denied). */
export const GOVERNED_ALLOWED = ['getRgbWallet', 'transfer'] as const;

interface TransferArgs {
  token?: string;
  amount?: number;
}
type Ctx = { args: readonly unknown[] };
const first = (ctx: Ctx) => (ctx.args[0] ?? {}) as TransferArgs;

export function buildSpendPolicy(limits: SpendLimits, spentLast24h?: SpentLast24h) {
  const cap = Number(limits.paymentCap);
  if (!Number.isSafeInteger(cap) || cap <= 0)
    throw new Error(`PAYMENT_CAP=${limits.paymentCap} must be a positive integer.`);
  const daily = limits.dailyCap === undefined ? undefined : Number(limits.dailyCap);
  if (daily !== undefined && (!Number.isSafeInteger(daily) || daily <= 0))
    throw new Error(`DAILY_CAP=${limits.dailyCap} must be a positive integer.`);
  const allow = new Set(limits.assetAllowlist);
  return {
    id: 'wiseledger-spend',
    name: 'WiseLedger spend limits',
    scope: 'project' as const,
    rules: [
      {
        name: 'over-cap',
        reason: 'The amount is above your payment limit.',
        operation: 'transfer',
        action: 'DENY' as const,
        conditions: [(ctx: Ctx) => (first(ctx).amount ?? 0) > cap],
      },
      ...(daily !== undefined && spentLast24h
        ? [
            {
              name: 'over-daily-cap',
              reason: 'This payment would go over your daily spending limit.',
              operation: 'transfer',
              action: 'DENY' as const,
              conditions: [
                (ctx: Ctx) => spentLast24h(first(ctx).token ?? '') + (first(ctx).amount ?? 0) > daily,
              ],
            },
          ]
        : []),
      ...(allow.size > 0
        ? [
            {
              name: 'asset-not-allowed',
              reason: 'This asset is not on your list of approved assets.',
              operation: 'transfer',
              action: 'DENY' as const,
              conditions: [(ctx: Ctx) => !allow.has(first(ctx).token ?? '')],
            },
          ]
        : []),
      { name: 'allow-wallet-use', operation: [...GOVERNED_ALLOWED], action: 'ALLOW' as const, conditions: [] },
    ],
  };
}

/** WDK PolicyViolationError → PolicyDenied with the rule's plain reason; undefined for other errors. */
export function policyDenied(e: unknown): PolicyDenied | undefined {
  if (!(e instanceof Error) || e.name !== 'PolicyViolationError') return undefined;
  const reason = e.message.split(': ').at(-1)?.trim();
  return new PolicyDenied(reason && !reason.startsWith('Policy violation') ? reason : undefined);
}
