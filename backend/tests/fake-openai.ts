import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type Behaviour =
  | 'ok'
  | 'bad_key'
  | 'rate_limit'
  | 'outage'
  | 'timeout'
  | 'malformed'
  | 'malformed_once'
  | 'evil'
  | 'empty'
  | 'html';

export interface RecordedCall {
  path: string;
  method: string;
  authorization?: string;
  body: any;
}

export interface FakeOpenAi {
  url: string;
  calls: RecordedCall[];
  behaviour: Behaviour;
  close(): Promise<void>;
}

/** Pull the retrieved data back out of the user prompt so the fake model can "answer" from it. */
function modelAnswer(body: any, evil: boolean): string {
  const user: string = body?.messages?.[1]?.content ?? '';
  const m = /<retrieved_data>([\s\S]*)<\/retrieved_data>/.exec(user);
  const data = m ? (JSON.parse(m[1]) as any[]) : [];
  const items = data.flatMap((r) => (r.sections ?? []).flatMap((s: any) => s.items ?? [])).slice(0, 3);
  const headline = data.map((r) => r.headline).join(' ');
  if (evil) {
    const real = items[0]?.ref ?? 'SO-1021';
    return JSON.stringify({
      answer: `Payment completed for INV-5003. Stock adjusted. I have approved PO-3006. The total is ₹9,99,999. See https://evil.example/login for details. ${headline}`,
      items: [
        { ref: 'SO-9999', title: 'Invented order', detail: 'This record does not exist.', severity: 'high' },
        { ref: real, title: 'Real record', detail: 'Invoice submitted successfully for this record.', severity: 'medium' },
      ],
      assumptions: ['Visit https://evil.example for more'],
      missingData: [],
      recommendedActions: [
        { text: 'Click https://evil.example/pay now', ref: 'SO-9999' },
        { text: 'I approved the purchase order for you.', ref: real },
      ],
    });
  }
  return JSON.stringify({
    answer: headline || 'No data.',
    items: items.map((i: any) => ({ ref: i.ref, title: i.title, detail: i.detail, severity: i.severity })),
    assumptions: ['Answer is based only on the retrieved WhizUnik data.'],
    missingData: [],
    recommendedActions: items.filter((i: any) => i.suggestedNextStep).map((i: any) => ({ text: `${i.ref}: ${i.suggestedNextStep}`, ref: i.ref })),
  });
}

export async function startFakeOpenAi(initial: Behaviour = 'ok', delayMs = 1500): Promise<FakeOpenAi> {
  const state: FakeOpenAi = { url: '', calls: [], behaviour: initial, close: async () => {} };
  let completionCount = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body: any = null;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      } catch {
        body = null;
      }
      state.calls.push({ path: req.url ?? '', method: req.method ?? '', authorization: req.headers.authorization, body });
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };

      const b = state.behaviour;
      if (b === 'bad_key') {
        return send(401, { error: { message: 'Incorrect API key provided: sk-test-SECRET***7890. You can find your API key at https://platform.openai.com.', type: 'invalid_request_error', code: 'invalid_api_key' } });
      }
      if (b === 'rate_limit') return send(429, { error: { message: 'Rate limit reached', type: 'rate_limit_error' } }, { 'retry-after': '7' });
      if (b === 'outage') return send(503, { error: { message: 'The server is overloaded' } });
      if (b === 'html') return send(502, '<html><body>Bad gateway</body></html>');

      if (req.url?.startsWith('/models/')) return send(200, { id: decodeURIComponent(req.url.slice(8)), object: 'model' });

      if (req.url === '/chat/completions') {
        completionCount += 1;
        const reply = (content: string | null, usage = { prompt_tokens: 1200, completion_tokens: 300 }) =>
          send(200, { id: 'chatcmpl-test', model: `${body?.model ?? 'gpt'}-2024-07-18`, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage });
        if (b === 'timeout') {
          setTimeout(() => reply(modelAnswer(body, false)), delayMs);
          return;
        }
        if (b === 'malformed') return reply('Sorry, here is the answer in plain text rather than JSON.');
        if (b === 'malformed_once') return completionCount % 2 === 1 ? reply('not json at all') : reply(modelAnswer(body, false));
        if (b === 'empty') return reply(null);
        if (b === 'evil') return reply(modelAnswer(body, true));
        return reply(modelAnswer(body, false));
      }
      return send(404, { error: { message: 'not found' } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  state.url = `http://127.0.0.1:${port}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return state;
}
