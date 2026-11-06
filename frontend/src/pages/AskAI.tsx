import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../api';
import AnswerView from '../components/AnswerView';
import { ErrorBox, PageHead, Spinner, StatusBadge, UsageBanner } from '../components/ui';
import { fmtDateTime } from '../format';
import { useAsync } from '../hooks';
import type { AiStatus, AskResponse, HistoryItem } from '../types';

type View =
  | { kind: 'idle' }
  | { kind: 'loading'; question: string }
  | { kind: 'answer'; question: string; response: AskResponse; notice?: string }
  | { kind: 'error'; question: string; error: ApiError };

export default function AskAI() {
  const status = useAsync(() => api<AiStatus>('/api/ai/status'), []);
  const history = useAsync(() => api<{ items: HistoryItem[] }>('/api/ai/history'), []);
  const [question, setQuestion] = useState('');
  const [view, setView] = useState<View>({ kind: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const submit = useCallback(
    async (q: string) => {
      const text = q.trim();
      if (text.length < 3) {
        setView({ kind: 'error', question: text, error: new ApiError(400, 'INVALID_QUESTION', 'Please enter a question of at least 3 characters.', null) });
        return;
      }
      setView({ kind: 'loading', question: text });
      try {
        const response = await api<AskResponse>('/api/ai/ask', { method: 'POST', body: { question: text } });
        setView({ kind: 'answer', question: text, response });
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(0, 'NETWORK', 'Something went wrong. Please try again.', null);
        if (err.body?.fallback) setView({ kind: 'answer', question: text, response: err.body.fallback as AskResponse, notice: err.message });
        else setView({ kind: 'error', question: text, error: err });
      } finally {
        history.reload();
        status.reload();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (view.kind !== 'idle') resultRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [view.kind]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(question);
  };

  const openHistory = async (h: HistoryItem) => {
    setQuestion(h.question);
    setView({ kind: 'loading', question: h.question });
    try {
      const entry = await api<{ response: AskResponse | { error: { code: string; message: string } } }>(`/api/ai/history/${h.id}`);
      if ('error' in entry.response) setView({ kind: 'error', question: h.question, error: new ApiError(0, entry.response.error.code, entry.response.error.message, null) });
      else setView({ kind: 'answer', question: h.question, response: entry.response, notice: undefined });
    } catch (e) {
      setView({ kind: 'error', question: h.question, error: e instanceof ApiError ? e : new ApiError(0, 'ERROR', 'Could not load that answer.', null) });
    }
  };

  const clearHistory = async () => {
    await api('/api/ai/history', { method: 'DELETE' });
    history.reload();
  };

  const st = status.data;
  const blocked = st && (!st.enabled || !st.roleAllowed);
  const busy = view.kind === 'loading';

  return (
    <>
      <PageHead title="Ask WhizUnik AI" subtitle="Ask about orders, stock, procurement, warehouse, finance and marketplace. Answers come only from your company's WhizUnik data." />
      <UsageBanner usage={st?.usage} />

      <div className="ask-layout">
        <div>
          <div className="card">
            <form className="ask-form" onSubmit={onSubmit} role="search">
              <label className="sr-only" htmlFor="q">
                Your question
              </label>
              <input
                id="q"
                ref={inputRef}
                type="text"
                value={question}
                maxLength={500}
                placeholder="e.g. Which invoices above ₹1 lakh are overdue?"
                onChange={(e) => setQuestion(e.target.value)}
                disabled={!!blocked}
                autoComplete="off"
              />
              <button className="btn primary" type="submit" disabled={busy || !!blocked || question.trim().length === 0}>
                {busy ? <Spinner label="Asking…" /> : 'Ask'}
              </button>
            </form>
            {blocked && st && (
              <div className="banner warn" style={{ marginTop: 12 }}>
                <div>
                  <strong>AI is not available</strong>
                  <span className="banner-body">{st.reason}</span>
                </div>
              </div>
            )}
            {st && !blocked && (
              <>
                <div className="chips" aria-label="Example questions">
                  {st.sampleQuestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="chip"
                      disabled={busy}
                      onClick={() => {
                        setQuestion(s);
                        void submit(s);
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <p className="small muted" style={{ marginTop: 12 }}>
                  Your role ({st.roleLabel}) can ask about: {st.roleAccess.toLowerCase()}. {question.length > 0 && `${question.length}/500`}
                </p>
              </>
            )}
          </div>

          <div ref={resultRef} style={{ marginTop: 16 }}>
            {view.kind === 'idle' && (
              <div className="card empty">
                <div className="big">💬</div>
                <h2>Ask a question to get started</h2>
                <p style={{ marginTop: 6 }}>Answers show the figures, date range, assumptions and the WhizUnik records they came from.</p>
              </div>
            )}

            {view.kind === 'loading' && (
              <div className="card" aria-busy="true">
                <Spinner label={`Retrieving WhizUnik records for “${view.question}”…`} />
              </div>
            )}

            {view.kind === 'answer' && <AnswerView r={view.response} degradedNotice={view.notice} />}

            {view.kind === 'error' && <AskError error={view.error} onRetry={() => void submit(view.question)} />}
          </div>
        </div>

        <aside className="card" aria-label="Your search history">
          <div className="card-head">
            <h2>Your history</h2>
            {history.data && history.data.items.length > 0 && (
              <button className="btn sm ghost danger" onClick={clearHistory}>
                Clear
              </button>
            )}
          </div>
          {history.loading && !history.data && <Spinner label="Loading…" />}
          {history.error && <p className="small muted">Could not load history.</p>}
          {history.data && history.data.items.length === 0 && <p className="small muted">No searches yet. Your questions appear here and are visible only to you.</p>}
          <ul className="history">
            {history.data?.items.map((h) => (
              <li key={h.id}>
                <button onClick={() => openHistory(h)} disabled={busy}>
                  <span className="q">{h.question}</span>
                  <span className="t">
                    {fmtDateTime(h.createdAt)} · <StatusBadge status={h.status} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </>
  );
}

function AskError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  switch (error.code) {
    case 'ROLE_NOT_PERMITTED':
      return (
        <div className="banner warn" role="alert">
          <div>
            <strong>This data isn't available to your role</strong>
            <span className="banner-body">{error.message}</span>
          </div>
        </div>
      );
    case 'AI_DISABLED':
      return (
        <div className="banner info" role="alert">
          <div>
            <strong>AI is turned off</strong>
            <span className="banner-body">{error.message} Everything else in WhizUnik works as usual.</span>
          </div>
        </div>
      );
    case 'MONTHLY_LIMIT_REACHED':
    case 'DAILY_LIMIT_REACHED':
      return (
        <div className="banner error" role="alert">
          <div>
            <strong>{error.code === 'DAILY_LIMIT_REACHED' ? 'Daily limit reached' : 'Monthly limit reached'}</strong>
            <span className="banner-body">{error.message}</span>
          </div>
        </div>
      );
    case 'INVALID_QUESTION':
      return (
        <div className="banner warn" role="alert">
          <div>
            <strong>Check your question</strong>
            <span className="banner-body">{error.message}</span>
          </div>
        </div>
      );
    default:
      return <ErrorBox title="The AI assistant couldn't answer" message={error.message} onRetry={onRetry} />;
  }
}
