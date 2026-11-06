import type { Category, Role } from '../types';
import type { ToolResult } from './ai-data-tools.service';

/** Everything the answer depends on. The OpenAI provider gets it as text; the local provider uses it directly. */
export interface AnswerContext {
  mode: 'ask' | 'summary';
  question: string;
  category: Category;
  role: Role;
  today: string;
  period: { from: string; to: string; description: string };
  toolResults: ToolResult[];
  blockedByRole: string[];
}

export interface ProviderRequest {
  model: string;
  system: string;
  user: string;
  timeoutMs: number;
  maxOutputTokens: number;
  context: AnswerContext;
}

export interface ProviderResponse {
  /** Raw model text; expected to be a JSON object matching ProviderAnswerSchema. */
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export type ProviderErrorCode =
  | 'PROVIDER_NOT_CONFIGURED'
  | 'INVALID_API_KEY'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_OUTAGE'
  | 'PROVIDER_REJECTED'
  | 'MALFORMED_RESPONSE';

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ConnectionTestResult {
  provider: string;
  ok: boolean;
  configured: boolean;
  models: { fast: string; strong: string };
  code?: ProviderErrorCode;
  message: string;
  latencyMs?: number;
}

export interface AiProvider {
  readonly name: 'openai' | 'local';
  isConfigured(): boolean;
  complete(req: ProviderRequest): Promise<ProviderResponse>;
  testConnection(): Promise<ConnectionTestResult>;
}
