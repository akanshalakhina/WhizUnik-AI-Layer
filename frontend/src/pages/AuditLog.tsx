import { useMemo, useState } from 'react';
import { getRagAuditEvents } from '../api';
import { useAuth } from '../auth';
import { Badge, Empty, ErrorBox, PageHead, Spinner } from '../components/ui';
import { useAsync } from '../hooks';
import { confidencePct, isKnowledgeAdmin, STATUS_LABEL } from '../rag';
import { NotPermitted } from './KnowledgeBase';

const STATUS_TONE: Record<string, 'success' | 'warning' | 'neutral'> = {
  grounded: 'success',
  clarification_needed: 'warning',
  insufficient_evidence: 'neutral',
};

function parseSources(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || '[]');
    // The server records one ID per retrieved chunk, so the same document can appear several times.
    return Array.isArray(v) ? [...new Set(v.map(String))] : [];
  } catch {
    return [];
  }
}

export default function AuditLog() {
  const { user } = useAuth();
  const admin = isKnowledgeAdmin(user?.role);
  const audit = useAsync(() => (admin ? getRagAuditEvents() : Promise.resolve({ events: [] })), [admin]);
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');

  const events = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (audit.data?.events ?? []).filter(
      (ev) =>
        (status === 'all' || ev.answer_status === status) &&
        (!q || [ev.question, ev.user_name, ev.user_email, ev.department, ev.intent].some((f) => (f ?? '').toLowerCase().includes(q))),
    );
  }, [audit.data, status, search]);

  if (!admin) return <NotPermitted what="AI Audit Log" />;

  const total = audit.data?.events.length ?? 0;
  const totalCost = events.reduce((s, e) => s + (Number(e.cost_inr) || 0), 0);

  return (
    <div className="page">
      <PageHead
        title="AI Audit Log"
        subtitle="Every assistant question for this company: who asked, which approved sources were retrieved, the outcome, model, tokens, cost and latency. Latest 100 events."
      />

      <div className="filters">
        <label>
          Outcome
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All</option>
            <option value="grounded">{STATUS_LABEL.grounded}</option>
            <option value="insufficient_evidence">{STATUS_LABEL.insufficient_evidence}</option>
            <option value="clarification_needed">{STATUS_LABEL.clarification_needed}</option>
          </select>
        </label>
        <label className="grow">
          Search
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Question, user or department" />
        </label>
        {total > 0 && (
          <span className="muted-sm filters-summary">
            {events.length} of {total} events · ₹{totalCost.toFixed(2)} estimated cost
          </span>
        )}
      </div>

      {audit.loading ? (
        <Spinner label="Loading audit events…" />
      ) : audit.error ? (
        <ErrorBox title="Could not load audit events" message={(audit.error as any).message || String(audit.error)} onRetry={() => audit.reload()} />
      ) : !events.length ? (
        <Empty message={total ? 'No events match these filters.' : 'No assistant questions have been logged for this company yet.'} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>User</th>
                <th>Question</th>
                <th>Intent · Dept</th>
                <th>Sources</th>
                <th>Outcome</th>
                <th>Feedback</th>
                <th>Model</th>
                <th className="num">Tokens</th>
                <th className="num">Cost</th>
                <th className="num">Latency</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => {
                const sources = parseSources(ev.retrieved_source_ids);
                const d = new Date(ev.created_at);
                return (
                  <tr key={ev.audit_id}>
                    <td className="nowrap">
                      {d.toLocaleDateString([], { day: 'numeric', month: 'short' })}
                      <small className="cell-sub">{d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
                    </td>
                    <td className="nowrap">
                      {ev.user_name || `User #${ev.user_id}`}
                      <small className="cell-sub">{ev.user_email}</small>
                    </td>
                    <td className="cell-question">{ev.question}</td>
                    <td className="nowrap">
                      <code>{ev.intent || 'general'}</code>
                      <small className="cell-sub">{ev.department || 'All'}</small>
                    </td>
                    <td>
                      {sources.length ? (
                        <details className="sources-cell">
                          <summary>{sources.length} source{sources.length === 1 ? '' : 's'}</summary>
                          {sources.map((s) => (
                            <code key={s}>{s}</code>
                          ))}
                        </details>
                      ) : (
                        <span className="muted-sm">None</span>
                      )}
                    </td>
                    <td>
                      <Badge variant={STATUS_TONE[ev.answer_status] ?? 'neutral'}>{STATUS_LABEL[ev.answer_status] ?? ev.answer_status}</Badge>
                      {ev.answer_status === 'grounded' && <small className="cell-sub">{confidencePct(ev.confidence)}% match</small>}
                    </td>
                    <td>
                      {ev.feedback ? (
                        <Badge variant={ev.feedback === 'helpful' ? 'success' : 'danger'}>{ev.feedback === 'helpful' ? 'Helpful' : 'Not helpful'}</Badge>
                      ) : (
                        <span className="muted-sm">—</span>
                      )}
                    </td>
                    <td>
                      <code className="model">{ev.model}</code>
                    </td>
                    <td className="num">{ev.tokens_total}</td>
                    <td className="num">₹{(Number(ev.cost_inr) || 0).toFixed(2)}</td>
                    <td className="num nowrap">{ev.latency_ms} ms</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
