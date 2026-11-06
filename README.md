# WhizUnik AI Layer — Phase 1 (advisory, read-only)

An AI assistant for the WhizUnik operating platform that **analyses approved platform data, explains risks and recommends actions** — without ever changing a financial, inventory or accounting record. It implements the specification in *“WhizUnik AI Layer Context, Architecture, Development Tasks and Deliverables.pdf”*.

```
User asks a question
  → WhizUnik identifies the user and client      (JWT → user, client and role re-read from the database)
  → checks permissions                           (permission matrix, enforced on the backend)
  → retrieves only relevant records              (approved data tools on a READ-ONLY database connection)
  → AI analyses the selected data                (OpenAI, or the built-in offline engine)
  → AI returns explanation + recommendation      (validated, sourced, safe-language filtered)
  → user opens the linked WhizUnik workflow      (every item links to its source record)
  → existing approval process is followed        (the AI cannot approve, pay, adjust or submit)
```

> **Important context.** No existing WhizUnik code base was provided, only the specification. So this repository contains the AI layer **and a small stand-in platform** (database schema, demo data, login, and read-only record screens) for it to sit on. The AI layer is isolated (`ai-*` files) so it can be lifted into the real WhizUnik backend; `record-links.ts` is the one place to point source links at the real screens.

## What is built (specification → code)

| Spec task / deliverable | Where |
|---|---|
| 1 · Configure the AI provider | [`config.ts`](backend/src/config.ts), [`ai-provider.openai.ts`](backend/src/services/ai-provider.openai.ts), [`.env.example`](backend/.env.example), `npm run ai:test-connection`, `GET /api/ai/health` |
| 2 · AI service (prompt, model selection, call, validation, timeout, failure handling) | [`ai-assistant.service.ts`](backend/src/services/ai-assistant.service.ts), [`ai-prompt.ts`](backend/src/services/ai-prompt.ts) |
| 3 · `POST /api/ai/ask` (auth, validation, structured + error responses) | [`routes/ai-assistant.ts`](backend/src/routes/ai-assistant.ts) |
| 4 · Approved data tools (+ unit tests) | [`ai-data-tools.service.ts`](backend/src/services/ai-data-tools.service.ts), `tests/tools.test.ts` |
| 5 · Question classification and tool-selection rules | [`ai-classifier.service.ts`](backend/src/services/ai-classifier.service.ts) |
| 6 · Roles and permissions | [`ai-permissions.service.ts`](backend/src/services/ai-permissions.service.ts) |
| 7 · AI Management Summary (API + dashboard panel, refresh, loading/error states, source links) | [`ai-summary.service.ts`](backend/src/services/ai-summary.service.ts), [`Dashboard.tsx`](frontend/src/pages/Dashboard.tsx) |
| 8 · Natural-language search (input, answer, sources, per-user history, empty/error states) | [`AskAI.tsx`](frontend/src/pages/AskAI.tsx), [`AnswerView.tsx`](frontend/src/components/AnswerView.tsx) |
| 9 · Usage tracking (client, user, question, time, model, tokens, cost, status; monthly + daily limits; 70%/90% warnings; limit-reached; dashboard) | [`ai-usage.service.ts`](backend/src/services/ai-usage.service.ts), [`Usage.tsx`](frontend/src/pages/Usage.tsx) |
| 10 · AI audit logging | [`ai-audit.service.ts`](backend/src/services/ai-audit.service.ts) |
| 11 · Safe response rules | [`ai-safety.service.ts`](backend/src/services/ai-safety.service.ts) |
| 12 · Failure handling | `toAppError`, [`ai-provider.openai.ts`](backend/src/services/ai-provider.openai.ts), degraded mode |
| 13 · Security testing | [`docs/SECURITY_TEST_REPORT.md`](docs/SECURITY_TEST_REPORT.md), `tests/security.test.ts` |
| 14 · Functional testing (data, results, limitations, screenshots) | [`docs/FUNCTIONAL_TEST_REPORT.md`](docs/FUNCTIONAL_TEST_REPORT.md), [`docs/screenshots/`](docs/screenshots) |
| 15 · Production readiness | [`docs/DEPLOYMENT_CHECKLIST.md`](docs/DEPLOYMENT_CHECKLIST.md) (incl. rollback), feature flag, permitted roles and limits set by the operator with `npm run ai:configure` (read-only view under **AI usage → Settings**) |
| Client usage guide · Support guide | [`docs/CLIENT_USAGE_GUIDE.md`](docs/CLIENT_USAGE_GUIDE.md), [`docs/SUPPORT_TROUBLESHOOTING.md`](docs/SUPPORT_TROUBLESHOOTING.md) |
| API reference | [`docs/API.md`](docs/API.md) |
| The PDF in plain language · clause-by-clause compliance check | [`docs/PDF_EXPLAINED.md`](docs/PDF_EXPLAINED.md), [`docs/SPEC_COMPLIANCE.md`](docs/SPEC_COMPLIANCE.md) |

