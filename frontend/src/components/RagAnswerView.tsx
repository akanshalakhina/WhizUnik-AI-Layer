import { useState } from 'react';
import { submitRagFeedback } from '../api';
import { Badge, Button, Card } from './ui';
import type { RagAskResponse, RagCitation } from '../types';

export default function RagAnswerView({
  response,
  onClarify,
}: {
  response: RagAskResponse;
  onClarify?: (text: string) => void;
}) {
  const [feedback, setFeedback] = useState<'helpful' | 'not_helpful' | null>(null);
  const [showCorrection, setShowCorrection] = useState(false);
  const [comment, setComment] = useState('');
  const [proposedCorrection, setProposedCorrection] = useState('');
  const [submittingFb, setSubmittingFb] = useState(false);
  const [fbSubmitted, setFbSubmitted] = useState(false);
  const [previewCitation, setPreviewCitation] = useState<RagCitation | null>(null);
  const [clarifyInput, setClarifyInput] = useState('');
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);

  const handleFeedback = async (type: 'helpful' | 'not_helpful') => {
    setFeedback(type);
    if (type === 'not_helpful') {
      setShowCorrection(true);
    } else {
      try {
        await submitRagFeedback({
          messageId: response.messageId,
          feedback: 'helpful',
        });
        setFbSubmitted(true);
      } catch (e) {
        console.error('Feedback error', e);
      }
    }
  };

  const submitCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittingFb(true);
    try {
      await submitRagFeedback({
        messageId: response.messageId,
        feedback: 'not_helpful',
        comment,
        proposedCorrection,
      });
      setFbSubmitted(true);
      setShowCorrection(false);
    } catch (e) {
      console.error('Correction submission error', e);
    } finally {
      setSubmittingFb(false);
    }
  };

  const isUnavailable = response.answerStatus === 'insufficient_evidence';
  const isClarification = response.answerStatus === 'clarification_needed';
  const isGrounded = response.answerStatus === 'grounded';

  return (
    <Card style={{ padding: 24 }}>
      {/* Header Badges */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {isGrounded && <span className="verified-pill success">✓ Verified Company Policy</span>}
          {isUnavailable && <span className="verified-pill neutral">ℹ️ Policy Not Found</span>}
          {isClarification && <span className="verified-pill warning">⚠️ Clarification Needed</span>}
          {response.department && <Badge tone="primary">{response.department}</Badge>}
        </div>

        <button
          type="button"
          onClick={() => setShowTechnicalDetails((v) => !v)}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--muted)',
            cursor: 'pointer',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 6px',
            borderRadius: 6,
          }}
        >
          <span>{showTechnicalDetails ? '▾ Hide Audit Details' : '▸ Audit & Model Details'}</span>
        </button>
      </div>

      {/* Answer Body */}
      <div
        style={{
          whiteSpace: 'pre-wrap',
          lineHeight: 1.65,
          fontSize: 15,
          color: 'var(--text)',
          marginBottom: 18,
        }}
      >
        {response.answer}
      </div>

      {/* Clarification prompt input */}
      {isClarification && onClarify && (
        <div style={{ background: 'var(--surface-2)', padding: 16, borderRadius: 10, margin: '16px 0', border: '1px solid var(--border)' }}>
          <label style={{ display: 'block', fontSize: 13.5, fontWeight: 600, marginBottom: 8, color: 'var(--text)' }}>
            {response.clarificationQuestion || 'Please provide clarification:'}
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={clarifyInput}
              onChange={(e) => setClarifyInput(e.target.value)}
              placeholder="e.g. damaged customer return, sales order approval..."
              style={{ flex: 1, padding: '9px 13px', borderRadius: 8, border: '1px solid var(--border)' }}
            />
            <Button
              variant="primary"
              onClick={() => {
                if (clarifyInput.trim()) {
                  onClarify(clarifyInput.trim());
                  setClarifyInput('');
                }
              }}
            >
              Continue
            </Button>
          </div>
        </div>
      )}

      {/* Source References & Citations */}
      {response.citations.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <strong style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Referenced Company Documents & SOPs
            </strong>
            <span className="small muted">{response.citations.length} sources cited</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {response.citations.map((c, i) => (
              <div key={i} className="citation-card">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 18 }}>📄</span>
                  <div>
                    <strong style={{ color: 'var(--text)', display: 'block' }}>{c.title}</strong>
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                      {c.department} · Section: {c.section || 'General'} (v{c.version})
                    </span>
                  </div>
                </div>
                <Button size="small" onClick={() => setPreviewCitation(c)}>
                  View Policy Excerpt
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Expandable Technical Details */}
      {showTechnicalDetails && (
        <div
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: 14,
            marginTop: 16,
            fontSize: 12.5,
            color: 'var(--muted)',
          }}
        >
          <div style={{ fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>Compliance & Model Traceability:</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
            <div>
              Confidence Match: <strong style={{ color: 'var(--text)' }}>{Math.round(response.confidence * 100)}%</strong>
            </div>
            <div>
              Engine: <strong style={{ color: 'var(--text)' }}>{response.model}</strong>
            </div>
            {response.requestId && (
              <div>
                Request ID: <code style={{ fontSize: 11 }}>{response.requestId}</code>
              </div>
            )}
            {response.usage && (
              <div>
                Tokens: {response.usage.inputTokens} in / {response.usage.outputTokens} out
              </div>
            )}
          </div>
        </div>
      )}

      {/* Feedback Controls (Helpful / Not Helpful) */}
      <div
        style={{
          borderTop: '1px solid var(--border)',
          paddingTop: 14,
          marginTop: 18,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 10,
        }}
      >
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          {fbSubmitted ? '✓ Thank you! Your feedback helps refine our company policies.' : 'Was this procedure guidance helpful?'}
        </span>
        {!fbSubmitted && (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              size="small"
              onClick={() => handleFeedback('helpful')}
              style={{ background: feedback === 'helpful' ? 'var(--primary-soft)' : undefined }}
            >
              👍 Yes, accurate
            </Button>
            <Button
              size="small"
              onClick={() => handleFeedback('not_helpful')}
              style={{ background: feedback === 'not_helpful' ? 'var(--surface-2)' : undefined }}
            >
              👎 Needs update / Propose correction
            </Button>
          </div>
        )}
      </div>

      {/* Report Correction Form */}
      {showCorrection && (
        <div
          style={{
            background: 'var(--surface-2)',
            padding: 16,
            borderRadius: 10,
            marginTop: 14,
            border: '1px solid var(--border)',
          }}
        >
          <h4 style={{ margin: '0 0 6px', fontSize: 14, color: 'var(--text)' }}>Propose SOP Correction or Feedback</h4>
          <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--muted)' }}>
            Your proposal will be routed to your company’s department reviewer before updating the approved knowledge base.
          </p>
          <form onSubmit={submitCorrection}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, marginBottom: 5 }}>
                  Reason (Optional):
                </label>
                <input
                  type="text"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="e.g. Quarantine Bay procedure was revised last week..."
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, marginBottom: 5 }}>
                  Proposed Updated Process:
                </label>
                <textarea
                  rows={3}
                  value={proposedCorrection}
                  onChange={(e) => setProposedCorrection(e.target.value)}
                  placeholder="Enter the correct step-by-step procedure..."
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)' }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <Button size="small" onClick={() => setShowCorrection(false)}>
                  Cancel
                </Button>
                <Button size="small" variant="primary" type="submit" disabled={submittingFb}>
                  {submittingFb ? 'Submitting…' : 'Submit to Department Reviewer'}
                </Button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Citation Preview Modal */}
      {previewCitation && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.6)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 100,
            padding: 20,
          }}
          onClick={() => setPreviewCitation(null)}
        >
          <div
            className="card"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 640, width: '100%', maxHeight: '85vh', display: 'flex', flexDirection: 'column', padding: 24 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 17, color: 'var(--text)' }}>{previewCitation.title}</h3>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>
                  Department: <strong>{previewCitation.department}</strong> · Version: v{previewCitation.version} · Section: {previewCitation.section || 'General'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPreviewCitation(null)}
                style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: 'var(--muted)' }}
              >
                ✕
              </button>
            </div>

            <div style={{ background: 'var(--surface-2)', padding: 16, borderRadius: 8, overflowY: 'auto', flex: 1, border: '1px solid var(--border)' }}>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 13.5, lineHeight: 1.6, color: 'var(--text)' }}>
                {previewCitation.excerpt || 'Excerpt from company knowledge base.'}
              </pre>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <Button onClick={() => setPreviewCitation(null)}>Done</Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
