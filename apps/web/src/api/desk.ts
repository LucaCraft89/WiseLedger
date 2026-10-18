import type { ApiClient } from './client.js';
import type { DeskResponse } from './contracts.js';

/** Demo backend only: a small desk from the fake's own invoices and wallet (the real server builds it itself). */
export async function deskFromApi(api: ApiClient): Promise<DeskResponse> {
  const [invoices, wallet] = await Promise.all([api.listInvoices(), api.wallet()]);
  const waiting = invoices.invoices.filter((i) => i.state === 'AWAITING_CONFIRMATION');
  const who = (i: { issuerName?: string; filename: string }) => i.issuerName ?? i.filename;
  const needsYou = waiting.slice(0, 5).map((i) => ({
    kind: (i.verdict === 'review' ? 'review_verdict' : 'awaiting_confirmation') as
      | 'review_verdict'
      | 'awaiting_confirmation',
    id: i.id,
    title: `The invoice from ${who(i)} waits for your OK.`,
    action: { label: 'Review and pay', href: `#/invoice/${encodeURIComponent(i.id)}` },
  }));
  const lately = invoices.invoices
    .filter((i) => i.state === 'PAID' || i.state === 'BLOCKED')
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 5)
    .map((i) => ({
      kind: (i.state === 'PAID' ? 'paid' : 'blocked') as 'paid' | 'blocked',
      id: i.id,
      title: i.state === 'PAID' ? `Paid ${who(i)}.` : `I stopped an invoice from ${who(i)}.`,
      at: i.updatedAt,
    }));
  return {
    greetingCounts: { needsYou: waiting.length, dueThisWeek: 0, scheduled: 0, waitingToBePaid: 0 },
    balances: wallet.assets.map((a) => ({
      assetId: a.assetId,
      ticker: a.ticker,
      spendable: a.balance.spendable,
      precision: a.precision,
    })),
    feeSats: wallet.btcBalanceSats,
    needsYou,
    lately,
    updated: { text: 'Demo data' },
  };
}
