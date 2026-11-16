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

    for (const row of chunkRows) {
      let vec: number[] = [];
      try {
        vec = JSON.parse(row.embedding);
      } catch {
        vec = this.vectorService.generateLocalVector(row.text);
      }

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

      if (compositeScore >= this.MIN_CONFIDENCE_THRESHOLD && (cosineSim >= 0.32 || keywordRatio >= 0.50)) {
        candidates.push({
          sourceType: row.source_type as any,
          sourceId: row.chunk_id,
          documentId: row.document_id,
          title: row.title,
          department: row.department,
          version: row.version,
          sectionHeading: row.section_heading,
          content: row.text,
          score: compositeScore,
        });
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
        let srcDocId = 'doc-approved-qa';
        try {
          const parsed = JSON.parse(s.source_document_ids);
          if (Array.isArray(parsed) && parsed[0]) srcDocId = parsed[0];
        } catch {}

        // If stored response cites a document, verify that source document is active and approved
        if (srcDocId !== 'doc-approved-qa') {
          const docRow = this.db
            .prepare('SELECT is_deleted, approved_status FROM rag_documents WHERE document_id = ?')
            .get(srcDocId) as { is_deleted: number; approved_status: string } | undefined;
          if (docRow && (docRow.is_deleted === 1 || docRow.approved_status !== 'approved')) {
            continue;
          }
        }

        candidates.push({
          sourceType: 'stored_response',
          sourceId: s.response_id,
          documentId: srcDocId,
          title: `Approved Q&A: ${s.question}`,
          department: s.department,
          version: 1,
          sectionHeading: 'Approved Answer',
          content: `${s.question}\nAnswer: ${s.answer}`,
          score: score + 0.1, // Stored approved answers receive slight precedence
        });
      }
    }

    // Sort descending by score
    candidates.sort((a, b) => b.score - a.score);

    // Limit to top 5 most relevant unique sections
    const topCandidates = candidates.slice(0, 5);
    const topConfidence = topCandidates.length > 0 ? topCandidates[0].score : 0;

    return {
      hasSufficientEvidence: topCandidates.length > 0 && topConfidence >= this.MIN_CONFIDENCE_THRESHOLD,
      candidates: topCandidates,
      topConfidence: Math.round(topConfidence * 100) / 100,
    };
  }
}
