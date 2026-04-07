# PROMPTS.md

This file documents all AI prompts used in **cf_ai_incident_responder**, their rationale, and iteration notes.

---

## 1. Triage Prompt

**Where used:** `RemediationWorkflow` → Step 1 (`triage`)  
**Model:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast`

### System prompt

```
You are an expert SRE. Classify the incident severity (P1/P2/P3/P4),
list the top 3 symptoms, and identify affected systems.
Respond in JSON: { severity, symptoms: string[], affectedSystems: string[] }.
Return ONLY the JSON object, no prose.
```

### User prompt

```
Incident: {title}
Severity hint: {severity}
Description: {description}
```

### Rationale

- **Structured JSON output** is enforced via the system prompt to make downstream parsing deterministic. Without this constraint, Llama 3.3 wraps output in prose and markdown fences.
- **"Return ONLY the JSON object"** was added after observing the model prefixing responses with "Here is the JSON:" — this instruction eliminates that.
- **Severity hint** is passed in but not treated as ground truth — the model may upgrade or downgrade based on description content, which is intentional (operators often underestimate P1s).

### Iteration notes

- v1 asked for 5 symptoms; reduced to 3 to keep latency under 1s for P1 scenarios where speed matters.
- Originally asked for "affected services" — changed to "affectedSystems" to match SRE terminology and avoid ambiguity with microservice names.

---

## 2. Diagnosis Prompt

**Where used:** `RemediationWorkflow` → Step 2 (`diagnose`)  
**Model:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast`

### System prompt

```
You are a senior SRE performing root-cause analysis.
Given triage data, generate the top 3 root-cause hypotheses
with confidence scores (0–1).
Respond in JSON: { hypotheses: [{cause, confidence, evidence}] }.
Return ONLY the JSON object.
```

### User prompt

```
Triage output:
{triage.output}

Original description:
{description}
```

### Rationale

- **Chaining triage output** into the diagnosis prompt creates a reasoning chain — the model builds on structured evidence rather than re-reading raw prose. This is a lightweight chain-of-thought pattern without explicit CoT tokens.
- **Confidence scores** are deliberately 0–1 (not percentages or qualitative labels) to enable future sorting/filtering in UI without regex parsing.
- **"evidence"** field grounds each hypothesis — without it, the model generates plausible-sounding but unsubstantiated causes.

### Iteration notes

- v1 asked for "possible causes" — changed to "root-cause hypotheses" to prime the model for causal reasoning rather than symptom listing.
- Passing both triage output AND original description prevents the model from over-indexing on the structured triage and missing nuance in the description.

---

## 3. Action Plan Prompt

**Where used:** `RemediationWorkflow` → Step 3 (`action-plan`)  
**Model:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast`

### System prompt

```
You are a senior SRE writing a remediation runbook.
Produce an ordered list of concrete mitigation steps
with owner roles and estimated impact.
Respond in JSON: { steps: [{action, owner, estimatedImpact, priority}] }.
Return ONLY the JSON object.
```

### User prompt

```
Diagnosis:
{diagnosis.output}

Incident: {title}
Description: {description}
```

### Rationale

- **"Concrete mitigation steps"** prevents the model from producing vague guidance like "investigate the database." Early testing showed Llama 3.3 defaults to generic advice without this constraint.
- **"owner roles"** (not "owners") avoids the model hallucinating specific person names. "Database team", "On-call engineer" etc. are actionable without being fictitious.
- **"priority"** as a field (not just ordering) allows the UI to render steps in different visual styles and allows for future re-sorting.

### Iteration notes

- v1 asked for "steps to resolve" — this produced post-hoc steps rather than live mitigation. Changed to "mitigation steps" to shift the temporal frame.
- Adding `{title}` alongside `{diagnosis.output}` in the user prompt improved step relevance — without the title, the model sometimes generated generic steps from the diagnosis alone.

---

## 4. Interactive Chat System Prompt

**Where used:** `IncidentAgent.handleChat()` — every user message  
**Model:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (streaming)

### System prompt (constructed dynamically)

```
You are an expert SRE incident response assistant.
You help engineers triage, diagnose, and resolve production incidents efficiently.
Be concise, technical, and action-oriented.
Current incident: "{title}" | Severity: {severity} | Status: {status}.

SIMILAR PAST INCIDENTS (institutional memory):
• [P2] Database connection pool exhausted
  Root cause: Unbounded connection growth from ORM misconfiguration after deploy
  Resolution: Rolled back deploy, increased pool max, added connection leak alerting

[... up to 3 similar incidents ...]

Reference these when relevant to speed up resolution.

AUTO-TRIAGE RESULTS:
{triage JSON if available}

ROOT-CAUSE HYPOTHESES:
{diagnosis JSON if available}

REMEDIATION RUNBOOK:
{actionPlan JSON if available}
```

### Rationale

- **Dynamic context injection** means the system prompt grows richer as the incident progresses — once the Workflow completes, triage/diagnosis/runbook are injected automatically. The model always has the freshest structured data.
- **Institutional memory block** is injected from `IncidentMemory.search()` results, scoped to the top 3 similar past incidents. This is a lightweight RAG pattern without a vector database — keyword overlap is sufficient for incident titles/descriptions which tend to be specific.
- **"Be concise, technical, and action-oriented"** was the single biggest quality improvement over the base model — without it, Llama 3.3 produces explanatory text appropriate for learning, not for a stressed on-call engineer.
- **Conversation history** is sliced to the last 20 messages (`slice(-20)`) to keep within context limits while preserving immediate thread continuity.

### Iteration notes

- v1 injected the full incident description in every turn — dropped to reference via system prompt only, reducing prompt tokens by ~30%.
- Tried placing institutional memory after triage/diagnosis — moved it before them so it primes the model's reasoning before it sees the structured data.
- "Reference these when relevant" was added after observing the model ignoring the past incidents block when it appeared without explicit instruction to use it.

---

## General prompt engineering principles applied

1. **JSON-first outputs for Workflow steps** — structured data is more reliable to parse than prose; `"Return ONLY the JSON object"` is the minimal reliable constraint for Llama 3.3.

2. **Chaining over repeating** — each Workflow step receives the previous step's output rather than re-reading the raw incident. This builds a reasoning chain and reduces prompt size.

3. **Role priming before task** — "You are an expert SRE..." before any task description consistently improves output quality and reduces hedging language.

4. **Temporal framing** — "mitigation steps" vs "resolution steps" changes what the model thinks its time horizon is. Small word choices have large effect on output character.

5. **Streaming for latency** — chat responses are streamed token-by-token via the Workers AI streaming API. This makes P99 latency irrelevant to perceived responsiveness — the engineer sees output start within ~200ms.
