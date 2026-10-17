import type { AnalysisReport } from './api/contracts.js';
import { FlagList } from './FlagCard.js';
import { VERDICT_COLORS, VERDICT_EXPLAIN, VERDICT_LABELS } from './lib/format.js';

/** The Analyst's report: verdict banner, flags by severity, plain-language summary, questions. */
export function ReportView({ report }: { report: AnalysisReport }) {
  const ex = report.extraction;
  return (
    <div>
      <h3>What we found</h3>
      <div style={{ background: VERDICT_COLORS[report.verdict], padding: 12 }}>
        <strong style={{ fontSize: '1.2em' }}>{VERDICT_LABELS[report.verdict]}</strong>
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
      {report.flags.length === 0 ? <p>All checks passed.</p> : <FlagList flags={report.flags} />}

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
