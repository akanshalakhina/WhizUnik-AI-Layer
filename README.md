# WhizUnik AI Layer (Multi-Tenant RAG)

A secure, company-isolated **Retrieval-Augmented Generation (RAG)** assistant for the WhizUnik operating platform. It answers operational, process, and financial queries using only approved company workflows, standard operating procedures (SOPs), verified Q&A, and live business data—without hallucinating or leaking data across tenants.

---

## Architecture Diagram

```mermaid
flowchart TD
    subgraph Client["Web Client (React + TypeScript)"]
        UI["Ask AI Screen / Knowledge Admin / Audit Log"]
    end

    subgraph Gateway["API Gateway & Security"]
        Auth["Auth & Session Layer (JWT)"]
        Scope["Tenant Resolver (Extracts tenantId & companyId)"]
    end

    subgraph RAG["WhizUnik RAG Engine"]
        NLP["NLP Classifier (Intent, Dept, Entities)"]
        Retriever["Filter-Before-Retrieval Engine"]
        LiveService["Live Business Data Service (ERP Balances)"]
        Generator["Grounded Response Synthesizer"]
    end

    subgraph Storage["Isolated Database (SQLite / Vector Store)"]
        Docs["rag_documents (Approved SOPs & Workflows)"]
        Chunks["rag_chunks (256-D Dense Semantic Vectors)"]
        StoredQA["rag_stored_responses (Verified Q&A)"]
        AuditDB["rag_audit_events & rag_conversations"]
    end

    subgraph LLM["Language Model Providers"]
        Gemini["Google Gemini (gemini-3.8-flash)"]
        OpenAI["OpenAI (gpt-4o / gpt-4o-mini)"]
        Fallback["Deterministic Grounded Engine (Offline Fallback)"]
    end

    UI -->|1. Question + Bearer Token| Auth
    Auth --> Scope
    Scope -->|2. Validated Tenant Scope| NLP
    NLP --> Retriever
    Retriever -->|3. Filter: tenantId + companyId + approved| Docs
    Retriever -->|4. Cosine Vector Search| Chunks
    Retriever -->|5. Exact Match Q&A| StoredQA
    NLP -.->|If live ERP query| LiveService
    Retriever -->|6. Verified Context Blocks| Generator
    LiveService -->|6b. Structured Balances| Generator
    Generator -->|7. Grounded Inference| Gemini
    Generator -.->|Optional Provider| OpenAI
    Generator -.->|Fallback on Quota/Outage| Fallback
    Generator -->|8. Grounded Answer + Citations| UI
    Generator -->|9. Async Trace & Cost Log| AuditDB
```

---

## User Flow Diagram

```mermaid
sequenceDiagram
    autonumber
    actor User as Authenticated User
    participant Web as WhizUnik Frontend
    participant API as Backend API
    participant RAG as Retrieval Engine
    participant Model as Hosted LLM (Gemini)

    User->>Web: Enters query (e.g. "How are damaged returns treated?")
    Web->>API: POST /api/v1/assistant/ask (Bearer Token)
    Note over API: Server derives tenantId & companyId from token.<br/>Never trusts client-supplied companyId.
    API->>RAG: Retrieve approved context (tenantId, companyId, approved_status='approved')
    
    alt Cross-Tenant Query or No Approved Documents Found
        RAG-->>API: Insufficient evidence (0 matching records)
        API-->>Web: "I could not find an approved answer for this company..."
        Web-->>User: Displays exact unavailable notification
    else Approved Company SOPs / Stored Q&A Match
        RAG-->>API: Top ranked context chunks + source document metadata
        API->>Model: Prompts with strict context boundaries & evidence rules
        Model-->>API: Grounded step-by-step response
        API-->>Web: Returns answer + validated citations + token metrics
        Web-->>User: Renders formatted answer with expandable source cards
        User->>Web: Clicks "Helpful" or "Report Correction"
        Web->>API: POST /api/v1/assistant/feedback (Audited)
    end
```

---

## Core Capabilities

1. **Strict Multi-Tenant Isolation:**
   Every query applies `WHERE tenant_id = ? AND company_id = ? AND approved_status = 'approved' AND is_deleted = 0` before vector ranking. Cross-company access is blocked at the database level.
2. **Hybrid Semantic Retrieval:**
   Combines 256-D normalized semantic vector similarity, token n-grams, keyword frequency ratios, and department/intent alignment boosts.
3. **Fail-Safe Hosted Generation:**
   Powered by **Google Gemini** (`gemini-3.8-flash`) via an OpenAI-compatible endpoint. Automatically falls back to an internal deterministic synthesizer if network errors or quota limits occur.
4. **Exact Unavailable Fallback:**
   If a user asks about unapproved policies or foreign company processes, the system returns:
   > *"I could not find an approved answer for this company. Please contact the relevant department or add this process to the company knowledge base."*
5. **Knowledge Base Governance & Audit:**
   Full UI at `/knowledge` for document upload, approval, version history, and verified Q&A creation. Comprehensive trace logs at `/audit` record request latency, tokens, cost, and cited source IDs.

---

## Demo Companies & Logins

Password for all accounts: **`Demo@12345`**

| Company | Email | Industry | Example Question |
|---|---|---|---|
| **RFB Latex** | `admin@rfblatex.demo`<br/>`returns@rfblatex.demo` | Medical gloves manufacturing | *"What is the process for damaged return goods?"*<br/>*"When is an invoice generated?"* |
| **Alpine Retail** | `admin@alpineretail.demo`<br/>`marketplace@alpineretail.demo` | E-commerce & marketplace | *"How is stock reserved for a marketplace order?"*<br/>*"How are marketplace returns handled?"* |
| **Demo Manufacturing Co.** | `admin@demomfg.demo`<br/>`warehouse@demomfg.demo` | Industrial equipment | *"How is a GRN created?"*<br/>*"How is material issued for production?"* |

*Try querying RFB Latex's Quarantine Bay Q-2 from an Alpine Retail session to verify cross-tenant blocking.*

---

## Quick Start

Requires **Node.js 20+**.

```bash
# 1. Install dependencies
npm install
npm run install:all

# 2. Seed demo companies, documents, and 21 standard questions
npm run seed

# 3. Start development servers (Backend :4000, Frontend :5173)
npm run dev

# 4. Run automated test suite (322 tests across 7 test files)
npm test
```

### Environment Configuration (`backend/.env`)

```env
PORT=4000
CORS_ORIGINS=http://localhost:5173
JWT_SECRET=change-me-in-production-use-a-long-random-string
DATABASE_PATH=./data/whizunik.db

# AI Provider Configuration (Google Gemini / OpenAI)
AI_PROVIDER=gemini
GEMINI_API_KEY=<your-key>
OPENAI_API_KEY=<your-key>
OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
AI_MODEL_FAST=gemini-3.8-flash
AI_MODEL_STRONG=gemini-3.8-flash
AI_TIMEOUT_MS=30000
```
