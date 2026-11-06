# WhizUnik AI — support troubleshooting guide

**Golden rule:** the AI is advisory and isolated. If it misbehaves, switch it off (see *Rollback* in the deployment checklist) — no business data needs repair, and normal WhizUnik operations are never blocked by an AI failure.

## 1. Quick triage

1. Ask the user for the **time**, **their role**, and the **error message** they saw (the screen shows the code in plain words).
2. Management → **AI usage → Audit log**: find the request (time + user). `Status`, `Data tools used`, `Flags` and `Time` usually explain it.
3. Check provider health: **Settings & provider → Test provider connection** or `npm run ai:test-connection` on the server (both check the routine and the analysis model).
4. Check server logs for `[ai]` lines (they never contain the key or question text).

## 2. Symptom → cause → fix

| What the user sees (API code) | Likely cause | Fix |
|---|---|---|
| "The AI assistant is not enabled for your company" (`AI_DISABLED`) | Client feature flag off (new clients start off), or `AI_ENABLED=false` | `npm run ai:configure -- --client <id> --enable`; check env |
| "…not enabled for the <role> role" (`ROLE_NOT_PERMITTED`) | Role not in the client's permitted roles | `npm run ai:configure -- --client <id> --roles management,<role>` |
| "Your role (X) is not permitted to access this data" (`ROLE_NOT_PERMITTED`, lists who can) | Correct behaviour: the question needs another department's data | Ask a user of a listed role, or Management |
| "AI service is not configured correctly" (`AI_PROVIDER_AUTH`) | Provider rejected the key (invalid, revoked, wrong project) | Test connection → `INVALID_API_KEY`; set a valid `OPENAI_API_KEY`; restart |
| "AI service has not been set up yet" (`AI_PROVIDER_NOT_CONFIGURED`) | `AI_PROVIDER=openai` but no key | Set the key, or `AI_PROVIDER=local` |
| "The AI service is busy" (`AI_PROVIDER_RATE_LIMIT`, `Retry-After`) | Provider rate limit or **quota/billing** exhausted | Check provider billing and limits; retry later; lower traffic |
| "took too long" (`AI_PROVIDER_TIMEOUT`, 504) | Slow provider / network | Retry; raise `AI_TIMEOUT_MS` (default 20 s) if persistent |
| "temporarily unavailable" (`AI_PROVIDER_OUTAGE`) | Provider outage, network/DNS, or base-URL typo | Check provider status page, egress firewall, `OPENAI_BASE_URL` |
| "returned an answer that could not be used" (`AI_MALFORMED_RESPONSE`) | Model produced invalid JSON twice | Retry; check `AI_MAX_OUTPUT_TOKENS` isn't too low (truncation); consider the stronger model |
| "monthly AI usage limit" (`MONTHLY_LIMIT_REACHED`) | Cost or request limit hit | Review Usage; the operator raises it with `npm run ai:configure -- --client <id> --monthly-cost <₹>`; resets on the 1st |
| "daily AI limit" (`DAILY_LIMIT_REACHED`) | Per-user daily limit (users are warned at 70% and 90%) | `npm run ai:configure -- --client <id> --daily-user <n>` or wait until tomorrow. Provider failures do **not** count against this limit |
| "Too many AI requests" (`RATE_LIMITED`) | >40 requests/min from one user | Wait a minute |
| "Too many failed sign-in attempts" | >20 failed logins / 15 min from one IP | Wait; check for a wrong password or a script |
| Answer says "No matching records" | Nothing matches (or data is for another client) | Check the record in WhizUnik; see §3 |
| "I'm not sure what you're asking" | Question not classified | Use a suggested question; mention the department/record number |
| Dashboard shows a yellow "data only" banner | Provider failure or limit reached while generating the summary | Same fixes as above; the banner clears on the next refresh (degraded summaries are cached only 5 minutes) |
| "Please check" box with unverified figures | A figure in the AI text wasn't found in the retrieved data | Open the linked records; if repeated, review the model choice and report examples |
| Answer is missing something the user expects | Hidden for the role, truncated ("Showing 25 of N"), or outside the date range | Read **Missing or withheld data** and **Date range** on the answer |
| Source link shows "Record not found" | The record was deleted/renamed after the answer, or belongs to another client | Re-ask; verify the record number |

## 3. "The AI got it wrong" checklist

1. Open the answer's **source records** and compare the figures — the AI only restates retrieved data. If the record differs from the answer, capture the question, time and answer text.
2. Check the **assumptions** list (e.g. overdue = due date before today; sellable stock = on hand − reserved − quarantined − damaged; cash flow excludes overdue receivables).
3. Check the data itself in WhizUnik (is the invoice marked paid? is the PO date right?). Wrong answers are most often wrong or stale source data.
4. If wording was misleading, note the question and answer; the safe-language filter is conservative but heuristic.

## 4. Useful queries (SQLite)

```sql
-- last 20 AI requests with outcome and cost
SELECT created_at, user_id, role, category, status, model, processing_ms, input_tokens, output_tokens, est_cost_inr, flags
FROM ai_audit_log ORDER BY id DESC LIMIT 20;

-- this month's usage per client
SELECT client_id, COUNT(*) requests, ROUND(SUM(est_cost_inr),2) cost_inr
FROM ai_usage WHERE usage_date >= strftime('%Y-%m-01','now') AND status IN ('success','success_empty','provider_error')
GROUP BY client_id;

-- provider failures in the last day
SELECT created_at, model, status FROM ai_usage WHERE status = 'provider_error' AND created_at > datetime('now','-1 day');
```

Audit `status` values: `success`, `success_empty` (no matching records), `refused` (threat or action request), `unknown_question`, `forbidden`, `blocked_limit`, `provider_error`, `invalid`, `cached` (summary), `error` (unexpected — check server logs). Notable `flags`: `provider:INVALID_API_KEY` / `provider:PROVIDER_TIMEOUT` / `provider:PROVIDER_RATE_LIMIT` / `provider:PROVIDER_OUTAGE` / `provider:MALFORMED_RESPONSE` (which provider problem it was), `injection_suspected`, `action_request_refused`, `tool_blocked_by_role`, `truncated`, `malformed_retry`, `unsafe_claim_removed`, `ungrounded_numbers`, `unknown_ref_dropped`.

## 5. Operations

* **Rotate the provider key:** revoke at the provider → create a new key → update the secret → restart → `npm run ai:test-connection`.
* **Turn AI off for one client / role / everyone:** `npm run ai:configure -- --client <id> --disable` (or `--roles …`), or `AI_ENABLED=false` for everyone.
* **Change models or prices:** `AI_MODEL_FAST`, `AI_MODEL_STRONG`, `AI_PRICE_*` then restart. Costs shown are estimates; reconcile with the provider invoice.
* **Reset a stuck summary:** `DELETE FROM ai_summary_cache WHERE client_id = ?`.
* **Provider unreachable but you want a basic assistant:** `AI_PROVIDER=local` serves data-only answers with no external calls.

## 6. Escalate to engineering when

* `error`-status audit rows or `INTERNAL` errors appear;
* a user sees data that should belong to another company or role (treat as a security incident: disable AI for the client, preserve the audit log);
* answers cite records that do not exist, or the key appears in any log/response.
