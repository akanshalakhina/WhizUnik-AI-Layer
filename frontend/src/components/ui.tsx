import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { SEVERITY_LABEL, statusTone, titleCase } from '../format';
import type { Tone } from '../format';
import type { Severity, SourceRef, UsageStatus } from '../types';

export function Badge({
  tone,
  variant,
  children,
}: {
  tone?: Tone | 'primary';
  variant?: 'success' | 'warning' | 'danger' | 'neutral';
  children: ReactNode;
}) {
  let appliedTone: Tone | 'primary' = tone || 'grey';
  if (variant === 'success') appliedTone = 'green';
  else if (variant === 'warning') appliedTone = 'amber';
  else if (variant === 'danger') appliedTone = 'red';
  else if (variant === 'neutral') appliedTone = 'grey';

  return <span className={`badge ${appliedTone}`}>{children}</span>;
}

export function Button({
  children,
  onClick,
  type = 'button',
  variant,
  size,
  disabled,
  style,
}: {
  children: ReactNode;
  onClick?: (e?: any) => void;
  type?: 'button' | 'submit' | 'reset';
  variant?: 'primary';
  size?: 'small';
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  const cls = ['btn', variant === 'primary' ? 'primary' : '', size === 'small' ? 'sm' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button className={cls} type={type} onClick={onClick} disabled={disabled} style={style}>
      {children}
    </button>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="card" style={style}>
      {children}
    </div>
  );
}

export function Empty({ message }: { message: string }) {
  return (
    <div className="card empty" style={{ textAlign: 'center', padding: '30px 20px', color: 'var(--muted)' }}>
      <p style={{ margin: 0 }}>{message}</p>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{titleCase(status)}</Badge>;
}

export function SeverityDot({ severity }: { severity: Severity }) {
  return <span className={`dot ${severity}`} role="img" aria-label={`${SEVERITY_LABEL[severity]} severity`} title={`${SEVERITY_LABEL[severity]} severity`} />;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function Skeleton({ h = 16, w = '100%' }: { h?: number; w?: number | string }) {
  return <div className="skeleton" style={{ height: h, width: w }} aria-hidden="true" />;
}

export function ErrorBox({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <div className="banner error" role="alert">
      <div style={{ flex: 1 }}>
        <strong>{title}</strong>
        <span className="banner-body">{message}</span>
      </div>
      {onRetry && (
        <button className="btn sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function SourceLink({ source, short }: { source: SourceRef; short?: boolean }) {
  return (
    <Link className="src" to={source.link} title={`Open ${source.label} in WhizUnik`}>
      {short ? source.ref : source.label}
      <span aria-hidden="true">↗</span>
    </Link>
  );
}

export function UsageBanner({ usage }: { usage: UsageStatus | null | undefined }) {
  if (!usage) return null;
  const monthly = usage.level !== 'ok';
  const daily = usage.dailyLevel !== 'ok';
  if (!monthly && !daily) return null;
  return (
    <>
      {monthly && (
        <div className={`banner ${usage.level === 'limit_reached' ? 'error' : 'warn'}`} role="status">
          <div>
            <strong>
              {usage.level === 'limit_reached' ? 'Monthly AI limit reached' : usage.level === 'warning_90' ? 'Over 90% of the monthly AI limit used' : 'Over 70% of the monthly AI limit used'}
            </strong>
            <span className="banner-body">
              {usage.monthlyPct.toFixed(0)}% of this month's company AI allowance is used.{' '}
              {usage.level === 'limit_reached'
                ? 'AI answers are paused until next month or until your WhizUnik administrator raises the limit; all other WhizUnik features keep working.'
                : 'Contact your WhizUnik administrator if you expect heavier use.'}
            </span>
          </div>
        </div>
      )}
      {daily && (
        <div className={`banner ${usage.dailyLevel === 'limit_reached' ? 'error' : 'warn'}`} role="status">
          <div>
            <strong>
              {usage.dailyLevel === 'limit_reached' ? 'Daily AI limit reached' : usage.dailyLevel === 'warning_90' ? 'Over 90% of your daily AI limit used' : 'Over 70% of your daily AI limit used'}
            </strong>
            <span className="banner-body">
              You have used {usage.dailyUsed} of {usage.dailyLimit} AI requests today.
              {usage.dailyLevel === 'limit_reached' ? ' It resets tomorrow; everything else in WhizUnik keeps working.' : ''}
            </span>
          </div>
        </div>
      )}
    </>
  );
}

export function AdvisoryNote() {
  return (
    <p className="small muted" style={{ marginTop: 16 }}>
      🛈 WhizUnik AI is <strong>advisory only</strong>. It reads approved WhizUnik data, explains it and recommends the next step — it cannot approve, pay, adjust stock or change any record. Open the linked
      workflow to act; the existing approval process stays in charge.
    </p>
  );
}

export function PageHead({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}
