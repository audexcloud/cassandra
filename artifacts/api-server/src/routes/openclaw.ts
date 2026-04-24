import { Router, type IRouter } from "express";
import {
  GetOpenClawStatusResponse,
  ListOpenClawJobsQueryParams,
  ListOpenClawJobsResponse,
  RunOpenClawCycleResponse,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import { openclawJobs } from "@workspace/db";
import { desc } from "drizzle-orm";
import {
  openClawSnapshot,
  runCycle,
} from "../lib/cassandra/openclaw";

const router: IRouter = Router();

router.get("/openclaw/status", async (_req, res) => {
  const snapshot = openClawSnapshot();
  const recent = await db
    .select()
    .from(openclawJobs)
    .orderBy(desc(openclawJobs.startedAt))
    .limit(10);
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
    }),
  );
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
