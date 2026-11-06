# The PDF explained in plain language

*"WhizUnik AI Layer — Context, Architecture, Development Tasks and Deliverables"* (15 pages). This page explains what it asks for, section by section, without jargon. The section numbers match the PDF.

---

## The big idea in one paragraph

WhizUnik is a platform a business uses to run itself: products, buying, selling, stock, warehouse, approvals, money, online marketplaces, accounting. The PDF asks for an **AI assistant on top of it**. The assistant **reads** WhizUnik's data, **explains** what is going on, **points out** what needs attention and **recommends** what to do next. It **does not do anything itself**: it cannot approve, pay, change stock or create documents. People still do those things in WhizUnik, through the normal approval steps.

Think of it as a very quick analyst who is allowed to read the company's books but is never allowed to pick up the pen.

---

## 1. Purpose
* The AI is **advisory only** at first. It must not get around the existing approval, inventory, finance or accounting controls.
* It should help management and departments understand four things: **what is happening, what needs attention, what may happen next, which action to take.**

## 2. Product context
* WhizUnik covers: SKU/portfolio management, procurement, sales, inventory, warehouse, checker approvals, finance and treasury, marketplace operations, Tally integration.
* The AI must work across all of these, but it must **not create a second data system**. **WhizUnik's own database stays the single source of truth.**

## 3. Recommended AI approach
* Use a **hosted AI service** such as the OpenAI API. **Do not build or train a private AI model** at the start.
* Use a **cheaper model** for routine summaries and searches and a **stronger model** for complex management analysis and document review (to control cost).
* **Facts come from the WhizUnik database. The AI only explains and recommends. Approvals and actions stay in the existing WhizUnik workflows.**
* In Phase 1 the AI must **never directly modify important financial or inventory records.**

## 4. Core workflow (what happens when someone asks a question)
1. User asks a question.
2. WhizUnik works out **who the user is and which client (company) they belong to**.
3. WhizUnik **checks their permissions**.
4. WhizUnik **retrieves only the relevant records**.
5. The AI **analyses just that selected data**.
6. The AI returns an **explanation and a recommendation**.
7. The user **opens the relevant WhizUnik workflow**.
8. The **existing approval process** is followed.

Example in the PDF: *"Which orders need attention today?"* → "SO-1021 is waiting for stock, SO-1025 is waiting for customer approval, SO-1028 is waiting for warehouse dispatch. Recommended action: open the Sales and Warehouse queues."

## 5. Initial AI features (what it should be able to do)
* **Management assistant** — daily business summary; sales, stock, procurement and warehouse risks/delays; overdue collections; supplier payment obligations; marketplace settlement differences; a "What needs attention today?" answer.
* **SKU and inventory** — reorder recommendations, fast/slow-moving SKUs, stock-out risk, duplicate products, marketplace SKU mapping problems, explanations of unusual stock movements.
* **Procurement** — purchase recommendations, supplier delivery delays, supplier price comparisons, unusual price increases, stock shortage warnings.
* **Sales** — delayed sales orders, high-value opportunities, unusual discounts, why an order is blocked, which customers to follow up.
* **Warehouse** — picking priorities, dispatch deadline warnings, workload, stock discrepancies, damaged/quarantined stock.
* **Finance** — cash-flow explanations, overdue customer balances, upcoming supplier payments, expected vs received marketplace settlements, receivable and payable summaries.
* **Marketplace** — unmapped marketplace SKUs, orders waiting for stock, orders waiting for invoices, API failures, return-risk, settlement differences.

## 6. Technical architecture
* Create a **separate AI layer** in the backend, with three suggested files: `ai-assistant.service.ts`, `ai-data-tools.service.ts`, and the route `ai-assistant.ts`.
* One endpoint: **`POST /api/ai/ask`**. You send `{ "question": "…" }`; you get back `{ "answer", "items", "sources", "usage": { "inputTokens", "outputTokens" } }`.

## 7. Approved data tools (how the AI is kept on a short leash)
* The AI must **not get free access to the database**. Instead there is a short list of **controlled functions**: `getOpenSalesOrders`, `getOverdueInvoices`, `getLowStockProducts`, `getDelayedPurchaseOrders`, `getPendingWarehouseTasks`, `getMarketplaceExceptions`, `getCashFlowSummary`.
* Every one must: take the logged-in client's id; return **only that client's data**; return **only the fields needed**; **apply role restrictions**; and **leave out passwords, tokens and unnecessary personal data**.

## 8. Role-based access
| Role | What the AI may use for them |
|---|---|
| Management | Cross-department summaries |
| Sales | Sales orders, customers and collections |
| Procurement | Suppliers, Purchase Orders and purchasing |
| Warehouse | Stock, dispatch and warehouse tasks |
| Finance | Invoices, receipts, settlements and cash flow |
| Checker | Pending approvals and exceptions |

Rule: **the backend must enforce this. Hiding things in the screen is not security.**

