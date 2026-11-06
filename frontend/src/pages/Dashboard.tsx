import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { AdvisoryNote, Badge, ErrorBox, PageHead, SeverityDot, Skeleton, SourceLink, Spinner, UsageBanner } from '../components/ui';
import { fmtDateTime, inrSmall, num, ROLE_LABEL } from '../format';
import { errorText, useAsync } from '../hooks';
import type { SummaryResponse, SummarySection } from '../types';

const WORKFLOW_LINK: Record<string, { label: string; link: string }> = {
  salesRisks: { label: 'Sales Orders queue', link: '/records/sales-orders' },
  stockRisks: { label: 'Inventory', link: '/records/products' },
  procurementDelays: { label: 'Procurement queue', link: '/records/purchase-orders' },
  overduePayments: { label: 'Invoices & collections', link: '/records/invoices' },
  warehouseDelays: { label: 'Warehouse queue', link: '/records/warehouse-tasks' },
  marketplaceExceptions: { label: 'Marketplace orders', link: '/records/marketplace-orders' },
  approvals: { label: 'Checker approvals', link: '/records/approvals' },
};

function SectionCard({ s }: { s: SummarySection }) {
  const wf = WORKFLOW_LINK[s.key];
  if (s.restricted) {
    return (
      <section className="card section-card restricted" aria-label={`${s.title} (not available)`}>
        <h2>🔒 {s.title}</h2>
        <p className="small muted" style={{ marginTop: 6 }}>
          Not available for your role. This data is enforced on the server; it is not sent to your browser.
        </p>
      </section>
    );
  }
  return (
    <section className="card section-card" aria-label={s.title}>
      <div className="card-head">
        <h2>{s.title}</h2>
        <div className="row">
          {s.high > 0 && <Badge tone="red">{s.high} high</Badge>}
          <Badge tone={s.total ? 'amber' : 'green'}>{s.total}</Badge>
        </div>
      </div>
      {s.items.length === 0 ? (
        <p className="muted small">Nothing needs attention here right now.</p>
      ) : (
        <ul className="items">
          {s.items.map((it) => (
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
      )}
      {wf && (
        <p className="small" style={{ marginTop: 10 }}>
          <Link to={wf.link}>Open {wf.label} →</Link>
          {s.total > s.items.length && <span className="muted"> · showing {s.items.length} of {s.total}</span>}
        </p>
      )}
    </section>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const summary = useAsync(() => api<SummaryResponse>('/api/ai/summary'), [user?.id]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      summary.setData(await api<SummaryResponse>('/api/ai/summary?refresh=true'));
    } catch (e) {
      setRefreshError(errorText(e));
    } finally {
      setRefreshing(false);
    }
  };

  const s = summary.data;
  const err = summary.error;
  const disabled = err instanceof ApiError && (err.code === 'AI_DISABLED' || err.code === 'ROLE_NOT_PERMITTED');

  return (
    <>
      <PageHead
        title="AI Management Summary"
        subtitle={
          <>
            {user && (
              <>
                {ROLE_LABEL[user.role]} view · {user.clientName}
              </>
            )}
            {s && <> · generated {fmtDateTime(s.generatedAt)}{s.cached ? ' (cached for today)' : ''}</>}
          </>
        }
      >
        <button className="btn primary" onClick={refresh} disabled={refreshing || summary.loading || disabled} aria-busy={refreshing}>
          {refreshing ? <Spinner label="Refreshing…" /> : '↻ Refresh'}
        </button>
      </PageHead>

      {refreshError && <ErrorBox title="Could not refresh the summary" message={refreshError} onRetry={refresh} />}

      {summary.loading && !s && (
        <div className="stack" aria-busy="true" aria-label="Loading AI Management Summary">
          <div className="card">
            <Skeleton h={20} w="40%" />
            <div style={{ height: 12 }} />
            <Skeleton h={14} />
            <div style={{ height: 8 }} />
            <Skeleton h={14} w="85%" />
          </div>
          <div className="grid cards">
            {[0, 1, 2, 3].map((i) => (
              <div className="card" key={i}>
                <Skeleton h={18} w="50%" />
                <div style={{ height: 14 }} />
                <Skeleton h={12} />
                <div style={{ height: 8 }} />
                <Skeleton h={12} w="70%" />
              </div>
            ))}
          </div>
        </div>
      )}

      {err && !s && disabled && (
        <div className="card empty">
          <div className="big">🤖</div>
          <h2>{err.message}</h2>
          <p style={{ marginTop: 6 }}>The rest of WhizUnik works as normal. Ask an administrator to enable the AI assistant for your company or role.</p>
        </div>
      )}
      {err && !s && !disabled && <ErrorBox title="The AI Management Summary could not be loaded" message={err.message} onRetry={summary.reload} />}

      {s && (
        <>
          <UsageBanner usage={s.usageStatus} />
          {s.degraded && (
            <div className="banner warn" role="status" style={{ marginBottom: 14 }}>
              <div>
                <strong>AI analysis unavailable — showing data only</strong>
                <span className="banner-body">{s.aiNotice}</span>
              </div>
            </div>
          )}
          {s.warnings.length > 0 && (
            <div className="banner warn" role="status" style={{ marginBottom: 14 }}>
              <div>
                <strong>Please check</strong>
                {s.warnings.map((w) => (
                  <span key={w} className="banner-body" style={{ display: 'block' }}>
                    {w}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="card overview-card">
            <div className="card-head">
              <h2>Overview</h2>
              <div className="row">
                {s.usage.provider === 'local' ? <Badge tone="grey">Offline rules engine</Badge> : <Badge tone="primary">{s.usage.model}</Badge>}
                {s.cached && <Badge tone="blue">Cached</Badge>}
              </div>
            </div>
            <p className="overview">{s.overview}</p>
          </div>

          {s.figures.length > 0 && (
            <div className="kpis">
              {s.figures.map((f) => (
                <div className="kpi" key={f.label}>
                  <div className="v">{typeof f.value === 'number' ? num(f.value) : f.value}</div>
                  <div className="l">{f.label}</div>
                </div>
              ))}
            </div>
          )}

          <div className="grid cards">
            {s.sections.map((sec) => (
              <SectionCard key={sec.key} s={sec} />
            ))}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-head">
              <h2>Recommended next actions</h2>
              <span className="small muted">Every action links to the original WhizUnik record</span>
            </div>
            {s.recommendedActions.length === 0 ? (
              <p className="muted">No actions are recommended right now.</p>
            ) : (
              <ol className="actions-list">
                {s.recommendedActions.map((a, i) => (
                  <li key={i}>
                    <span className="num">{i + 1}</span>
                    <div>
                      <div>{a.text}</div>
                      <div className="row small" style={{ marginTop: 6 }}>
                        {a.source && <SourceLink source={a.source} />}
                        {a.workflow && <Link to={a.workflow.link}>Open {a.workflow.label} →</Link>}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <details className="how card" style={{ marginTop: 16 }}>
            <summary>How this was calculated · assumptions · withheld data</summary>
            <ul>
              {s.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
            {s.missingData.length > 0 && (
              <>
                <h3 style={{ marginTop: 12 }}>Missing or truncated data</h3>
                <ul>
                  {s.missingData.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </>
            )}
            <p className="small muted" style={{ marginTop: 10 }}>
              Section lists come straight from WhizUnik data. {s.usage.model !== 'none' ? `The overview was written by ${s.usage.model} (${num(s.usage.inputTokens)} tokens in / ${num(s.usage.outputTokens)} out, est. ${inrSmall(s.usage.estimatedCostInr)}).` : 'No AI model was called for this view.'}
            </p>
          </details>
          <AdvisoryNote />
        </>
      )}
    </>
  );
}
