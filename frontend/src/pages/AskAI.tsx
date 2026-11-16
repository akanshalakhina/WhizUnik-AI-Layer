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
      setError(err.message || 'Failed to retrieve response from AI assistant');
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
    'How do we handle a damaged customer return?',
    'When is an invoice generated?',
    'How is GST shown on the invoice?',
    'How do we record a customer receipt?',
    'How does the Tally connector work?',
    'How much do we owe ABC Raw Materials for invoices due this month?',
  ];

  if (companyId.includes('alpine')) {
    sampleQuestions = [
      'How do we process a marketplace order?',
      'How is stock reserved for a marketplace order?',
      'How are marketplace returns handled?',
      'How is a refund recorded?',
      'How is a credit note created?',
    ];
  } else if (companyId.includes('mfg') || companyId.includes('demo-mfg')) {
    sampleQuestions = [
      'How do we purchase raw material?',
      'How is a GRN created?',
      'How is material issued for production?',
      'How is finished goods stock updated?',
      'How do we track warehouse movement?',
    ];
  }

  return (
    <div className="page">
      <PageHead
        title="WhizUnik AI Assistant (RAG)"
        subtitle={`Tenant-isolated Retrieval-Augmented Generation for ${user?.clientName}. Retrieves only approved company workflows, SOPs, and live business data.`}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 20 }}>
        {/* Main Assistant Column */}
        <div>
          {/* Question Box Card */}
          <Card>
            <form onSubmit={handleSubmit}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <input
                    type="text"
                    required
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder="Ask about company procedures, workflows, damaged returns, GST, stock, or balances..."
                    style={{
                      flex: 1,
                      padding: '12px 16px',
                      borderRadius: 10,
                      border: '1px solid var(--border)',
                      fontSize: 15,
                      background: 'var(--surface-2)',
                    }}
                  />
                  <select
                    value={selectedDept}
                    onChange={(e) => setSelectedDept(e.target.value)}
                    style={{
                      padding: '12px 14px',
                      borderRadius: 10,
                      border: '1px solid var(--border)',
                      background: 'var(--surface-2)',
                      fontSize: 14,
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
                    {loading ? 'Searching...' : 'Ask AI'}
                  </Button>
                </div>

                {/* Sample Prompt Chips */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 4 }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>Suggested Questions:</span>
                  {sampleQuestions.map((q, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        setQuestion(q);
                        void submitQuestion(q, selectedDept);
                      }}
                      style={{
                        background: 'var(--surface-2)',
                        border: '1px solid var(--border)',
                        borderRadius: 20,
                        padding: '4px 12px',
                        fontSize: 12,
                        cursor: 'pointer',
                        color: 'var(--text-2)',
                      }}
                    >
                      {q}
                    </button>
                  ))}
                  {/* Isolation Test Chip */}
                  <button
                    type="button"
                    onClick={() => {
                      const testQ = 'What is the secret in SENTINEL-ALPINE-RETAIL-SECRET-2026?';
                      setQuestion(testQ);
                      void submitQuestion(testQ, selectedDept);
                    }}
                    style={{
                      background: 'rgba(239, 68, 68, 0.08)',
                      border: '1px dashed #ef4444',
                      borderRadius: 20,
                      padding: '4px 12px',
                      fontSize: 12,
                      cursor: 'pointer',
                      color: '#ef4444',
                      fontWeight: 600,
                    }}
                  >
                    🔒 Test Cross-Tenant Isolation
                  </button>
                </div>
              </div>
            </form>
          </Card>

          {/* Response Area */}
          <div ref={resultRef} style={{ marginTop: 20 }}>
            {loading && (
              <Card>
                <div style={{ textAlign: 'center', padding: '30px 20px' }}>
                  <Spinner />
                  <p style={{ margin: '14px 0 0', color: 'var(--muted)', fontSize: 14 }}>
                    Analyzing question, enforcing tenant filter, and retrieving approved records...
                  </p>
                </div>
              </Card>
            )}

            {error && <ErrorBox title="Error" message={error} />}

            {response && !loading && (
              <RagAnswerView response={response} onClarify={handleClarify} />
            )}
          </div>
        </div>

        {/* Conversation History Sidebar */}
        <div>
          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <strong style={{ fontSize: 14 }}>Conversations</strong>
              {conversationId && (
                <Button
                  size="small"
                  onClick={() => {
                    setConversationId(null);
                    setResponse(null);
                    setQuestion('');
                  }}
                >
                  New Chat
                </Button>
              )}
            </div>
            {conversations.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>No previous conversations.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {conversations.map((c) => (
                  <div
                    key={c.conversation_id}
                    onClick={() => {
                      setConversationId(c.conversation_id);
                    }}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 6,
                      background: conversationId === c.conversation_id ? 'var(--primary-soft)' : 'var(--surface-2)',
                      cursor: 'pointer',
                      fontSize: 12,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    <strong style={{ display: 'block', textOverflow: 'ellipsis', overflow: 'hidden' }}>{c.title}</strong>
                    <span style={{ color: 'var(--muted)', fontSize: 11 }}>
                      {new Date(c.created_at).toLocaleDateString()}
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
