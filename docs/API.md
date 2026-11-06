# WhizUnik AI API reference

All endpoints are under `/api`, return JSON, and (except `/auth/login` and `/health`) require `Authorization: Bearer <token>`. The client id and role are always taken from the database record of the token's user — never from the request.

Errors share one shape: `{ "error": { "code": "…", "message": "…" } }`.

## Auth

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/login` | `{ email, password }` → `{ token, user }`. 401 `INVALID_CREDENTIALS`; failed attempts are rate limited (429 `RATE_LIMITED`) |
| GET | `/auth/me` | current user |
| GET | `/health` | liveness |

## `POST /ai/ask`

Request: `{ "question": "Which sales orders need attention today?" }` (3–500 characters; body ≤ 8 KB)

Response (200):

```jsonc
{
  "requestId": "uuid",
  "status": "success",            // success | success_empty | refused | unknown_question
  "answer": "7 sales orders need attention out of 14 open …",
  "category": "sales",            // sales|procurement|inventory|warehouse|finance|marketplace|management|unknown
  "items": [{ "ref": "SO-1021", "title": "…", "detail": "…", "severity": "high",
              "source": { "type": "sales-orders", "ref": "SO-1021", "label": "…", "link": "/records/sales-orders/SO-1021",
                          "workflow": { "label": "Sales Orders queue", "link": "/records/sales-orders" } } }],
  "sources": [ /* the source objects of the items/actions, de-duplicated */ ],
  "figures": [{ "label": "Open sales orders", "value": 14 }],
  "dateRange": { "from": "2026-11-05", "to": "2026-11-05", "description": "As of today (2026-11-05)" },
  "assumptions": ["…"],
  "missingData": ["…"],           // withheld-for-role, truncated lists, not-found records
  "recommendedActions": [{ "text": "SO-1021: …", "source": { … }, "workflow": { "label": "…", "link": "…" } }],
  "warnings": [],                 // e.g. unverified figures, removed "action completed" claims
  "suggestions": ["…"],           // only for refused / unknown questions
  "degraded": false,
  "usage": { "inputTokens": 1200, "outputTokens": 300, "estimatedCostInr": 0.0315, "model": "gpt-4o-mini", "provider": "openai" },
  "usageStatus": { "level": "ok", "dailyLevel": "ok", "dailyPct": 7.5, "monthlyPct": 1.3, "costUsedInr": 0, "costLimitInr": 2000, "requestsUsed": 19, "requestLimit": 1500, "dailyUsed": 3, "dailyLimit": 40 },
  "generatedAt": "2026-11-05T06:30:00.000Z"
}
```

Error codes

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `INVALID_QUESTION` / `INVALID_REQUEST` | missing/empty/too long question, malformed JSON |
| 401 | `UNAUTHENTICATED` | missing/expired/invalid token |
| 403 | `AI_DISABLED` | feature flag off (global or for the client) |
| 403 | `ROLE_NOT_PERMITTED` | role not enabled for AI, or the question needs data the role may not see (`allowedRoles` lists who can) |
| 413 | `INVALID_REQUEST` | body too large |
| 429 | `MONTHLY_LIMIT_REACHED` / `DAILY_LIMIT_REACHED` | limits (`error.usage` has the numbers); `RATE_LIMITED` for request bursts |
| 502/503/504 | `AI_MALFORMED_RESPONSE`, `AI_PROVIDER_AUTH`, `AI_PROVIDER_NOT_CONFIGURED`, `AI_PROVIDER_RATE_LIMIT` (+`Retry-After`), `AI_PROVIDER_OUTAGE`, `AI_PROVIDER_TIMEOUT` | provider problems. The body also carries `fallback`: a data-only answer built from the retrieved records, with `degraded: true` |

Malicious questions (prompt injection, secrets, SQL, cross-tenant) and requests to change data are **not errors**: they return 200 with `status: "refused"` and no model call.

## Other AI endpoints

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/ai/summary?refresh=true` | any permitted role | AI Management Summary: `overview`, `sections[]` (salesRisks, stockRisks, procurementDelays, overduePayments, warehouseDelays, marketplaceExceptions, approvals; `restricted: true` sections carry no data), `recommendedActions[]` (each with a source record), `figures`, `cached`, `degraded`, `aiNotice`. Cached per client + role + day (default 4 h); never fails because the AI is unavailable |
| GET | `/ai/status` | any | feature state, role, allowed tools, sample questions, usage status |
| GET · DELETE | `/ai/history` | any (own) | list / clear own search history · `GET /ai/history/:id` returns one stored answer. Reading requires AI to be enabled for the company and the user's role (403 otherwise) |
| GET | `/ai/usage` | any | management: whole company; others: own usage. 30-day series, by user/model/status, recent requests |
| GET | `/ai/audit?limit=` | management | audit log |
| GET | `/ai/settings` | management | read-only view of the feature flag, permitted roles, monthly cost / request limits and daily per-user limit. There is **no write route**: the operator changes them with `npm run ai:configure` |
| GET | `/ai/permissions` | any | management gets the whole matrix |
| GET | `/ai/health` | management | provider connection test (key + model); never returns the key |

## Records (source links)

`GET /records` (types the role may open) · `GET /records/:type` · `GET /records/:type/:ref` — read-only; scoped to the caller's client and role. Types: `sales-orders`, `invoices`, `products`, `purchase-orders`, `warehouse-tasks`, `marketplace-orders`, `settlements`, `approvals`, `supplier-bills`, `api-events`. There are no write routes.
