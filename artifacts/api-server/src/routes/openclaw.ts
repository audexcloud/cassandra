import { Router, type IRouter } from "express";
import {
  GetOpenClawStatusResponse,
  ListOpenClawJobsQueryParams,
  ListOpenClawJobsResponse,
  RunOpenClawCycleResponse,
  RunOpenClawOnDemandJobBody,
  RunOpenClawOnDemandJobParams,
  RunOpenClawOnDemandJobResponse,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  openclawJobs,
  observations,
  narratives,
  historicalParallels,
  anomalies,
} from "@workspace/db";
import { desc, sql } from "drizzle-orm";
import {
  openClawSnapshot,
  runCycle,
  runOnDemandJob,
  ON_DEMAND_JOB_KINDS,
  type OnDemandJobKind,
} from "../lib/cassandra/openclaw";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/openclaw/status", async (_req, res) => {
  const snapshot = openClawSnapshot();
  const [recent, memCounts] = await Promise.all([
    db
      .select()
      .from(openclawJobs)
      .orderBy(desc(openclawJobs.startedAt))
      .limit(10),
    Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(observations),
      db.select({ n: sql<number>`count(*)::int` }).from(narratives),
      db.select({ n: sql<number>`count(*)::int` }).from(historicalParallels),
      db.select({ n: sql<number>`count(*)::int` }).from(anomalies),
    ]),
  ]);
  const [obsRow, narRow, parRow, anoRow] = memCounts;
  res.json(
    GetOpenClawStatusResponse.parse({
      running: snapshot.running,
      nextRunAt: snapshot.nextRunAt ? snapshot.nextRunAt.toISOString() : null,
      lastCycleAt: snapshot.lastCycleAt ? snapshot.lastCycleAt.toISOString() : null,
      cycleIntervalSec: snapshot.cycleIntervalSec,
      connectors: snapshot.connectors.map((c) => ({
        name: c.name,
        status: c.status,
        lastSyncAt: c.lastSyncAt ? c.lastSyncAt.toISOString() : null,
        note: c.note ?? null,
      })),
      recentJobs: recent.map(serializeJob),
      scheduledJobs: [...snapshot.scheduledJobs],
      memoryStats: {
        observations: obsRow[0]?.n ?? 0,
        narratives: narRow[0]?.n ?? 0,
        parallels: parRow[0]?.n ?? 0,
        anomalies: anoRow[0]?.n ?? 0,
      },
      lastDailyBriefAt: snapshot.lastDailyBriefAt
        ? snapshot.lastDailyBriefAt.toISOString()
        : null,
    }),
  );
});

router.get("/openclaw/jobs", async (req, res) => {
  const parsed = ListOpenClawJobsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(openclawJobs)
    .orderBy(desc(openclawJobs.startedAt))
    .limit(parsed.data.limit ?? 50);
  res.json(ListOpenClawJobsResponse.parse(rows.map(serializeJob)));
});

router.post("/openclaw/run", async (_req, res) => {
  // Fire and forget so the request returns quickly; the snapshot will reflect
  // the in-flight job via its DB row.
  runCycle().catch(() => undefined);
  const snapshot = openClawSnapshot();
  res.json(
    RunOpenClawCycleResponse.parse({
      running: snapshot.running,
      nextRunAt: snapshot.nextRunAt ? snapshot.nextRunAt.toISOString() : null,
      lastCycleAt: snapshot.lastCycleAt ? snapshot.lastCycleAt.toISOString() : null,
      cycleIntervalSec: snapshot.cycleIntervalSec,
      connectors: snapshot.connectors.map((c) => ({
        name: c.name,
        status: c.status,
        lastSyncAt: c.lastSyncAt ? c.lastSyncAt.toISOString() : null,
        note: c.note ?? null,
      })),
      recentJobs: [],
      scheduledJobs: [...snapshot.scheduledJobs],
      memoryStats: { observations: 0, narratives: 0, parallels: 0, anomalies: 0 },
      lastDailyBriefAt: snapshot.lastDailyBriefAt
        ? snapshot.lastDailyBriefAt.toISOString()
        : null,
    }),
  );
});

router.post("/openclaw/jobs/:kind/run", async (req, res) => {
  const parsedParams = RunOpenClawOnDemandJobParams.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ error: parsedParams.error.message });
    return;
  }
  const kind = parsedParams.data.kind;
  if (!ON_DEMAND_JOB_KINDS.includes(kind as OnDemandJobKind)) {
    res.status(400).json({ error: `Unknown on-demand job kind: ${kind}` });
    return;
  }
  const parsedBody = RunOpenClawOnDemandJobBody.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    res.status(400).json({ error: parsedBody.error.message });
    return;
  }
  // Strip undefined keys so the audit payload is clean.
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsedBody.data)) {
    if (v !== undefined) payload[k] = v;
  }

  try {
    const id = await runOnDemandJob(kind as OnDemandJobKind, payload);
    const [row] = await db
      .select()
      .from(openclawJobs)
      .where(eq(openclawJobs.id, id))
      .limit(1);
    res.json(RunOpenClawOnDemandJobResponse.parse(serializeJob(row)));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function serializeJob(row: typeof openclawJobs.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    durationMs: row.durationMs,
    message: row.message,
  };
}

export default router;
