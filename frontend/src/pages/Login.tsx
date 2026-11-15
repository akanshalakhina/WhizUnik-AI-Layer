import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { errorText } from '../hooks';
import { useTheme } from '../theme';

const DEMO_PASSWORD = (import.meta.env.VITE_DEMO_PASSWORD as string | undefined) || 'Demo@12345';

interface DemoCompany {
  id: string;
  name: string;
  industry: string;
  icon: string;
  tag: string;
  personas: {
    name: string;
    role: string;
    email: string;
    badge: string;
  }[];
}

const DEMO_COMPANIES: DemoCompany[] = [
  {
    id: 'rfb',
    name: 'RFB Latex',
    industry: 'Medical Gloves Manufacturing',
    icon: '🏥',
    tag: 'Healthcare Mfg',
    personas: [
      { name: 'Rachel Verma', role: 'Operations & Plant Admin', email: 'admin@rfblatex.demo', badge: 'Admin' },
      { name: 'Sanjay Gupta', role: 'Finance & Accounts Lead', email: 'finance@rfblatex.demo', badge: 'Finance' },
      { name: 'Pooja Sharma', role: 'Returns & Quality Lead', email: 'returns@rfblatex.demo', badge: 'QA & Returns' },
      { name: 'Arun Patel', role: 'Sales & Dispatch Lead', email: 'sales@rfblatex.demo', badge: 'Sales' },
      { name: 'Kiran Yadav', role: 'Warehouse & Inventory Officer', email: 'warehouse@rfblatex.demo', badge: 'Warehouse' },
    ],
  },
  {
    id: 'alpine',
    name: 'Alpine Retail',
    industry: 'Multi-Channel E-Commerce & Retail',
    icon: '🛒',
    tag: 'E-Commerce',
    personas: [
      { name: 'Alex Roy', role: 'Operations Admin', email: 'admin@alpineretail.demo', badge: 'Admin' },
      { name: 'Neha Chawla', role: 'Marketplace Operations Lead', email: 'marketplace@alpineretail.demo', badge: 'Marketplace' },
      { name: 'Rohan Mehra', role: 'Finance & Settlements Manager', email: 'finance@alpineretail.demo', badge: 'Finance' },
    ],
  },
  {
    id: 'mfg',
    name: 'Demo Manufacturing Co.',
    industry: 'Industrial Equipment & Machinery',
    icon: '⚙️',
    tag: 'Industrial Mfg',
    personas: [
      { name: 'Vikram Singh', role: 'Plant General Manager', email: 'admin@demomfg.demo', badge: 'Admin' },
      { name: 'Deepak Joshi', role: 'Procurement & Supply Officer', email: 'procurement@demomfg.demo', badge: 'Procurement' },
      { name: 'Mohit Rao', role: 'Plant Warehouse Lead', email: 'warehouse@demomfg.demo', badge: 'Plant Store' },
    ],
  },
];

