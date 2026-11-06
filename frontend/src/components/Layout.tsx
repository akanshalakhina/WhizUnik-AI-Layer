import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ROLE_LABEL } from '../format';
import { useAsync } from '../hooks';
import { Badge } from './ui';

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
};

export default function Layout() {
  const { user, logout } = useAuth();
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
            <svg width="18" height="18" viewBox="0 0 32 32">
              <path d="M6 9l5 14 5-9 5 9 5-14" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          WhizUnik
        </div>
        <nav className="nav">
          <NavLink to="/" end>
            <Icon d={ICONS.dash} /> Dashboard
          </NavLink>
          <NavLink to="/ask">
            <Icon d={ICONS.ask} /> Ask WhizUnik AI
          </NavLink>
          <div className="nav-group">Workflows</div>
          {types.data?.types.map((t) => (
            <NavLink key={t.type} to={`/records/${t.type}`}>
              <Icon d={ICONS.list} /> {t.label}
            </NavLink>
          ))}
          <div className="nav-group">AI controls</div>
          <NavLink to="/usage">
            <Icon d={ICONS.usage} /> AI usage {user.role === 'management' ? '& audit' : ''}
          </NavLink>
        </nav>
        <div className="sidebar-foot">
          <strong>{user.name}</strong>
          {ROLE_LABEL[user.role]} · {user.clientName}
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="row">
            <button className="btn ghost menu-btn" onClick={() => setOpen((o) => !o)} aria-label="Toggle navigation" aria-expanded={open}>
              ☰
            </button>
            <Badge tone="primary">AI layer · Phase 1 · read-only</Badge>
          </div>
          <div className="who">
            <span>
              {user.email} · <strong>{ROLE_LABEL[user.role]}</strong>
            </span>
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
