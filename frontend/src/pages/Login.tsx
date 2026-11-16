import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { errorText } from '../hooks';
const DEMO_PASSWORD = (import.meta.env.VITE_DEMO_PASSWORD as string | undefined) || 'Demo@12345';

const DEMO_COMPANIES = [
  {
    name: 'RFB Latex',
    desc: 'Medical gloves manufacturing',
    users: [
      { email: 'admin@rfblatex.demo', label: 'Admin (Management)' },
      { email: 'finance@rfblatex.demo', label: 'Finance Lead' },
      { email: 'returns@rfblatex.demo', label: 'Returns / Checker' },
      { email: 'sales@rfblatex.demo', label: 'Sales Officer' },
      { email: 'warehouse@rfblatex.demo', label: 'Warehouse Officer' },
    ],
  },
  {
    name: 'Alpine Retail',
    desc: 'Consumer retail & multi-channel marketplace',
    users: [
      { email: 'admin@alpineretail.demo', label: 'Admin (Management)' },
      { email: 'marketplace@alpineretail.demo', label: 'Marketplace Lead' },
      { email: 'finance@alpineretail.demo', label: 'Finance Manager' },
    ],
  },
  {
    name: 'Demo Manufacturing Co.',
    desc: 'Industrial equipment manufacturing',
    users: [
      { email: 'admin@demomfg.demo', label: 'Admin (Management)' },
      { email: 'procurement@demomfg.demo', label: 'Procurement Lead' },
      { email: 'warehouse@demomfg.demo', label: 'Plant / Warehouse' },
    ],
  },
];

export default function Login() {
  const { user, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 32 32">
              <path d="M6 9l5 14 5-9 5 9 5-14" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="brand-text">
            <strong>Whizunik</strong>
            <small>AI LAYER</small>
          </span>
        </div>
        <h1>Sign in</h1>
        <p className="muted" style={{ margin: '4px 0 18px' }}>
          The AI layer explains what is happening and recommends the next action. Approvals and actions stay in WhizUnik.
        </p>
        <form className="stack" onSubmit={submit}>
          <label className="field">
            E-mail
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
          </label>
          <label className="field">
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </label>
          {error && (
            <div className="banner error" role="alert">
              <div>{error}</div>
            </div>
          )}
          <button className="btn primary" disabled={busy} type="submit">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {DEMO_PASSWORD && (
          <div style={{ marginTop: 22 }}>
            <div className="small muted" style={{ marginBottom: 8, fontWeight: 700 }}>
              WhizUnik RAG Demo Companies (PDF Specification)
            </div>
            {DEMO_COMPANIES.map((comp) => (
              <div key={comp.name} style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                <div className="small" style={{ fontWeight: 700, color: 'var(--primary-text)' }}>
                  {comp.name}{' '}
                  <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 11 }}>({comp.desc})</span>
                </div>
                <div className="demo-grid" style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {comp.users.map((u) => (
                    <button
                      key={u.email}
                      type="button"
                      className="pill"
                      disabled={busy}
                      onClick={() => {
                        setEmail(u.email);
                        setPassword(DEMO_PASSWORD);
                        void login(u.email, DEMO_PASSWORD);
                      }}
                    >
                      {u.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
