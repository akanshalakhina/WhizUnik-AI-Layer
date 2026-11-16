import type { Db } from '../types';
import type { NlpAnalysisResult } from './rag-nlp.service';
import type { RagVectorService } from './rag-vector.service';

export interface RetrievedCandidate {
  sourceType: 'workflow' | 'sop' | 'stored_response' | 'platform_data';
  sourceId: string;
  documentId: string;
  title: string;
  department: string;
  version: number;
  sectionHeading?: string;
  content: string;
  score: number;
  /** For stored answers: the approved documents the answer was derived from. */
  sourceDocumentIds?: string[];
  /** True for a document section included only because a matching approved answer was derived from it. */
  supporting?: boolean;
}

export interface RetrievalResult {
  hasSufficientEvidence: boolean;
  candidates: RetrievedCandidate[];
  topConfidence: number;
}

export class RagRetrievalService {
  private db: Db;
  private vectorService: RagVectorService;
  private readonly MIN_CONFIDENCE_THRESHOLD = 0.45;

  constructor(db: Db, vectorService: RagVectorService) {
    this.db = db;
    this.vectorService = vectorService;
  }

  /**
   * Tenant-isolated retrieval.
   * STRICT ENFORCEMENT: Only records matching authenticated tenantId AND companyId,
   * approvedStatus = 'approved', and isDeleted = 0 are ever considered.
   */
  async retrieve(
    tenantId: string,
    companyId: string,
    question: string,
    nlp: NlpAnalysisResult,
  ): Promise<RetrievalResult> {
    const candidates: RetrievedCandidate[] = [];
    const queryVec = await this.vectorService.getEmbedding(question);

    // 1. Retrieve approved company chunks (Filter-before-retrieval)
    const chunkRows = this.db
      .prepare(`
        SELECT c.chunk_id, c.document_id, c.chunk_index, c.section_heading, c.text, c.embedding,
               d.title, d.department, d.version, d.source_type
        FROM rag_chunks c
        JOIN rag_documents d ON d.document_id = c.document_id
        WHERE c.tenant_id = ?
          AND c.company_id = ?
          AND c.approved_status = 'approved'
          AND c.is_deleted = 0
          AND d.approved_status = 'approved'
          AND d.is_deleted = 0
      `)
      .all(tenantId, companyId) as {
      chunk_id: string;
      document_id: string;
      chunk_index: number;
      section_heading: string;
      text: string;
      embedding: string;
      title: string;
      department: string;
      version: number;
      source_type: string;
    }[];

    // Best-scoring section of every approved document, even below the threshold: used to cite the source
    // document behind a matching approved answer.
    const bestChunksByDoc = new Map<string, RetrievedCandidate[]>();

    for (const row of chunkRows) {
      const vec = this.vectorService.vectorFor(row.embedding, row.text);

      const cosineSim = this.vectorService.cosineSimilarity(queryVec, vec);
      const textLower = row.text.toLowerCase();
      const titleLower = row.title.toLowerCase();

      // Entity / Keyword match calculation
      let keywordHits = 0;
      for (const kw of nlp.keywords) {
        if (textLower.includes(kw) || titleLower.includes(kw)) {
          keywordHits++;
        }
      }
      const keywordRatio = nlp.keywords.length > 0 ? keywordHits / nlp.keywords.length : 0;

      // Only boost if there is genuine semantic AND keyword alignment
      let deptBoost = 0;
      let intentBoost = 0;
      if (cosineSim >= 0.35 && keywordRatio >= 0.40) {
        if (row.department.toLowerCase() === nlp.department.toLowerCase()) {
          deptBoost = 0.10;
        }

        if (nlp.intent === 'damaged_return' && (textLower.includes('damaged') || textLower.includes('scrap') || textLower.includes('quarantine'))) {
          intentBoost = 0.15;
        } else if (nlp.intent === 'gst_display' && (textLower.includes('gst') || textLower.includes('cgst') || textLower.includes('igst'))) {
          intentBoost = 0.15;
        } else if (nlp.intent === 'credit_note_linkage' && textLower.includes('credit note')) {
          intentBoost = 0.15;
        } else if (nlp.intent === 'tally_sync_status' && textLower.includes('tally')) {
          intentBoost = 0.15;
        } else if (nlp.intent === 'create_grn' && (textLower.includes('grn') || textLower.includes('goods receipt note'))) {
          intentBoost = 0.15;
        } else if (nlp.intent === 'stock_reservation' && textLower.includes('reserv')) {
          intentBoost = 0.15;
        } else if (nlp.intent === 'marketplace_order' && textLower.includes('marketplace')) {
          intentBoost = 0.15;
        }
      }

      const compositeScore = Math.min(1.0, cosineSim * 0.55 + keywordRatio * 0.45 + deptBoost + intentBoost);
      const candidate: RetrievedCandidate = {
        sourceType: row.source_type as RetrievedCandidate['sourceType'],
        sourceId: row.chunk_id,
        documentId: row.document_id,
        title: row.title,
        department: row.department,
        version: row.version,
        sectionHeading: row.section_heading,
        content: row.text,
        score: compositeScore,
      };
      const top = [...(bestChunksByDoc.get(row.document_id) ?? []), candidate].sort((a, b) => b.score - a.score).slice(0, 2);
      bestChunksByDoc.set(row.document_id, top);

      if (compositeScore >= this.MIN_CONFIDENCE_THRESHOLD && (cosineSim >= 0.32 || keywordRatio >= 0.50)) {
        candidates.push(candidate);
      }
    }

    // 2. Retrieve approved company stored responses (Filter-before-retrieval)
    const storedRows = this.db
      .prepare(`
        SELECT response_id, question, answer, department, source_document_ids
        FROM rag_stored_responses
        WHERE tenant_id = ?
          AND company_id = ?
          AND approved_status = 'approved'
      `)
      .all(tenantId, companyId) as {
      response_id: string;
      question: string;
      answer: string;
      department: string;
      source_document_ids: string;
    }[];

    for (const s of storedRows) {
      const qVec = this.vectorService.generateLocalVector(s.question);
      const cosineSim = this.vectorService.cosineSimilarity(queryVec, qVec);
      const qLower = s.question.toLowerCase();
      let matchCount = 0;
      for (const kw of nlp.keywords) {
        if (qLower.includes(kw)) matchCount++;
      }
      const kwRatio = nlp.keywords.length > 0 ? matchCount / nlp.keywords.length : 0;
      const score = Math.min(1.0, cosineSim * 0.6 + kwRatio * 0.4);

      if (score >= this.MIN_CONFIDENCE_THRESHOLD && (cosineSim >= 0.35 || kwRatio >= 0.45)) {
        let sourceIds: string[] = [];
        try {
          const parsed = JSON.parse(s.source_document_ids);
          if (Array.isArray(parsed)) sourceIds = parsed.filter((x) => typeof x === 'string' && x);
        } catch {
          /* no sources */
        }

        // A stored answer derived from documents is only valid while ALL of those documents are still approved
        // and not deleted in THIS company. Otherwise it may describe a superseded procedure.
        if (sourceIds.length > 0) {
          const placeholders = sourceIds.map(() => '?').join(',');
          const active = (this.db
            .prepare(`SELECT COUNT(*) AS n FROM rag_documents
                      WHERE company_id = ? AND tenant_id = ? AND is_deleted = 0 AND approved_status = 'approved'
                        AND document_id IN (${placeholders})`)
            .get(companyId, tenantId, ...sourceIds) as { n: number }).n;
          if (active !== new Set(sourceIds).size) continue;
        }

        candidates.push({
          sourceType: 'stored_response',
          sourceId: s.response_id,
          // Cite the stored answer itself; its source documents are listed separately.
          documentId: s.response_id,
          title: `Approved answer: ${s.question}`,
          department: s.department,
          version: 1,
          sectionHeading: 'Approved Answer',
          content: s.answer,
          score: Math.min(1, score),
          sourceDocumentIds: sourceIds,
        });
      }
    }

    // An approved answer is derived from approved documents: bring its source document's best section into the
    // evidence (if it is not already there) so the original procedure is cited alongside the stored answer.
    for (const s of candidates.filter((c) => c.sourceType === 'stored_response')) {
      for (const docId of s.sourceDocumentIds ?? []) {
        if (candidates.some((c) => c.documentId === docId)) continue;
        for (const best of bestChunksByDoc.get(docId) ?? []) {
          candidates.push({ ...best, score: Math.min(1, s.score * 0.95), supporting: true });
        }
      }
    }

    // Specification retrieval order: company documents (workflows, SOPs, policies…) first, then previously approved
    // answers. Within each group, by score. At most 2 sections per document so one long document cannot crowd out
    // the others; one of the 5 slots is kept for the best matching approved answer when there is one.
    const byScore = (a: RetrievedCandidate, b: RetrievedCandidate) => b.score - a.score;
    const docs = candidates.filter((c) => c.sourceType !== 'stored_response').sort(byScore);
    const stored = candidates.filter((c) => c.sourceType === 'stored_response').sort(byScore);
    const perDoc = new Map<string, number>();
    const pickedDocs: RetrievedCandidate[] = [];
    for (const c of docs) {
      const n = perDoc.get(c.documentId) ?? 0;
      if (n >= 2) continue;
      perDoc.set(c.documentId, n + 1);
      pickedDocs.push(c);
    }
    const docSlots = stored.length > 0 ? 4 : 5;
    const topCandidates = [...pickedDocs.slice(0, docSlots), ...stored.slice(0, 5 - Math.min(pickedDocs.length, docSlots))].slice(0, 5);
    const topConfidence = topCandidates.reduce((m, c) => Math.max(m, Math.min(1, c.score)), 0);

    return {
      hasSufficientEvidence: topCandidates.length > 0 && topConfidence >= this.MIN_CONFIDENCE_THRESHOLD,
      candidates: topCandidates,
      topConfidence: Math.round(topConfidence * 100) / 100,
    };
  }
}
