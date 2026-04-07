import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";

export interface RemediationParams {
  incidentId: string;
  title: string;
  severity: string;
  description: string;
  agentId: string;
}

interface WorkflowStepResult {
  step: string;
  output: string;
  timestamp: number;
}

/**
 * RemediationWorkflow — a durable multi-step Cloudflare Workflow.
 *
 * Steps:
 *   1. triage      — classify severity and extract symptoms
 *   2. diagnose    — generate root-cause hypotheses via Llama 3.3
 *   3. action-plan — produce a prioritised runbook
 *   4. notify      — push structured results back to the IncidentAgent DO
 *
 * Each step retries automatically on failure (Workflow guarantee).
 */
export class RemediationWorkflow extends WorkflowEntrypoint<Env, RemediationParams> {
  async run(event: WorkflowEvent<RemediationParams>, step: WorkflowStep): Promise<void> {
    const { incidentId, title, severity, description, agentId } = event.payload;

    // ── Step 1: Triage ──────────────────────────────────────────────────
    const triage = await step.do<WorkflowStepResult>(
      "triage",
      { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
      async () => {
        const result = await this.env.AI.run(
          "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          {
            messages: [
              {
                role: "system",
                content:
                  "You are an expert SRE. Classify the incident severity (P1/P2/P3/P4), " +
                  "list the top 3 symptoms, and identify affected systems. " +
                  "Respond in JSON: { severity, symptoms: string[], affectedSystems: string[] }. " +
                  "Return ONLY the JSON object, no prose.",
              },
              {
                role: "user",
                content: `Incident: ${title}\nSeverity hint: ${severity}\nDescription: ${description}`,
              },
            ],
            max_tokens: 300,
          }
        ) as { response: unknown };

        return {
          step: "triage",
          output: typeof result.response === "string" ? result.response : JSON.stringify(result.response),
          timestamp: Date.now(),
        };
      }
    );

    // ── Step 2: Diagnose ────────────────────────────────────────────────
    const diagnosis = await step.do<WorkflowStepResult>(
      "diagnose",
      { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
      async () => {
        const result = await this.env.AI.run(
          "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          {
            messages: [
              {
                role: "system",
                content:
                  "You are a senior SRE performing root-cause analysis. " +
                  "Given triage data, generate the top 3 root-cause hypotheses " +
                  "with confidence scores (0–1). " +
                  "Respond in JSON: { hypotheses: [{cause, confidence, evidence}] }. " +
                  "Return ONLY the JSON object.",
              },
              {
                role: "user",
                content: `Triage output:\n${triage.output}\n\nOriginal description:\n${description}`,
              },
            ],
            max_tokens: 500,
          }
        ) as { response: unknown };

        return {
          step: "diagnose",
          output: typeof result.response === "string" ? result.response : JSON.stringify(result.response),
          timestamp: Date.now(),
        };
      }
    );

    // ── Step 3: Action Plan ─────────────────────────────────────────────
    const actionPlan = await step.do<WorkflowStepResult>(
      "action-plan",
      { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
      async () => {
        const result = await this.env.AI.run(
          "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          {
            messages: [
              {
                role: "system",
                content:
                  "You are a senior SRE writing a remediation runbook. " +
                  "Produce an ordered list of concrete mitigation steps " +
                  "with owner roles and estimated impact. " +
                  "Respond in JSON: { steps: [{action, owner, estimatedImpact, priority}] }. " +
                  "Return ONLY the JSON object.",
              },
              {
                role: "user",
                content: `Diagnosis:\n${diagnosis.output}\n\nIncident: ${title}\nDescription: ${description}`,
              },
            ],
            max_tokens: 600,
          }
        ) as { response: unknown };

        return {
          step: "action-plan",
          output: typeof result.response === "string" ? result.response : JSON.stringify(result.response),
          timestamp: Date.now(),
        };
      }
    );

    // ── Step 4: Push results back to the IncidentAgent DO ──────────────
    await step.do(
      "notify-agent",
      { retries: { limit: 5, delay: "2 seconds" } },
      async () => {
        const agentStub = this.env.INCIDENT_AGENT.get(
          this.env.INCIDENT_AGENT.idFromName(agentId)
        );
        await agentStub.fetch(
          new Request("https://internal/workflow-complete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              incidentId,
              triage: triage.output,
              diagnosis: diagnosis.output,
              actionPlan: actionPlan.output,
            }),
          })
        );
        return { ok: true };
      }
    );
  }
}