export default function Login() {
  const { user, login } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();

  const [activeTab, setActiveTab] = useState<'demo' | 'credentials'>('demo');
  const [selectedCompId, setSelectedCompId] = useState<string>('rfb');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const submitCredentials = async (e: FormEvent) => {
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

  const handlePersonaLogin = async (userEmail: string) => {
    setBusy(true);
    setError(null);
    try {
      await login(userEmail, DEMO_PASSWORD);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const currentCompany = DEMO_COMPANIES.find((c) => c.id === selectedCompId) || DEMO_COMPANIES[0];

  return (
    <div className="login-page">
      {/* Top Header */}
      <header className="login-topbar">
        <div className="brand" style={{ padding: 0 }}>
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

        <button type="button" className="theme-toggle-btn" onClick={toggleTheme} title="Switch theme">
          {theme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode'}
        </button>
      </header>

      {/* Main Login Workspace */}
      <div className="login-container">
        {/* Left Hero Column */}
        <div className="login-hero">
          <div>
            <span className="badge primary" style={{ marginBottom: 12 }}>
              Enterprise Operations & Intelligence
            </span>
            <h1>
              Unified ERP Workflows & <span>Company Knowledge</span>
            </h1>
            <p className="hero-subtitle">
              Access real-time inventory, purchase orders, sales queues, and company standard operating procedures—all in one secure, isolated platform.
            </p>
          </div>

          <div className="hero-features">
            <div className="hero-feature-item">
              <div className="hero-feature-icon">📋</div>
              <div className="hero-feature-text">
                <strong>Grounded Standard Operating Procedures</strong>
                <span>Get verified process steps directly from your company’s approved manuals and SOPs.</span>
              </div>
            </div>

            <div className="hero-feature-item">
              <div className="hero-feature-icon">🔒</div>
              <div className="hero-feature-text">
                <strong>Strict Multi-Tenant Security</strong>
                <span>Filter-before-retrieval access control guarantees zero cross-tenant data leakage.</span>
              </div>
            </div>

            <div className="hero-feature-item">
              <div className="hero-feature-icon">⚡</div>
              <div className="hero-feature-text">
                <strong>Live ERP Integration</strong>
                <span>Instant visibility into supplier balances, order status, and warehouse movement.</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Authentication Card */}
        <div className="login-card-wrapper">
          <div className="login-card-header">
            <h2>Welcome Back</h2>
            <p>Select a verified demo workspace or enter your organization credentials.</p>
          </div>

          {/* Mode Tabs */}
          <div className="login-tabs">
            <button
              type="button"
              className={`login-tab-btn ${activeTab === 'demo' ? 'active' : ''}`}
              onClick={() => setActiveTab('demo')}
            >
              <span>⚡</span> Quick Demo Workspaces
            </button>
            <button
              type="button"
              className={`login-tab-btn ${activeTab === 'credentials' ? 'active' : ''}`}
              onClick={() => setActiveTab('credentials')}
            >
              <span>🔑</span> Email & Password
            </button>
          </div>

          {error && (
            <div className="banner error" role="alert" style={{ marginBottom: 16 }}>
              <div>{error}</div>
            </div>
          )}

          {/* Tab 1: Quick Demo Workspaces */}
          {activeTab === 'demo' && (
            <div>
              <label className="field" style={{ marginBottom: 10 }}>
                Select Demo Company
              </label>

              {/* Company Selector Pills */}
              <div className="demo-company-selector">
                {DEMO_COMPANIES.map((comp) => {
                  const isSelected = comp.id === selectedCompId;
                  return (
                    <button
                      key={comp.id}
                      type="button"
                      className={`company-pill-btn ${isSelected ? 'selected' : ''}`}
                      onClick={() => setSelectedCompId(comp.id)}
                    >
                      <span className="comp-icon">{comp.icon}</span>
                      <span className="comp-name">{comp.name}</span>
                      <span className="comp-tag">{comp.tag}</span>
                    </button>
                  );
                })}
              </div>

              {/* Persona List for Selected Company */}
              <div style={{ marginTop: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span className="small muted" style={{ fontWeight: 600 }}>
                    Select a team member to sign in:
                  </span>
                  <span className="badge grey">{currentCompany.industry}</span>
                </div>

                <div className="persona-list">
                  {currentCompany.personas.map((persona) => (
                    <button
                      key={persona.email}
                      type="button"
                      className="persona-btn"
                      disabled={busy}
                      onClick={() => handlePersonaLogin(persona.email)}
                    >
                      <div className="persona-avatar">
                        {persona.name
                          .split(' ')
                          .map((n) => n[0])
                          .join('')}
                      </div>
                      <div className="persona-info">
                        <strong>{persona.name}</strong>
                        <span>{persona.role}</span>
                      </div>
                      <span className="persona-action">{busy ? 'Entering…' : 'Enter →'}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Tab 2: Standard Credentials Form */}
          {activeTab === 'credentials' && (
            <form className="stack" onSubmit={submitCredentials}>
              <label className="field">
                E-mail Address
                <input
                  type="email"
                  placeholder="name@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  required
                />
              </label>
              <label className="field">
                Password
                <input
                  type="password"
                  placeholder="••••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                <label className="check" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" defaultChecked /> Remember this session
                </label>
              </div>

              <button className="btn primary" disabled={busy} type="submit" style={{ marginTop: 6, minHeight: 44 }}>
                {busy ? 'Signing in…' : 'Sign In to Workspace'}
              </button>
            </form>
          )}

          <div style={{ marginTop: 24, textAlign: 'center', fontSize: 12, color: 'var(--muted)' }}>
            WhizUnik Enterprise Operations · Multi-Tenant Isolated & Compliant
          </div>
        </div>
      </div>
    </div>
  );
}
