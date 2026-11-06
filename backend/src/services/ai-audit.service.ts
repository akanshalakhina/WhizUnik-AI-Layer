import type { Db } from '../types';

/**
 * AI audit log (spec Task 10). Records who asked, for which client, the
 * question CATEGORY (not the question text), the data tools used, the model,
 * status, processing time and token usage. It never stores API keys, tokens or
 * the raw question/answer.
 */
export interface AuditEntry {
  requestId: string;
  now: Date;
  clientId: number;
  userId: number;
  role: string;
  category: string | null;
  toolsUsed: string[];
  model: string | null;
  provider: string | null;
  status: string;
  processingMs: number;
  inputTokens: number;
  outputTokens: number;
  estCostInr: number;
  flags: string[];
}

export function recordAudit(db: Db, e: AuditEntry): void {
  db.prepare(
    `INSERT INTO ai_audit_log (request_id, created_at, client_id, user_id, role, category, tools_used, model, provider, status, processing_ms, input_tokens, output_tokens, est_cost_inr, flags)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    e.requestId,
    e.now.toISOString(),
    e.clientId,
    e.userId,
    e.role,
    e.category,
    JSON.stringify(e.toolsUsed),
    e.model,
    e.provider,
    e.status,
    Math.round(e.processingMs),
    e.inputTokens,
    e.outputTokens,
    e.estCostInr,
    JSON.stringify(e.flags),
  );
}

export function listAudit(db: Db, clientId: number, limit = 100) {
  const rows = db
    .prepare(
      `SELECT a.id, a.request_id AS requestId, a.created_at AS createdAt, usr.name AS user, a.role, a.category,
              a.tools_used AS toolsUsed, a.model, a.provider, a.status, a.processing_ms AS processingMs,
              a.input_tokens AS inputTokens, a.output_tokens AS outputTokens, a.est_cost_inr AS costInr, a.flags
         FROM ai_audit_log a JOIN users usr ON usr.id = a.user_id
        WHERE a.client_id = ? ORDER BY a.id DESC LIMIT ?`,
    )
    .all(clientId, Math.min(Math.max(limit, 1), 500)) as (Record<string, unknown> & { toolsUsed: string; flags: string })[];
  return rows.map((r) => ({ ...r, toolsUsed: JSON.parse(r.toolsUsed) as string[], flags: JSON.parse(r.flags) as string[] }));
}

// ------------------------------------------------------------------ history

export function saveHistory(
  db: Db,
  h: { clientId: number; userId: number; requestId: string; now: Date; question: string; category: string | null; status: string; response: unknown },
): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO ai_history (client_id, user_id, request_id, created_at, question, category, status, response_json) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(h.clientId, h.userId, h.requestId, h.now.toISOString(), h.question.slice(0, 500), h.category, h.status, JSON.stringify(h.response)).lastInsertRowid,
  );
  // Keep the most recent 50 entries per user.
  db.prepare(
    `DELETE FROM ai_history WHERE user_id = ? AND client_id = ? AND id NOT IN (
       SELECT id FROM ai_history WHERE user_id = ? AND client_id = ? ORDER BY id DESC LIMIT 50)`,
  ).run(h.userId, h.clientId, h.userId, h.clientId);
  return id;
}

export function listHistory(db: Db, clientId: number, userId: number, limit = 30) {
  return db
    .prepare(
      `SELECT id, created_at AS createdAt, question, category, status FROM ai_history
        WHERE client_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(clientId, userId, Math.min(Math.max(limit, 1), 50));
}

export function getHistoryEntry(db: Db, clientId: number, userId: number, id: number) {
  const r = db
    .prepare(`SELECT id, created_at AS createdAt, question, category, status, response_json AS response FROM ai_history WHERE id = ? AND client_id = ? AND user_id = ?`)
    .get(id, clientId, userId) as { id: number; createdAt: string; question: string; category: string | null; status: string; response: string } | undefined;
  return r ? { ...r, response: JSON.parse(r.response) as unknown } : null;
}

export function clearHistory(db: Db, clientId: number, userId: number): number {
  return db.prepare('DELETE FROM ai_history WHERE client_id = ? AND user_id = ?').run(clientId, userId).changes;
}
