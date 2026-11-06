import { z } from 'zod';

/**
 * Safety rules for the AI layer (spec Task 11, Task 13, Phase 1 exclusions).
 * Everything here is deterministic code — it does not depend on the model
 * behaving well.
 */

// ---------------------------------------------------------------- questions

export type QuestionCheck = { ok: true; question: string } | { ok: false; message: string };

export function validateQuestion(input: unknown, maxChars: number): QuestionCheck {
  if (typeof input !== 'string') {
    return { ok: false, message: 'A "question" string is required.' };
  }
  // Remove control characters and collapse whitespace.
  const question = input.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (question.length < 3) {
    return { ok: false, message: 'Please enter a question of at least 3 characters.' };
  }
  if (question.length > maxChars) {
    return { ok: false, message: `The question is too long (maximum ${maxChars} characters).` };
  }
  if (!/[\p{L}\p{N}]/u.test(question)) {
    return { ok: false, message: 'The question must contain words or numbers.' };
  }
  return { ok: true, question };
}

export type ThreatId =
  | 'override_instructions'
  | 'reveal_prompt'
  | 'role_override'
  | 'special_tokens'
  | 'secret_request'
  | 'cross_tenant'
  | 'sql_injection'
  | 'data_dump';

const THREAT_PATTERNS: { id: ThreatId; re: RegExp }[] = [
  {
    id: 'override_instructions',
    re: /\b(ignore|disregard|forget|override|bypass|skip)\b[^.?!]{0,40}\b(previous|prior|above|earlier|all|any|your|the|these)\b[^.?!]{0,30}\b(instructions?|prompts?|rules?|guidelines?|polic(?:y|ies)|restrictions?|safeguards?|permissions?)\b/i,
  },
  {
    id: 'reveal_prompt',
    re: /\b(reveal|show|print|repeat|display|output|leak|tell me|what (?:is|are))\b[^.?!]{0,40}\b(system|hidden|initial|developer|original)\b[^.?!]{0,20}\b(prompt|instructions?|message)\b/i,
  },
  {
    id: 'role_override',
    re: /\b(you are now|pretend (?:to be|you are)|roleplay as|developer mode|jailbreak|do anything now|act as (?:an? )?(?:admin|root|system|unrestricted|different))\b|\bDAN\b/i,
  },
  { id: 'special_tokens', re: /<\|?\s*(system|im_start|im_end|assistant)\s*\|?>|\[\/?INST\]|^\s*#{2,}\s*(system|instructions?)\b/im },
  {
    id: 'secret_request',
    re: /\b(api[\s_-]?keys?|secret[\s_-]?keys?|access[\s_-]?tokens?|bearer[\s_-]?tokens?|private[\s_-]?keys?|jwt[\s_-]?secret|passwords?|\.env\b|connection[\s_-]?string)/i,
  },
  {
    id: 'cross_tenant',
    re: /\b(other|another|different|all)\s+(clients?|tenants?|compan(?:y|ies)|organi[sz]ations?)\b|\bclient[\s_-]?id\s*[=:]?\s*\d+/i,
  },
  {
    id: 'sql_injection',
    re: /\bunion\s+select\b|\bdrop\s+table\b|;\s*(?:drop|delete|update|insert|alter)\b|\bselect\b[\s\S]{0,60}\bfrom\b[\s\S]{0,40}\b(?:users|clients|ai_\w+|sqlite_master)\b|\bor\s+1\s*=\s*1\b/i,
  },
  {
    id: 'data_dump',
    re: /\b(dump|export|download|list|show)\b[^.?!]{0,30}\b(entire|whole|full|complete)\b[^.?!]{0,20}\b(database|tables?|users?|records)\b/i,
  },
];

/** Returns the threat ids matched. Any match means the question is refused without calling the provider. */
export function detectThreats(question: string): ThreatId[] {
  return THREAT_PATTERNS.filter((p) => p.re.test(question)).map((p) => p.id);
}

export interface ActionRequest {
  verb: string;
  workflowHint: { label: string; link: string };
}

const ACTION_RE =
  /^(?:(?:please|kindly|can you|could you|would you|will you|go ahead and|just|now)\s+)*(approve|reject|cancel|delete|remove|create|submit|dispatch|confirm|adjust|modify|update|edit|pay|release|post|raise|issue|file|write\s*off|mark|change|set|overwrite|clear|close|send)\b/i;

/** Phase 1 is read-only: requests to change records are refused and redirected to the real workflow. */
const READ_REQUEST_RE =
  /^\s+(?:me|us)\b|^\s+(?:a|an|the|my|our)?\s*(?:short\s+|quick\s+|brief\s+|daily\s+|weekly\s+)?(?:summary|report|list|overview|digest|brief|breakdown|explanation|analysis)\b/i;

export function detectActionRequest(question: string): ActionRequest | null {
  const text = question.trim();
  const m = ACTION_RE.exec(text);
  if (!m) return null;
  if (READ_REQUEST_RE.test(text.slice(m[0].length))) return null;
  const q = question.toLowerCase();
  let workflowHint = { label: 'the relevant WhizUnik workflow', link: '/' };
  if (/\b(po|purchase order)\b|po-\d/.test(q)) workflowHint = { label: 'Procurement queue / Checker approvals', link: '/records/purchase-orders' };
  else if (/\b(payment|pay|bill|supplier)\b|bill-\d/.test(q)) workflowHint = { label: 'Supplier payments (Finance) and Checker approvals', link: '/records/supplier-bills' };
  else if (/\b(invoice|credit note|irn|e-?way)\b|inv-\d/.test(q)) workflowHint = { label: 'Invoices & collections (Finance)', link: '/records/invoices' };
  else if (/\b(stock|inventory|sku|adjust)\b|sku-\d/.test(q)) workflowHint = { label: 'Inventory workflow and Checker approvals', link: '/records/products' };
  else if (/\b(dispatch|pick|pack|warehouse)\b|wt-\d/.test(q)) workflowHint = { label: 'Warehouse queue', link: '/records/warehouse-tasks' };
  else if (/\b(sales order|order)\b|so-\d/.test(q)) workflowHint = { label: 'Sales Orders queue', link: '/records/sales-orders' };
  else if (/\bapprov/.test(q)) workflowHint = { label: 'Checker approvals', link: '/records/approvals' };
  return { verb: m[1].toLowerCase().replace(/\s+/g, ' '), workflowHint };
}

// --------------------------------------------------------------- data text

const DATA_INSTRUCTION_RE =
  /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(instructions?|prompts?|rules?)\b|\b(system prompt|you are now|new instructions?)\b|<\|?\s*(system|im_start|assistant)\s*\|?>|\bassistant\s*:|\b(approve|pay|release|delete|mark)\s+(all|every)\b/i;

/**
 * Free text coming out of the database (names, notes, error messages) is
 * untrusted: a supplier could be named "Ignore previous instructions...".
 * We strip control characters, cap the length, and cut off anything that looks
 * like an instruction before it can reach the model.
 */
export function sanitizeDataText(value: unknown, max = 160): string {
  if (value === null || value === undefined) return '';
  let s = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const m = DATA_INSTRUCTION_RE.exec(s);
  if (m) s = `${s.slice(0, m.index).trim()} [text removed: looked like an instruction]`.trim();
  s = redactSensitive(s);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// -------------------------------------------------------------- redaction

const REDACTIONS: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED_KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, 'Bearer [REDACTED_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]'],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]'],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[ID]'],
  [/\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z0-9]Z[A-Z0-9]\b/g, '[ID]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[CARD]'],
  [/\b\d{4}\s\d{4}\s\d{4}\b/g, '[ID]'],
  [/(?:\+91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g, '[PHONE]'],
];

