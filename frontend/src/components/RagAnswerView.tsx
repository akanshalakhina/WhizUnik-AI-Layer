import { useState } from 'react';
import type { FormEvent } from 'react';
import { getRagDocument, submitRagFeedback } from '../api';
import { confidenceLabel, confidencePct, groupCitations, STATUS_LABEL, stripLeadingHeading } from '../rag';
import type { RagAskResponse, RagCitation, RagDocument } from '../types';
import Markdown from './Markdown';
import { Badge, Button } from './ui';

type SourceView = { citation: RagCitation & { sections: string[] }; doc?: RagDocument; error?: string; loading: boolean };

export default function RagAnswerView({
  response,
  onClarify,
  feedbackGiven,
}: {
  response: RagAskResponse;
  onClarify?: (text: string) => void;
  /** True for stored turns that were already rated. */
  feedbackGiven?: boolean;
}) {
  // idle → (helpful) sending → done, or idle → form → sending (form stays visible) → done
  const [fbState, setFbState] = useState<'idle' | 'form' | 'sending' | 'done'>(
    response.answerStatus === 'insufficient_evidence' || feedbackGiven ? 'done' : 'idle',
  );
  const [fbError, setFbError] = useState<string | null>(null);
  const [fbKind, setFbKind] = useState<'helpful' | 'not_helpful' | null>(null);
  const [comment, setComment] = useState('');
  const [correction, setCorrection] = useState('');
  const [clarifyInput, setClarifyInput] = useState('');
  const [source, setSource] = useState<SourceView | null>(null);

  const status = response.answerStatus;
  const isGrounded = status === 'grounded';
  const isUnavailable = status === 'insufficient_evidence';
  const isClarification = status === 'clarification_needed';
  const pct = confidencePct(response.confidence);
  const conf = confidenceLabel(pct);
  const cites = groupCitations(response.citations ?? []);

  const [formOpen, setFormOpen] = useState(false);

  async function sendFeedback(kind: 'helpful' | 'not_helpful', extra?: { comment?: string; proposedCorrection?: string }) {
    setFbState('sending');
    setFbError(null);
    try {
      await submitRagFeedback({ messageId: response.messageId, feedback: kind, ...extra });
      setFbKind(kind);
      setFbState('done');
      setFormOpen(false);
    } catch (e: any) {
      setFbError(e?.message || 'Feedback could not be saved. Please try again.');
      setFbState(formOpen ? 'form' : 'idle');
    }
  }

  function submitCorrection(e: FormEvent) {
    e.preventDefault();
    void sendFeedback('not_helpful', {
      comment: comment.trim() || undefined,
      proposedCorrection: correction.trim() || undefined,
    });
  }

  async function openSource(c: RagCitation & { sections: string[] }) {
    setSource({ citation: c, loading: true });
    try {
      // Server-side permission check: the document is only returned for the user's own company.
      const res = await getRagDocument(c.documentId);
      setSource({ citation: c, doc: res.document, loading: false });
    } catch (e: any) {
      setSource({ citation: c, loading: false, error: e?.status === 404 ? 'not-found' : e?.message || 'Could not load the source.' });
    }
  }

  const sourceChunks = source?.doc?.chunks?.length
    ? source.doc.chunks.filter((ch) => !source.citation.sections.length || source.citation.sections.includes(ch.section_heading))
    : [];

  return (
    <div className={`rag-answer ${isUnavailable ? 'is-unavailable' : ''}`}>
      <div className="meta-row">
        {isGrounded && <Badge variant="success">{STATUS_LABEL.grounded}</Badge>}
        {isUnavailable && <Badge variant="neutral">{STATUS_LABEL.insufficient_evidence}</Badge>}
        {isClarification && <Badge variant="warning">{STATUS_LABEL.clarification_needed}</Badge>}
        {response.department && <Badge tone="primary">{response.department}</Badge>}
        {isGrounded && (
          <span className={`badge ${conf.tone}`} title="How closely the retrieved approved sources match the question. It is not a guarantee of correctness — check the cited sources.">
            {conf.text} match · {pct}%
          </span>
        )}
      </div>

      {isUnavailable ? (
        <p className="rag-unavailable">{response.answer}</p>
      ) : (
        <Markdown text={response.answer} className="answer-md" />
      )}

      {isClarification && onClarify && (
        <form
          className="rag-clarify"
          onSubmit={(e) => {
            e.preventDefault();
            if (clarifyInput.trim()) {
              onClarify(clarifyInput.trim());
              setClarifyInput('');
            }
          }}
        >
          <label htmlFor={`clarify-${response.messageId}`}>{response.clarificationQuestion || 'Add details so the assistant can find the right procedure:'}</label>
          <div className="ask-form">
            <input
              id={`clarify-${response.messageId}`}
              value={clarifyInput}
              onChange={(e) => setClarifyInput(e.target.value)}
              placeholder="e.g. a damaged customer return, a sales order credit approval…"
            />
            <Button variant="primary" type="submit" disabled={!clarifyInput.trim()}>
              Send
            </Button>
          </div>
        </form>
      )}

      {cites.length > 0 && (
        <div className="block">
          <h3>Sources ({cites.length})</h3>
          <ul className="cite-list">
            {cites.map((c) => (
              <li key={`${c.documentId}-${c.version}-${c.title}`}>
                <div className="cite-main">
                  <strong>{c.title}</strong>
                  <span className="cite-meta">
                    v{c.version} · {c.department}
                    {c.sections.length > 0 && ` · ${c.sections.join(', ')}`}
                  </span>
                </div>
                <Button size="small" onClick={() => void openSource(c)}>
                  View source
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {isGrounded && response.model && (
        <div className="rag-foot-meta">
          Model: <code>{response.model}</code>
          {response.usage && response.usage.inputTokens + response.usage.outputTokens > 0 && (
            <> · {response.usage.inputTokens + response.usage.outputTokens} tokens</>
          )}
        </div>
      )}

      {!isUnavailable && (
        <div className="rag-feedback">
          {fbState === 'done' ? (
            <span className="muted-sm">
              {fbKind === 'not_helpful'
                ? correction.trim()
                  ? 'Thanks — your correction was sent to the knowledge reviewer. It is not used until it is approved.'
                  : 'Thanks — your feedback was recorded.'
                : 'Thanks for your feedback!'}
            </span>
          ) : (
            <>
              <span className="muted-sm">Was this answer helpful?</span>
              <div className="rag-feedback-btns">
                <Button size="small" disabled={fbState === 'sending'} onClick={() => void sendFeedback('helpful')}>
                  👍 Helpful
                </Button>
                <Button
                  size="small"
                  disabled={fbState === 'sending'}
                  onClick={() => {
                    setFbState('form');
                    setFormOpen(true);
                  }}
                >
                  👎 Not helpful
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      {fbError && <p className="field-error" role="alert">{fbError}</p>}

      {formOpen && fbState !== 'done' ? (
        <form className="rag-correction" onSubmit={submitCorrection}>
          <h4>What was wrong?</h4>
          <p className="muted-sm">Corrections stay inside your company and are only used after a knowledge reviewer approves them.</p>
          <label>
            Comment (optional)
            <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="e.g. the procedure changed last month" maxLength={1000} />
          </label>
          <label>
            Correct answer (optional)
            <textarea rows={3} value={correction} onChange={(e) => setCorrection(e.target.value)} placeholder="Write the correct procedure for your department…" maxLength={2000} />
          </label>
          <div className="row-end">
            <Button
              size="small"
              disabled={fbState === 'sending'}
              onClick={() => {
                setFbState('idle');
                setFormOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button size="small" variant="primary" type="submit" disabled={fbState === 'sending'}>
              {fbState === 'sending' ? 'Sending…' : 'Send feedback'}
            </Button>
          </div>
        </form>
      ) : null}

      {source && (
        <div className="modal-backdrop" onClick={() => setSource(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label={source.citation.title} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
            <h2 style={{ margin: '0 0 4px' }}>{source.citation.title}</h2>
            <div className="cite-meta" style={{ marginBottom: 14 }}>
              v{source.citation.version} · {source.citation.department}
              {source.citation.sections.length > 0 && ` · ${source.citation.sections.join(', ')}`}
            </div>
            <div className="source-body">
              {source.loading ? (
                <p className="muted-sm">Loading source…</p>
              ) : source.doc ? (
                sourceChunks.length ? (
                  sourceChunks.map((ch) => (
                    <section key={ch.chunk_id}>
                      {ch.section_heading && <h4>{ch.section_heading}</h4>}
                      <Markdown text={stripLeadingHeading(ch.text, ch.section_heading)} />
                    </section>
                  ))
                ) : (
                  <Markdown text={source.doc.content || source.citation.excerpt || ''} />
                )
              ) : (
                <>
                  <p className="muted-sm">
                    {source.error === 'not-found'
                      ? 'This source is a stored approved answer (not a document), or it is no longer available. Excerpt used for the answer:'
                      : source.error}
                  </p>
                  {source.citation.excerpt && <Markdown text={source.citation.excerpt} />}
                </>
              )}
            </div>
            <div className="row-end" style={{ marginTop: 14 }}>
              <Button onClick={() => setSource(null)}>Close</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
