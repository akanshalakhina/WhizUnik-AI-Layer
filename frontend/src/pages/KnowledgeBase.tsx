import { useState } from 'react';
import { approveRagDocument, archiveRagDocument, createRagDocument, createRagQa, getRagDocuments, getRagQa, rejectRagDocument } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Card, Empty, ErrorBox, Spinner } from '../components/ui';
import { useAsync } from '../hooks';
import type { RagDocument } from '../types';

const DEPARTMENTS = [
  'All',
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

export default function KnowledgeBase() {
  const { user } = useAuth();
  const [selectedDept, setSelectedDept] = useState('All');
  const [tab, setTab] = useState<'docs' | 'qa'>('docs');
  const [previewDoc, setPreviewDoc] = useState<RagDocument | null>(null);

  // Modals
  const [showAddDoc, setShowAddDoc] = useState(false);
  const [showAddQa, setShowAddQa] = useState(false);

  // Form states
  const [docTitle, setDocTitle] = useState('');
  const [docDept, setDocDept] = useState('Returns');
  const [docContent, setDocContent] = useState('');
  const [docType, setDocType] = useState('sop');

  const [qaQ, setQaQ] = useState('');
  const [qaA, setQaA] = useState('');
  const [qaDept, setQaDept] = useState('Returns');

  const docs = useAsync(() => getRagDocuments(selectedDept), [selectedDept, tab]);
  const qa = useAsync(() => getRagQa(), [tab]);

  const handleCreateDoc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!docTitle || !docContent) return;
    try {
      await createRagDocument({
        title: docTitle,
        department: docDept,
        content: docContent,
        sourceType: docType,
      });
      setShowAddDoc(false);
      setDocTitle('');
      setDocContent('');
      docs.reload();
    } catch (err: any) {
      alert(err.message || 'Failed to create document');
    }
  };

  const handleCreateQa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!qaQ || !qaA) return;
    try {
      await createRagQa({
        question: qaQ,
        answer: qaA,
        department: qaDept,
      });
      setShowAddQa(false);
      setQaQ('');
      setQaA('');
      qa.reload();
    } catch (err: any) {
      alert(err.message || 'Failed to create Q&A');
    }
  };

  const handleStatusChange = async (docId: string, action: 'approve' | 'reject' | 'archive') => {
    try {
      if (action === 'approve') await approveRagDocument(docId);
      else if (action === 'reject') await rejectRagDocument(docId);
      else if (action === 'archive') await archiveRagDocument(docId);
      docs.reload();
    } catch (err: any) {
      alert(err.message || 'Action failed');
    }
  };

  return (
    <div className="page">
      <header className="page-header" style={{ marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Knowledge Base Admin</h1>
          <p className="sub" style={{ margin: '4px 0 0', color: 'var(--muted)' }}>
            Manage approved company documents, SOPs, and verified Q&A for <strong>{user?.clientName}</strong>.
            All retrieval is strictly tenant-isolated before vector search.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Button variant="primary" onClick={() => setShowAddDoc(true)}>
            + Upload / Add Document
          </Button>
          <Button onClick={() => setShowAddQa(true)}>+ Add Verified Q&A</Button>
        </div>
      </header>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 12, borderBottom: '1px solid var(--border)', marginBottom: 20 }}>
        <button
          onClick={() => setTab('docs')}
          style={{
            background: 'none',
            border: 'none',
            borderBottom: tab === 'docs' ? '2px solid var(--primary)' : '2px solid transparent',
            color: tab === 'docs' ? 'var(--primary)' : 'var(--muted)',
            fontWeight: 700,
            padding: '8px 16px',
            cursor: 'pointer',
          }}
        >
          Company Documents & SOPs ({docs.data?.documents.length || 0})
        </button>
        <button
          onClick={() => setTab('qa')}
          style={{
            background: 'none',
            border: 'none',
            borderBottom: tab === 'qa' ? '2px solid var(--primary)' : '2px solid transparent',
            color: tab === 'qa' ? 'var(--primary)' : 'var(--muted)',
            fontWeight: 700,
            padding: '8px 16px',
            cursor: 'pointer',
          }}
        >
          Approved Stored Responses / Q&A ({qa.data?.qa.length || 0})
        </button>
      </div>

      {tab === 'docs' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>Filter by Department:</span>
            <select
              value={selectedDept}
              onChange={(e) => setSelectedDept(e.target.value)}
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--surface)',
              }}
            >
              {DEPARTMENTS.map((d) => (
                <option key={d} value={d === 'All' ? 'all' : d}>
                  {d}
                </option>
              ))}
            </select>
          </div>

          {docs.loading ? (
            <Spinner />
          ) : docs.error ? (
            <ErrorBox title="Error loading documents" message={(docs.error as any).message || String(docs.error)} onRetry={() => docs.reload()} />
          ) : !docs.data?.documents.length ? (
            <Empty message="No documents found for this department." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {docs.data.documents.map((d) => (
                <Card key={d.document_id}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <strong style={{ fontSize: 16 }}>{d.title}</strong>
                        <Badge
                          variant={
                            d.approved_status === 'approved'
                              ? 'success'
                              : d.approved_status === 'archived'
                              ? 'neutral'
                              : 'warning'
                          }
                        >
                          {d.approved_status.toUpperCase()}
                        </Badge>
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>v{d.version}</span>
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>• Dept: {d.department}</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                        Document ID: <code>{d.document_id}</code> • Type: {d.source_type} • Created by: {d.created_by} •{' '}
                        {new Date(d.created_at).toLocaleDateString()}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Button size="small" onClick={() => setPreviewDoc(d)}>
                        Preview Chunks
                      </Button>
                      {d.approved_status !== 'approved' && (
                        <Button size="small" variant="primary" onClick={() => handleStatusChange(d.document_id, 'approve')}>
                          Approve
                        </Button>
                      )}
                      {d.approved_status === 'approved' && (
                        <Button size="small" onClick={() => handleStatusChange(d.document_id, 'archive')}>
                          Archive
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'qa' && (
        <>
          {qa.loading ? (
            <Spinner />
          ) : qa.error ? (
            <ErrorBox title="Error loading Q&A" message={(qa.error as any).message || String(qa.error)} onRetry={() => qa.reload()} />
          ) : !qa.data?.qa.length ? (
            <Empty message="No verified Q&A records found." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {qa.data.qa.map((q) => (
                <Card key={q.response_id}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <strong style={{ fontSize: 15 }}>Q: {q.question}</strong>
                        <Badge variant="success">APPROVED</Badge>
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Dept: {q.department}</span>
                      </div>
                      <p style={{ margin: '6px 0', fontSize: 14, color: 'var(--text-2)' }}>
                        <strong>A:</strong> {q.answer}
                      </p>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                        Response ID: <code>{q.response_id}</code> • Created: {new Date(q.created_at).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {/* Add Document Modal */}
      {showAddDoc && (
        <div className="modal-backdrop" onClick={() => setShowAddDoc(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
            <h2 style={{ margin: '0 0 16px' }}>Add Knowledge Document / SOP</h2>
            <form onSubmit={handleCreateDoc}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Document Title</label>
                  <input
                    type="text"
                    required
                    value={docTitle}
                    onChange={(e) => setDocTitle(e.target.value)}
                    placeholder="e.g. Returned Goods Inspection Procedure"
                    style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)' }}
                  />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Department</label>
                    <select
                      value={docDept}
                      onChange={(e) => setDocDept(e.target.value)}
                      style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)' }}
                    >
                      {DEPARTMENTS.filter((d) => d !== 'All').map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Source Type</label>
                    <select
                      value={docType}
                      onChange={(e) => setDocType(e.target.value)}
                      style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)' }}
                    >
                      <option value="sop">SOP</option>
                      <option value="workflow">Workflow</option>
                      <option value="policy">Policy</option>
                      <option value="platform_doc">Platform Doc</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                    Document Content (Markdown / Text)
                  </label>
                  <textarea
                    required
                    rows={8}
                    value={docContent}
                    onChange={(e) => setDocContent(e.target.value)}
                    placeholder="Enter full workflow instructions, numbered steps, and procedures..."
                    style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', fontFamily: 'monospace' }}
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 }}>
                  <Button onClick={() => setShowAddDoc(false)}>Cancel</Button>
                  <Button variant="primary" type="submit">
                    Save and Index Document
                  </Button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Q&A Modal */}
      {showAddQa && (
        <div className="modal-backdrop" onClick={() => setShowAddQa(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 580 }}>
            <h2 style={{ margin: '0 0 16px' }}>Add Verified Question & Answer</h2>
            <form onSubmit={handleCreateQa}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Question</label>
                  <input
                    type="text"
                    required
                    value={qaQ}
                    onChange={(e) => setQaQ(e.target.value)}
                    placeholder="e.g. How do we record a customer receipt?"
                    style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Department</label>
                  <select
                    value={qaDept}
                    onChange={(e) => setQaDept(e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)' }}
                  >
                    {DEPARTMENTS.filter((d) => d !== 'All').map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Approved Answer</label>
                  <textarea
                    required
                    rows={5}
                    value={qaA}
                    onChange={(e) => setQaA(e.target.value)}
                    placeholder="Enter the official, approved answer..."
                    style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)' }}
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 }}>
                  <Button onClick={() => setShowAddQa(false)}>Cancel</Button>
                  <Button variant="primary" type="submit">
                    Save Approved Answer
                  </Button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {previewDoc && (
        <div className="modal-backdrop" onClick={() => setPreviewDoc(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 700 }}>
            <h2 style={{ margin: '0 0 8px' }}>{previewDoc.title}</h2>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
              Document ID: <code>{previewDoc.document_id}</code> • Version: v{previewDoc.version} • Department: {previewDoc.department}
            </div>
            <div style={{ maxHeight: 380, overflowY: 'auto', background: 'var(--surface-2)', padding: 14, borderRadius: 8 }}>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 13 }}>{previewDoc.content || 'Content indexed in chunks.'}</pre>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <Button onClick={() => setPreviewDoc(null)}>Close</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