### How the safety guarantees are met

| Requirement | Mechanism |
|---|---|
| AI never modifies financial/inventory records | Data tools receive a **separate read-only SQLite connection** (`query_only`), so even a bug cannot write. A test fingerprints every business table before/after dozens of AI calls from every role. Action requests ("approve PO-3006") are refused before any model call. |
| No cross-client data | Every tool query filters on the authenticated client id; shared record numbers (SO-1021…) deliberately exist for two seeded clients and are tested in both directions. |
| Role restrictions enforced by the backend | Permission matrix + `ToolGate` (category-approved ∩ role-permitted) + the tools re-check the role + field-level stripping (unit cost, supplier pricing, settlement amounts, customer credit). |
| Model can’t pick tools or run arbitrary queries | The backend classifies the question and chooses tools; the model only sees the retrieved JSON. |
| Prompt injection | Questions with injection/secret/SQL/cross-tenant patterns are refused without a model call; text coming *from the database* is sanitised and fenced as data; model output is schema-validated, and any ref the model cites that wasn’t retrieved is dropped. |
| No invented numbers / no claimed actions | Numeric grounding check (warns on figures not in the data); sentences claiming “payment completed”, “stock adjusted”, “PO approved”, “invoice submitted” are removed; external links are stripped. |
| API key never exposed | Read only on the server, sent only in the provider request header; never in responses, logs, audit, or the frontend bundle (tested, bundle scanned). |
| AI failure never blocks operations | Provider errors are mapped to clear typed errors; the user still gets the retrieved records (“degraded mode”); the rest of the platform is separate routes. |

## Quick start

Requires **Node.js 20+** (tested on 20.19). On Windows use PowerShell.

