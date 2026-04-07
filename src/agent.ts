import { DurableObject } from "cloudflare:workers";
import type { StoredIncident } from "./memory";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

interface IncidentState {
  id: string;
  agentName: string; // the idFromName key used to look up this DO
  title: string;
  severity: string;
  description: string;
  status: "open" | "investigating" | "resolved";
  workflowRunning: boolean;
  triage: string | null;
  diagnosis: string | null;
  actionPlan: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

/**
 * IncidentAgent — one Durable Object instance per active incident.
 *
 * Responsibilities:
 *   • Holds WebSocket connections for real-time chat UI
 *   • Persists full conversation history in SQLite
 *   • Launches the RemediationWorkflow and receives its output
 *   • Streams Llama 3.3 responses for free-form chat during investigation
 *   • Pulls similar past incidents from IncidentMemory before each AI call
 */
export class IncidentAgent extends DurableObject<Env> {
  private sql: SqlStorage;
  private sockets: Set<WebSocket> = new Set();
  private incidentState!: IncidentState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS incident_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Restore state if it exists
    const raw = this.sql
      .exec<{ key: string; value: string }>(
        `SELECT value FROM incident_state WHERE key = 'state'`
      )
      .toArray()[0];
    if (raw) {
      this.incidentState = JSON.parse(raw.value);
    }
  }

