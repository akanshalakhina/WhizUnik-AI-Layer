export type Role = 'management' | 'sales' | 'procurement' | 'warehouse' | 'finance' | 'checker';
export type Severity = 'high' | 'medium' | 'low';

export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
  clientId: number;
  clientName: string;
}

export interface SourceRef {
  type: string;
  ref: string;
  label: string;
  link: string;
  workflow: { label: string; link: string };
}

export interface ResponseItem {
  ref: string;
  title: string;
  detail: string;
  severity: Severity;
  source: SourceRef;
}

export interface ResponseAction {
  text: string;
  source?: SourceRef;
  workflow?: { label: string; link: string };
}

export interface Figure {
  label: string;
  value: string | number;
}

export type UsageLevel = 'ok' | 'warning_70' | 'warning_90' | 'limit_reached';

export interface UsageStatus {
  level: UsageLevel;
  dailyLevel: UsageLevel;
  dailyPct: number;
  monthlyPct: number;
  costUsedInr: number;
  costLimitInr: number;
  requestsUsed: number;
  requestLimit: number;
  dailyUsed: number;
  dailyLimit: number;
  message?: string;
}

export interface AskResponse {
  requestId: string;
  status: 'success' | 'success_empty' | 'refused' | 'unknown_question';
  answer: string;
  category: string;
  items: ResponseItem[];
  sources: SourceRef[];
  figures: Figure[];
  dateRange: { from: string; to: string; description: string };
  assumptions: string[];
  missingData: string[];
  recommendedActions: ResponseAction[];
  warnings: string[];
  suggestions?: string[];
  degraded?: boolean;
  usage: { inputTokens: number; outputTokens: number; estimatedCostInr: number; model: string; provider: string };
  usageStatus: UsageStatus;
  generatedAt: string;
}

export interface SummarySection {
  key: string;
  title: string;
  restricted: boolean;
  total: number;
  high: number;
  items: ResponseItem[];
}

export interface SummaryResponse {
  requestId: string;
  date: string;
  role: Role;
  generatedAt: string;
  expiresAt: string;
  cached: boolean;
  degraded: boolean;
  aiNotice?: string;
  overview: string;
  sections: SummarySection[];
  recommendedActions: ResponseAction[];
  figures: Figure[];
  assumptions: string[];
  missingData: string[];
  warnings: string[];
  usage: AskResponse['usage'];
  usageStatus: UsageStatus;
}

export interface AiStatus {
  enabled: boolean;
  roleAllowed: boolean;
  reason: string | null;
  provider: 'openai' | 'local';
  role: Role;
  roleLabel: string;
  roleAccess: string;
  allowedTools: string[];
  sampleQuestions: string[];
  usage: UsageStatus | null;
  advisoryOnly: boolean;
}

export interface HistoryItem {
  id: number;
  createdAt: string;
  question: string;
  category: string | null;
  status: string;
}

export interface RecordColumn {
  key: string;
  label: string;
  kind?: 'text' | 'number' | 'money' | 'date' | 'status' | 'datetime';
}

export interface RecordTable {
  title: string;
  columns: RecordColumn[];
  rows: Record<string, string | number | null>[];
}

export interface RecordListResponse {
  type: string;
  label: string;
  singular: string;
  columns: RecordColumn[];
  rows: Record<string, string | number | null>[];
}

export interface RecordDetailResponse {
  type: string;
  label: string;
  singular: string;
  ref: string;
  columns: RecordColumn[];
  record: Record<string, string | number | null>;
  tables: RecordTable[];
  related: { type: string; ref: string; label: string; link: string }[];
  readOnlyNotice: string;
}

export interface UsageDashboard {
  scope: 'client' | 'self';
  month: string;
  status: UsageStatus;
  limits: { monthlyCostLimitInr: number; monthlyRequestLimit: number; dailyUserLimit: number };
  totals: { requests: number; inputTokens: number; outputTokens: number; costInr: number };
  daily: { date: string; requests: number; costInr: number }[];
  byUser: { userId: number; name: string; role: string; requests: number; costInr: number; tokens: number }[];
  byModel: { model: string; requests: number; inputTokens: number; outputTokens: number; costInr: number }[];
  byStatus: { status: string; requests: number }[];
  recent: { createdAt: string; user: string; kind: string; question: string; model: string; inputTokens: number; outputTokens: number; costInr: number; status: string }[];
  note: string;
}

export interface AuditRow {
  id: number;
  requestId: string;
  createdAt: string;
  user: string;
  role: string;
  category: string | null;
  toolsUsed: string[];
  model: string | null;
  provider: string | null;
  status: string;
  processingMs: number;
  inputTokens: number;
  outputTokens: number;
  costInr: number;
  flags: string[];
}

export interface AiSettings {
  clientId: number;
  name: string;
  plan: string;
  aiEnabled: boolean;
  permittedRoles: Role[];
  monthlyCostLimitInr: number;
  monthlyRequestLimit: number;
  dailyUserLimit: number;
  globalAiEnabled: boolean;
  provider: 'openai' | 'local';
  models: { fast: string; strong: string };
  editable: false;
  changedBy: string;
}

export interface PermissionMatrix {
  roles: Record<string, { label: string; access: string }>;
  tools: Record<string, string[]>;
  fields: Record<string, string[]>;
  records: Record<string, string[]>;
  categories: Record<string, string[]>;
}

export interface ConnectionTest {
  provider: string;
  ok: boolean;
  configured: boolean;
  models: { fast: string; strong: string };
  code?: string;
  message: string;
  latencyMs?: number;
}
