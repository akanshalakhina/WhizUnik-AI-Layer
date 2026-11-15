import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { api } from '../api';
import { ADVENTRA_URL } from '../adventra';
import { useAuth } from '../auth';
import { ROLE_LABEL } from '../format';
import { useAsync } from '../hooks';
import { useTheme } from '../theme';

interface RecordTypeInfo {
  type: string;
  label: string;
  singular: string;
}

const Icon = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const ICONS = {
  dash: 'M3 12l9-9 9 9M5 10v10h14V10',
  ask: 'M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  usage: 'M18 20V10M12 20V4M6 20v-6',
  docs: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6',
  audit: 'M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.5L17 7.5V19a2 2 0 0 1-2 2z',
};

export default function Layout() {
  const { user, logout } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const types = useAsync(() => api<{ types: RecordTypeInfo[] }>('/api/records'), [user?.id]);

  useEffect(() => setOpen(false), [loc.pathname]);
  if (!user) return null;

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Main navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 32 32">
              <path d="M6 9l5 14 5-9 5 9 5-14" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="brand-text">
            <strong>WhizUnik</strong>
            <small>Operations Hub</small>
          </span>
        </div>

        <nav className="nav">
          <NavLink to="/" end>
            <Icon d={ICONS.dash} /> Dashboard
          </NavLink>
          <NavLink to="/ask">
            <Icon d={ICONS.ask} /> Operations Assistant
          </NavLink>
          <NavLink to="/knowledge">
            <Icon d={ICONS.docs} /> Knowledge Base
          </NavLink>
          <NavLink to="/audit">
            <Icon d={ICONS.audit} /> Compliance & Audit
          </NavLink>

          <div className="nav-group">Workflows</div>
          {types.data?.types.map((t) => (
            <NavLink key={t.type} to={`/records/${t.type}`}>
              <Icon d={ICONS.list} /> {t.label}
            </NavLink>
          ))}

          <div className="nav-group">Controls</div>
          <NavLink to="/usage">
            <Icon d={ICONS.usage} /> Usage & Limits
          </NavLink>
        </nav>

        <div className="sidebar-foot">
          <strong>{user.name}</strong>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {ROLE_LABEL[user.role]} · {user.clientName}
          </span>
          {ADVENTRA_URL && (
            <a className="adv-link" href={ADVENTRA_URL} target="_blank" rel="noreferrer">
              Open the Adventra platform ↗
            </a>
          )}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="row">
            <button className="btn ghost menu-btn" onClick={() => setOpen((o) => !o)} aria-label="Toggle navigation" aria-expanded={open}>
              ☰
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="badge primary" style={{ fontWeight: 700 }}>
                🏢 {user.clientName}
              </span>
              <span className="badge grey">{ROLE_LABEL[user.role]}</span>
            </div>
          </div>

          <div className="who">
            <button type="button" className="theme-toggle-btn" onClick={toggleTheme} title="Switch theme">
              {theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
            </button>
            <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{user.email}</span>
            <button className="btn sm" onClick={logout}>
              Sign out
            </button>
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
