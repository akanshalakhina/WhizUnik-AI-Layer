import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  approveRagDocument,
  approveRagReview,
  archiveRagDocument,
  createRagDocument,
  createRagQa,
  getRagDocument,
  getRagDocuments,
  getRagFeedbackReviews,
  getRagQa,
  rejectRagDocument,
  rejectRagReview,
} from '../api';
import { useAuth } from '../auth';
import Markdown from '../components/Markdown';
import { Badge, Button, Card, Empty, ErrorBox, PageHead, Spinner } from '../components/ui';
import { useAsync } from '../hooks';
import { isKnowledgeAdmin, RAG_DEPARTMENTS, stripLeadingHeading } from '../rag';
import type { RagDocument, RagFeedbackReview } from '../types';

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  approved: 'success',
  pending_review: 'warning',
  pending: 'warning',
  rejected: 'danger',
  archived: 'neutral',
};
const STATUS_TEXT: Record<string, string> = {
  approved: 'Approved',
  pending_review: 'Pending review',
  pending: 'Pending review',
  rejected: 'Rejected',
  archived: 'Archived',
  none: '—',
};
const SOURCE_TYPE_TEXT: Record<string, string> = { sop: 'SOP', workflow: 'Workflow', policy: 'Policy', manual_qa: 'Manual Q&A', platform_doc: 'Platform doc' };
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export function NotPermitted({ what }: { what: string }) {
  return (
    <div className="page">
      <PageHead title={what} />
      <Card>
        <div className="empty">
          <div className="big">🔒</div>
          <p>This screen is available to knowledge administrators (management role) only.</p>
        </div>
      </Card>
    </div>
  );
}

type Tab = 'docs' | 'qa' | 'reviews';

