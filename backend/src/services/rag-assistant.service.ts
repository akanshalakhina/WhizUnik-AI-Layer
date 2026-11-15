import crypto from 'node:crypto';
import type { AppConfig } from '../config';
import type { AuthUser, Db, RagAskResponse, RagCitation } from '../types';
import { RagLiveDataService } from './rag-live-data.service';
import { RagNlpService } from './rag-nlp.service';
import { RagGenerationService } from './rag-generation.service';
import { RagRetrievalService } from './rag-retrieval.service';
import { RagVectorService } from './rag-vector.service';

export interface RagAskOptions {
  question: string;
  conversationId?: string | null;
  departmentHint?: string;
}

export class RagAssistantService {
  private config: AppConfig;
  private db: Db;
  private nlpService: RagNlpService;
  private vectorService: RagVectorService;
  private retrievalService: RagRetrievalService;
  private liveDataService: RagLiveDataService;
  private generationService: RagGenerationService;

  constructor(config: AppConfig, db: Db) {
    this.config = config;
    this.db = db;
    this.nlpService = new RagNlpService();
    this.vectorService = new RagVectorService(config);
    this.retrievalService = new RagRetrievalService(db, this.vectorService);
    this.liveDataService = new RagLiveDataService(db);
    this.generationService = new RagGenerationService(config);
  }

  /**
   * Main Question-Answering Pipeline for WhizUnik AI RAG Application
   *
   * Flow:
   * 1. Resolve company & tenant strictly from authenticated user (never trust client)
   * 2. Analyze question with NLP (intent, department, entities)
   * 3. If live data requested: query authorized live platform tables
   * 4. Perform tenant-isolated retrieval over company workflows, SOPs & stored Q&A
   * 5. Generate grounded response with citations
   * 6. Save conversation, message & audit log
   */
  async ask(user: AuthUser, opts: RagAskOptions): Promise<RagAskResponse> {
    const question = (opts.question || '').trim();
    if (!question) {
      throw new Error('Question is required');
    }

    // 1. Resolve trusted tenant scope
    const companyId = user.companyId || `company-${user.clientId}`;
    const tenantId = user.tenantId || `tenant-${user.clientId}`;

    // Get company details
    const companyRow = this.db
      .prepare('SELECT name, industry FROM clients WHERE id = ?')
      .get(user.clientId) as { name: string; industry?: string } | undefined;
    const companyName = companyRow?.name || 'WhizUnik Enterprise';

    // 2. Question analysis using NLP
    const nlp = this.nlpService.analyze(question, opts.departmentHint);

    let conversationId = opts.conversationId;
    if (!conversationId) {
      conversationId = `conv-${crypto.randomUUID().slice(0, 8)}`;
      this.db
        .prepare(`
          INSERT INTO rag_conversations (conversation_id, tenant_id, company_id, user_id, title, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `)
        .run(conversationId, tenantId, companyId, user.id, question.slice(0, 60));
    }

    // 3. Check for Live Platform Data Query (e.g. supplier balance)
    if (nlp.intent === 'supplier_balance' && nlp.entities.supplier) {
      const liveData = this.liveDataService.getSupplierOutstanding(user.clientId, nlp.entities.supplier);
      if (liveData) {
        const messageId = `msg-${crypto.randomUUID().slice(0, 8)}`;
        const formattedTotal = liveData.totalDueInr.toLocaleString('en-IN', {
          style: 'currency',
          currency: 'INR',
          maximumFractionDigits: 0,
        });

        const invoiceDetails = liveData.invoices
          .map((inv) => `• Order/Invoice **${inv.invoiceRef}**: ${inv.amountInr.toLocaleString('en-IN', { style: 'currency', currency: 'INR' })} (Due: ${inv.dueDate}, Status: ${inv.status})`)
          .join('\n');

        const answer = `Based on current authorized finance records for **${liveData.supplierName}** (as of ${new Date(liveData.asOf).toLocaleDateString('en-IN')}):\n\n` +
          `• Total outstanding balance due: **${formattedTotal}** across **${liveData.invoiceCount}** order(s)/invoice(s).\n\n` +
          `${invoiceDetails}\n\n` +
          `*Data Source:* WhizUnik Accounts Payable & Purchase Orders ledger. Verified against active company finance permissions.`;

        const citations: RagCitation[] = [
          {
            documentId: 'live-finance-ap',
            title: 'Accounts Payable Ledger',
            department: 'Finance',
            version: 1,
            section: 'Supplier Balances',
            excerpt: `Live balance query for ${liveData.supplierName}`,
          },
        ];

        this.recordInteraction({
          messageId,
          conversationId,
          tenantId,
          companyId,
          userId: user.id,
          question,
          answer,
          intent: nlp.intent,
          department: nlp.department,
          retrievedSourceIds: citations.map((c) => c.documentId),
          confidence: 0.98,
          answerStatus: 'grounded',
          model: 'whizunik-live-ledger',
          inputTokens: 120,
          outputTokens: 110,
          costInr: 0,
          latencyMs: 15,
        });

        return {
          answer,
          answerStatus: 'grounded',
          citations,
          confidence: 0.98,
          intent: nlp.intent,
          department: nlp.department,
          entities: nlp.entities,
          clarificationQuestion: null,
          conversationId,
          messageId,
          model: 'whizunik-live-ledger',
          usage: {
            inputTokens: 120,
            outputTokens: 110,
            costInr: 0,
          },
        };
      }
    }

    // 4. Tenant-isolated RAG retrieval
    const retrieval = await this.retrievalService.retrieve(tenantId, companyId, question, nlp);

    // 5. Generate grounded response
    const gen = await this.generationService.generate(question, nlp, retrieval, companyName);
    const messageId = `msg-${crypto.randomUUID().slice(0, 8)}`;

    // 6. Record interaction in conversation messages & audit events
    this.recordInteraction({
      messageId,
      conversationId,
      tenantId,
      companyId,
      userId: user.id,
      question,
      answer: gen.answer,
      intent: nlp.intent,
      department: nlp.department,
      retrievedSourceIds: gen.citations.map((c) => c.documentId),
      confidence: gen.confidence,
      answerStatus: gen.answerStatus,
      clarificationQuestion: gen.clarificationQuestion,
      model: gen.model,
      inputTokens: gen.inputTokens,
      outputTokens: gen.outputTokens,
      costInr: gen.costInr,
      latencyMs: gen.latencyMs,
    });

    return {
      answer: gen.answer,
      answerStatus: gen.answerStatus,
      citations: gen.citations,
      confidence: gen.confidence,
      intent: nlp.intent,
      department: nlp.department,
      entities: nlp.entities,
      clarificationQuestion: gen.clarificationQuestion,
      conversationId,
      messageId,
      model: gen.model,
      usage: {
        inputTokens: gen.inputTokens,
        outputTokens: gen.outputTokens,
        costInr: gen.costInr,
      },
    };
  }

