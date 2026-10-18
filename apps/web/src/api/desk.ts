import { ApiCallError, type ApiClient } from './client.js';
import type { BooksQuery, BooksResponse, DeskResponse, ReceiptResponse } from './contracts.js';

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
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = invoices.invoices.filter((i) => i.updatedAt.startsWith(month));
  const stopped = thisMonth.filter((i) => i.state === 'BLOCKED');
  const first = wallet.assets[0];
  return {
    mood: waiting.length > 0 ? 'attention' : 'quiet',
    month: {
      invoicesRead: thisMonth.length,
      invoicesStopped: stopped.length,
      protectedAmount: first
        ? [
            {
              assetId: first.assetId,
              amount: String(
                stopped.reduce((sum, i) => sum + Math.round(Number(i.total ?? 0) * 10 ** first.precision), 0),
              ),
            },
          ]
        : [],
      paymentsMade: 0,
      received: 0,
    },
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

/** Demo backend only: the ledger of the fake wallet. The balance is anchored on the settled balance, newest row last. */
export async function booksFromApi(api: ApiClient, q: Partial<BooksQuery> = {}): Promise<BooksResponse> {
  const [t, w, i] = await Promise.all([api.transfers(), api.wallet(), api.listInvoices()]);
  const asset = w.assets.find((a) => a.assetId === q.assetId) ?? w.assets[0];
  if (!asset) return { settledBalance: '0', rows: [] };
  const names = new Map(i.invoices.map((inv) => [inv.id, inv.issuerName ?? inv.filename]));
  const mine = t.transfers
    .filter((x) => x.assetId === asset.assetId && !(x.direction === 'in' && x.status === 'WaitingCounterparty'))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let balance = BigInt(asset.balance.settled);
  const after = new Map<string, bigint>();
  for (const x of [...mine].reverse()) {
    if (x.status !== 'Settled') continue;
    after.set(x.transferId, balance);
    balance += x.direction === 'out' ? BigInt(x.amount) : -BigInt(x.amount);
  }
  const rows = mine
    .map((x) => {
      const who = x.invoiceId ? names.get(x.invoiceId) : undefined;
      const settled = x.status === 'Settled';
      const failed = x.status === 'Failed';
      return {
        at: x.createdAt,
        kind: x.direction === 'out' ? ('payment' as const) : ('receipt' as const),
        title: x.direction === 'out' ? (who ? `Paid ${who}` : 'Payment sent') : 'Payment received',
        ...(x.direction === 'out' ? { out: x.amount } : { in: x.amount }),
        balanceAfter: settled ? String(after.get(x.transferId) ?? 0n) : null,
        ...(settled || failed ? {} : { pending: true }),
        transferId: x.transferId,
        ...(x.invoiceId ? { invoiceId: x.invoiceId } : {}),
        stamp: failed
          ? ('FAILED' as const)
          : !settled
            ? ('PENDING' as const)
            : x.direction === 'out'
              ? ('PAID' as const)
              : ('RECEIVED' as const),
        labels: x.labels,
      };
    })
    .reverse();
  const start = q.before ? rows.findIndex((r) => r.transferId === q.before) + 1 : 0;
  const limit = q.limit ?? 20;
  const page = rows.slice(start, start + limit);
  const last = page.at(-1);
  return {
    assetId: asset.assetId,
    ticker: asset.ticker,
    precision: asset.precision,
    settledBalance: asset.balance.settled,
    rows: page,
    ...(start + limit < rows.length && last?.transferId ? { nextBefore: last.transferId } : {}),
  };
}

/** Demo backend only: a settled transfer as a receipt, like GET /api/receipts/:id. */
export async function receiptFromApi(api: ApiClient, transferId: string): Promise<ReceiptResponse> {
  const d = await api.transfer(transferId);
  const t = d.transfer;
  if (t.status !== 'Settled' || t.kind === 'issuance' || !d.asset) {
    throw new ApiCallError('NO_RECEIPT', 'There is no receipt for this payment: only settled payments have one.', 404);
  }
  const out = t.kind === 'outgoing';
  return {
    transferId,
    direction: out ? 'out' : 'in',
    payerName: out ? 'You (this wallet)' : 'The payer (not named)',
    payeeName: out ? (d.invoice?.issuerName ?? 'The receiver of the payment request') : 'You (this wallet)',
    ...(d.invoice?.invoiceNumber ? { invoiceNumber: d.invoice.invoiceNumber } : {}),
    amount: t.amount,
    asset: { assetId: d.asset.assetId, ticker: d.asset.ticker, precision: d.asset.precision },
    rail: t.rail,
    ...(t.txid ? { txid: t.txid } : {}),
    settledAt: t.settledAt ?? d.statusTimes.Settled ?? t.createdAt,
    labels: t.labels,
  };
}
