import type { AnalysisReport } from './api/contracts.js';
import { SEVERITY_COLORS, SEVERITY_WORDS, VERDICT_COLORS, VERDICT_EXPLAIN, VERDICT_LABELS } from './lib/format.js';

const SEVERITY_ORDER = { block: 0, warn: 1, info: 2 } as const;

/** The Analyst's report: verdict banner, flags by severity, plain-language summary, questions. */
export function ReportView({ report }: { report: AnalysisReport }) {
  const ex = report.extraction;
  // Most serious flags first.
  const flags = [...report.flags].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
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
      {flags.length === 0 ? (
        <p>All checks passed.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {flags.map((f) => {
            const c = SEVERITY_COLORS[f.severity];
            return (
              <li
                key={f.code}
                data-severity={f.severity}
                style={{ background: c.bg, borderLeft: `4px solid ${c.border}`, padding: '8px 12px', marginBottom: 6 }}
              >
                <strong>{SEVERITY_WORDS[f.severity]}:</strong> {f.message}
                {f.evidence && <div style={{ fontSize: '0.9em' }}>What we saw: “{f.evidence}”</div>}
              </li>
            );
          })}
        </ul>
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
