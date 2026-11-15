/**
 * Thin fetch wrapper. The browser only ever holds the user's session token;
 * the AI provider API key exists solely on the server.
 */
const BASE: string = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
const TOKEN_KEY = 'wz_token';

let token: string | null = null;
try {
  token = localStorage.getItem(TOKEN_KEY);
} catch {
  token = null;
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

export function setToken(next: string | null) {
  token = next;
  try {
    if (next) localStorage.setItem(TOKEN_KEY, next);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode): the session just won't persist */
  }
}

export function hasToken(): boolean {
  return token !== null;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body: any,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'Could not reach the WhizUnik server. Check your connection and try again.', null);
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = body?.error;
    if (res.status === 401 && path !== '/api/auth/login') onUnauthorized?.();
    throw new ApiError(res.status, err?.code ?? 'ERROR', err?.message ?? `Request failed (${res.status}).`, body);
  }
  return body as T;
}

// ------------------------------------------------------------- RAG API Client Helpers
export function askRagAssistant(question: string, department?: string, conversationId?: string) {
  return api<import('./types').RagAskResponse>('/api/v1/assistant/ask', {
    method: 'POST',
    body: { question, department, conversationId },
  });
}

export function submitRagFeedback(opts: {
  messageId: string;
  feedback: 'helpful' | 'not_helpful';
  comment?: string;
  proposedCorrection?: string;
}) {
  return api<{ success: boolean; reviewStatus: string }>('/api/v1/assistant/feedback', {
    method: 'POST',
    body: opts,
  });
}

export function getRagDocuments(department?: string, status?: string) {
  const params = new URLSearchParams();
  if (department && department !== 'all') params.set('department', department);
  if (status && status !== 'all') params.set('status', status);
  const q = params.toString();
  return api<{ documents: import('./types').RagDocument[] }>(`/api/v1/knowledge/documents${q ? '?' + q : ''}`);
}

export function getRagDocument(id: string) {
  return api<{ document: import('./types').RagDocument }>(`/api/v1/knowledge/documents/${id}`);
}

export function createRagDocument(doc: {
  title: string;
  description?: string;
  department: string;
  content: string;
  sourceType?: string;
}) {
  return api<{ documentId: string }>('/api/v1/knowledge/documents', {
    method: 'POST',
    body: doc,
  });
}

export function approveRagDocument(id: string) {
  return api<{ success: boolean }>(`/api/v1/knowledge/documents/${id}/approve`, { method: 'POST' });
}

export function rejectRagDocument(id: string) {
  return api<{ success: boolean }>(`/api/v1/knowledge/documents/${id}/reject`, { method: 'POST' });
}

export function archiveRagDocument(id: string) {
  return api<{ success: boolean }>(`/api/v1/knowledge/documents/${id}/archive`, { method: 'POST' });
}

export function getRagQa() {
  return api<{ qa: import('./types').RagStoredQa[] }>('/api/v1/knowledge/qa');
}

export function createRagQa(qa: { question: string; answer: string; department: string; sourceDocumentIds?: string[] }) {
  return api<{ responseId: string }>('/api/v1/knowledge/qa', {
    method: 'POST',
    body: qa,
  });
}

export function getRagAuditEvents() {
  return api<{ events: import('./types').RagAuditEvent[] }>('/api/v1/admin/audit-events');
}