```bash
# 1. Backend (http://localhost:4000)
cd backend
npm install
cp .env.example .env        # development defaults; AI_PROVIDER=local needs no key
npm run seed                # optional: recreate the demo database (it also seeds itself when empty)
npm run dev

# 2. Frontend (http://localhost:5173) — in a second terminal
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. (Demo data is only created when `DEMO_MODE=true`, which `.env.example` sets for development.) In development the sign-in page has quick-login buttons for the seeded demo accounts. Accounts are `<role>@aarav.demo` and `<role>@bharat.demo` for roles `management`, `sales`, `procurement`, `warehouse`, `finance`, `checker`; the password is `SEED_PASSWORD` from `backend/.env.example`. (Two companies exist so isolation is visible: sign in as one, then the other.)

### Using the hosted OpenAI model

```bash
# backend/.env
AI_PROVIDER=openai
OPENAI_API_KEY=<your key>          # server-side only
AI_MODEL_FAST=gpt-4o-mini          # routine questions — verify current model names and pricing
AI_MODEL_STRONG=gpt-4o             # management analysis
```

```bash
npm run ai:test-connection         # checks key + model; prints the result, never the key
```

With `AI_PROVIDER=local` (the development default only; production defaults to `openai`) a deterministic rules engine restates the retrieved data — free, offline, and not the hosted AI the PDF specifies. It is also what supplies the data-only fallback when the provider is down.

### Commands

| In `backend/` | |
|---|---|
| `npm run dev` / `npm run build && npm start` | run the API (watch mode / production) |
| `npm test` | 309 tests: tools, classifier, permissions, safety, API, failures, security |
| `npm run typecheck` | TypeScript check |
| `npm run seed` | recreate demo data |
| `npm run ai:configure -- --list` | operator: show / change a client's AI flag, permitted roles and limits (`--client 1 --enable --roles sales,finance --monthly-cost 5000 --daily-user 40`) |
| `npm run report` | regenerate `docs/FUNCTIONAL_TEST_REPORT.md` |
| `npm run ai:test-connection` | provider connection test |

| In `frontend/` | |
|---|---|
| `npm run dev` · `npm run build` · `npm test` | dev server (proxies `/api`) · production build · unit tests |

## Project layout

```
backend/src
  app.ts, server.ts, config.ts, middleware.ts, errors.ts, types.ts
  db/            schema.ts · database.ts (read-write + READ-ONLY handles) · seed.ts
  routes/        auth.ts · ai-assistant.ts · records.ts
  services/
    ai-assistant.service.ts     orchestration: gates → classify → tools → model → validate → log
    ai-data-tools.service.ts    9 approved, client-scoped, role-aware read-only tools
    ai-classifier.service.ts    question category, parameters, tool-selection rules
    ai-permissions.service.ts   permission matrix + ToolGate
    ai-safety.service.ts        validation, threat/action detection, redaction, safe language, grounding
    ai-summary.service.ts       AI Management Summary (+ daily cache)
    ai-usage.service.ts         usage, cost estimates, limits, dashboard, client settings
    ai-audit.service.ts         audit log + per-user history
    ai-provider*.ts, ai-prompt.ts   OpenAI + offline engine, prompts
    records.service.ts, record-links.ts   read-only record viewer used by source links
backend/tests    309 tests incl. a fake OpenAI server (tests/fake-openai.ts)
frontend/src     pages (Dashboard, AskAI, Records, Usage, Login), components, api client
docs/            reports, guides, screenshots
```

## Approved data tools

`getOpenSalesOrders` · `getSalesOrderDetail` · `getOverdueInvoices` · `getLowStockProducts` · `getDelayedPurchaseOrders` · `getPendingWarehouseTasks` · `getMarketplaceExceptions` · `getCashFlowSummary` · `getPendingApprovals` — the seven named in the specification plus order-detail (for “Why is SO-1021 blocked?”) and approvals (for the Checker role). Each takes the authenticated client id, selects only needed fields, strips role-restricted fields, caps records (default 25) and discloses truncation.

## Assumptions and things to confirm

* **Stand-in platform** (see above) — replace the schema/seed/record screens with the real WhizUnik; keep the `ai-*` services.
* **Response contract** extends the specified `{answer, items, sources, usage}` with `category`, `figures`, `dateRange`, `assumptions`, `missingData`, `recommendedActions`, `warnings`, `usageStatus` (additive; the four specified fields are unchanged).
* **Role mapping**: the PDF's section 8 table is applied literally. Management = everything; Sales = sales orders, customers, collections; Procurement = suppliers, POs, purchasing (+ stock shortage/reorder, which the PDF lists under procurement); Warehouse = stock, dispatch, warehouse tasks; Finance = invoices, receipts, settlements, cash flow (for marketplace data Finance gets only orders waiting for an invoice and settlement differences); Checker = pending approvals and exceptions only. The PDF assigns marketplace operations to no single role, so the full marketplace picture is Management-only. Change any of it in one table: `ai-permissions.service.ts`.
* **Limits**: a monthly client limit is enforced on both estimated cost (₹) and request count (whichever is higher drives the 70/90/100% states) plus a daily per-user request limit (also with 70/90/100% warnings). Limits, permitted roles and the feature flag are set by the operator (`npm run ai:configure`), never by the client; new clients start with AI **off**.
* **Not verified against the live OpenAI API** — see *Known limitations* in the functional test report.