export default function KnowledgeBase() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('docs');
  const [dept, setDept] = useState('all');
  const [status, setStatus] = useState('all');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ doc?: RagDocument; loading: boolean; error?: string } | null>(null);
  const [docForm, setDocForm] = useState<null | { title: string; department: string; sourceType: string; content: string }>(null);
  const [qaForm, setQaForm] = useState<null | { question: string; answer: string; department: string; fromReview?: string }>(null);
  const [saving, setSaving] = useState(false);

  const admin = isKnowledgeAdmin(user?.role);
  const docs = useAsync(() => (admin ? getRagDocuments(dept, status) : Promise.resolve({ documents: [] })), [dept, status, admin]);
  const qa = useAsync(() => (admin ? getRagQa() : Promise.resolve({ qa: [] })), [admin]);
  const reviews = useAsync(() => (admin ? getRagFeedbackReviews() : Promise.resolve({ reviews: [] })), [admin]);

  if (!admin) return <NotPermitted what="Knowledge Base" />;

  const pendingReviews = (reviews.data?.reviews ?? []).filter((r) => r.review_status === 'pending');

  async function changeStatus(d: RagDocument, action: 'approve' | 'reject' | 'archive') {
    setBusyId(d.document_id);
    setNotice(null);
    try {
      if (action === 'approve') await approveRagDocument(d.document_id);
      else if (action === 'reject') await rejectRagDocument(d.document_id);
      else await archiveRagDocument(d.document_id);
      const verb = action === 'approve' ? 'approved — it can now be used in answers' : action === 'reject' ? 'rejected' : 'archived — it is no longer used in answers';
      setNotice({ kind: 'ok', text: `“${d.title}” ${verb}.` });
      docs.reload();
    } catch (e: any) {
      setNotice({ kind: 'error', text: e?.message || 'The action failed.' });
    } finally {
      setBusyId(null);
    }
  }

  async function openPreview(d: RagDocument) {
    setPreview({ loading: true, doc: d });
    try {
      const res = await getRagDocument(d.document_id);
      setPreview({ loading: false, doc: res.document });
    } catch (e: any) {
      setPreview({ loading: false, doc: d, error: e?.message || 'Could not load the document.' });
    }
  }

  async function saveDoc(e: FormEvent) {
    e.preventDefault();
    if (!docForm) return;
    setSaving(true);
    try {
      await createRagDocument({ title: docForm.title.trim(), department: docForm.department, sourceType: docForm.sourceType, content: docForm.content });
      setDocForm(null);
      setStatus('all');
      setNotice({ kind: 'ok', text: 'Document saved as “Pending review”. It is not used in answers until you approve it.' });
      docs.reload();
    } catch (err: any) {
      setNotice({ kind: 'error', text: err?.message || 'The document could not be saved.' });
    } finally {
      setSaving(false);
    }
  }

  async function saveQa(e: FormEvent) {
    e.preventDefault();
    if (!qaForm) return;
    setSaving(true);
    try {
      const edits = { question: qaForm.question.trim(), answer: qaForm.answer.trim(), department: qaForm.department };
      if (qaForm.fromReview) await approveRagReview(qaForm.fromReview, edits);
      else await createRagQa(edits);
      setQaForm(null);
      setNotice({ kind: 'ok', text: qaForm.fromReview ? 'Correction approved and saved as an approved answer for this company.' : 'Approved answer saved. It is used for this company only.' });
      qa.reload();
      reviews.reload();
    } catch (err: any) {
      setNotice({ kind: 'error', text: err?.message || 'The answer could not be saved.' });
    } finally {
      setSaving(false);
    }
  }

  function promote(r: RagFeedbackReview) {
    const department = r.department && RAG_DEPARTMENTS.includes(r.department) ? r.department : RAG_DEPARTMENTS[0];
    setQaForm({ question: r.question, answer: r.proposed_correction || '', department, fromReview: r.message_id });
  }

  async function rejectReview(r: RagFeedbackReview) {
    setBusyId(r.message_id);
    setNotice(null);
    try {
      await rejectRagReview(r.message_id);
      setNotice({ kind: 'ok', text: 'Correction rejected. It will not be used.' });
      reviews.reload();
    } catch (e: any) {
      setNotice({ kind: 'error', text: e?.message || 'The correction could not be rejected.' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page">
      <PageHead
        title="Knowledge Base"
        subtitle={
          <>
            Approved documents and answers for <strong>{user?.clientName}</strong>. Only approved items are used by the assistant, and only for this company.
          </>
        }
      >
        <div className="row-end">
          <Button variant="primary" onClick={() => setDocForm({ title: '', department: 'Returns', sourceType: 'sop', content: '' })}>
            + Add document
          </Button>
          <Button onClick={() => setQaForm({ question: '', answer: '', department: 'Returns' })}>+ Add approved answer</Button>
        </div>
      </PageHead>

      {notice && (
        <div className={`banner ${notice.kind === 'error' ? 'error' : 'ok'}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          <div style={{ flex: 1 }}>{notice.text}</div>
          <button className="btn sm ghost" onClick={() => setNotice(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'docs'} className={`tab ${tab === 'docs' ? 'active' : ''}`} onClick={() => setTab('docs')}>
          Documents{docs.data ? ` (${docs.data.documents.length})` : ''}
        </button>
        <button role="tab" aria-selected={tab === 'qa'} className={`tab ${tab === 'qa' ? 'active' : ''}`} onClick={() => setTab('qa')}>
          Approved answers{qa.data ? ` (${qa.data.qa.length})` : ''}
        </button>
        <button role="tab" aria-selected={tab === 'reviews'} className={`tab ${tab === 'reviews' ? 'active' : ''}`} onClick={() => setTab('reviews')}>
          Review queue{pendingReviews.length ? ` (${pendingReviews.length})` : ''}
        </button>
      </div>

      {tab === 'docs' && (
        <>
          <div className="filters">
            <label>
              Department
              <select value={dept} onChange={(e) => setDept(e.target.value)}>
                <option value="all">All</option>
                {RAG_DEPARTMENTS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Status
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="all">All</option>
                <option value="pending_review">Pending review</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="archived">Archived</option>
              </select>
            </label>
          </div>
          {docs.loading ? (
            <Spinner label="Loading documents…" />
          ) : docs.error ? (
            <ErrorBox title="Could not load documents" message={(docs.error as any).message || String(docs.error)} onRetry={() => docs.reload()} />
          ) : !docs.data?.documents.length ? (
            <Empty message="No documents match these filters." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Department</th>
                    <th>Status</th>
                    <th>Version</th>
                    <th>Updated</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {docs.data.documents.map((d) => (
                    <tr key={d.document_id}>
                      <td>
                        <button className="link-btn" onClick={() => void openPreview(d)}>
                          {d.title}
                        </button>
                        <small className="cell-sub">
                          {SOURCE_TYPE_TEXT[d.source_type] ?? d.source_type} · by {d.created_by}
                        </small>
                      </td>
                      <td>{d.department}</td>
                      <td>
                        <Badge variant={STATUS_TONE[d.approved_status] ?? 'neutral'}>{STATUS_TEXT[d.approved_status] ?? d.approved_status}</Badge>
                      </td>
                      <td>v{d.version}</td>
                      <td>{fmtDate(d.updated_at || d.created_at)}</td>
                      <td>
                        <div className="row-end nowrap">
                          {d.approved_status === 'pending_review' && (
                            <>
                              <Button size="small" variant="primary" disabled={busyId === d.document_id} onClick={() => void changeStatus(d, 'approve')}>
                                Approve
                              </Button>
                              <Button size="small" disabled={busyId === d.document_id} onClick={() => void changeStatus(d, 'reject')}>
                                Reject
                              </Button>
                            </>
                          )}
                          {d.approved_status === 'approved' && (
                            <Button size="small" disabled={busyId === d.document_id} onClick={() => void changeStatus(d, 'archive')}>
                              Archive
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'qa' &&
        (qa.loading ? (
          <Spinner label="Loading approved answers…" />
        ) : qa.error ? (
          <ErrorBox title="Could not load approved answers" message={(qa.error as any).message || String(qa.error)} onRetry={() => qa.reload()} />
        ) : !qa.data?.qa.length ? (
          <Empty message="No approved answers yet." />
        ) : (
          <div className="stack">
            {qa.data.qa.map((q) => (
              <Card key={q.response_id}>
                <div className="meta-row">
                  <Badge variant={STATUS_TONE[q.approved_status] ?? 'neutral'}>{STATUS_TEXT[q.approved_status] ?? q.approved_status}</Badge>
                  <Badge tone="primary">{q.department}</Badge>
                  <span className="muted-sm">
                    by {q.created_by} · {fmtDate(q.created_at)}
                  </span>
                </div>
                <strong className="qa-q">{q.question}</strong>
                <Markdown text={q.answer} className="qa-a" />
              </Card>
            ))}
          </div>
        ))}

      {tab === 'reviews' &&
        (reviews.loading ? (
          <Spinner label="Loading review queue…" />
        ) : reviews.error ? (
          <ErrorBox title="Could not load the review queue" message={(reviews.error as any).message || String(reviews.error)} onRetry={() => reviews.reload()} />
        ) : !(reviews.data?.reviews ?? []).length ? (
          <Empty message="No feedback waiting for review." />
        ) : (
          <div className="stack">
            <p className="muted-sm" style={{ margin: 0 }}>
              Users’ corrections are never used until approved. Approving saves the (edited) correction as an approved answer for this company only.
            </p>
            {(reviews.data?.reviews ?? []).map((r) => {
              const pending = r.review_status === 'pending';
              return (
                <Card key={r.message_id}>
                  <div className="meta-row">
                    <Badge variant={STATUS_TONE[r.review_status] ?? 'neutral'}>{r.review_status === 'approved' ? 'Approved as answer' : STATUS_TEXT[r.review_status] ?? r.review_status}</Badge>
                    {r.feedback && <Badge variant={r.feedback === 'helpful' ? 'success' : 'danger'}>{r.feedback === 'helpful' ? 'Helpful' : 'Not helpful'}</Badge>}
                    <span className="muted-sm">
                      {r.user_name || r.user_email} · {fmtDate(r.created_at)}
                    </span>
                  </div>
                  <strong className="qa-q">{r.question}</strong>
                  {r.feedback_comment && <p className="review-comment">“{r.feedback_comment}”</p>}
                  {r.proposed_correction && (
                    <div className="review-correction">
                      <span className="label">Proposed correction</span>
                      <Markdown text={r.proposed_correction} />
                    </div>
                  )}
                  <details className="how">
                    <summary>Original answer</summary>
                    <Markdown text={r.answer} />
                  </details>
                  {pending && (
                    <div className="row-end" style={{ marginTop: 10 }}>
                      <Button size="small" disabled={busyId === r.message_id} onClick={() => void rejectReview(r)}>
                        Reject
                      </Button>
                      {r.proposed_correction && (
                        <Button size="small" variant="primary" disabled={busyId === r.message_id} onClick={() => promote(r)}>
                          Review & approve as answer…
                        </Button>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        ))}

      {docForm && (
        <div className="modal-backdrop" onClick={() => !saving && setDocForm(null)}>
          <form className="modal form-modal" role="dialog" aria-modal="true" aria-label="Add document" onClick={(e) => e.stopPropagation()} onSubmit={saveDoc}>
            <h2>Add document</h2>
            <label>
              Title
              <input required minLength={2} maxLength={200} value={docForm.title} onChange={(e) => setDocForm({ ...docForm, title: e.target.value })} placeholder="e.g. Returned goods inspection procedure" />
            </label>
            <div className="grid cols-2">
              <label>
                Department
                <select value={docForm.department} onChange={(e) => setDocForm({ ...docForm, department: e.target.value })}>
                  {RAG_DEPARTMENTS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Type
                <select value={docForm.sourceType} onChange={(e) => setDocForm({ ...docForm, sourceType: e.target.value })}>
                  <option value="sop">SOP</option>
                  <option value="workflow">Workflow</option>
                  <option value="policy">Policy</option>
                  <option value="platform_doc">Platform doc</option>
                </select>
              </label>
            </div>
            <label>
              Content (Markdown: use ## headings and numbered steps)
              <textarea required minLength={10} rows={10} className="mono" value={docForm.content} onChange={(e) => setDocForm({ ...docForm, content: e.target.value })} placeholder={'## Section\n1. First step\n2. Second step'} />
            </label>
            <div className="row-end">
              <Button onClick={() => setDocForm(null)} disabled={saving}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save & index'}
              </Button>
            </div>
          </form>
        </div>
      )}

      {qaForm && (
        <div className="modal-backdrop" onClick={() => !saving && setQaForm(null)}>
          <form className="modal form-modal" role="dialog" aria-modal="true" aria-label="Add approved answer" onClick={(e) => e.stopPropagation()} onSubmit={saveQa}>
            <h2>{qaForm.fromReview ? 'Approve correction as answer' : 'Add approved answer'}</h2>
            {qaForm.fromReview && <p className="muted-sm">Check and edit the wording before saving — it will be used for future answers in this company.</p>}
            <label>
              Question
              <input required minLength={3} maxLength={500} value={qaForm.question} onChange={(e) => setQaForm({ ...qaForm, question: e.target.value })} />
            </label>
            <label>
              Department
              <select value={qaForm.department} onChange={(e) => setQaForm({ ...qaForm, department: e.target.value })}>
                {RAG_DEPARTMENTS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Approved answer
              <textarea required minLength={5} maxLength={3000} rows={6} value={qaForm.answer} onChange={(e) => setQaForm({ ...qaForm, answer: e.target.value })} />
            </label>
            <div className="row-end">
              <Button onClick={() => setQaForm(null)} disabled={saving}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save approved answer'}
              </Button>
            </div>
          </form>
        </div>
      )}

      {preview?.doc && (
        <div className="modal-backdrop" onClick={() => setPreview(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label={preview.doc.title} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760 }}>
            <h2 style={{ margin: '0 0 6px' }}>{preview.doc.title}</h2>
            <div className="meta-row">
              <Badge variant={STATUS_TONE[preview.doc.approved_status] ?? 'neutral'}>{STATUS_TEXT[preview.doc.approved_status] ?? preview.doc.approved_status}</Badge>
              <span className="muted-sm">
                v{preview.doc.version} · {preview.doc.department} · {SOURCE_TYPE_TEXT[preview.doc.source_type] ?? preview.doc.source_type}
                {preview.doc.approved_by && ` · ${preview.doc.approved_status === 'approved' ? 'approved' : 'updated'} by ${preview.doc.approved_by} on ${fmtDate(preview.doc.approved_at)}`}
              </span>
            </div>
            <div className="source-body">
              {preview.loading ? (
                <Spinner label="Loading…" />
              ) : preview.error ? (
                <p className="field-error">{preview.error}</p>
              ) : preview.doc.chunks?.length ? (
                <>
                  <p className="muted-sm">Indexed as {preview.doc.chunks.length} searchable section{preview.doc.chunks.length === 1 ? '' : 's'}:</p>
                  {preview.doc.chunks.map((ch) => (
                    <section key={ch.chunk_id} className="chunk">
                      <span className="chunk-no">#{ch.chunk_index + 1}</span>
                      {ch.section_heading && <h4>{ch.section_heading}</h4>}
                      <Markdown text={stripLeadingHeading(ch.text, ch.section_heading)} />
                    </section>
                  ))}
                </>
              ) : (
                <Markdown text={preview.doc.content || ''} />
              )}
            </div>
            <div className="row-end" style={{ marginTop: 14 }}>
              <Button onClick={() => setPreview(null)}>Close</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