## 9. "AI Management Summary" dashboard panel
A panel showing sales risks, stock risks, procurement delays, overdue payments, warehouse delays, marketplace exceptions and **recommended next actions**. **Every recommendation must link to the original WhizUnik record.**

## 10. Natural-language search
Users type questions such as *"Which invoices above ₹1 lakh are overdue?"*, *"What stock may run out this month?"*, *"Which Purchase Orders are delayed?"*, *"Why is SO-1021 blocked?"*, *"Which marketplace orders are waiting for an invoice?"*. Each answer must include: the **explanation, relevant figures, date range, assumptions, source records, and a link to the relevant workflow.**

## 11. The 15 development tasks
| # | Task | In everyday words |
|---|---|---|
| 1 | Configure the AI provider | Get the OpenAI account/key, choose the model, store the key safely on the server (never in frontend code), test the connection. A wrong key must give a clear backend error. |
| 2 | Build the AI service | The code that builds the prompt, picks the model, calls the AI, checks the reply, handles timeouts and provider failures — without crashing the platform. |
| 3 | Build the API route | `POST /api/ai/ask`: login required (401 if not), bad questions get 400, structured replies and errors. |
| 4 | Build the approved data tools | The seven controlled functions + unit tests. No data from other clients; empty results handled. |
| 5 | Question classification | Sort each question into sales / procurement / inventory / warehouse / finance / marketplace / management / unknown; the AI may only use tools approved for that category. |
| 6 | Roles and permissions | The permission table, enforced on the backend, with tests that finance data can't leak to the wrong people or clients. |
| 7 | Management Summary | The dashboard panel with a refresh button, loading/error states and links to records. |
| 8 | Natural-language search | The search box, answer display, source links, the user's own search history, empty/error states. Answers only from retrieved data; missing data is clearly disclosed. |
| 9 | Usage tracking | Record client, user, question, time, model, tokens, estimated cost, status. Monthly client limit, daily user limit, warnings at 70% and 90%, a "limit reached" message, and a usage dashboard. |
| 10 | AI audit logging | Log who, which client, question category, tools used, model, status, time, usage — but **no API keys or unnecessary sensitive data**. |
| 11 | Safe response rules | Don't invent numbers; say when information is missing; show assumptions; recommend the right workflow; **never claim an action was done** ("Payment completed", "Stock adjusted", "Purchase Order approved", "Invoice submitted") unless WhizUnik confirms it. |
| 12 | Failure handling | Handle: invalid key, timeout, rate limit, outage, empty results, too many records, malformed reply, usage limit reached. AI failure must **never block normal WhizUnik work**. |
| 13 | Security testing | Test cross-client access, role bypass, prompt injection, key exposure, sensitive-data leaks, unauthorised tool calls, huge responses, malicious questions. |
| 14 | Functional testing | Run the 7 sample questions; deliver test data, results, known limitations, screenshots/recordings. |
| 15 | Production readiness | Before switching a client on: production key, monthly limit, permitted roles, audit and usage checked, data isolation checked, failure handling checked, feature flag on, support docs and rollback instructions ready. |

## 12. Cost planning
AI usage costs money depending on how much text goes in and out and on the model chosen (estimates only; check current prices before launch).
| Usage | Approximate AI cost |
|---|---|
| Small pilot | ₹500–₹2,000 / month |
| Normal client | ₹2,000–₹8,000 / month |
| Heavy analysis and documents | ₹10,000–₹30,000+ / month |

For the ₹50,000/month plan: include AI under fair-use limits, use the cheap model by default, the strong model only when needed, **cache daily summaries**, limit requests per user and per client, and sell advanced AI as a higher plan. Suggested packages: **Standard ₹50,000/month** (controlled AI summaries, alerts, natural-language search); **Intelligence ₹65,000–₹75,000/month** (higher usage, advanced forecasting, document analysis); **Enterprise** (custom pricing: large data, multiple companies, custom integrations).

## 13. What the AI must NOT do in Phase 1
Approve Purchase Orders · approve payments · modify inventory · create invoices · create credit notes · confirm dispatch · submit IRN or E-Way Bill · alter accounting records · delete or overwrite platform data. These may only be considered **after** the read-only assistant has been tested and approved.

## 14. Final deliverables (14 items)
1 AI backend service · 2 `/api/ai/ask` endpoint · 3 approved data tools · 4 role-based permissions · 5 AI Management Summary · 6 natural-language search · 7 usage tracking · 8 audit logging · 9 error handling · 10 security tests · 11 functional test report · 12 deployment checklist · 13 client usage guide · 14 support troubleshooting guide.

## 15. Definition of success
Phase 1 is done when: users can ask operational questions · answers are based on WhizUnik data · source records are linked · users see only permitted data · **no financial or inventory record is changed by AI** · usage is controlled and measurable · all requests are auditable · AI failure does not interrupt normal workflows.

**Positioning line (end of the PDF):** *"An intelligent control layer over the operating platform that explains what is happening, identifies what needs attention and recommends the next action — while WhizUnik's existing approval and workflow controls remain in charge."*
