# PDF compliance check

How the build lines up with *"WhizUnik AI Layer — Context, Architecture, Development Tasks and Deliverables"*. Section numbers are the PDF's. For a plain-language version of the PDF itself, read [`PDF_EXPLAINED.md`](PDF_EXPLAINED.md).

**How this was checked.** After building, an *independent* reviewer (a separate AI agent) was given only the PDF text and the source code — not these documents — and asked to list every gap, every difference and everything implemented that the PDF does not ask for. Its findings were checked by hand against the PDF; each is listed below as **fixed**, **kept (with reason)** or **open**.

Legend: ✅ met · ⚠️ met with a stated limitation · ➖ outside Phase 1 / not applicable

---

## A. Requirement-by-requirement

| PDF section | Requirement | Status | Where / how |
|---|---|---|---|
| 1 | Advisory only; must not bypass approval, inventory, finance or accounting controls | ✅ | AI tools use a read-only DB connection; action requests refused; no write path |
| 2 | Works across all workflows; WhizUnik's DB is the source of truth; no second data system | ⚠️ | No WhizUnik code was supplied, so a **stand-in** schema/seed/login/record viewer exists. The AI reads only that one database. Replace it with the real WhizUnik data access (see C) |
| 3 | Hosted AI API (OpenAI); do not train a private model | ⚠️ | `ai-provider.openai.ts`. **Production now defaults to `openai`**; the offline engine is the development default / fallback. **Not run against the live API** (no key) |
| 3 | Cheaper model for routine; stronger for complex management analysis **and document review** | ⚠️ | Routing: strong model only for management-category questions or ≥3-tool analysis (was too broad — fixed). **Document review is not built**: nothing in Phase 1 involves documents |
| 3 | Never modify financial/inventory records in Phase 1 | ✅ | `openReadOnlyDb` (`query_only`); fingerprint test over every business table |
| 4 | Core workflow (identify user + client → permissions → retrieve relevant records → AI → explanation + recommendation → workflow → approvals) | ✅ | `ai-assistant.service.ts › ask()` |
| 5 | Management assistant (all 9 bullets) | ✅ | summary + `getOpenSalesOrders`, `getLowStockProducts`, `getDelayedPurchaseOrders`, `getPendingWarehouseTasks`, `getOverdueInvoices`, `getCashFlowSummary`, `getMarketplaceExceptions` |
| 5 | SKU & inventory intelligence (reorder, fast/slow, stock-out, duplicates, SKU-mapping problems, unusual movements) | ✅ | `getLowStockProducts` sections; unmapped SKUs in the marketplace tool |
| 5 | Procurement intelligence (purchase recs, delivery delays, price comparison, unusual increases, shortage warnings) | ✅ | `getDelayedPurchaseOrders` + reorder section |
| 5 | Sales intelligence (delayed SOs, high-value opportunities, unusual discounts, blocked-order explanations, follow-ups) | ⚠️ | All present. "High-value opportunities" = open orders ≥ ₹5 lakh (no quote/pipeline data exists to do more) |
| 5 | Warehouse intelligence (picking priority, dispatch deadlines, workload, discrepancies, damaged/quarantined) | ✅ | `getPendingWarehouseTasks` |
| 5 | Finance intelligence (cash flow, overdue balances, supplier payments, **expected vs received settlements**, receivable/payable summaries) | ✅ | Settlements were previously unreachable from a Finance question without the word "marketplace" — **fixed** (routing + category) |
| 5 | Marketplace intelligence (unmapped SKUs, waiting for stock/invoice, API failures, return risk, settlement differences) | ✅ | `getMarketplaceExceptions` |
| 6 | Separate AI layer; files `ai-assistant.service.ts`, `ai-data-tools.service.ts`, `routes/ai-assistant.ts` | ✅ | same names and locations |
| 6 | `POST /api/ai/ask` with `{answer, items, sources, usage{inputTokens, outputTokens}}` | ✅ | Response is a superset (adds category, figures, dateRange, assumptions, missingData, recommendedActions, warnings, usageStatus) because section 10 requires figures/date range/assumptions |
| 7 | The 7 named tools; each takes the client id, returns only that client's data, only required fields, applies role restrictions, excludes passwords/tokens/unnecessary personal data | ✅ | Two extra tools (`getSalesOrderDetail` for "Why is SO-1021 blocked?", `getPendingApprovals` for the Checker role). Hardened after review: database free text is redacted (e-mails, phones, tokens, IDs) and approval submitters' names are no longer sent |
| 8 | Role table — Management / Sales / Procurement / Warehouse / Finance / Checker | ✅ | Applied **literally** after review (see B). Enforced on the backend |
| 9 | AI Management Summary panel with the 7 listed contents; every recommendation links to the record | ✅ | `ai-summary.service.ts`, `Dashboard.tsx` (plus a "Pending approvals" panel for the Checker role) |
| 10 | Natural-language search; answer includes explanation, figures, date range, assumptions, source records, workflow link | ✅ | `AnswerView.tsx`; all 5 sample questions tested |
| 11 · T1 | Provider config: account, model, secure env var, dev/prod config, connection test; key never in frontend; invalid key → clear backend error | ⚠️ | Env-based config; `npm run ai:test-connection` and `GET /api/ai/health` now check **both** models. Creating the OpenAI account is yours |
| T2 | AI service: prompt, model selection, call, validation, timeout, failure handling | ✅ | `ai-assistant.service.ts`, `ai-prompt.ts` |
| T3 | Route: auth (401), validation (400), structured + error responses, registration | ✅ | |
| T4 | Data tools + unit tests; no cross-client data; empty results handled | ✅ | `tools.test.ts` |
| T5 | Classification into 8 categories; tool-selection rules; unknown handling; only approved tools per category | ✅ | `ai-classifier.service.ts`, `ToolGate` |
| T6 | Permission matrix, backend enforcement, permission tests | ✅ | |
| T7 | Management Summary: API, panel, refresh, loading/error, links | ✅ | |
| T8 | Search: input, answer display, source links, per-user history, empty/error states; answers only from retrieved data; missing data disclosed | ✅ | |
| T9 | Usage tracking (9 fields); monthly client limit; daily user limit; 70% / 90% warnings; limit-reached response; usage dashboard | ✅ | 70/90 warnings now also apply to the **daily** limit (were monthly only) |
| T10 | Audit log (8 fields); no keys / unnecessary sensitive data | ✅ | Provider failures now carry a `provider:<CODE>` flag |
| T11 | Safe response rules (no invented numbers, show assumptions, recommend workflow, never claim an action) | ⚠️ | Claim filter strengthened after review. It is heuristic — see Known limitations |
| T12 | Failure handling (invalid key, timeout, rate limit, outage, empty, too many records, malformed, limit reached); never block normal operations | ✅ | Failures no longer count against a user's request limits |
| T13 | Security testing (8 areas) | ✅ | [`SECURITY_TEST_REPORT.md`](SECURITY_TEST_REPORT.md) |
| T14 | Functional testing: data, results, limitations, screenshots | ✅ | [`FUNCTIONAL_TEST_REPORT.md`](FUNCTIONAL_TEST_REPORT.md) (answers come from the offline engine; the live model was not run) |
| T15 | Production readiness: key, monthly limit, roles, audit, usage, isolation, failure handling, **feature flag**, support docs, rollback | ✅ | New clients now start with AI **off**; flag/roles/limits set by the operator (`npm run ai:configure`) |
| 12 | Cost planning: cache daily summaries, user + client limits, cheap model by default, advanced plan | ⚠️ | All implemented except plan-specific behaviour: `clients.plan` is stored but does not change anything (the PDF defines no Phase 1 plan differences) |
| 13 | Phase 1 exclusions (nine things the AI must not do) | ✅ | No write capability exists; refusals tested for each |
| 14 | The 14 final deliverables | ✅ | See README table |
| 15 | Definition of success (8 points) | ✅ / ⚠️ | "Source records linked" points at the stand-in record viewer until real WhizUnik screens are wired |

