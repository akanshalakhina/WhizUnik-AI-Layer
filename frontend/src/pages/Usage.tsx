import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Badge, ErrorBox, PageHead, Skeleton, Spinner, StatusBadge, UsageBanner } from '../components/ui';
import { fmtDate, fmtDateTime, inr, inrSmall, num, ROLE_LABEL, TOOL_LABEL, titleCase } from '../format';
import { errorText, useAsync } from '../hooks';
import type { AiSettings, AuditRow, ConnectionTest, PermissionMatrix, Role, UsageDashboard } from '../types';

const ALL_ROLES: Role[] = ['management', 'sales', 'procurement', 'warehouse', 'finance', 'checker'];

function Meter({ pct }: { pct: number }) {
  const cls = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
  return (
    <div>
      <div className={`meter ${cls}`} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Monthly AI usage">
        <span style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="meter-scale" aria-hidden="true">
        <span style={{ left: '70%' }}>70%</span>
        <span style={{ left: '90%' }}>90%</span>
        <span style={{ left: '100%' }}>100%</span>
      </div>
    </div>
  );
}

function DailyChart({ data }: { data: UsageDashboard['daily'] }) {
  const max = Math.max(1, ...data.map((d) => d.requests));
  const w = 600;
  const h = 130;
  const bw = w / data.length;
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h + 18}`} role="img" aria-label="AI requests per day for the last 30 days" preserveAspectRatio="none">
      {data.map((d, i) => {
        const bh = (d.requests / max) * h;
        return (
          <g key={d.date}>
            <rect className="bar" x={i * bw + 2} y={h - bh} width={bw - 4} height={Math.max(bh, d.requests ? 2 : 0)} rx={2}>
              <title>{`${fmtDate(d.date)}: ${d.requests} request(s), ${inrSmall(d.costInr)}`}</title>
            </rect>
          </g>
        );
      })}
      <text x={0} y={h + 13}>{fmtDate(data[0].date)}</text>
      <text x={w} y={h + 13} textAnchor="end">{fmtDate(data[data.length - 1].date)}</text>
      <text x={0} y={10}>max {max}/day</text>
    </svg>
  );
}

function Overview({ u }: { u: UsageDashboard }) {
  const s = u.status;
  return (
    <>
      <UsageBanner usage={s} />
      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <h2>Monthly company allowance</h2>
            <Badge tone={s.level === 'ok' ? 'green' : s.level === 'limit_reached' ? 'red' : 'amber'}>{s.monthlyPct.toFixed(1)}%</Badge>
          </div>
          <Meter pct={s.monthlyPct} />
          <div className="grid cols-2" style={{ marginTop: 16 }}>
            <div>
              <div className="small muted">Estimated cost</div>
              <strong>
                {inrSmall(s.costUsedInr)} <span className="muted">of {inr(s.costLimitInr)}</span>
              </strong>
            </div>
            <div>
              <div className="small muted">Requests</div>
              <strong>
                {num(s.requestsUsed)} <span className="muted">of {num(s.requestLimit)}</span>
              </strong>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Your daily limit</h2>
            <Badge tone={s.dailyUsed >= s.dailyLimit ? 'red' : 'grey'}>
              {s.dailyUsed} / {s.dailyLimit}
            </Badge>
          </div>
          <div className="meter" role="progressbar" aria-valuenow={s.dailyUsed} aria-valuemax={s.dailyLimit} aria-label="Daily requests used">
            <span style={{ width: `${Math.min(100, s.dailyLimit ? (s.dailyUsed / s.dailyLimit) * 100 : 0)}%` }} />
          </div>
          <p className="small muted" style={{ marginTop: 12 }}>
            Each person can make {s.dailyLimit} AI requests a day. Cached summaries, refused and empty-result questions do not use model capacity.
          </p>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi">
          <div className="v">{num(u.totals.requests)}</div>
          <div className="l">Requests this month {u.scope === 'self' ? '(yours)' : ''}</div>
        </div>
        <div className="kpi">
          <div className="v">{num(u.totals.inputTokens)}</div>
          <div className="l">Input tokens</div>
        </div>
        <div className="kpi">
          <div className="v">{num(u.totals.outputTokens)}</div>
          <div className="l">Output tokens</div>
        </div>
        <div className="kpi">
          <div className="v">{inrSmall(u.totals.costInr)}</div>
          <div className="l">Estimated cost</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Requests per day (last 30 days)</h2>
        </div>
        <DailyChart data={u.daily} />
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <h2 style={{ marginBottom: 10 }}>By model</h2>
          {u.byModel.length === 0 ? (
            <p className="muted small">No usage yet this month.</p>
          ) : (
            <div className="table-wrap" style={{ boxShadow: 'none' }}>
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="num">Requests</th>
                    <th className="num">Tokens</th>
                    <th className="num">Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {u.byModel.map((m) => (
                    <tr key={m.model}>
                      <td>{m.model}</td>
                      <td className="num">{num(m.requests)}</td>
                      <td className="num">{num(m.inputTokens + m.outputTokens)}</td>
                      <td className="num">{inrSmall(m.costInr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card">
          <h2 style={{ marginBottom: 10 }}>Outcomes</h2>
          <div className="row">
            {u.byStatus.map((s2) => (
              <span key={s2.status} className="row" style={{ gap: 6 }}>
                <StatusBadge status={s2.status} /> <strong>{s2.requests}</strong>
              </span>
            ))}
            {u.byStatus.length === 0 && <span className="muted small">Nothing yet.</span>}
          </div>
        </div>
      </div>

      {u.scope === 'client' && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ marginBottom: 10 }}>By user (this month)</h2>
          <div className="table-wrap" style={{ boxShadow: 'none' }}>
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th className="num">Requests</th>
                  <th className="num">Tokens</th>
                  <th className="num">Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {u.byUser.map((r) => (
                  <tr key={r.userId}>
                    <td>{r.name}</td>
                    <td>{ROLE_LABEL[r.role] ?? r.role}</td>
                    <td className="num">{r.requests}</td>
                    <td className="num">{num(r.tokens)}</td>
                    <td className="num">{inrSmall(r.costInr)}</td>
                  </tr>
                ))}
                {u.byUser.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      No AI usage yet this month.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginBottom: 10 }}>Recent requests</h2>
        <div className="table-wrap" style={{ boxShadow: 'none' }}>
          <table>
            <thead>
              <tr>
                <th>When</th>
                {u.scope === 'client' && <th>User</th>}
                <th>Question</th>
                <th>Model</th>
                <th className="num">Tokens in/out</th>
                <th className="num">Est. cost</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {u.recent.map((r, i) => (
                <tr key={i}>
                  <td>{fmtDateTime(r.createdAt)}</td>
                  {u.scope === 'client' && <td>{r.user}</td>}
                  <td>{r.question}</td>
                  <td>{r.model}</td>
                  <td className="num">
                    {num(r.inputTokens)} / {num(r.outputTokens)}
                  </td>
                  <td className="num">{inrSmall(r.costInr)}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                </tr>
              ))}
              {u.recent.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No requests yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 10 }}>
          {u.note}
        </p>
      </div>
    </>
  );
}

function AuditLog() {
  const audit = useAsync(() => api<{ items: AuditRow[] }>('/api/ai/audit?limit=100'), []);
  if (audit.loading && !audit.data) return <Skeleton h={200} />;
  if (audit.error) return <ErrorBox title="Could not load the audit log" message={audit.error.message} onRetry={audit.reload} />;
  return (
    <div className="card">
      <div className="card-head">
        <h2>AI audit log</h2>
        <button className="btn sm" onClick={audit.reload}>
          Refresh
        </button>
      </div>
      <p className="small muted" style={{ marginBottom: 10 }}>
        Every AI request is logged with who asked, the question <em>category</em>, the data tools used, model, outcome, processing time and usage. Question text, API keys and answers are not stored here.
      </p>
      <div className="table-wrap" style={{ boxShadow: 'none' }}>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>User</th>
              <th>Category</th>
              <th>Data tools used</th>
              <th>Model</th>
              <th>Status</th>
              <th className="num">Time</th>
              <th className="num">Tokens</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {audit.data?.items.map((a) => (
              <tr key={a.id}>
                <td>{fmtDateTime(a.createdAt)}</td>
                <td>
                  {a.user}
                  <div className="small muted">{ROLE_LABEL[a.role] ?? a.role}</div>
                </td>
                <td>{a.category ? titleCase(a.category) : '—'}</td>
                <td className="small">{a.toolsUsed.length ? a.toolsUsed.map((t) => TOOL_LABEL[t] ?? t).join(', ') : '—'}</td>
                <td>{a.model ?? '—'}</td>
                <td>
                  <StatusBadge status={a.status} />
                </td>
                <td className="num">{a.processingMs} ms</td>
                <td className="num">{num(a.inputTokens + a.outputTokens)}</td>
                <td className="small">{a.flags.length ? a.flags.join(', ') : '—'}</td>
              </tr>
            ))}
            {audit.data?.items.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">
                  No AI requests logged yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SettingsPanel() {
  const settings = useAsync(() => api<AiSettings>('/api/ai/settings'), []);
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const [testing, setTesting] = useState(false);

  if (settings.loading && !settings.data) return <Skeleton h={240} />;
  if (settings.error) return <ErrorBox title="Could not load settings" message={settings.error.message} onRetry={settings.reload} />;
  if (!settings.data) return null;
  const s = settings.data;

  const runTest = async () => {
    setTesting(true);
    try {
      setTest(await api<ConnectionTest>('/api/ai/health'));
    } catch (err) {
      setTest({ provider: s.provider, ok: false, configured: true, models: s.models, message: errorText(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="grid cols-2">
      <div className="card stack">
        <h2>AI settings for {s.name}</h2>
        <div className="banner info">
          <div>
            Limits, permitted roles and the on/off switch control cost and access, so they are set by {s.changedBy} and cannot be changed from this screen.
          </div>
        </div>
        {!s.globalAiEnabled && (
          <div className="banner warn">
            <div>AI is switched off globally on the server (AI_ENABLED=false).</div>
          </div>
        )}
        <dl className="fields">
          <dt>AI for this company</dt>
          <dd>{s.aiEnabled ? <Badge tone="green">Enabled</Badge> : <Badge tone="grey">Disabled</Badge>}</dd>
          <dt>Permitted roles</dt>
          <dd>{s.permittedRoles.map((r) => ROLE_LABEL[r] ?? r).join(', ')}</dd>
          <dt>Monthly cost limit</dt>
          <dd>{inr(s.monthlyCostLimitInr)}</dd>
          <dt>Monthly requests</dt>
          <dd>{num(s.monthlyRequestLimit)}</dd>
          <dt>Daily per user</dt>
          <dd>{num(s.dailyUserLimit)} requests</dd>
        </dl>
        <p className="small muted">Warnings appear at 70% and 90% of the monthly limit and of each person's daily limit; at 100% AI answers pause while the rest of WhizUnik keeps working.</p>
      </div>

      <div className="card stack">
        <h2>AI provider</h2>
        <dl className="fields">
          <dt>Provider</dt>
          <dd>{s.provider === 'openai' ? 'OpenAI (hosted)' : 'Offline rules engine (development only — no external provider)'}</dd>
          <dt>Routine model</dt>
          <dd>{s.models.fast}</dd>
          <dt>Analysis model</dt>
          <dd>{s.models.strong}</dd>
          <dt>Plan</dt>
          <dd>{titleCase(s.plan)}</dd>
        </dl>
        <p className="small muted">The API key is configured on the server only and is never shown here or sent to the browser.</p>
        <div>
          <button className="btn" onClick={runTest} disabled={testing}>
            {testing ? <Spinner label="Testing…" /> : 'Test provider connection'}
          </button>
        </div>
        {test && (
          <div className={`banner ${test.ok ? 'ok' : 'error'}`} role="status">
            <div>
              <strong>{test.ok ? 'Connected' : 'Connection problem'}</strong>
              <span className="banner-body">
                {test.message}
                {test.latencyMs !== undefined && test.ok ? ` (${test.latencyMs} ms)` : ''}
                {test.code ? ` [${test.code}]` : ''}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PermissionsPanel() {
  const perms = useAsync(() => api<PermissionMatrix>('/api/ai/permissions'), []);
  if (perms.loading && !perms.data) return <Skeleton h={220} />;
  if (perms.error || !perms.data) return <ErrorBox title="Could not load the permission matrix" message={perms.error?.message ?? ''} onRetry={perms.reload} />;
  const m = perms.data;
  return (
    <div className="card">
      <h2 style={{ marginBottom: 6 }}>Role-based AI data access</h2>
      <p className="small muted" style={{ marginBottom: 12 }}>Enforced by the backend on every request. Hiding something in the browser is never relied on for security.</p>
      <div className="table-wrap" style={{ boxShadow: 'none' }}>
        <table>
          <thead>
            <tr>
              <th>Approved data tool</th>
              {ALL_ROLES.map((r) => (
                <th key={r} style={{ textAlign: 'center' }}>
                  {ROLE_LABEL[r]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(m.tools).map(([tool, roles]) => (
              <tr key={tool}>
                <td>
                  <strong>{TOOL_LABEL[tool] ?? tool}</strong>
                  <div className="small muted">{tool}()</div>
                </td>
                {ALL_ROLES.map((r) => (
                  <td key={r} style={{ textAlign: 'center' }}>
                    {roles.includes(r) ? <span aria-label="allowed">✅</span> : <span className="muted" aria-label="not allowed">—</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 style={{ margin: '16px 0 6px' }}>Role summary</h3>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        {Object.entries(m.roles).map(([r, d]) => (
          <li key={r}>
            <strong>{d.label}</strong>: {d.access}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Usage() {
  const { user } = useAuth();
  const isMgmt = user?.role === 'management';
  const usage = useAsync(() => api<UsageDashboard>('/api/ai/usage'), [user?.id]);
  const [tab, setTab] = useState<'overview' | 'audit' | 'settings' | 'permissions'>('overview');

  return (
    <>
      <PageHead title="AI usage" subtitle={isMgmt ? 'Company-wide usage, limits, audit log and current settings.' : 'Your own AI usage this month.'}>
        {usage.data && <Badge tone="grey">{usage.data.month}</Badge>}
      </PageHead>
      {isMgmt && (
        <div className="tabs" role="tablist">
          {(
            [
              ['overview', 'Usage'],
              ['audit', 'Audit log'],
              ['settings', 'Settings & provider'],
              ['permissions', 'Permissions'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {tab === 'overview' && (
        <>
          {usage.loading && !usage.data && <Skeleton h={260} />}
          {usage.error && <ErrorBox title="Could not load usage" message={usage.error.message} onRetry={usage.reload} />}
          {usage.data && <Overview u={usage.data} />}
        </>
      )}
      {tab === 'audit' && isMgmt && <AuditLog />}
      {tab === 'settings' && isMgmt && <SettingsPanel />}
      {tab === 'permissions' && isMgmt && <PermissionsPanel />}
    </>
  );
}