/** Mask secrets and personal identifiers before anything is stored in usage / history / logs. */
export function redactSensitive(text: string): string {
  return REDACTIONS.reduce((acc, [re, repl]) => acc.replace(re, repl), text);
}

// ---------------------------------------------------------- safe responses

const CLAIM_PATTERNS: RegExp[] = [
  /\bpayment\s+(?:has\s+been\s+|was\s+|is\s+)?(?:completed|processed|made|released|sent)\b/i,
  /\bstock\s+(?:has\s+been\s+|was\s+|is\s+now\s+)?(?:adjusted|corrected|updated)\b/i,
  /\bpurchase\s+order(?:\s+\S+)?\s+(?:has\s+been\s+|was\s+|is\s+now\s+)?approved\b/i,
  /\binvoice(?:\s+\S+)?\s+(?:has\s+been\s+|was\s+)?(?:submitted|created|generated|posted)\b/i,
  /\b(?:dispatch|e-?way bill|irn)\s+(?:has\s+been\s+|was\s+)?(?:confirmed|submitted|generated)\b/i,
  /\bcredit\s+note(?:\s+\S+)?\s+(?:has\s+been\s+|was\s+)?(?:created|issued|posted)\b/i,
  /\b(?:i|we|the ai|ai)\s+(?:have\s+|'ve\s+|has\s+)?(?:just\s+|now\s+|successfully\s+)?(?:approved|rejected|paid|released|dispatched|adjusted|submitted|created|cancelled|deleted|updated|posted|confirmed|raised|issued|filed|fixed|corrected)\b/i,
  /\b(?:has|have)\s+(?:now\s+|just\s+|successfully\s+)?been\s+(?:approved|paid|processed|submitted|dispatched|adjusted|released|posted|confirmed)\s+(?:by\s+(?:me|the ai|ai))\b/i,
  /\b(?:successfully|just)\s+(?:approved|paid|processed|submitted|dispatched|adjusted|released|posted|confirmed)\b/i,
  // "PO-3002 has been approved", "INV-5001 is now submitted" (a fresh action, not a status read from the data)
  /\b(?:SO|PO|INV|BILL|WT|APR|ST|MP)-[A-Z0-9-]+\s+(?:has\s+been|have\s+been|is\s+now|are\s+now)\s+(?:now\s+|just\s+|successfully\s+)?(?:approved|paid|submitted|dispatched|posted|adjusted|released|processed|confirmed|cancelled|created|deleted|updated)\b/i,
  /\bpayments?\b[^.!?]{0,40}\b(?:has|have)\s+(?:now\s+|just\s+)?been\s+(?:made|completed|processed|sent|released)\b/i,
  /\b(?:i|we)\s+(?:have\s+|'ve\s+)?(?:made|completed|processed|sent)\s+(?:the\s+)?payment/i,
];

/** A negation only protects a sentence when it sits right before the claim ("No stock was adjusted"). */
const NEGATION_BEFORE_RE = /\b(?:not|no|never|cannot|can't|can not|unable to|won't|isn't|hasn't|haven't|wasn't|weren't|yet to|until|unless|before|once|if|whether|without)\b[^.!?]{0,30}$/i;

function claimsCompletedAction(sentence: string): boolean {
  for (const re of CLAIM_PATTERNS) {
    const m = re.exec(sentence);
    if (!m) continue;
    const before = sentence.slice(Math.max(0, m.index - 40), m.index);
    if (!NEGATION_BEFORE_RE.test(before)) return true;
  }
  return false;
}

export interface SafeLanguageResult {
  text: string;
  removed: number;
}

export const ADVISORY_NOTE =
  'WhizUnik AI is advisory only in this phase — it cannot approve, pay, adjust stock or submit documents. Use the linked WhizUnik workflow to take any action.';

/** Drop sentences that claim an action was completed (the platform has not confirmed anything). */
export function enforceSafeLanguage(text: string): SafeLanguageResult {
  let removed = 0;
  // Work line by line so bullet lists keep their structure, then sentence by sentence within a line.
  const lines = text.split('\n').flatMap((line) => {
    const sentences = line.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [line];
    const kept = sentences.filter((s) => {
      const claims = claimsCompletedAction(s);
      if (claims) removed += 1;
      return !claims;
    });
    const joined = kept.join('').replace(/[ \t]{2,}/g, ' ').trim();
    return joined === '' && line.trim() !== '' ? [] : [joined];
  });
  return { text: lines.join('\n').trim(), removed };
}

// --------------------------------------------------------- number grounding

export function collectNumbers(value: unknown, into: Set<number> = new Set()): Set<number> {
  if (typeof value === 'number' && Number.isFinite(value)) {
    into.add(Math.abs(value));
    into.add(Math.abs(Math.round(value)));
  } else if (typeof value === 'string') {
    for (const m of value.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
      const n = Number(m[0].replace(/,/g, ''));
      if (Number.isFinite(n)) into.add(n);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectNumbers(v, into));
  } else if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((v) => collectNumbers(v, into));
  }
  return into;
}

const SUFFIX_MULT: Record<string, number> = { lakh: 1e5, lac: 1e5, lakhs: 1e5, crore: 1e7, crores: 1e7, cr: 1e7, k: 1e3 };

/** Numbers in `text` that cannot be found in the retrieved data (so the model may have invented them). */
export function findUngroundedNumbers(text: string, allowed: Set<number>): string[] {
  const stripped = text
    .replace(/\b[A-Z]{2,5}-[A-Z0-9-]+\b/g, ' ') // record refs such as SO-1021
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ') // ISO dates
    .replace(/\b\d{1,2}:\d{2}\b/g, ' '); // times
  const bad: string[] = [];
  for (const m of stripped.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr|k)?\b/gi)) {
    const base = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(base)) continue;
    const suffix = m[2]?.toLowerCase();
    const value = suffix ? base * (SUFFIX_MULT[suffix] ?? 1) : base;
    if (!suffix && Number.isInteger(value) && value <= 31) continue; // small counts / day numbers
    if (!suffix && value >= 1990 && value <= 2100) continue; // years
    const tol = suffix ? 0.03 : 0.005;
    let ok = false;
    for (const a of allowed) {
      if (Math.abs(a - value) <= Math.max(0.5, a * tol)) {
        ok = true;
        break;
      }
    }
    if (!ok) bad.push(m[0].trim());
  }
  return [...new Set(bad)];
}

// ------------------------------------------------------- provider output

export const ProviderAnswerSchema = z.object({
  answer: z.string().min(1).max(8000),
  items: z
    .array(
      z.object({
        ref: z.string().min(1).max(60),
        title: z.string().max(240).default(''),
        detail: z.string().max(800).default(''),
        severity: z.enum(['high', 'medium', 'low']).default('medium'),
      }),
    )
    .max(60)
    .default([]),
  assumptions: z.array(z.string().max(400)).max(12).default([]),
  missingData: z.array(z.string().max(400)).max(12).default([]),
  recommendedActions: z
    .array(
      z.object({
        text: z.string().min(1).max(500),
        ref: z.string().max(60).optional(),
      }),
    )
    .max(12)
    .default([]),
});
export type ProviderAnswer = z.infer<typeof ProviderAnswerSchema>;

/** Parse the model's reply as JSON, tolerating code fences and surrounding prose. */
export function parseProviderJson(raw: string): unknown {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object found');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * AI text must never carry its own links (a manipulated answer could point
 * users to an external site). Internal links come only from backend `source`
 * objects, so any URL in generated text is removed.
 */
export function stripExternalLinks(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\((?:https?:)?\/\/[^)]*\)/gi, '$1')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '[link removed]');
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
