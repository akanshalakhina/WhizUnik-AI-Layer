import request from 'supertest';
import { makeEnv, ask } from '../tests/helpers';

(async () => {
  const env = await makeEnv();
  const t = await env.as('management');
  const qs = [
    'Which sales orders need attention today?',
    'Which invoices are overdue?',
    'Which invoices above ₹1 lakh are overdue?',
    'What stock will run out soon?',
    'Which suppliers have delayed POs?',
    'Which marketplace orders are blocked?',
    'Why is SO-1021 waiting?',
    'What is expected cash flow this month?',
    'What needs attention today?',
  ];
  for (const q of qs) {
    const r = await ask(env, t, q);
    console.log('\n### ' + q, r.status, r.body.category, r.body.status);
    console.log(r.body.answer ?? JSON.stringify(r.body));
    console.log('items:', (r.body.items ?? []).map((i: any) => i.ref).join(', '));
    console.log('warnings:', r.body.warnings, 'missing:', r.body.missingData);
  }
  env.cleanup();
})();
