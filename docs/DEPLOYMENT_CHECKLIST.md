# Deployment checklist and rollback (Task 15)

Complete every item **before enabling AI for a client**. Tick the box and note who verified it and when.

## A. Environment (once per environment)

- [ ] **Production API key configured** as a server secret (`OPENAI_API_KEY`) in the secrets manager / environment — never in the repository, frontend or logs. Use separate keys for development and production.
- [ ] `NODE_ENV=production`, `AI_PROVIDER=openai`, `JWT_SECRET` (≥ 32 random characters), `DEMO_MODE=false`, `CORS_ORIGINS` set to the real frontend origin(s). The server refuses to start otherwise.
- [ ] Models chosen and **current provider pricing checked**: `AI_MODEL_FAST` (routine), `AI_MODEL_STRONG` (management analysis) and the `AI_PRICE_*_INR_PER_M` estimates updated.
- [ ] `npm run ai:test-connection` reports `ok: true` for the production key (Management can also run **AI usage → Settings → Test provider connection**; it checks both the routine and the analysis model).
- [ ] Database backups enabled for the WhizUnik database (`DATABASE_PATH`); the AI tables (`ai_usage`, `ai_audit_log`, `ai_history`, `ai_summary_cache`) live in the same database.
- [ ] HTTPS in front of the API; frontend built with `npm run build` and served from the allowed origin (set `VITE_API_URL` only if the API is on a different origin).
- [ ] `npm audit` clean for backend and frontend; `npm test` green in CI.

## B. Per client (before turning AI on)

- [ ] **Monthly limit configured** by the operator (clients cannot raise their own limits): `npm run ai:configure -- --client <id> --monthly-cost <₹> --monthly-requests <n> --daily-user <n>`. Suggested starting points are in section D. Verify with `npm run ai:configure -- --list`.
- [ ] **Permitted roles configured**: `npm run ai:configure -- --client <id> --roles sales,finance` — only the roles that should use AI (Management is always included).
- [ ] **Audit logging verified**: ask a few questions, open **Audit log** and confirm user, role, category, tools, model, status, time and tokens are recorded, and that no question text or key appears.
- [ ] **Usage tracking verified**: **Usage** tab shows the requests, tokens and estimated cost; compare the first day's token totals with the provider dashboard.
- [ ] **Data isolation verified**: sign in as a user of this client and of another client; run *"Why is SO-1021 waiting?"* style questions on shared record numbers; confirm no cross-client names appear (the automated suite does this; repeat on real data for the new client).
- [ ] **Role restrictions verified** on real users: a Sales user cannot get cash-flow or supplier-payment data; a Warehouse user cannot get invoices.
- [ ] **Provider failure handling verified**: temporarily set an invalid key in staging → users see a clear message plus the data-only fallback and the rest of WhizUnik works; restore the key.
- [ ] **Limit behaviour verified** in staging: set a tiny monthly limit → 70% / 90% warnings appear, then *"monthly limit reached"* with the platform still usable.
- [ ] Run the functional questions (see the functional test report) against the **real model** and review the answers with the client's champion; confirm answers cite records and no figure looks invented. Re-run the prompt-injection scenarios.
- [ ] **Enable the feature flag** for the client — new clients start with AI **off**: `npm run ai:configure -- --client <id> --enable`.
- [ ] **Support documentation prepared**: share `CLIENT_USAGE_GUIDE.md`; give support `SUPPORT_TROUBLESHOOTING.md`.
- [ ] **Rollback instructions** (below) read by the on-call engineer.

## C. Rollback

Rollback is safe and instant because the AI layer is advisory and read-only — nothing it does has to be undone in business data.

| Situation | Action | Effect |
|---|---|---|
| One client has a problem | `npm run ai:configure -- --client <id> --disable` (or `UPDATE clients SET ai_enabled = 0 WHERE id = <client>`) | That client gets `AI_DISABLED` for all AI calls, and stored answers become unreadable; the rest of WhizUnik is unchanged |
| A role should lose access | `npm run ai:configure -- --client <id> --roles <remaining roles>` | That role gets `ROLE_NOT_PERMITTED` |
| Provider outage / cost spike / suspected abuse | Set `AI_ENABLED=false` and restart (or `AI_PROVIDER=local` to keep a data-only assistant without the hosted model) | AI is off globally / served by the offline engine; no external calls |
| Key compromised | Revoke the key at the provider, create a new one, update the secret, restart, run `ai:test-connection` | No data exposure: the key never reaches browsers or logs |
| Bad release | Redeploy the previous build; the schema changes are additive (`CREATE TABLE IF NOT EXISTS`) so old and new builds coexist | — |
| Clear cached summaries | `DELETE FROM ai_summary_cache` | Next dashboard visit regenerates |

No cleanup of business data is ever needed after a rollback, because the AI cannot write to it.

## D. Cost planning and packaging (spec section 12)

AI API cost depends on the volume of input and output and on the model. Estimates only — **check current provider pricing before launch**.

| Usage | Approximate AI API cost |
|---|---|
| Small pilot | ₹500–₹2,000 / month |
| Normal client usage | ₹2,000–₹8,000 / month |
| Heavy analysis and documents | ₹10,000–₹30,000+ / month |

For the ₹50,000/month plan: include AI under fair-use limits; use the low-cost model for routine questions (automatic) and the stronger model only for management analysis (automatic); **daily summaries are cached** (default 4 hours); requests are limited by user and by client; offer advanced AI as a higher-priced plan.

| Plan | AI scope | Suggested limits to configure |
|---|---|---|
| Standard — ₹50,000/month | Controlled AI summaries, alerts and natural-language search | monthly cost limit ≈ ₹2,000–₹8,000; daily per user ≈ 40 |
| Intelligence — ₹65,000–₹75,000/month | Higher AI usage, advanced forecasting and document analysis (forecasting/document analysis are *not* in Phase 1) | monthly cost limit ≈ ₹8,000–₹30,000 |
| Enterprise — custom | Large data volumes, multiple companies, custom integrations | custom |

The measured cost per request is recorded in the usage log, so limits can be tuned from real numbers after the pilot.

## E. Phase 1 exclusions — confirm with the client

The AI **cannot**: approve Purchase Orders or payments, modify inventory, create invoices or credit notes, confirm dispatch, submit IRN / E-Way Bill, alter accounting records, or delete/overwrite platform data. Any such request is refused and the user is pointed to the correct WhizUnik workflow. These capabilities may be considered only after the read-only assistant has been tested and approved.