  /**
   * Submit feedback on an answer (helpful / not helpful, with optional comment and proposed correction)
   */
  submitFeedback(opts: {
    messageId: string;
    userId: number;
    feedback: 'helpful' | 'not_helpful';
    comment?: string;
    proposedCorrection?: string;
  }) {
    const msg = this.db
      .prepare('SELECT message_id, conversation_id, tenant_id, company_id FROM rag_messages WHERE message_id = ?')
      .get(opts.messageId) as { message_id: string; conversation_id: string; tenant_id: string; company_id: string } | undefined;

    if (!msg) {
      throw new Error('Message not found');
    }

    const reviewStatus = opts.proposedCorrection ? 'pending' : 'none';

    this.db
      .prepare(`
        UPDATE rag_messages
        SET feedback = ?, feedback_comment = ?, proposed_correction = ?, review_status = ?
        WHERE message_id = ?
      `)
      .run(opts.feedback, opts.comment || null, opts.proposedCorrection || null, reviewStatus, opts.messageId);

    // Update corresponding audit event
    this.db
      .prepare(`UPDATE rag_audit_events SET feedback = ? WHERE audit_id = ?`)
      .run(opts.feedback, opts.messageId);

    return { success: true, messageId: opts.messageId, reviewStatus };
  }

  /**
   * List conversations for a user
   */
  getConversations(userId: number, limit = 20) {
    return this.db
      .prepare(`
        SELECT conversation_id, title, created_at, updated_at
        FROM rag_conversations
        WHERE user_id = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(userId, limit);
  }

  /**
   * Get messages for a conversation
   */
  getConversationMessages(conversationId: string, userId: number) {
    return this.db
      .prepare(`
        SELECT message_id, question, answer, intent, department, retrieved_source_ids,
               confidence, answer_status, clarification_question, model, feedback, created_at
        FROM rag_messages
        WHERE conversation_id = ? AND user_id = ?
        ORDER BY created_at ASC
      `)
      .all(conversationId, userId);
  }

  private recordInteraction(data: {
    messageId: string;
    conversationId: string;
    tenantId: string;
    companyId: string;
    userId: number;
    question: string;
    answer: string;
    intent: string;
    department: string;
    retrievedSourceIds: string[];
    confidence: number;
    answerStatus: string;
    clarificationQuestion?: string | null;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costInr: number;
    latencyMs: number;
  }) {
    const sourceIdsJson = JSON.stringify(data.retrievedSourceIds);

    // 1. Insert message
    this.db
      .prepare(`
        INSERT INTO rag_messages (
          message_id, conversation_id, tenant_id, company_id, user_id,
          question, answer, intent, department, retrieved_source_ids,
          confidence, answer_status, clarification_question, model,
          input_tokens, output_tokens, cost_inr, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `)
      .run(
        data.messageId,
        data.conversationId,
        data.tenantId,
        data.companyId,
        data.userId,
        data.question,
        data.answer,
        data.intent,
        data.department,
        sourceIdsJson,
        data.confidence,
        data.answerStatus,
        data.clarificationQuestion || null,
        data.model,
        data.inputTokens,
        data.outputTokens,
        data.costInr,
        data.latencyMs,
      );

    // 2. Insert audit event
    this.db
      .prepare(`
        INSERT INTO rag_audit_events (
          audit_id, tenant_id, company_id, user_id, question, intent,
          department, retrieved_source_ids, answer_status, confidence,
          model, tokens_total, cost_inr, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `)
      .run(
        data.messageId,
        data.tenantId,
        data.companyId,
        data.userId,
        data.question,
        data.intent,
        data.department,
        sourceIdsJson,
        data.answerStatus,
        data.confidence,
        data.model,
        data.inputTokens + data.outputTokens,
        data.costInr,
        data.latencyMs,
      );

    // 3. Update conversation updated_at
    this.db
      .prepare(`UPDATE rag_conversations SET updated_at = datetime('now') WHERE conversation_id = ?`)
      .run(data.conversationId);
  }
}