  private persistState(): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO incident_state (key, value) VALUES ('state', ?)`,
      JSON.stringify(this.incidentState)
    );
  }

  private addMessage(role: "user" | "assistant" | "system", content: string): void {
    this.sql.exec(
      `INSERT INTO messages (role, content, timestamp) VALUES (?, ?, ?)`,
      role,
      content,
      Date.now()
    );
  }

  private getHistory(): ChatMessage[] {
    return this.sql
      .exec<{ role: string; content: string; timestamp: number }>(
        `SELECT role, content, timestamp FROM messages ORDER BY id`
      )
      .toArray() as ChatMessage[];
  }

  private broadcast(payload: unknown): void {
    const msg = JSON.stringify(payload);
    for (const ws of this.sockets) {
      try {
        ws.send(msg);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }

  private async getSimilarIncidents(query: string): Promise<StoredIncident[]> {
    try {
      const memoryId = this.env.INCIDENT_MEMORY.idFromName("global");
      const memoryStub = this.env.INCIDENT_MEMORY.get(memoryId);
      const res = await memoryStub.fetch(
        `https://internal/search?q=${encodeURIComponent(query)}`
      );
      return await res.json<StoredIncident[]>();
    } catch {
      return [];
    }
  }

  private buildSystemPrompt(similar: StoredIncident[]): string {
    let prompt = `You are an expert SRE incident response assistant. 
You help engineers triage, diagnose, and resolve production incidents efficiently.
Be concise, technical, and action-oriented. 
Current incident: "${this.incidentState?.title}" | Severity: ${this.incidentState?.severity} | Status: ${this.incidentState?.status}.`;

    if (similar.length > 0) {
      prompt += `\n\nSIMILAR PAST INCIDENTS (institutional memory):\n`;
      for (const inc of similar) {
        prompt += `\n• [${inc.severity}] ${inc.title}
  Root cause: ${inc.rootCause}
  Resolution: ${inc.resolution}\n`;
      }
      prompt += `\nReference these when relevant to speed up resolution.`;
    }

    if (this.incidentState?.triage) {
      prompt += `\n\nAUTO-TRIAGE RESULTS:\n${this.incidentState.triage}`;
    }
    if (this.incidentState?.diagnosis) {
      prompt += `\n\nROOT-CAUSE HYPOTHESES:\n${this.incidentState.diagnosis}`;
    }
    if (this.incidentState?.actionPlan) {
      prompt += `\n\nREMEDIATION RUNBOOK:\n${this.incidentState.actionPlan}`;
    }

    return prompt;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ── WebSocket upgrade ───────────────────────────────────────────────
    if (request.headers.get("Upgrade") === "websocket") {
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      this.sockets.add(server);

      // Send current state immediately on connect
      if (this.incidentState) {
        server.send(
          JSON.stringify({ type: "state", incident: this.incidentState, history: this.getHistory() })
        );
      }

      server.addEventListener("message", async (evt) => {
        let msg: { type: string; [k: string]: unknown };
        try {
          msg = JSON.parse(evt.data as string);
        } catch {
          return;
        }

        if (msg.type === "init") {
          await this.handleInit(msg as { type: string; agentName: string; title: string; severity: string; description: string });
        } else if (msg.type === "chat") {
          await this.handleChat(msg.content as string);
        } else if (msg.type === "resolve") {
          await this.handleResolve(msg.resolution as string);
        }
      });

      server.addEventListener("close", () => this.sockets.delete(server));

      return new Response(null, { status: 101, webSocket: client });
    }

    // ── Internal: workflow completion callback ──────────────────────────
    if (request.method === "POST" && url.pathname === "/workflow-complete") {
      const body = await request.json<{
        incidentId: string;
        triage: string;
        diagnosis: string;
        actionPlan: string;
      }>();
      this.incidentState.triage = body.triage;
      this.incidentState.diagnosis = body.diagnosis;
      this.incidentState.actionPlan = body.actionPlan;
      this.incidentState.workflowRunning = false;
      this.incidentState.status = "investigating";
      this.persistState();

      const summary = this.formatWorkflowSummary(body.triage, body.diagnosis, body.actionPlan);
      this.addMessage("assistant", summary);
      this.broadcast({ type: "workflow-complete", incident: this.incidentState, message: { role: "assistant", content: summary, timestamp: Date.now() } });
      return Response.json({ ok: true });
    }

    // ── REST: get incident state ────────────────────────────────────────
    if (request.method === "GET" && url.pathname === "/state") {
      return Response.json({ incident: this.incidentState, history: this.getHistory() });
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleInit(msg: { type: string; agentName: string; title: string; severity: string; description: string }): Promise<void> {
    const id = msg.agentName;
    this.incidentState = {
      id,
      agentName: msg.agentName,
      title: msg.title,
      severity: msg.severity,
      description: msg.description,
      status: "open",
      workflowRunning: true,
      triage: null,
      diagnosis: null,
      actionPlan: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    this.persistState();

    const initMsg = `🚨 **Incident opened**: ${msg.title}\n**Severity**: ${msg.severity}\n\nLaunching automated triage pipeline... I'll analyze this incident and prepare a remediation runbook. You can ask me questions while the workflow runs.`;
    this.addMessage("assistant", initMsg);
    this.broadcast({ type: "state", incident: this.incidentState, history: this.getHistory() });

    // Launch the Cloudflare Workflow — pass agentName so the Workflow
    // can call back via INCIDENT_AGENT.idFromName(agentName)
    try {
      await this.env.REMEDIATION_WORKFLOW.create({
        params: {
          incidentId: id,
          title: msg.title,
          severity: msg.severity,
          description: msg.description,
          agentId: msg.agentName,
        },
      });
    } catch (e) {
      this.incidentState.workflowRunning = false;
      this.persistState();
      this.broadcast({ type: "error", message: `Workflow launch failed: ${e}` });
    }
  }

  private async handleChat(content: string): Promise<void> {
    this.addMessage("user", content);
    this.broadcast({ type: "message", message: { role: "user", content, timestamp: Date.now() } });

    // Pull similar incidents for context
    const similar = await this.getSimilarIncidents(`${this.incidentState?.title ?? ""} ${content}`);
    const systemPrompt = this.buildSystemPrompt(similar);
    const history = this.getHistory();

    const messages: { role: string; content: string }[] = [
      { role: "system", content: systemPrompt },
      ...history.slice(-20).map((m) => ({ role: m.role, content: m.content })),
    ];

    // Stream Llama 3.3 response
    this.broadcast({ type: "typing", value: true });
    try {
      const stream = await this.env.AI.run(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        { messages, max_tokens: 800, stream: true }
      ) as ReadableStream;

      let fullResponse = "";
      const reader = stream.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        // Parse SSE data lines
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ") && !line.includes("[DONE]")) {
            try {
              const data = JSON.parse(line.slice(6));
              const token = data.response ?? "";
              fullResponse += token;
              this.broadcast({ type: "token", token });
            } catch { /* skip malformed */ }
          }
        }
      }

      this.addMessage("assistant", fullResponse);
      this.broadcast({ type: "typing", value: false });
      this.broadcast({ type: "message-complete", content: fullResponse, timestamp: Date.now() });
    } catch (e) {
      this.broadcast({ type: "typing", value: false });
      this.broadcast({ type: "error", message: `AI error: ${e}` });
    }
  }

  private async handleResolve(resolution: string): Promise<void> {
    this.incidentState.status = "resolved";
    this.incidentState.resolvedAt = Date.now();
    this.persistState();

    // Extract root cause from diagnosis (best-effort JSON parse)
    let rootCause = "See diagnosis notes";
    if (this.incidentState.diagnosis) {
      try {
        const d = JSON.parse(this.incidentState.diagnosis);
        rootCause = d.hypotheses?.[0]?.cause ?? rootCause;
      } catch { /* use default */ }
    }

    // Persist to IncidentMemory for future retrieval
    try {
      const memoryId = this.env.INCIDENT_MEMORY.idFromName("global");
      const memoryStub = this.env.INCIDENT_MEMORY.get(memoryId);
      const incident: StoredIncident = {
        id: this.incidentState.id,
        title: this.incidentState.title,
        severity: this.incidentState.severity,
        description: this.incidentState.description,
        rootCause,
        resolution,
        timestamp: Date.now(),
        tags: this.incidentState.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
      };
      await memoryStub.fetch(
        new Request("https://internal/store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(incident),
        })
      );
    } catch { /* non-fatal */ }

    const msg = `✅ **Incident resolved.** Resolution recorded: "${resolution}"\n\nThis incident has been saved to institutional memory and will surface automatically for similar future incidents.`;
    this.addMessage("assistant", msg);
    this.broadcast({ type: "state", incident: this.incidentState, history: this.getHistory() });
    this.broadcast({ type: "message", message: { role: "assistant", content: msg, timestamp: Date.now() } });
  }

  // Workers AI may return a parsed object or a raw JSON string — handle both
  private parseAIOutput(raw: string): unknown {
    if (typeof raw !== "string") return raw;
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/,"").trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }

  private formatWorkflowSummary(triage: string, diagnosis: string, actionPlan: string): string {
    let out = "## 🤖 Automated Analysis Complete\n\n";

    const t = this.parseAIOutput(triage) as { severity?: string; symptoms?: string[]; affectedSystems?: string[] } | null;
    if (t && t.severity) {
      out += `### Triage\n- **Severity**: ${t.severity}\n- **Symptoms**: ${(t.symptoms ?? []).join(", ")}\n- **Affected Systems**: ${(t.affectedSystems ?? []).join(", ")}\n\n`;
    } else {
      out += `### Triage\n${triage}\n\n`;
    }

    const d = this.parseAIOutput(diagnosis) as { hypotheses?: { cause: string; confidence: number; evidence: string }[] } | null;
    if (d && d.hypotheses?.length) {
      out += `### Root-Cause Hypotheses\n`;
      for (const h of d.hypotheses) {
        out += `- **${h.cause}** (confidence: ${Math.round((h.confidence ?? 0) * 100)}%): ${h.evidence}\n`;
      }
      out += "\n";
    } else {
      out += `### Diagnosis\n${diagnosis}\n\n`;
    }

    const a = this.parseAIOutput(actionPlan) as { steps?: { priority?: string; owner: string; action: string; estimatedImpact: string }[] } | null;
    if (a && a.steps?.length) {
      out += `### Remediation Runbook\n`;
      for (const s of a.steps) {
        out += `${s.priority ?? ""}. **[${s.owner}]** ${s.action} — *${s.estimatedImpact}*\n`;
      }
    } else {
      out += `### Action Plan\n${actionPlan}`;
    }
    out += "\n\n_Ask me anything about this incident or start working through the runbook._";
    return out;
  }
}
