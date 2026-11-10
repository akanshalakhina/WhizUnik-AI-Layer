import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { ROLE_LABEL } from '../format';
import { errorText } from '../hooks';
import type { Role } from '../types';

const ROLES: Role[] = ['management', 'sales', 'procurement', 'warehouse', 'finance', 'checker'];
const DEMO_PASSWORD = (import.meta.env.VITE_DEMO_PASSWORD as string | undefined) ?? '';

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

  const quick = async (client: 'aarav' | 'bharat', role: Role) => {
    setBusy(true);
    setError(null);
    try {
      await login(`${role}@${client}.demo`, DEMO_PASSWORD);
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

        {import.meta.env.DEV && DEMO_PASSWORD && (
          <div style={{ marginTop: 22 }}>
            <div className="small muted">Development quick sign-in (seeded demo accounts)</div>
            {(['aarav', 'bharat'] as const).map((c) => (
              <div key={c} style={{ marginTop: 10 }}>
                <div className="small" style={{ fontWeight: 600 }}>
                  {c === 'aarav' ? 'Aarav Consumer Goods (client 1)' : 'Bharat Home Essentials (client 2)'}
                </div>
                <div className="demo-grid">
                  {ROLES.map((r) => (
                    <button key={r} type="button" className="pill" disabled={busy} onClick={() => quick(c, r)}>
                      {ROLE_LABEL[r]}
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
