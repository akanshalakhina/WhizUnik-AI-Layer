import { Link } from 'react-router-dom';
import { fmtDate, inrSmall, num, titleCase } from '../format';
import type { AskResponse } from '../types';
import { AdvisoryNote, Badge, SeverityDot, SourceLink } from './ui';

const CATEGORY_LABEL: Record<string, string> = {
  sales: 'Sales',
  procurement: 'Procurement',
  inventory: 'Inventory',
  warehouse: 'Warehouse',
  finance: 'Finance',
  marketplace: 'Marketplace',
  management: 'Management',
  unknown: 'Unclassified',
};

/** Renders a structured AI answer: explanation, figures, date range, assumptions, source records and workflow links. */
export default function AnswerView({ r, degradedNotice }: { r: AskResponse; degradedNotice?: string }) {
  const refused = r.status === 'refused';
  const range = r.dateRange.from === r.dateRange.to ? fmtDate(r.dateRange.from) : `${fmtDate(r.dateRange.from)} → ${fmtDate(r.dateRange.to)}`;

  return (
    <div className="card" aria-live="polite">
      {degradedNotice && (
        <div className="banner warn" style={{ marginBottom: 14 }} role="status">
          <div>
            <strong>AI analysis unavailable</strong>
            <span className="banner-body">{degradedNotice}</span>
          </div>
        </div>
      )}
      <div className="meta-row">
        <Badge tone="primary">{CATEGORY_LABEL[r.category] ?? titleCase(r.category)}</Badge>
        {refused && <Badge tone="red">Request declined</Badge>}
        {r.status === 'success_empty' && <Badge tone="amber">No matching records</Badge>}
        {r.status === 'unknown_question' && <Badge tone="amber">Not understood</Badge>}
        {r.degraded && <Badge tone="amber">Data only · no AI analysis</Badge>}
        {r.usage.provider === 'local' && r.usage.model !== 'none' && <Badge tone="grey">Offline rules engine</Badge>}
      </div>

      <p className="answer">{r.answer}</p>

      {r.warnings.length > 0 && (
        <div className="banner warn" style={{ marginTop: 14 }} role="status">
          <div>
            <strong>Please check</strong>
            {r.warnings.map((w, i) => (
              <span className="banner-body" key={i} style={{ display: 'block' }}>
                {w}
              </span>
            ))}
          </div>
        </div>
      )}

      {r.figures.length > 0 && (
        <div className="fig-grid">
          {r.figures.map((f, i) => (
            <div className="fig" key={`${f.label}-${i}`}>
              <div className="v">{typeof f.value === 'number' ? num(f.value) : f.value}</div>
              <div className="l">{f.label}</div>
            </div>
          ))}
        </div>
      )}

      {(r.status === 'success' || r.status === 'success_empty') && (
        <p className="small muted">
          <strong>Date range:</strong> {r.dateRange.description} ({range})
        </p>
      )}

      {r.items.length > 0 && (
        <div className="block">
          <h3>Records behind this answer</h3>
          <ul className="items">
            {r.items.map((it) => (
              <li key={`${it.source.type}-${it.ref}`}>
                <SeverityDot severity={it.severity} />
                <div className="it-body">
                  <Link className="it-title" to={it.source.link}>
                    {it.title}
                  </Link>
                  <span className="it-detail">{it.detail}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {r.recommendedActions.length > 0 && (
        <div className="block">
          <h3>Recommended next actions</h3>
          <ol className="actions-list">
            {r.recommendedActions.map((a, i) => (
              <li key={i}>
                <span className="num">{i + 1}</span>
                <div>
                  <div>{a.text}</div>
                  <div className="row small" style={{ marginTop: 6 }}>
                    {a.workflow && (
                      <Link to={a.workflow.link}>
                        Open {a.workflow.label} →
                      </Link>
                    )}
                    {a.source && <SourceLink source={a.source} short />}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {r.assumptions.length > 0 && (
        <div className="block">
          <h3>Assumptions</h3>
          <ul className="small" style={{ margin: 0, paddingLeft: 18, color: 'var(--text-2)' }}>
            {r.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}

      {r.missingData.length > 0 && (
        <div className="block">
          <h3>Missing or withheld data</h3>
          <ul className="small" style={{ margin: 0, paddingLeft: 18, color: 'var(--amber)' }}>
            {r.missingData.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}

      {r.suggestions && r.suggestions.length > 0 && (
        <div className="block">
          <h3>Try asking</h3>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {r.suggestions.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      )}

      {r.sources.length > 0 && (
        <div className="block">
          <h3>Source records</h3>
          <div className="src-list">
            {r.sources.map((s) => (
              <SourceLink key={`${s.type}-${s.ref}`} source={s} />
            ))}
          </div>
        </div>
      )}

      <p className="small muted" style={{ marginTop: 16 }}>
        {r.usage.model !== 'none' ? (
          <>
            Model <code>{r.usage.model}</code> · {num(r.usage.inputTokens)} tokens in / {num(r.usage.outputTokens)} out · estimated cost {inrSmall(r.usage.estimatedCostInr)} ·{' '}
          </>
        ) : (
          <>No AI model call was needed · </>
        )}
        answered from WhizUnik data
      </p>
      <AdvisoryNote />
    </div>
  );
}
