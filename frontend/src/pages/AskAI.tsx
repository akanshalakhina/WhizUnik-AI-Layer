import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { askRagAssistant, clarifyRag, getRagConversation, getRagConversations } from '../api';
import { useAuth } from '../auth';
import RagAnswerView from '../components/RagAnswerView';
import { Button, Card, ErrorBox, PageHead, Spinner } from '../components/ui';
import { RAG_DEPARTMENTS } from '../rag';
import type { RagAskResponse, RagConversation, RagStoredMessage } from '../types';

type Turn = {
  key: string;
  question: string;
  response?: RagAskResponse;
  error?: string;
  pending?: boolean;
  feedbackGiven?: boolean;
};

const SAMPLES: Record<'rfb' | 'alpine' | 'mfg', string[]> = {
  rfb: [
    'How do we handle a damaged customer return?',
    'How is GST shown on the invoice?',
    'How do we record a customer receipt?',
    'How does the Tally connector work?',
    'When is stock deducted?',
    'How much do we owe ABC Raw Materials for invoices due this month?',
  ],
  alpine: [
    'How do we process a marketplace order?',
    'How is stock reserved for a marketplace order?',
    'How are marketplace returns handled?',
    'How is a refund recorded?',
    'How is a credit note created?',
  ],
  mfg: [
    'How do we purchase raw material?',
    'How is a GRN created?',
    'How is material issued for production?',
    'How is finished goods stock updated?',
    'How do we track warehouse movement?',
  ],
};

function storedToResponse(m: RagStoredMessage, conversationId: string): RagAskResponse {
  return {
    answer: m.answer,
    answerStatus: m.answer_status,
    citations: [],
    confidence: m.confidence,
    department: m.department,
    intent: m.intent,
    clarificationQuestion: m.clarification_question ?? null,
    conversationId,
    messageId: m.message_id,
    model: m.model,
  };
}

const relTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export default function AskAI() {
  const { user } = useAuth();
  const [question, setQuestion] = useState('');
  const [dept, setDept] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<RagConversation[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loadingConv, setLoadingConv] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = turns.some((t) => t.pending) || loadingConv;

  const companyId = user?.companyId || '';
  const samples = companyId.includes('alpine') ? SAMPLES.alpine : companyId.includes('mfg') ? SAMPLES.mfg : SAMPLES.rfb;

  const loadConversations = useCallback(async () => {
    try {
      const res = await getRagConversations();
      setConversations(res.conversations || []);
      setHistoryError(null);
    } catch (e: any) {
      setHistoryError(e?.message || 'Could not load conversations.');
    }
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  async function run(q: string, send: () => Promise<RagAskResponse>) {
    const key = `t${Date.now()}`;
    setTurns((prev) => [...prev, { key, question: q, pending: true }]);
    try {
      const res = await send();
      setTurns((prev) => prev.map((t) => (t.key === key ? { ...t, pending: false, response: res } : t)));
      if (res.conversationId) setConversationId(res.conversationId);
      void loadConversations();
    } catch (e: any) {
      setTurns((prev) =>
        prev.map((t) => (t.key === key ? { ...t, pending: false, error: e?.message || 'The assistant could not answer right now. Please try again.' } : t)),
      );
    }
  }

  function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setQuestion('');
    void run(q, () => askRagAssistant(q, dept || undefined, conversationId ?? undefined));
  }

  function clarify(turn: Turn, text: string) {
    const convId = turn.response?.conversationId || conversationId;
    if (!convId) return ask(`${turn.question} — ${text}`);
    void run(`${text}`, () => clarifyRag(convId, text, turn.question));
  }

  async function openConversation(c: RagConversation) {
    if (busy) return;
    setLoadingConv(true);
    try {
      const res = await getRagConversation(c.conversation_id);
      setConversationId(c.conversation_id);
      setTurns(
        (res.messages || []).map((m) => ({
          key: m.message_id,
          question: m.question,
          response: storedToResponse(m, c.conversation_id),
          feedbackGiven: !!m.feedback,
        })),
      );
    } catch (e: any) {
      setHistoryError(e?.message || 'Could not open the conversation.');
    } finally {
      setLoadingConv(false);
    }
  }

  function newChat() {
    setConversationId(null);
    setTurns([]);
    setQuestion('');
    inputRef.current?.focus();
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    ask(question);
  };

  return (
    <div className="page">
      <PageHead
        title="AI Assistant"
        subtitle={
          <>
            Answers only from <strong>{user?.clientName}</strong>’s approved workflows, SOPs and stored answers — never from other companies.
          </>
        }
      />

      <div className="ask-layout">
        <div className="rag-main">
          <Card>
            <form className="ask-form rag-ask-form" onSubmit={handleSubmit}>
              <input
                ref={inputRef}
                aria-label="Your question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ask about a procedure, e.g. how do we handle a damaged return?"
                maxLength={1000}
              />
              <select aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)}>
                <option value="">All departments</option>
                {RAG_DEPARTMENTS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <Button variant="primary" type="submit" disabled={busy || !question.trim()}>
                {busy ? 'Working…' : 'Ask'}
              </Button>
            </form>
            {turns.length === 0 && (
              <div className="chips" aria-label="Suggested questions">
                {samples.map((q) => (
                  <button key={q} type="button" className="chip" disabled={busy} onClick={() => ask(q)}>
                    {q}
                  </button>
                ))}
                {import.meta.env.DEV && (
                  <button
                    type="button"
                    className="chip chip-test"
                    disabled={busy}
                    title="Development check: asks for another company's secret marker; the answer must be 'not found'."
                    onClick={() => ask('What is the secret in SENTINEL-ALPINE-RETAIL-SECRET-2026?')}
                  >
                    🔒 Isolation check
                  </button>
                )}
              </div>
            )}
          </Card>

          {loadingConv && (
            <Card>
              <Spinner label="Opening conversation…" />
            </Card>
          )}

          {!loadingConv && turns.length === 0 && (
            <div className="empty">
              <div className="big">💬</div>
              <p>Ask a question or pick a suggestion. Every answer shows the approved sources it came from.</p>
            </div>
          )}

          <div className="rag-thread">
            {turns.map((t, i) => {
              const isLast = i === turns.length - 1;
              return (
                <div key={t.key} className="rag-turn">
                  <div className="rag-q">
                    <span className="rag-q-bubble">{t.question}</span>
                  </div>
                  <Card>
                    {t.pending ? (
                      <Spinner label="Searching your company’s approved knowledge…" />
                    ) : t.error ? (
                      <ErrorBox title="No answer" message={t.error} onRetry={isLast ? () => ask(t.question) : undefined} />
                    ) : t.response ? (
                      <RagAnswerView
                        response={t.response}
                        feedbackGiven={t.feedbackGiven}
                        onClarify={isLast && !busy ? (text) => clarify(t, text) : undefined}
                      />
                    ) : null}
                  </Card>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
        </div>

        <aside>
          <Card>
            <div className="card-head">
              <strong>Conversations</strong>
              {(turns.length > 0 || conversationId) && (
                <Button size="small" onClick={newChat} disabled={busy}>
                  + New chat
                </Button>
              )}
            </div>
            {historyError && <p className="field-error">{historyError}</p>}
            {conversations.length === 0 ? (
              <p className="muted-sm" style={{ margin: 0 }}>
                No previous conversations yet.
              </p>
            ) : (
              <ul className="history">
                {conversations.map((c) => (
                  <li key={c.conversation_id}>
                    <button
                      type="button"
                      className={conversationId === c.conversation_id ? 'active' : ''}
                      onClick={() => void openConversation(c)}
                      disabled={busy}
                    >
                      <span className="q">{c.title}</span>
                      <span className="t">{relTime(c.updated_at || c.created_at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
