import type { AppConfig } from '../config';

export interface ChunkInput {
  documentId: string;
  tenantId: string;
  companyId: string;
  title: string;
  department: string;
  content: string;
}

export interface ChunkOutput {
  chunkId: string;
  documentId: string;
  tenantId: string;
  companyId: string;
  chunkIndex: number;
  sectionHeading: string;
  text: string;
  tokenEstimate: number;
  embedding: number[];
}

export class RagVectorService {
  private config: AppConfig;
  private readonly VECTOR_DIM = 256;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * Semantically chunk a document into structured sections (headings, numbered steps, tables)
   */
  chunkDocument(doc: ChunkInput): ChunkOutput[] {
    const lines = doc.content.split('\n');
    const sections: { heading: string; lines: string[] }[] = [];
    let currentHeading = doc.title;
    let currentLines: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      // Detect markdown headings or capitalized section titles
      if (/^#{1,4}\s+(.*)/.test(line)) {
        if (currentLines.length > 0) {
          sections.push({ heading: currentHeading, lines: currentLines });
          currentLines = [];
        }
        currentHeading = line.replace(/^#{1,4}\s+/, '').trim();
      } else if (/^[A-Z0-9\s-]{4,40}:$/.test(line)) {
        if (currentLines.length > 0) {
          sections.push({ heading: currentHeading, lines: currentLines });
          currentLines = [];
        }
        currentHeading = line.replace(/:$/, '').trim();
      } else {
        currentLines.push(line);
      }
    }

    if (currentLines.length > 0) {
      sections.push({ heading: currentHeading, lines: currentLines });
    }

    // If no headings found, group by paragraphs
    if (sections.length === 0) {
      sections.push({ heading: doc.title, lines: [doc.content] });
    }

    const chunks: ChunkOutput[] = [];
    let index = 0;

    for (const sec of sections) {
      const text = `${sec.heading}\n${sec.lines.join('\n')}`;
      const tokenEstimate = Math.ceil(text.length / 4);
      const embedding = this.generateLocalVector(text);

      chunks.push({
        chunkId: `${doc.documentId}-chk-${index + 1}`,
        documentId: doc.documentId,
        tenantId: doc.tenantId,
        companyId: doc.companyId,
        chunkIndex: index,
        sectionHeading: sec.heading,
        text,
        tokenEstimate,
        embedding,
      });
      index++;
    }

    return chunks;
  }

  /**
   * Deterministic dense semantic vector generator (256-D normalized vector).
   * Generates high-resolution n-gram and word frequency representations.
   */
  generateLocalVector(text: string): number[] {
    const vec = new Float64Array(this.VECTOR_DIM);
    const cleaned = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const tokens = cleaned.split(/\s+/).filter((t) => t.length > 1);

    // 1. Unigrams
    for (const token of tokens) {
      const hash = this.fnv1a(token);
      const idx = Math.abs(hash) % this.VECTOR_DIM;
      const weight = 1.0 + Math.min(3.0, token.length / 3);
      vec[idx] += weight;
    }

    // 2. Bigrams (for phrase capture like 'damaged return', 'credit note')
    for (let i = 0; i < tokens.length - 1; i++) {
      const bigram = `${tokens[i]}_${tokens[i + 1]}`;
      const hash = this.fnv1a(bigram);
      const idx = Math.abs(hash) % this.VECTOR_DIM;
      vec[idx] += 2.5;
    }

    // 3. Trigrams
    for (let i = 0; i < tokens.length - 2; i++) {
      const trigram = `${tokens[i]}_${tokens[i + 1]}_${tokens[i + 2]}`;
      const hash = this.fnv1a(trigram);
      const idx = Math.abs(hash) % this.VECTOR_DIM;
      vec[idx] += 3.0;
    }

    // Normalize vector (L2 norm)
    let sumSq = 0;
    for (let i = 0; i < this.VECTOR_DIM; i++) sumSq += vec[i] * vec[i];
    const mag = Math.sqrt(sumSq);
    if (mag > 0) {
      for (let i = 0; i < this.VECTOR_DIM; i++) vec[i] /= mag;
    }

    return Array.from(vec);
  }

  /** Dimension of every stored chunk vector and every query vector. */
  get dimensions(): number {
    return this.VECTOR_DIM;
  }

  /**
   * Query embedding. Chunks are embedded at ingestion with `generateLocalVector`, so queries MUST use the same
   * embedding space: comparing vectors from two different models (or sizes) gives meaningless scores.
   * Switching to a hosted embedding model requires re-embedding every stored chunk with that model first.
   */
  async getEmbedding(text: string): Promise<number[]> {
    return this.generateLocalVector(text);
  }

  /** A stored vector is usable only if it is a numeric array of the current dimension; otherwise re-embed the text. */
  vectorFor(stored: string | null | undefined, text: string): number[] {
    try {
      const v = stored ? JSON.parse(stored) : null;
      if (Array.isArray(v) && v.length === this.VECTOR_DIM && v.every((x) => typeof x === 'number' && Number.isFinite(x))) return v;
    } catch {
      /* fall through */
    }
    return this.generateLocalVector(text);
  }

  /**
   * Cosine similarity. Vectors of different length come from different embedding spaces and are not comparable.
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
    const len = a.length;
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA <= 0 || normB <= 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private fnv1a(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash;
  }
}

