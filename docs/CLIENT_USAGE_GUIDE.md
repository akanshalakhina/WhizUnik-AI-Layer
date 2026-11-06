# WhizUnik AI — client usage guide

WhizUnik AI is an **intelligent control layer over the operating platform**. It explains what is happening, identifies what needs attention and recommends the next action — while WhizUnik's existing approval and workflow controls remain in charge.

## What it does — and does not do

| ✅ It can | ❌ It cannot |
|---|---|
| Summarise what needs attention today | Approve purchase orders or payments |
| Explain why an order is blocked or waiting | Adjust stock or change inventory |
| List overdue invoices, delayed POs, stock at risk, warehouse delays, marketplace exceptions | Create invoices or credit notes |
| Explain expected cash flow and settlement differences | Confirm dispatch, submit IRN / E-Way Bill |
| Recommend which WhizUnik screen to open next | Change, delete or overwrite any record |

It only reads **your company's** WhizUnik data, and only the data your role is allowed to see.

## The AI Management Summary (Dashboard)

The dashboard opens with the **AI Management Summary**: an overview, headline figures, and panels for *Sales risks, Stock risks, Procurement delays, Overdue payments, Warehouse delays, Marketplace exceptions* and *Pending approvals*, followed by **Recommended next actions**.

* Every line links to the original WhizUnik record. Click the title to open it.
* **↻ Refresh** regenerates the summary. Otherwise it is kept for the day (up to a few hours) to save usage.
* Panels marked 🔒 are not part of your role; their data is never sent to your browser.
* A yellow banner means the AI analysis was unavailable (or your limit was reached) and you are seeing the data-only version. Nothing else is affected.

## Asking questions (Ask WhizUnik AI)

Type a question or click an example. Good questions are specific and use business words:

* *Which sales orders need attention today?*
* *Which invoices above ₹1 lakh are overdue?*
* *What stock may run out this month?*
* *Which Purchase Orders are delayed?*
* *Why is SO-1021 blocked?*
* *Which marketplace orders are waiting for an invoice?*
* *What is expected cash flow this month?*

Each answer shows:

1. **The explanation**, in plain language;
2. **Figures** that matter (amounts, counts);
3. **Date range** the answer covers (e.g. "this month = 5 Nov → 30 Nov");
4. **Records behind the answer**, ranked by severity (red = high, amber = medium, blue = low), each clickable;
5. **Recommended next actions** with a link to the right workflow;
6. **Assumptions** (for example "overdue means due date before today and an unpaid balance");
7. **Missing or withheld data** — if something is hidden for your role, or the list was cut ("Showing 25 of 67"), it says so;
8. **Source records** and, at the bottom, the model used and the estimated cost.

If the answer includes a **"Please check"** box, some figure could not be matched to WhizUnik data — open the linked record to confirm before relying on it.

### Tips

* Mention a record number (SO-1021, PO-3002, INV-5003) for record-specific questions.
* Use ₹ amounts like "above ₹1 lakh", periods like "today", "this week", "this month", "next 10 days".
* If you get *"I'm not sure what you're asking"*, try one of the suggested questions.
* Your **history** (right side) lists your own past questions; only you can see it. Click one to reopen the answer, or **Clear** to delete it.

## What you will see when something can't be answered

| Message | Meaning |
|---|---|
| "This data isn't available to your role" | The question needs data outside your role (for example Sales asking for cash flow). It tells you which roles can ask. |
| "No matching records" | Nothing in WhizUnik matches; the AI will not guess. |
| "I can't approve/pay/update anything…" | You asked the AI to act. It is advisory only: open the workflow it points to. |
| "Daily limit reached" / "Monthly limit reached" | Usage limits. They reset tomorrow / next month, or Management can raise them. The rest of WhizUnik keeps working. |
| "The AI service is unavailable…" | A temporary problem with the AI provider. You still get the matching records; try again later. |

## Usage and limits

**AI usage** shows how much of the monthly company allowance is used (warnings at **70%** and **90%**), your daily limit, tokens, estimated cost and recent requests. You are warned at **70%** and **90%** of your daily limit as well. Management also sees usage by person and the **audit log** (who asked what *category* of question, which data tools ran, outcome, time).

## For Management: settings (read-only)

*AI usage → Settings & provider* shows whether AI is on for your company, which roles may use it, the monthly cost and request limits and the daily per-user limit, and lets you test the provider connection. These settings control cost and access, so your WhizUnik administrator changes them — they cannot be edited from this screen. *Permissions* shows exactly which role can use which data tool.

## Role access

| Role | AI can use |
|---|---|
| Management | Cross-department summaries (including the full marketplace picture) |
| Sales | Sales orders, customers and collections |
| Procurement | Suppliers, Purchase Orders and purchasing; stock shortage warnings |
| Warehouse | Stock, dispatch and warehouse tasks |
| Finance | Invoices, receipts, settlements and cash flow (marketplace: orders waiting for an invoice and settlement differences) |
| Checker | Pending approvals and exceptions |
