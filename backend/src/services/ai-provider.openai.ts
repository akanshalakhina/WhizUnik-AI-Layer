import type { AiProvider, ConnectionTestResult, ProviderErrorCode, ProviderRequest, ProviderResponse } from './ai-provider.types';
import { ProviderError } from './ai-provider.types';

export interface OpenAiSettings {
  apiKey: string;
  baseUrl: string;
  modelFast: string;
  modelStrong: string;
}

/**
 * Hosted OpenAI provider. The API key lives only in server configuration:
 * it is sent in the Authorization header of the outgoing request and is never
 * returned to the frontend, written to logs, or included in error messages.
 */
export class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const;

  constructor(
    private readonly settings: OpenAiSettings,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  isConfigured(): boolean {
    return this.settings.apiKey.trim().length > 0;
  }

  private mapStatus(status: number, headers: Headers): ProviderError {
    if (status === 401 || status === 403) {
      return new ProviderError('INVALID_API_KEY', 'The AI provider rejected the API key. Check OPENAI_API_KEY in the server configuration.');
    }
    if (status === 429) {
      const ra = Number(headers.get('retry-after'));
      return new ProviderError('PROVIDER_RATE_LIMIT', 'The AI provider rate limit or quota was reached.', Number.isFinite(ra) && ra > 0 ? ra : undefined);
    }
    if (status === 408 || status === 504) return new ProviderError('PROVIDER_TIMEOUT', 'The AI provider timed out.');
    if (status >= 500) return new ProviderError('PROVIDER_OUTAGE', `The AI provider is unavailable (HTTP ${status}).`);
    return new ProviderError('PROVIDER_REJECTED', `The AI provider rejected the request (HTTP ${status}).`);
  }

  private async call(path: string, init: RequestInit, timeoutMs: number): Promise<{ res: Response; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.settings.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.settings.apiKey}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { res, body };
    } catch (e) {
      const err = e as { name?: string };
      if (err?.name === 'AbortError') throw new ProviderError('PROVIDER_TIMEOUT', `The AI provider did not respond within ${Math.round(timeoutMs / 1000)} seconds.`);
      throw new ProviderError('PROVIDER_OUTAGE', 'Could not reach the AI provider.');
    } finally {
      clearTimeout(timer);
    }
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    if (!this.isConfigured()) {
      throw new ProviderError('PROVIDER_NOT_CONFIGURED', 'No AI provider API key is configured on the server (OPENAI_API_KEY).');
    }
    const { res, body } = await this.call(
      '/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({
          model: req.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          response_format: { type: 'json_object' },
          // Reasoning-model families (o-series, gpt-5) only accept the default temperature.
          ...(/^(o\d|gpt-5)/i.test(req.model) ? {} : { temperature: 0.2 }),
          max_completion_tokens: req.maxOutputTokens,
        }),
      },
      req.timeoutMs,
    );

    if (!res.ok) throw this.mapStatus(res.status, res.headers);

    const data = body as {
      choices?: { message?: { content?: unknown }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    } | null;
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new ProviderError('MALFORMED_RESPONSE', 'The AI provider returned an empty or unreadable response.');
    }
    return {
      text: content,
      inputTokens: Math.max(0, Math.round(data?.usage?.prompt_tokens ?? 0)),
      outputTokens: Math.max(0, Math.round(data?.usage?.completion_tokens ?? 0)),
      model: typeof data?.model === 'string' ? data.model : req.model,
    };
  }

  /** Checks one model with GET /models/{model} (consumes no tokens). */
  private async checkModel(model: string): Promise<{ ok: boolean; code?: ProviderErrorCode; message: string }> {
    try {
      const { res } = await this.call(`/models/${encodeURIComponent(model)}`, { method: 'GET' }, 10_000);
      if (res.ok) return { ok: true, message: 'ok' };
      if (res.status === 404) return { ok: false, code: 'PROVIDER_REJECTED', message: `The key works but model "${model}" is not available to it.` };
      const err = this.mapStatus(res.status, res.headers);
      return { ok: false, code: err.code as ProviderErrorCode, message: err.message };
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError('PROVIDER_OUTAGE', 'Could not reach the AI provider.');
      return { ok: false, code: err.code, message: err.message };
    }
  }

  /** Connectivity + key + BOTH configured models (routine and analysis). */
  async testConnection(): Promise<ConnectionTestResult> {
    const models = { fast: this.settings.modelFast, strong: this.settings.modelStrong };
    if (!this.isConfigured()) {
      return { provider: 'openai', ok: false, configured: false, models, code: 'PROVIDER_NOT_CONFIGURED', message: 'OPENAI_API_KEY is not set on the server.' };
    }
    const started = Date.now();
    const fast = await this.checkModel(models.fast);
    if (!fast.ok) return { provider: 'openai', ok: false, configured: true, models, code: fast.code, message: fast.message, latencyMs: Date.now() - started };
    if (models.strong !== models.fast) {
      const strong = await this.checkModel(models.strong);
      if (!strong.ok) return { provider: 'openai', ok: false, configured: true, models, code: strong.code, message: strong.message, latencyMs: Date.now() - started };
    }
    return { provider: 'openai', ok: true, configured: true, models, message: 'Connected to the AI provider; the API key and both configured models are valid.', latencyMs: Date.now() - started };
  }
}
