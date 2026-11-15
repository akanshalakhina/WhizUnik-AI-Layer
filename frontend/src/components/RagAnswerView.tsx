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
    <Card>
      {/* Header Badges */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {isGrounded && <Badge variant="success">GROUNDED IN COMPANY KNOWLEDGE</Badge>}
          {isUnavailable && <Badge variant="neutral">EVIDENCE UNAVAILABLE</Badge>}
          {isClarification && <Badge variant="warning">CLARIFICATION NEEDED</Badge>}
          {response.department && <Badge variant="neutral">{response.department}</Badge>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--muted)' }}>
          <span>Confidence: <strong>{Math.round(response.confidence * 100)}%</strong></span>
          <span>• Model: <code>{response.model}</code></span>
        </div>
      </div>

      {/* Answer Body */}
      <div
        style={{
          whiteSpace: 'pre-wrap',
          lineHeight: 1.6,
          fontSize: 15,
          color: 'var(--text)',
          marginBottom: 16,
        }}
      >
        {response.answer}
      </div>

      {/* Clarification prompt input */}
      {isClarification && onClarify && (
        <div style={{ background: 'var(--surface-2)', padding: 14, borderRadius: 8, margin: '14px 0' }}>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            {response.clarificationQuestion || 'Provide clarification:'}
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={clarifyInput}
              onChange={(e) => setClarifyInput(e.target.value)}
              placeholder="e.g. damaged customer return, sales order approval..."
              style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)' }}
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
              Submit Clarification
            </Button>
          </div>
        </div>
      )}

      {/* Source References & Citations */}
      {response.citations.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 14 }}>
          <strong style={{ display: 'block', fontSize: 13, marginBottom: 8, color: 'var(--muted)' }}>
            Retrieved Approved Sources & Citations:
          </strong>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {response.citations.map((c, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 12px',
                  background: 'var(--surface-2)',
                  borderRadius: 8,
                  fontSize: 13,
                }}
              >
                <div>
                  <strong style={{ color: 'var(--primary-text)' }}>{c.title}</strong>{' '}
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                    (v{c.version} • {c.department} • Section: {c.section || 'General'})
                  </span>
                </div>
                <Button size="small" onClick={() => setPreviewCitation(c)}>
                  View Citation
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Feedback Controls (Helpful / Not Helpful) */}
      <div
        style={{
          borderTop: '1px solid var(--border)',
          paddingTop: 12,
          marginTop: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {fbSubmitted ? 'Thank you for your feedback!' : 'Was this answer helpful?'}
        </span>
        {!fbSubmitted && (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              size="small"
              onClick={() => handleFeedback('helpful')}
              style={{ background: feedback === 'helpful' ? 'var(--primary-soft)' : undefined }}
            >
              👍 Helpful
            </Button>
            <Button
              size="small"
              onClick={() => handleFeedback('not_helpful')}
              style={{ background: feedback === 'not_helpful' ? 'var(--surface-2)' : undefined }}
            >
              👎 Not helpful / Report correction
            </Button>
          </div>
        )}
      </div>

      {/* Report Correction Form */}
      {showCorrection && (
        <div
          style={{
            background: 'var(--surface-2)',
            padding: 14,
            borderRadius: 8,
            marginTop: 12,
            border: '1px solid var(--border)',
          }}
        >
          <h4 style={{ margin: '0 0 8px', fontSize: 14 }}>Submit Feedback / Proposed Correction</h4>
          <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--muted)' }}>
            Proposed corrections remain company-scoped and undergo reviewer approval before becoming searchable.
          </p>
          <form onSubmit={submitCorrection}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  Why was this not helpful? (Optional comment)
                </label>
                <input
                  type="text"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="e.g. Procedure was recently updated..."
                  style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  Proposed Corrected Procedure:
                </label>
                <textarea
                  rows={3}
                  value={proposedCorrection}
                  onChange={(e) => setProposedCorrection(e.target.value)}
                  placeholder="Enter the updated procedure for your department..."
                  style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)' }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <Button size="small" onClick={() => setShowCorrection(false)}>
                  Cancel
                </Button>
                <Button size="small" variant="primary" type="submit" disabled={submittingFb}>
                  {submittingFb ? 'Submitting...' : 'Submit to Reviewer'}
                </Button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Citation Preview Modal */}
      {previewCitation && (
        <div className="modal-backdrop" onClick={() => setPreviewCitation(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 600 }}>
            <h3 style={{ margin: '0 0 8px' }}>{previewCitation.title}</h3>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
              Document ID: <code>{previewCitation.documentId}</code> • Version: v{previewCitation.version} • Dept: {previewCitation.department}
            </div>
            <div style={{ background: 'var(--surface-2)', padding: 12, borderRadius: 8, maxHeight: 300, overflowY: 'auto' }}>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 13 }}>
                {previewCitation.excerpt || 'Excerpt from company knowledge base.'}
              </pre>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              <Button onClick={() => setPreviewCitation(null)}>Close</Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
