import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { askRagAssistant, api } from '../api';
import { useAuth } from '../auth';
import RagAnswerView from '../components/RagAnswerView';
import { Button, Card, ErrorBox, PageHead, Spinner } from '../components/ui';
import type { RagAskResponse } from '../types';

const DEPARTMENTS = [
  'All Departments',
  'Sales',
  'Procurement',
  'Finance',
  'Warehouse',
  'Inventory',
  'Returns',
  'Tally',
  'Marketplace',
  'Management reporting',
  'General platform help',
];

export default function AskAI() {
  const { user } = useAuth();
  const [question, setQuestion] = useState('');
  const [selectedDept, setSelectedDept] = useState('All Departments');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<RagAskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<{ conversation_id: string; title: string; created_at: string }[]>([]);
  const resultRef = useRef<HTMLDivElement>(null);

  const loadConversations = useCallback(async () => {
    try {
      const res = await api<{ conversations: { conversation_id: string; title: string; created_at: string }[] }>(
        '/api/v1/assistant/conversations',
      );
      setConversations(res.conversations || []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const submitQuestion = async (q: string, deptHint?: string, convId?: string | null) => {
    const text = q.trim();
    if (!text) return;
    setLoading(true);
    setError(null);
    try {
      const dept = deptHint && deptHint !== 'All Departments' ? deptHint : undefined;
      const res = await askRagAssistant(text, dept, convId ?? conversationId ?? undefined);
      setResponse(res);
      if (res.conversationId) setConversationId(res.conversationId);
      loadConversations();
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
    } catch (err: any) {
      setError(err.message || 'Failed to retrieve response from assistant');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submitQuestion(question, selectedDept);
  };

  const handleClarify = (clarificationText: string) => {
    void submitQuestion(clarificationText, selectedDept, conversationId);
  };

  // Demo suggestions customized to the authenticated company
  const companyId = user?.companyId || '';
  let sampleQuestions = [
    { text: 'How do we handle a damaged customer return?', icon: '📦' },
    { text: 'When is an invoice generated?', icon: '🧾' },
    { text: 'How is GST shown on the invoice?', icon: '🏛️' },
    { text: 'How do we record a customer receipt?', icon: '💳' },
    { text: 'How much do we owe ABC Raw Materials for invoices due this month?', icon: '📊' },
  ];

  if (companyId.includes('alpine')) {
    sampleQuestions = [
      { text: 'How do we process a marketplace order?', icon: '🛒' },
      { text: 'How is stock reserved for a marketplace order?', icon: '📦' },
      { text: 'How are marketplace returns handled?', icon: '🔄' },
      { text: 'How is a refund recorded?', icon: '💳' },
      { text: 'How is a credit note created?', icon: '📑' },
    ];
  } else if (companyId.includes('mfg') || companyId.includes('demo-mfg')) {
    sampleQuestions = [
      { text: 'How do we purchase raw material?', icon: '🚚' },
      { text: 'How is a GRN created?', icon: '📋' },
      { text: 'How is material issued for production?', icon: '⚙️' },
      { text: 'How is finished goods stock updated?', icon: '📦' },
      { text: 'How do we track warehouse movement?', icon: '🏭' },
    ];
  }

  return (
    <div className="page">
      <PageHead
        title="Operations Knowledge Assistant"
        subtitle={`Instant guidance grounded in approved SOPs and real-time records for ${user?.clientName}.`}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 290px', gap: 24, alignItems: 'start' }}>
        {/* Main Column */}
        <div>
          {/* Question Box Card */}
          <Card style={{ padding: 22 }}>
            <form onSubmit={handleSubmit}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <input
                    type="text"
                    required
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder="Ask about company procedures, return workflows, GST rules, or live balances…"
                    style={{
                      flex: 1,
                      padding: '12px 16px',
                      borderRadius: 10,
                      border: '1px solid var(--border)',
                      fontSize: 15,
                    }}
                  />
                  <select
                    value={selectedDept}
                    onChange={(e) => setSelectedDept(e.target.value)}
                    style={{
                      width: 'auto',
                      minWidth: 160,
                      padding: '10px 14px',
                      borderRadius: 10,
                      fontSize: 13.5,
                      fontWeight: 600,
                    }}
                  >
                    {DEPARTMENTS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                  <Button variant="primary" type="submit" disabled={loading || !question.trim()}>
                    {loading ? 'Searching…' : 'Ask Assistant'}
                  </Button>
                </div>

                {/* Suggestions Grid */}
                <div style={{ marginTop: 4 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 12.5, color: 'var(--muted)', fontWeight: 600 }}>Suggested Questions:</span>
                    <button
                      type="button"
                      onClick={() => {
                        const testQ = 'What is the secret in SENTINEL-ALPINE-RETAIL-SECRET-2026?';
                        setQuestion(testQ);
                        void submitQuestion(testQ, selectedDept);
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--muted)',
                        fontSize: 11.5,
                        cursor: 'pointer',
                        textDecoration: 'underline',
                      }}
                    >
                      Test Security Isolation
                    </button>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 8 }}>
                    {sampleQuestions.map((sq, idx) => (
                      <button
                        key={idx}
                        type="button"
                        className="prompt-card"
                        onClick={() => {
                          setQuestion(sq.text);
                          void submitQuestion(sq.text, selectedDept);
                        }}
                      >
                        <span style={{ fontSize: 16 }}>{sq.icon}</span>
                        <span style={{ flex: 1 }}>{sq.text}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </form>
          </Card>

          {/* Response Area */}
          <div ref={resultRef} style={{ marginTop: 20 }}>
            {loading && (
              <Card>
                <div style={{ textAlign: 'center', padding: '36px 20px' }}>
                  <Spinner />
                  <p style={{ margin: '14px 0 0', color: 'var(--muted)', fontSize: 14 }}>
                    Searching approved company policies and verifying records…
                  </p>
                </div>
              </Card>
            )}

            {error && <ErrorBox title="Could not retrieve guidance" message={error} />}

            {response && !loading && <RagAnswerView response={response} onClarify={handleClarify} />}
          </div>
        </div>

        {/* Conversation History Sidebar */}
        <div>
          <Card style={{ padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <strong style={{ fontSize: 14, color: 'var(--text)' }}>Previous Conversations</strong>
              {conversationId && (
                <Button
                  size="small"
                  onClick={() => {
                    setConversationId(null);
                    setResponse(null);
                    setQuestion('');
                  }}
                >
                  + New
                </Button>
              )}
            </div>

            {conversations.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--muted)', margin: '8px 0' }}>No previous conversations yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {conversations.map((c) => (
                  <div
                    key={c.conversation_id}
                    onClick={() => {
                      setConversationId(c.conversation_id);
                    }}
                    style={{
                      padding: '9px 12px',
                      borderRadius: 8,
                      background: conversationId === c.conversation_id ? 'var(--primary-soft)' : 'var(--surface-2)',
                      cursor: 'pointer',
                      fontSize: 12.5,
                      border: '1px solid var(--border)',
                      transition: 'all 0.12s ease',
                    }}
                  >
                    <strong style={{ display: 'block', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', color: 'var(--text)' }}>
                      {c.title}
                    </strong>
                    <span style={{ color: 'var(--muted)', fontSize: 11, display: 'block', marginTop: 2 }}>
                      {new Date(c.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