---

## B. What the review found and what was done

**Fixed — these were departures from the PDF or weak spots:**

| # | Finding | Why it mattered | Fix |
|---|---|---|---|
| 1 | **Checker** could use the sales-order tools (and via order detail see customer credit/overdue balances) | PDF: Checker = *pending approvals and exceptions* only; credit data is finance data | Checker's only AI data tool is `getPendingApprovals`; removed Checker's sales-order/PO record access and credit-limit field |
| 2 | **Sales** had the marketplace tool; **Finance** had the whole tool | PDF assigns marketplace operations to no role except *settlements* → Finance | Sales: none. Finance: orders waiting for an invoice + settlement differences only. Management: everything |
| 3 | A **client could raise its own limits** and switch itself on | The ₹50k plan relies on fair-use limits (section 12); Task 15 makes enabling a go-live step | Write route removed; settings are operator-only (`npm run ai:configure`); the Settings screen is read-only |
| 4 | AI was **ON for every role by default** for new clients | Task 15: the feature flag is enabled *after* checks | New clients: AI off, management-only. Only the two demo clients are switched on by the seed |
| 5 | **Offline engine was the production default** | PDF section 3: hosted AI | Production defaults to `openai`; startup warns if `local` is used in production |
| 6 | Strong (costly) model used for any "why/explain/risk" question | PDF: stronger model only for complex management analysis | Strong model only for management-category or ≥3-tool questions |
| 7 | Claim filter bypass ("Payment completed; please verify.") | Task 11 | Negation counts only directly before the claim; added record-reference and payment patterns |
| 8 | E-mails/phones/tokens in database free text were sent to the model | Section 7: exclude unnecessary personal data | Redacted before sending; submitters' names removed |
| 9 | Finance couldn't reach settlement data without saying "marketplace" | Section 5 finance intelligence | Routing + category fixed |
| 10 | Daily limit had no 70/90 warnings | Task 9 | Added (API + banner) |
| 11 | Provider failures: no log/flag; counted against users | Task 12 | `provider:<CODE>` audit flag + log line; failures don't use request limits (tokens still count as cost) |
| 12 | All-pairs duplicate check ran on every inventory call | Task 12: AI must not stall the platform | Only when asked, per category, precomputed, size-capped |
| 13 | "Update me on SO-1021" / "Create a summary…" refused as actions | Over-refusal | Read-style phrasings are allowed |
| 14 | "Above ₹X" used ≥ for orders, > for invoices | Consistency | Strict "greater than" everywhere |
| 15 | Provider test checked only the routine model | Task 1 | Checks both models |
| 16 | Stored answers readable after AI was switched off | Least privilege | History requires AI enabled for the company and role |
| 17 | Demo data seeded whenever `NODE_ENV` wasn't "production" | Safe defaults | Demo data only with explicit `DEMO_MODE=true` |

