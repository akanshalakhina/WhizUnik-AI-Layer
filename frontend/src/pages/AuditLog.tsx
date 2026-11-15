import { getRagAuditEvents } from '../api';
import { Badge, Card, Empty, ErrorBox, Spinner } from '../components/ui';
import { useAsync } from '../hooks';

export default function AuditLog() {
  const audit = useAsync(() => getRagAuditEvents(), []);

  return (
    <div className="page">
      <header className="page-header" style={{ marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Compliance & Activity Log</h1>
          <p className="sub" style={{ margin: '4px 0 0', color: 'var(--muted)' }}>
            Traceable activity record of company queries, cited policy sources, performance latency, and operator feedback.
          </p>
        </div>
      </header>

      {audit.loading ? (
        <Spinner />
      ) : audit.error ? (
        <ErrorBox title="Error loading audit events" message={(audit.error as any).message || String(audit.error)} onRetry={() => audit.reload()} />
      ) : !audit.data?.events.length ? (
        <Empty message="No AI interactions logged yet for this company." />
      ) : (
        <Card>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left', color: 'var(--muted)' }}>
                  <th style={{ padding: '10px 8px' }}>Timestamp</th>
                  <th style={{ padding: '10px 8px' }}>User</th>
                  <th style={{ padding: '10px 8px' }}>Question</th>
                  <th style={{ padding: '10px 8px' }}>Intent & Dept</th>
                  <th style={{ padding: '10px 8px' }}>Sources</th>
                  <th style={{ padding: '10px 8px' }}>Status</th>
                  <th style={{ padding: '10px 8px' }}>Feedback</th>
                  <th style={{ padding: '10px 8px' }}>Tokens</th>
                  <th style={{ padding: '10px 8px' }}>Cost</th>
                  <th style={{ padding: '10px 8px' }}>Latency</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.events.map((ev) => {
                  let sourceList: string[] = [];
                  try {
                    sourceList = JSON.parse(ev.retrieved_source_ids || '[]');
                  } catch {
                    sourceList = [];
                  }

                  return (
                    <tr key={ev.audit_id} style={{ borderBottom: '1px solid var(--border-soft)' }}>
                      <td style={{ padding: '10px 8px', whiteSpace: 'nowrap', color: 'var(--muted)' }}>
                        {new Date(ev.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        <br />
                        <small>{new Date(ev.created_at).toLocaleDateString()}</small>
                      </td>
                      <td style={{ padding: '10px 8px', whiteSpace: 'nowrap' }}>
                        <strong>{ev.user_name || `User #${ev.user_id}`}</strong>
                        <br />
                        <small style={{ color: 'var(--muted)' }}>{ev.user_email}</small>
                      </td>
                      <td style={{ padding: '10px 8px', maxWidth: 260 }}>
                        <span style={{ fontWeight: 500 }}>{ev.question}</span>
                      </td>
                      <td style={{ padding: '10px 8px', whiteSpace: 'nowrap' }}>
                        <code>{ev.intent || 'general'}</code>
                        <br />
                        <small style={{ color: 'var(--muted)' }}>{ev.department || 'All'}</small>
                      </td>
                      <td style={{ padding: '10px 8px', maxWidth: 160 }}>
                        {sourceList.length > 0 ? (
                          sourceList.map((s, idx) => (
                            <code key={idx} style={{ display: 'block', fontSize: 11 }}>
                              {s}
                            </code>
                          ))
                        ) : (
                          <span style={{ color: 'var(--muted)', fontSize: 12 }}>None</span>
                        )}
                      </td>
                      <td style={{ padding: '10px 8px' }}>
                        <Badge
                          variant={
                            ev.answer_status === 'grounded'
                              ? 'success'
                              : ev.answer_status === 'clarification_needed'
                              ? 'warning'
                              : 'neutral'
                          }
                        >
                          {ev.answer_status}
                        </Badge>
                      </td>
                      <td style={{ padding: '10px 8px' }}>
                        {ev.feedback ? (
                          <Badge variant={ev.feedback === 'helpful' ? 'success' : 'danger'}>
                            {ev.feedback}
                          </Badge>
                        ) : (
                          <span style={{ color: 'var(--muted)' }}>—</span>
                        )}
                      </td>
                      <td style={{ padding: '10px 8px' }}>{ev.tokens_total}</td>
                      <td style={{ padding: '10px 8px' }}>₹{ev.cost_inr.toFixed(2)}</td>
                      <td style={{ padding: '10px 8px', color: 'var(--muted)' }}>{ev.latency_ms}ms</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
