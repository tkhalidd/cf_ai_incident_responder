# SRE-Copilot

> An AI-powered SRE incident response agent built entirely on Cloudflare — Llama 3.3 on Workers AI, Cloudflare Workflows, Durable Objects with SQLite, and WebSocket chat.

---

## What it does

Production incidents are chaotic. Engineers lose precious MTTA (mean-time-to-acknowledge) piecing together context across Slack threads, runbooks, and tribal knowledge that lives only in people's heads.

**SRE-Copilot** is a stateful AI agent that acts as a senior SRE co-pilot the moment an incident is opened:

1. **Automated triage pipeline** — a Cloudflare Workflow runs three sequential LLM steps (triage → diagnosis → runbook) with per-step retry, durable execution, and automatic callout back to the incident agent when complete.
2. **Interactive chat** — engineers talk to the agent in real time via WebSocket while the workflow runs. The AI has full incident context, streaming tokens as fast as Llama 3.3 produces them.
3. **Institutional memory** — every resolved incident is saved to a global Durable Object. Future incidents automatically surface similar past cases in the AI's system prompt — a lightweight RAG pattern without a vector database.

---

## Architecture

```
Browser (WebSocket + REST)
         │
         ▼
   Cloudflare Worker (router)
         │
         ├──► IncidentAgent  (Durable Object — one per incident)
         │         • SQLite: full conversation history + incident state
         │         • WebSocket connections for real-time streaming UI
         │         • Streams Llama 3.3 tokens token-by-token to chat
         │         • Receives workflow results via internal /workflow-complete
         │
         ├──► RemediationWorkflow  (Cloudflare Workflow)
         │         • Step 1 — Triage: classify severity, extract symptoms
         │         • Step 2 — Diagnose: ranked root-cause hypotheses with confidence scores
         │         • Step 3 — Action Plan: ordered runbook with owner roles
         │         • Step 4 — Notify: push results → IncidentAgent DO
         │         • Each step: 3 retries, exponential backoff
         │
         └──► IncidentMemory  (Durable Object — global singleton)
                   • SQLite: all resolved incidents
                   • Keyword similarity search across title, description, tags
                   • Top-3 similar incidents injected into every AI system prompt
```

### Required components — all covered

| Assignment requirement | Implementation |
|---|---|
| LLM | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via Workers AI, streamed |
| Workflow / coordination | `RemediationWorkflow` — Cloudflare Workflow with 4 durable steps |
| User input via chat | WebSocket (`WebSocketPair` in Durable Object), real-time token streaming |
| Memory / state | `IncidentAgent` (per-incident SQLite) + `IncidentMemory` (global history) |

---

## Project structure

```
SRE-Copilot/
├── src/
│   ├── index.ts        # Worker entry point — routing + inline HTML/JS UI
│   ├── agent.ts        # IncidentAgent Durable Object
│   ├── memory.ts       # IncidentMemory Durable Object (global incident knowledge base)
│   └── workflow.ts     # RemediationWorkflow (Cloudflare Workflow, 4 steps)
├── scripts/
│   ├── seed.ts                       # Pre-populate institutional memory with demo incidents
│   └── sample_incident_context.log   # Example log/metrics file to attach when opening an incident
├── wrangler.toml
├── package.json
├── tsconfig.json
├── worker-configuration.d.ts
├── README.md
└── PROMPTS.md          # All AI prompts with rationale and iteration notes
```

---

## Getting started

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) ≥ 3.99
- Node.js ≥ 18

### Install

```bash
git clone https://github.com/<your-username>/SRE-Copilot
cd SRE-Copilot
npm install
```

### Run locally

```bash
wrangler login   # once
npm run dev
# → http://localhost:8787
```

Workers AI runs live even in local dev — no API key needed.

### Seed demo data (optional but recommended)

```bash
# In a second terminal while dev is running:
npx tsx scripts/seed.ts http://localhost:8787
```

This loads 5 realistic past incidents into institutional memory so the AI can surface similar cases immediately when you open a new incident.

### Deploy to Cloudflare

```bash
npm run deploy
# Wrangler provisions Durable Objects, Workflow, and AI binding automatically.

# Seed production memory:
npx tsx scripts/seed.ts https://cf-ai-incident-responder.<your-subdomain>.workers.dev
```

---

## Usage walkthrough

1. Click **+ New Incident** in the sidebar.
2. Fill in the incident details. For example:
   - **Title:** `Database connection pool exhausted`
   - **Severity:** `P2 — High`
   - **Description:** `All API requests returning 503 after deploy v2.4.1`
   - **Attach Context (optional):** attach `scripts/sample_incident_context.log` — this includes error logs, metrics snapshots, deploy history, and Postgres connection state that the AI will use for deeper analysis.
3. Click **Open Incident**. The agent opens a WebSocket and immediately launches the `RemediationWorkflow`.
4. While the workflow runs (spinner in the toolbar), ask questions freely — the AI already has incident context and past similar cases.
5. When the workflow completes (~15–30s), a structured report appears:
   - **Triage** — severity classification, top symptoms, affected systems
   - **Root-cause hypotheses** — ranked with confidence scores and evidence
   - **Remediation runbook** — ordered steps with owner roles and estimated impact
6. Work through the runbook, asking the agent questions as you go.
7. Click **✓ Resolve**, enter the resolution summary. The incident is saved to institutional memory and will surface for similar future incidents automatically.

---

## Why this project / personal connection

During my internship at CGI, I built a Python-based root-cause analysis agent that integrated Grafana/Prometheus observability signals and reduced MTTA by 15% for Sev-1 incidents. This project rebuilds and extends that concept natively on Cloudflare's platform:

- **Cloudflare Workflows** provide durable, retryable multi-step coordination — if a step fails mid-triage, it retries automatically without losing progress.
- **Durable Objects with SQLite** give each incident its own stateful micro-server — no external databases, conversation history survives restarts and deploys.
- **Streaming Llama 3.3** via Workers AI delivers sub-second first-token latency — an engineer in an active P1 can't wait 10 seconds for a full response.
- **Institutional memory** compounds value over time: every resolved incident makes future incidents faster to resolve.

---

## Future improvements

- **Vectorize** — replace keyword search in `IncidentMemory` with embedding-based semantic retrieval for higher-recall similar-incident lookups.
- **Alert ingestion** — consume PagerDuty / Grafana webhook events to auto-open incidents without manual input.
- **MCP tool exposure** — expose triage and diagnosis as MCP tools so other agents can call this agent as a sub-component in a larger agentic system.
- **Browser Rendering** — scrape internal runbook URLs and inject their content into the AI context automatically.
- **Cloudflare Calls** — add voice input for reporting incidents hands-free during active firefighting.

---

## License

MIT
