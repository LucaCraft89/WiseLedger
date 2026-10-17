import type { AnalysisReport } from './api/contracts.js';
import { FlagList } from './FlagCard.js';
import { VERDICT_ACCENT, VERDICT_COLORS, VERDICT_EXPLAIN, VERDICT_ICON, VERDICT_LABELS } from './lib/format.js';
import { splitFlags } from './lib/payment.js';

/** The Analyst's report: verdict banner, flags by severity, plain-language summary, questions. */
export function ReportView({ report }: { report: AnalysisReport }) {
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

      <h4>In short</h4>
      <p>{report.summary}</p>

      <ul>
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
