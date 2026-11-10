import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { adventraScreen } from '../adventra';
import { api, ApiError } from '../api';
import { ErrorBox, PageHead, Skeleton, StatusBadge } from '../components/ui';
import { fmtDate, fmtDateTime, inr, num } from '../format';
import { useAsync } from '../hooks';
import type { RecordColumn, RecordDetailResponse, RecordListResponse } from '../types';

type Cell = string | number | null;

function renderCell(col: RecordColumn, value: Cell) {
  if (value === null || value === undefined || value === '') return <span className="muted">—</span>;
  switch (col.kind) {
    case 'money':
      return inr(Number(value));
    case 'number':
      return num(Number(value));
    case 'date':
      return fmtDate(String(value));
    case 'datetime':
      return fmtDateTime(String(value));
    case 'status':
      return <StatusBadge status={String(value)} />;
    default:
      return String(value);
  }
}

const isNumeric = (c: RecordColumn) => c.kind === 'money' || c.kind === 'number';

function Tabs({ active }: { active?: string }) {
  const types = useAsync(() => api<{ types: { type: string; label: string }[] }>('/api/records'), []);
  return (
    <div className="tabs" role="tablist">
      {types.data?.types.map((t) => (
        <Link key={t.type} to={`/records/${t.type}`} className={`tab ${t.type === active ? 'active' : ''}`} role="tab" aria-selected={t.type === active} style={{ textDecoration: 'none' }}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}

export function RecordsIndex() {
  const types = useAsync(() => api<{ types: { type: string }[] }>('/api/records'), []);
  if (types.data?.types[0]) return <Navigate to={`/records/${types.data.types[0].type}`} replace />;
  if (types.error) return <ErrorBox title="Could not load workflows" message={types.error.message} onRetry={types.reload} />;
  return <Skeleton h={24} w="30%" />;
}

/** "Open in Adventra" — only rendered when VITE_ADVENTRA_URL is configured. */
function AdventraLink({ type }: { type: string }) {
  const target = adventraScreen(type);
  if (!target) return null;
  return (
    <a className="btn sm" href={target.href} target="_blank" rel="noreferrer" title={`Open ${target.label} in Adventra`}>
      Open in Adventra ↗
    </a>
  );
}

export function RecordsList() {
  const { type = '' } = useParams();
  const nav = useNavigate();
  const [filter, setFilter] = useState('');
  const list = useAsync(() => api<RecordListResponse>(`/api/records/${type}`), [type]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!list.data) return [];
    return q ? list.data.rows.filter((r) => Object.values(r).some((v) => v !== null && String(v).toLowerCase().includes(q))) : list.data.rows;
  }, [list.data, filter]);

  const forbidden = list.error instanceof ApiError && list.error.status === 403;

  return (
    <>
      <PageHead title={list.data?.label ?? 'Workflow'} subtitle="Read-only view of WhizUnik records. Actions and approvals are done in the existing workflow, not by AI.">
        <input type="text" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter records" style={{ width: 220 }} />
        <AdventraLink type={type} />
      </PageHead>
      <Tabs active={type} />
      {list.loading && !list.data && <Skeleton h={220} />}
      {forbidden && (
        <div className="banner warn" role="alert">
          <div>
            <strong>Not available for your role</strong>
            <span className="banner-body">{list.error?.message}</span>
          </div>
        </div>
      )}
      {list.error && !forbidden && <ErrorBox title="Could not load records" message={list.error.message} onRetry={list.reload} />}
      {list.data && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{list.data.singular}</th>
                {list.data.columns.map((c) => (
                  <th key={c.key} className={isNumeric(c) ? 'num' : ''}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.ref)} className="clickable" onClick={() => nav(`/records/${type}/${encodeURIComponent(String(r.ref))}`)}>
                  <td>
                    <Link to={`/records/${type}/${encodeURIComponent(String(r.ref))}`} onClick={(e) => e.stopPropagation()}>
                      <strong>{String(r.ref)}</strong>
                    </Link>
                  </td>
                  {list.data!.columns.map((c) => (
                    <td key={c.key} className={isNumeric(c) ? 'num' : ''}>
                      {renderCell(c, r[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={list.data.columns.length + 1} className="empty">
                    {filter ? 'No records match your filter.' : 'No records yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function RecordDetail() {
  const { type = '', ref = '' } = useParams();
  const rec = useAsync(() => api<RecordDetailResponse>(`/api/records/${type}/${encodeURIComponent(ref)}`), [type, ref]);

  return (
    <>
      <PageHead title={rec.data ? `${rec.data.singular} ${rec.data.ref}` : ref} subtitle={<Link to={`/records/${type}`}>← Back to {rec.data?.label ?? 'list'}</Link>}>
        <AdventraLink type={type} />
      </PageHead>
      {rec.loading && !rec.data && <Skeleton h={200} />}
      {rec.error && (
        <div className={`banner ${rec.error instanceof ApiError && rec.error.status === 404 ? 'info' : 'error'}`} role="alert">
          <div>
            <strong>{rec.error instanceof ApiError && rec.error.status === 404 ? 'Record not found' : 'Could not open this record'}</strong>
            <span className="banner-body">{rec.error.message}</span>
          </div>
        </div>
      )}
      {rec.data && (
        <>
          <div className="card">
            <dl className="fields">
              <dt>Reference</dt>
              <dd>{rec.data.ref}</dd>
              {rec.data.columns.map((c) => (
                <div key={c.key} style={{ display: 'contents' }}>
                  <dt>{c.label}</dt>
                  <dd>{renderCell(c, rec.data!.record[c.key])}</dd>
                </div>
              ))}
            </dl>
          </div>

          {rec.data.tables.map((t) => (
            <div key={t.title} className="card">
              <h2 style={{ marginBottom: 10 }}>{t.title}</h2>
              <div className="table-wrap" style={{ boxShadow: 'none' }}>
                <table>
                  <thead>
                    <tr>
                      {t.columns.map((c) => (
                        <th key={c.key} className={isNumeric(c) ? 'num' : ''}>
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {t.rows.map((row, i) => (
                      <tr key={i}>
                        {t.columns.map((c) => (
                          <td key={c.key} className={isNumeric(c) ? 'num' : ''}>
                            {renderCell(c, row[c.key] ?? null)}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {t.rows.length === 0 && (
                      <tr>
                        <td colSpan={t.columns.length} className="muted">
                          Nothing recorded.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {rec.data.related.length > 0 && (
            <div className="card">
              <h2 style={{ marginBottom: 10 }}>Related records</h2>
              <div className="src-list">
                {rec.data.related.map((r) => (
                  <Link key={`${r.type}-${r.ref}`} className="src" to={r.link}>
                    {r.label} <span aria-hidden="true">↗</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
          <p className="small muted" style={{ marginTop: 14 }}>
            🛈 {rec.data.readOnlyNotice}
          </p>
        </>
      )}
    </>
  );
}
