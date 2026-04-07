/**
 * seed.ts — populate IncidentMemory with realistic past incidents.
 *
 * Run after deploying:
 *   npx tsx scripts/seed.ts https://your-worker.workers.dev
 *
 * Or locally:
 *   npx tsx scripts/seed.ts http://localhost:8787
 */

const BASE_URL = process.argv[2] ?? "http://localhost:8787";

const SEED_INCIDENTS = [
  {
    id: "seed-001",
    title: "Database connection pool exhausted",
    severity: "P1",
    description:
      "All API requests returning 503. Postgres connection pool at max capacity. CPU normal, memory normal.",
    rootCause:
      "ORM connection leak introduced in deploy v2.4.1 — connections not released after failed transactions",
    resolution:
      "Rolled back to v2.4.0, increased pool max from 20 to 50 as temporary buffer, added connection leak alerting via Grafana",
    tags: ["database", "postgres", "connection", "pool", "503", "deploy"],
  },
  {
    id: "seed-002",
    title: "CDN cache miss storm causing origin overload",
    severity: "P2",
    description:
      "Origin servers at 95% CPU. Cache hit rate dropped from 85% to 12%. Started after config push at 14:32 UTC.",
    rootCause:
      "Cache-Control headers accidentally set to no-store in nginx config push, bypassing CDN for all assets",
    resolution:
      "Reverted nginx config, cache repopulated within 8 minutes. Added config diff review to deploy checklist.",
    tags: ["cdn", "cache", "nginx", "origin", "cpu", "config"],
  },
  {
    id: "seed-003",
    title: "Memory leak in worker processes causing OOM kills",
    severity: "P2",
    description:
      "Workers restarting every 15–20 minutes. Heap growing linearly. No traffic spike. Started after dependency upgrade.",
    rootCause:
      "Event listener not removed in WebSocket close handler — accumulating listeners on shared EventEmitter",
    resolution:
      "Patched close handler to call removeAllListeners(), deployed hotfix. Root-caused to ws@8.17.0 API change.",
    tags: ["memory", "leak", "worker", "oom", "websocket", "heap"],
  },
  {
    id: "seed-004",
    title: "Job queue backlog — ETL pipeline stalled",
    severity: "P2",
    description:
      "Nightly ETL jobs queued but not processing. Queue depth at 14,000. Workers healthy. Redis reachable.",
    rootCause:
      "Deadlock in job dequeue logic — two worker types both acquiring the same Redis lock in opposite order",
    resolution:
      "Restarted consumers with lock acquisition order fix. Backlog cleared in 45 min. Added deadlock detection metrics.",
    tags: ["queue", "redis", "etl", "deadlock", "backlog", "lock"],
  },
  {
    id: "seed-005",
    title: "Auth service elevated 401 rate — JWT validation failures",
    severity: "P3",
    description:
      "5% of authenticated requests returning 401 unexpectedly. Affects mobile clients only. Web clients unaffected.",
    rootCause:
      "Clock skew on mobile devices causing JWT iat (issued-at) to appear in the future — server rejecting tokens with negative age",
    resolution:
      "Added 60-second clock skew tolerance to JWT validation. Issued guidance to mobile team to use server-provided timestamps.",
    tags: ["auth", "jwt", "401", "mobile", "clock", "skew", "token"],
  },
];

async function seed() {
  console.log(`Seeding ${SEED_INCIDENTS.length} incidents to ${BASE_URL}/api/incidents/seed\n`);

  for (const incident of SEED_INCIDENTS) {
    try {
      const res = await fetch(`${BASE_URL}/api/incidents/seed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...incident, timestamp: Date.now() - Math.random() * 7 * 86400000 }),
      });
      const body = await res.json();
      console.log(`✅ ${incident.severity} — ${incident.title}`);
      if (!res.ok) console.error("   Error:", body);
    } catch (e) {
      console.error(`❌ Failed: ${incident.title}`, e);
    }
  }

  console.log("\nDone. Incident memory seeded.");
}

seed();
