import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ask, makeEnv } from './helpers';
import type { TestEnv } from './helpers';
import { startFakeOpenAi } from './fake-openai';
import type { Behaviour, FakeOpenAi } from './fake-openai';

const KEY = 'sk-test-SECRETKEY-1234567890abcdef';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(behaviour: Behaviour, extraEnv: Record<string, string> = {}, logs: string[] = []) {
  const fake = await startFakeOpenAi(behaviour);
  const logger = { error: (...a: unknown[]) => logs.push(a.join(' ')), warn: (...a: unknown[]) => logs.push(a.join(' ')), info: (...a: unknown[]) => logs.push(a.join(' ')) };
  const env = await makeEnv({
    env: { AI_PROVIDER: 'openai', OPENAI_API_KEY: KEY, OPENAI_BASE_URL: fake.url, AI_TIMEOUT_MS: '300', ...extraEnv },
    logger,
  });
  cleanups.push(() => env.cleanup(), () => fake.close());
  return { fake, env, logs };
}

const Q = 'Which invoices are overdue?';

describe('OpenAI provider: request format and successful answers (Task 1, 2)', () => {
  it('calls the provider securely, uses the cheaper model for routine questions and tracks real token usage', async () => {
    const { fake, env } = await setup('ok');
    const t = await env.as('finance');
    const res = await ask(env, t, Q);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const call = fake.calls.find((c) => c.path === '/chat/completions')!;
    expect(call.authorization).toBe(`Bearer ${KEY}`); // the key is only ever sent server-to-provider
    expect(call.body.model).toBe('gpt-4o-mini');
    expect(call.body.response_format).toEqual({ type: 'json_object' });
    expect(call.body.messages[0].content).toMatch(/READ-ONLY/);
    expect(call.body.messages[0].content).toMatch(/Never invent numbers/);
    expect(call.body.messages[0].content).toMatch(/never state or imply that an action was completed/i);
    expect(call.body.messages[1].content).toContain('<retrieved_data>');
    expect(call.body.messages[1].content).toContain('INV-5006');

    expect(res.body.usage).toMatchObject({ inputTokens: 1200, outputTokens: 300, provider: 'openai' });
    expect(res.body.usage.model).toContain('gpt-4o-mini');
    expect(res.body.usage.estimatedCostInr).toBeGreaterThan(0);
    expect(res.body.sources.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain(KEY);

    const usage = env.db.prepare('SELECT * FROM ai_usage ORDER BY id DESC LIMIT 1').get() as any;
    expect(usage).toMatchObject({ input_tokens: 1200, output_tokens: 300, status: 'success', provider: 'openai' });
    expect(usage.est_cost_inr).toBeCloseTo((1200 / 1e6) * 13 + (300 / 1e6) * 53, 3);
  });

  it('uses the lower-cost model for a single-record "why" question', async () => {
    const { fake, env } = await setup('ok');
    const res = await ask(env, await env.as('sales'), 'Why is SO-1021 waiting?');
    expect(res.status).toBe(200);
    expect(fake.calls.find((c) => c.path === '/chat/completions')!.body.model).toBe('gpt-4o-mini');
  });

  it('uses the stronger model for complex management analysis', async () => {
    const { fake, env } = await setup('ok');
    const res = await ask(env, await env.as('management'), 'What needs attention today?');
    expect(res.status).toBe(200);
    expect(fake.calls.find((c) => c.path === '/chat/completions')!.body.model).toBe('gpt-4o');
    expect(res.body.usage.estimatedCostInr).toBeGreaterThan(0.2); // 1200 in + 300 out at the strong-model rates
  });

  it('sends only the retrieved, role-permitted data to the provider', async () => {
    const { fake, env } = await setup('ok');
    await ask(env, await env.as('sales'), 'What needs attention today?');
    const prompt = fake.calls.find((c) => c.path === '/chat/completions')!.body.messages[1].content as string;
    expect(prompt).toContain('SO-1021');
    expect(prompt).not.toMatch(/BILL-70|inflows|WT-90|ST-AMZ|EVT-|Lotus Mart|Hari Om/);
    expect(prompt).not.toMatch(/@[a-z-]+\.example|HDFC-|\+91-9|password|\$2[aby]\$/i);
    expect(prompt).toContain("Data NOT available to this user's role");
  });
});

describe('provider failure handling (Task 12): clear errors, no crash, platform keeps working', () => {
  const cases: [Behaviour, number, string][] = [
    ['bad_key', 503, 'AI_PROVIDER_AUTH'],
    ['rate_limit', 503, 'AI_PROVIDER_RATE_LIMIT'],
    ['outage', 503, 'AI_PROVIDER_OUTAGE'],
    ['html', 503, 'AI_PROVIDER_OUTAGE'],
    ['timeout', 504, 'AI_PROVIDER_TIMEOUT'],
    ['malformed', 502, 'AI_MALFORMED_RESPONSE'],
    ['empty', 502, 'AI_MALFORMED_RESPONSE'],
  ];

  it.each(cases)('%s -> HTTP %i %s', async (behaviour, status, code) => {
    const logs: string[] = [];
    const { env } = await setup(behaviour, {}, logs);
    const t = await env.as('finance');
    const res = await ask(env, t, Q);
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(res.body.error.message).toMatch(/Normal WhizUnik workflows are not affected/);
    // Never leak the key or the provider's own error text.
    const text = JSON.stringify(res.body) + logs.join('\n');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('platform.openai.com');
    // Degraded mode: the user still gets the matching records, clearly labelled.
    expect(res.body.fallback.degraded).toBe(true);
    expect(res.body.fallback.sources.length).toBeGreaterThan(0);
    expect(res.body.fallback.warnings.join(' ')).toMatch(/unavailable/);
    // Normal operations are untouched.
    expect((await request(env.app).get('/api/records/invoices').set('Authorization', `Bearer ${t}`)).status).toBe(200);
    expect((await request(env.app).get('/api/health')).status).toBe(200);
    // Failure is audited and counted.
    expect(env.db.prepare('SELECT status FROM ai_audit_log ORDER BY id DESC LIMIT 1').get()).toEqual({ status: 'provider_error' });
    expect(env.db.prepare('SELECT status FROM ai_usage ORDER BY id DESC LIMIT 1').get()).toEqual({ status: 'provider_error' });
  });

  it('records WHICH provider problem happened (audit flag + log line) without leaking provider text', async () => {
    const logs: string[] = [];
    const { env, fake } = await setup('bad_key', {}, logs);
    const t = await env.as('finance');
    await ask(env, t, Q);
    fake.behaviour = 'rate_limit';
    await ask(env, t, Q);
    fake.behaviour = 'outage';
    await ask(env, t, Q);
    const flags = (env.db.prepare("SELECT flags FROM ai_audit_log WHERE status = 'provider_error' ORDER BY id").all() as { flags: string }[]).map((r) => r.flags);
    expect(flags[0]).toContain('provider:INVALID_API_KEY');
    expect(flags[1]).toContain('provider:PROVIDER_RATE_LIMIT');
    expect(flags[2]).toContain('provider:PROVIDER_OUTAGE');
    expect(logs.join('\n')).toMatch(/provider error INVALID_API_KEY/);
    expect(logs.join('\n')).not.toMatch(/sk-|SECRET|platform\.openai/);
  });

  it('provider failures do not use up a user’s limits, but any tokens they burned still count as cost', async () => {
    const { env, fake } = await setup('outage');
    const t = await env.as('finance');
    env.db.prepare('UPDATE clients SET ai_daily_user_limit = 2 WHERE id = 1').run();
    for (let i = 0; i < 5; i++) expect((await ask(env, t, Q)).status).toBe(503);
    const s1 = (await request(env.app).get('/api/ai/status').set('Authorization', `Bearer ${t}`)).body.usage;
    expect(s1.dailyUsed).toBe(0);
    expect(s1.requestsUsed).toBe(0);
    fake.behaviour = 'ok';
    expect((await ask(env, t, Q)).status).toBe(200); // the user is not locked out after the outage
    fake.behaviour = 'malformed'; // two attempts burn tokens, then fail
    expect((await ask(env, t, Q)).status).toBe(502);
    const s2 = (await request(env.app).get('/api/ai/status').set('Authorization', `Bearer ${t}`)).body.usage;
    expect(s2.requestsUsed).toBe(1);
    expect(s2.costUsedInr).toBeGreaterThan(0.05); // 1 good call + 2 malformed attempts
  });

  it('includes Retry-After for provider rate limits', async () => {
    const { env } = await setup('rate_limit');
    const res = await ask(env, await env.as('finance'), Q);
    expect(res.headers['retry-after']).toBe('7');
    expect(res.body.error.retryAfterSec).toBe(7);
  });

  it('recovers as soon as the provider recovers', async () => {
    const { env, fake } = await setup('outage');
    const t = await env.as('finance');
    expect((await ask(env, t, Q)).status).toBe(503);
    fake.behaviour = 'ok';
    expect((await ask(env, t, Q)).status).toBe(200);
  });

  it('retries malformed output once and adds up the token cost of both attempts', async () => {
    const { env, fake } = await setup('malformed_once');
    const res = await ask(env, await env.as('finance'), Q);
    expect(res.status).toBe(200);
    expect(fake.calls.filter((c) => c.path === '/chat/completions')).toHaveLength(2);
    expect(res.body.usage.inputTokens).toBe(2400);
    expect(res.body.usage.outputTokens).toBe(600);
    expect(env.db.prepare('SELECT flags FROM ai_audit_log ORDER BY id DESC LIMIT 1').get()).toEqual({ flags: expect.stringContaining('malformed_retry') });
  });

  it('gives up after one retry when the output stays malformed, and still records the tokens used', async () => {
    const { env, fake } = await setup('malformed');
    const res = await ask(env, await env.as('finance'), Q);
    expect(res.status).toBe(502);
    expect(fake.calls.filter((c) => c.path === '/chat/completions')).toHaveLength(2);
    const u = env.db.prepare('SELECT input_tokens, output_tokens FROM ai_usage ORDER BY id DESC LIMIT 1').get();
    expect(u).toEqual({ input_tokens: 2400, output_tokens: 600 });
  });

  it('handles an unreachable provider', async () => {
    const { env } = await setup('ok', { OPENAI_BASE_URL: 'http://127.0.0.1:1' });
    const res = await ask(env, await env.as('finance'), Q);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AI_PROVIDER_OUTAGE');
  });

  it('survives a burst of requests during an outage', async () => {
    const { env } = await setup('outage', { RATE_LIMIT_ENABLED: 'false' });
    const t = await env.as('management');
    env.db.prepare('UPDATE clients SET ai_daily_user_limit = 1000').run();
    const results = await Promise.all(Array.from({ length: 12 }, () => ask(env, t, Q)));
    expect(results.every((r) => r.status === 503)).toBe(true);
    expect((await request(env.app).get('/api/records/sales-orders').set('Authorization', `Bearer ${t}`)).status).toBe(200);
  });

  it('reports a missing API key clearly (provider not configured)', async () => {
    const { env } = await setup('ok', { OPENAI_API_KEY: '' });
    const res = await ask(env, await env.as('finance'), Q);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AI_PROVIDER_NOT_CONFIGURED');
    expect(res.body.fallback.degraded).toBe(true);
  });

  it('does not call the provider when nothing matched (empty results), so outages do not matter', async () => {
    const { env, fake } = await setup('outage');
    const res = await ask(env, await env.as('finance'), 'Which invoices above ₹5 crore are overdue?');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success_empty');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('provider connection test (Task 1)', () => {
  it('reports success for a valid key and the configured model', async () => {
    const { env, fake } = await setup('ok');
    const res = await request(env.app).get('/api/ai/health').set('Authorization', `Bearer ${await env.as('management')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provider: 'openai', ok: true, configured: true, models: { fast: 'gpt-4o-mini', strong: 'gpt-4o' } });
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(fake.calls.map((c) => c.path)).toEqual(['/models/gpt-4o-mini', '/models/gpt-4o']); // both configured models are checked
  });

  it('gives a clear error for an invalid key without echoing it', async () => {
    const { env } = await setup('bad_key');
    const res = await request(env.app).get('/api/ai/health').set('Authorization', `Bearer ${await env.as('management')}`);
    expect(res.body).toMatchObject({ ok: false, code: 'INVALID_API_KEY' });
    expect(res.body.message).toMatch(/rejected the API key/);
    expect(JSON.stringify(res.body)).not.toMatch(/sk-|SECRET/);
  });

  it('flags a missing key and an unreachable provider', async () => {
    const a = await setup('ok', { OPENAI_API_KEY: '' });
    const none = await request(a.env.app).get('/api/ai/health').set('Authorization', `Bearer ${await a.env.as('management')}`);
    expect(none.body).toMatchObject({ ok: false, configured: false, code: 'PROVIDER_NOT_CONFIGURED' });
    const b = await setup('ok', { OPENAI_BASE_URL: 'http://127.0.0.1:1' });
    const down = await request(b.env.app).get('/api/ai/health').set('Authorization', `Bearer ${await b.env.as('management')}`);
    expect(down.body).toMatchObject({ ok: false, code: 'PROVIDER_OUTAGE' });
  });

  it('is restricted to management', async () => {
    const { env } = await setup('ok');
    expect((await request(env.app).get('/api/ai/health').set('Authorization', `Bearer ${await env.as('sales')}`)).status).toBe(403);
    expect((await request(env.app).get('/api/ai/health')).status).toBe(401);
  });
});

describe('management summary degrades instead of failing', () => {
  it('still returns the data sections when the provider is down', async () => {
    const { env } = await setup('bad_key');
    const t = await env.as('management');
    const res = await request(env.app).get('/api/ai/summary?refresh=true').set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(res.body.aiNotice).toMatch(/not configured correctly/);
    expect(res.body.sections.find((s: any) => s.key === 'salesRisks').items.length).toBeGreaterThan(0);
    expect(res.body.recommendedActions.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    // A degraded summary is cached only briefly so recovery is quick.
    const cached = env.db.prepare('SELECT payload FROM ai_summary_cache').get() as { payload: string };
    const p = JSON.parse(cached.payload);
    expect(Date.parse(p.expiresAt) - Date.parse(p.generatedAt)).toBe(5 * 60_000);
  });

  it('still returns the data sections when the monthly limit is reached', async () => {
    const { env } = await setup('ok');
    env.db.prepare('UPDATE clients SET ai_monthly_request_limit = 1 WHERE id = 1').run();
    const t = await env.as('management');
    expect((await ask(env, t, Q)).status).toBe(200);
    const res = await request(env.app).get('/api/ai/summary?refresh=true').set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(res.body.aiNotice).toMatch(/monthly AI usage limit/);
    expect(res.body.sections.some((s: any) => s.items.length > 0)).toBe(true);
  });
});

describe('misbehaving model output is neutralised (safe response rules, Task 11)', () => {
  it('removes completed-action claims, invented records, invented numbers and links', async () => {
    const { env } = await setup('evil');
    const res = await ask(env, await env.as('finance'), Q);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/Payment completed|Stock adjusted|I have approved|Invoice submitted|approved the purchase order/i);
    expect(text).not.toContain('evil.example');
    expect(text).not.toContain('SO-9999');
    expect(res.body.items.every((i: any) => i.source && i.source.link.startsWith('/records/'))).toBe(true);
    expect(res.body.warnings.join(' ')).toMatch(/claimed an action was completed/);
    expect(res.body.warnings.join(' ')).toMatch(/could not be matched to WhizUnik data/);
    expect(res.body.warnings.join(' ')).toContain('9,99,999');
    const flags = (env.db.prepare('SELECT flags FROM ai_audit_log ORDER BY id DESC LIMIT 1').get() as { flags: string }).flags;
    expect(flags).toMatch(/unsafe_claim_removed/);
    expect(flags).toMatch(/ungrounded_numbers/);
    expect(flags).toMatch(/unknown_ref_dropped/);
  });
});

describe('helper', () => {
  it('has a typed env', () => {
    const e: TestEnv | undefined = undefined;
    const f: FakeOpenAi | undefined = undefined;
    expect(e).toBeUndefined();
    expect(f).toBeUndefined();
  });
});
