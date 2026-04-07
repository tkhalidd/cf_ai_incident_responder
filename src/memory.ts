import { DurableObject } from "cloudflare:workers";

export interface StoredIncident {
  id: string;
  title: string;
  severity: string;
  description: string;
  rootCause: string;
  resolution: string;
  timestamp: number;
  tags: string[];
}

/**
 * IncidentMemory — global singleton Durable Object.
 * Stores resolved incidents in SQLite so the AI can surface
 * similar past incidents during triage (institutional memory).
 */
export class IncidentMemory extends DurableObject {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        severity TEXT NOT NULL,
        description TEXT NOT NULL,
        root_cause TEXT NOT NULL,
        resolution TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        tags TEXT NOT NULL
      )
    `);
  }

  async store(incident: StoredIncident): Promise<void> {
    this.sql.exec(
      `INSERT OR REPLACE INTO incidents
         (id, title, severity, description, root_cause, resolution, timestamp, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      incident.id,
      incident.title,
      incident.severity,
      incident.description,
      incident.rootCause,
      incident.resolution,
      incident.timestamp,
      JSON.stringify(incident.tags)
    );
  }

  /**
   * Naïve keyword similarity search — finds past incidents whose title,
   * description, or tags overlap with the query terms.
   * In production you'd replace this with Vectorize embeddings.
   */
  async search(query: string): Promise<StoredIncident[]> {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 3);

    const all = this.sql
      .exec<{
        id: string;
        title: string;
        severity: string;
        description: string;
        root_cause: string;
        resolution: string;
        timestamp: number;
        tags: string;
      }>(`SELECT * FROM incidents ORDER BY timestamp DESC LIMIT 50`)
      .toArray();

    const scored = all
      .map((row) => {
        const haystack =
          `${row.title} ${row.description} ${row.tags}`.toLowerCase();
        const score = terms.filter((t) => haystack.includes(t)).length;
        return { row, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    return scored.map(({ row }) => ({
      id: row.id,
      title: row.title,
      severity: row.severity,
      description: row.description,
      rootCause: row.root_cause,
      resolution: row.resolution,
      timestamp: row.timestamp,
      tags: JSON.parse(row.tags),
    }));
  }

  async list(): Promise<StoredIncident[]> {
    return this.sql
      .exec<{
        id: string;
        title: string;
        severity: string;
        description: string;
        root_cause: string;
        resolution: string;
        timestamp: number;
        tags: string;
      }>(`SELECT * FROM incidents ORDER BY timestamp DESC LIMIT 20`)
      .toArray()
      .map((row) => ({
        id: row.id,
        title: row.title,
        severity: row.severity,
        description: row.description,
        rootCause: row.root_cause,
        resolution: row.resolution,
        timestamp: row.timestamp,
        tags: JSON.parse(row.tags),
      }));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/store") {
      const body = await request.json<StoredIncident>();
      await this.store(body);
      return Response.json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/search") {
      const q = url.searchParams.get("q") ?? "";
      const results = await this.search(q);
      return Response.json(results);
    }
    if (request.method === "GET" && url.pathname === "/list") {
      return Response.json(await this.list());
    }
    return new Response("Not found", { status: 404 });
  }
}
