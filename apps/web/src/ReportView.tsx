import { type AnalysisReport, formatAssetAmount } from './api/contracts.js';
import { FlagList } from './FlagCard.js';
import { VERDICT_ACCENT, VERDICT_COLORS, VERDICT_EXPLAIN, VERDICT_ICON, VERDICT_LABELS } from './lib/format.js';
import { shortId, splitFlags } from './lib/payment.js';
import { localTimeWithZone } from './lib/receive.js';
import { RgbCheckCard } from './RgbCheckCard.js';

type Asset = { assetId: string; ticker: string; precision: number };

/** Plain notice for a document that is only a payment request, with what the wallet read from it. */
export const PAYMENT_REQUEST_NOTICE =
  'This is a payment request, not an invoice. We read the amount, token and expiry directly from it. There is no supplier name or invoice number to check, so only pay if you know who sent it.';

function PaymentRequestFacts({ report, assets }: { report: AnalysisReport; assets: readonly Asset[] }) {
  const pr = report.paymentRequest;
  const assetId = pr?.assetId ?? pr?.payAssetId;
  const a = assets.find((x) => x.assetId === assetId);
  return (
    <section className="wl-card" data-testid="payment-request-notice" style={{ marginTop: 12 }}>
      <p style={{ marginTop: 0 }}>
        <strong>{PAYMENT_REQUEST_NOTICE}</strong>
      </p>
      {pr ? (
        <ul style={{ marginBottom: 0 }}>
          <li>
            Amount:{' '}
            {pr.amount
              ? a
                ? `${formatAssetAmount(pr.amount, a.precision)} ${a.ticker}`
                : `${pr.amount} smallest units`
              : 'not in the request: you type it before paying'}
          </li>
          <li>
            Token: {a?.ticker ?? 'unknown'}
            {!pr.assetId && ' (the request lets you choose; we use your approved token)'}
            {assetId && (
              <>
                {' '}
                · <code title={assetId}>{shortId(assetId)}</code>
              </>
            )}
          </li>
          <li>
            Paid {pr.rail === 'lightning' ? 'over Lightning' : 'on Bitcoin'} · network {pr.network}
          </li>
          <li>{pr.expiresAt ? `Valid until ${localTimeWithZone(pr.expiresAt)}` : 'No expiry'}</li>
        </ul>
      ) : (
        <p style={{ marginBottom: 0 }}>Your wallet could not read it, so it cannot be paid.</p>
      )}
    </section>
  );
}

/** The Analyst's report: verdict banner, flags by severity, plain-language summary, questions. */
export function ReportView({ report, assets = [] }: { report: AnalysisReport; assets?: readonly Asset[] }) {
  const ex = report.extraction;
  const { alerts, notes } = splitFlags(report.flags);
  return (
    <div>
      <h3>What we found</h3>
      <div
        style={{
          background: VERDICT_COLORS[report.verdict],
          border: `2px solid ${VERDICT_ACCENT[report.verdict]}`,
          borderRadius: 8,
          padding: 12,
        }}
      >
        <strong style={{ fontSize: '1.2em' }}>
          <span aria-hidden="true">{VERDICT_ICON[report.verdict]} </span>
          {VERDICT_LABELS[report.verdict]}
        </strong>
        <div>{VERDICT_EXPLAIN[report.verdict]}</div>
      </div>

      {report.kind === 'payment_request' && <PaymentRequestFacts report={report} assets={assets} />}

      {report.rgbCheck && report.rgbCheck.length > 0 && <RgbCheckCard lines={report.rgbCheck} />}

      <h4>In short</h4>
      <p>{report.summary}</p>

      <ul hidden={report.kind === 'payment_request'}>
        {ex.issuer.name && <li>From: {ex.issuer.name}</li>}
        {ex.invoiceNumber && <li>Invoice number: {ex.invoiceNumber}</li>}
        {ex.total && (
          <li>
            Total: {ex.total} {ex.currency ?? ''}
          </li>
        )}
        {ex.dueDate && <li>Due date: {ex.dueDate}</li>}
      </ul>

      <h4>Checks</h4>
      {alerts.length === 0 ? <p>All checks passed.</p> : <FlagList flags={alerts} />}
      {notes.length > 0 && (
        <>
          <h4>Good to know</h4>
          <FlagList flags={notes} />
        </>
      )}

      {report.questionsForUser.length > 0 && (
        <>
          <h4>Questions to ask yourself before paying</h4>
          <ul>
            {report.questionsForUser.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
