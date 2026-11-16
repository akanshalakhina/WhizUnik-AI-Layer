import type { RagCitation, Role } from './types';

export const RAG_DEPARTMENTS = [
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

/**
 * Knowledge Admin / Company Admin / Auditor screens (RAG spec §2) are shown to the management role only.
 * This is a UI convenience: the server remains the authority for what each user may do.
 */
export function isKnowledgeAdmin(role: Role | undefined): boolean {
  return role === 'management';
}

/** Retrieval confidence as a 0–100 integer (the API can return values slightly above 1). */
export function confidencePct(c: number | null | undefined): number {
  const v = Number(c);
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.min(1, Math.max(0, v)) * 100);
}

export function confidenceLabel(pct: number): { text: string; tone: 'green' | 'amber' | 'grey' } {
  if (pct >= 75) return { text: 'High', tone: 'green' };
  if (pct >= 50) return { text: 'Medium', tone: 'amber' };
  return { text: 'Low', tone: 'grey' };
}

/** One entry per cited document (the API returns one citation per retrieved chunk). */
export function groupCitations(citations: RagCitation[]): (RagCitation & { sections: string[] })[] {
  const byDoc = new Map<string, RagCitation & { sections: string[] }>();
  for (const c of citations ?? []) {
    const key = `${c.documentId}|${c.version}|${c.title}`;
    const cur = byDoc.get(key);
    const section = c.section?.trim();
    if (!cur) byDoc.set(key, { ...c, sections: section ? [section] : [] });
    else if (section && !cur.sections.includes(section)) cur.sections.push(section);
  }
  return [...byDoc.values()];
}

/** Chunk text often repeats its section heading as the first line; drop it when the heading is shown separately. */
export function stripLeadingHeading(text: string, heading?: string | null): string {
  if (!heading) return text;
  const lines = (text ?? '').split('\n');
  const first = (lines[0] ?? '').replace(/^#+\s*/, '').trim().toLowerCase();
  return first === heading.trim().toLowerCase() ? lines.slice(1).join('\n').replace(/^\s+/, '') : text;
}

export const STATUS_LABEL: Record<string, string> = {
  grounded: 'Answered from company knowledge',
  insufficient_evidence: 'No approved answer found',
  clarification_needed: 'Clarification needed',
};