**Kept deliberately (with reasons):**

* **Two extra tools** (order detail, approvals): needed for section 10's example question and the Checker role in section 8.
* **Offline rules engine** as development default and data-only fallback: the PDF doesn't ask for it, but it lets the app run without a key and gives the "AI failure must not block anything" behaviour real content. It is clearly labelled in the UI and warned about in production.
* **Extra response fields**, `/api/ai/status|permissions|audit|usage|history` endpoints, rate limiting, read-only record viewer: supporting pieces for sections 9, 10, Tasks 8–10, 13.
* **Staff/team labels in warehouse workload** (`assigned_to`): section 5 asks for "warehouse workload"; use team names rather than personal names in the real data.
* **Management sees every user's question text in the usage log**: Task 9 requires tracking the question; questions are redacted for secrets/identifiers before storage.

**Open (need your decision or real WhizUnik access):**

1. **Replace the stand-in platform** (schema, seed, login, record screens) with WhizUnik's real data access and deep links — the biggest remaining gap against section 2.
2. **Run against the live OpenAI API** and re-run the functional and prompt-injection scenarios with the real model.
3. **Document review** (section 3) is not built — nothing in the Phase 1 feature list needs it.
4. **Plan gating** (Standard / Intelligence / Enterprise) is commercial packaging only.
5. If the audit-log write fails the user's answer is still returned (the failure is logged loudly). Say if you prefer to fail closed.
6. Safe-language and numeric-grounding checks are heuristic (see the security report).
