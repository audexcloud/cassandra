/**
 * OpenClaw orchestrator. Runs mock connectors on a periodic cadence, ingests
 * markets/signals into the database, recomputes scoring, and records each
 * job's outcome. All state lives in Postgres so the UI can show real history
 * even after restarts.
 */

import { db } from "@workspace/db";
import {
  opportunities,
  signalEvents,
  openclawJobs,
  riskConfig,
  auditLog,
  connectorStatus,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";

import { connectors, type ConnectorResult } from "./connectors";
import { edgeScore, kellyFraction, suggestedDirection } from "./scoring";
import { logger } from "../logger";

const CYCLE_INTERVAL_SEC = 60;

interface OrchestratorState {
  running: boolean;
  intervalHandle: NodeJS.Timeout | null;
  lastCycleAt: Date | null;
  nextRunAt: Date | null;
  /**
   * In-flight guard. The scheduler and the manual /openclaw/run endpoint can
   * race; we serialize them here so we never double-ingest or race
   * pruneSignals.
   */
  cycleInFlight: Promise<void> | null;
  connectorStatus: Map<
    string,
    { status: "ok" | "degraded" | "error" | "idle"; lastSyncAt: Date | null; note?: string }
  >;
}

const state: OrchestratorState = {
  running: false,
  intervalHandle: null,
  lastCycleAt: null,
  nextRunAt: null,
  cycleInFlight: null,
  connectorStatus: new Map(),
};

// Initialise connector status map.
for (const c of connectors) {
  state.connectorStatus.set(c.name, { status: "idle", lastSyncAt: null });
}

async function recordJobStart(kind: string): Promise<number> {
  const [row] = await db
    .insert(openclawJobs)
    .values({ kind, status: "running" })
    .returning({ id: openclawJobs.id });
  return row.id;
}

async function recordJobFinish(
  id: number,
  status: "ok" | "error",
  startedAt: Date,
  message?: string,
): Promise<void> {
  const finishedAt = new Date();
  await db
    .update(openclawJobs)
    .set({
      status,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      message: message ?? null,
    })
    .where(eq(openclawJobs.id, id));
}

async function getMaxKelly(): Promise<number> {
  const [cfg] = await db.select().from(riskConfig).limit(1);
  return cfg?.maxKellyFraction ?? 0.25;
}

async function ingestConnector(result: ConnectorResult, maxKelly: number): Promise<{
  upserted: number;
  signalsInserted: number;
}> {
  let upserted = 0;
  let signalsInserted = 0;

  for (const market of result.markets) {
    const inputs = {
      marketProb: market.marketProb,
      modelProb: market.modelProb,
      confidence: market.confidence,
      liquidity: market.liquidity,
    };
    const score = edgeScore(inputs);
    const direction = suggestedDirection(inputs);
    const kelly = kellyFraction(inputs, maxKelly);

    const [row] = await db
      .insert(opportunities)
      .values({
        marketKey: market.marketKey,
        source: market.source,
        domain: market.domain,
        question: market.question,
        marketProb: market.marketProb,
        modelProb: market.modelProb,
        edge: market.modelProb - market.marketProb,
        edgeScore: score,
        confidence: market.confidence,
        liquidity: market.liquidity,
        kellyFraction: kelly,
        suggestedDirection: direction,
        url: market.url ?? null,
        rationale: market.rationale,
      })
      .onConflictDoUpdate({
        target: [opportunities.source, opportunities.marketKey],
        set: {
          marketProb: market.marketProb,
          modelProb: market.modelProb,
          edge: market.modelProb - market.marketProb,
          edgeScore: score,
          confidence: market.confidence,
          liquidity: market.liquidity,
          kellyFraction: kelly,
          suggestedDirection: direction,
          rationale: market.rationale,
          updatedAt: new Date(),
        },
      })
      .returning({ id: opportunities.id });

    upserted++;

    if (market.signals.length > 0) {
      await db.insert(signalEvents).values(
        market.signals.map((s) => ({
          opportunityId: row.id,
          domain: s.domain,
          source: s.source,
          kind: s.kind,
          title: s.title,
          body: s.body,
          impact: s.impact,
          sentiment: s.sentiment,
        })),
      );
      signalsInserted += market.signals.length;
    }
  }

  if (result.ambientSignals.length > 0) {
    await db.insert(signalEvents).values(
      result.ambientSignals.map((s) => ({
        opportunityId: null,
        domain: s.domain,
        source: s.source,
        kind: s.kind,
        title: s.title,
        body: s.body,
        impact: s.impact,
        sentiment: s.sentiment,
      })),
    );
    signalsInserted += result.ambientSignals.length;
  }

  return { upserted, signalsInserted };
}

async function pruneSignals(keepMostRecent = 500): Promise<void> {
  // Keep the table from growing unbounded between cycles in local dev.
  await db.execute(sql`
    DELETE FROM signal_events
    WHERE id NOT IN (
      SELECT id FROM signal_events ORDER BY observed_at DESC LIMIT ${keepMostRecent}
    )
  `);
}

export async function runCycle(): Promise<void> {
  // Serialize cycles. If one is already running, callers (manual trigger and
  // scheduler) wait for that one rather than starting a second concurrent
  // pipeline that would race ingestion and pruning.
  if (state.cycleInFlight) {
    return state.cycleInFlight;
  }
  state.cycleInFlight = runCycleInner().finally(() => {
    state.cycleInFlight = null;
  });
  return state.cycleInFlight;
}

async function runCycleInner(): Promise<void> {
  const startedAt = new Date();
  const cycleJobId = await recordJobStart("cycle");
  let totalMarkets = 0;
  let totalSignals = 0;

  try {
    const maxKelly = await getMaxKelly();

    for (const connector of connectors) {
      const jobStartedAt = new Date();
      const jobId = await recordJobStart(`ingest_${connector.name}`);
      try {
        const result = await connector.run();
        const { upserted, signalsInserted } = await ingestConnector(result, maxKelly);
        totalMarkets += upserted;
        totalSignals += signalsInserted;
        state.connectorStatus.set(connector.name, {
          status: result.status,
          lastSyncAt: result.fetchedAt,
          note: result.note,
        });
        // Mirror to the connector_status table so the OpenClaw command center
        // surfaces the same view between cycles, across restarts.
        await db
          .insert(connectorStatus)
          .values({
            name: connector.name,
            status: result.status,
            mockDataMode: connector.mockDataMode,
            lastSuccessfulRun: result.fetchedAt,
            lastError: null,
          })
          .onConflictDoUpdate({
            target: connectorStatus.name,
            set: {
              status: result.status,
              mockDataMode: connector.mockDataMode,
              lastSuccessfulRun: result.fetchedAt,
              lastError: null,
              updatedAt: new Date(),
            },
          });
        await recordJobFinish(
          jobId,
          "ok",
          jobStartedAt,
          `markets=${upserted} signals=${signalsInserted}`,
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        state.connectorStatus.set(connector.name, {
          status: "error",
          lastSyncAt: state.connectorStatus.get(connector.name)?.lastSyncAt ?? null,
          note: errMsg,
        });
        await db
          .insert(connectorStatus)
          .values({
            name: connector.name,
            status: "error",
            mockDataMode: connector.mockDataMode,
            lastSuccessfulRun: connector.lastSuccessfulRun,
            lastError: errMsg,
          })
          .onConflictDoUpdate({
            target: connectorStatus.name,
            set: {
              status: "error",
              lastError: errMsg,
              updatedAt: new Date(),
            },
          });
        await recordJobFinish(jobId, "error", jobStartedAt, errMsg);
        logger.warn({ connector: connector.name, err }, "connector run failed");
      }
    }

    await pruneSignals();

    state.lastCycleAt = new Date();
    state.nextRunAt = new Date(Date.now() + CYCLE_INTERVAL_SEC * 1000);
    await recordJobFinish(
      cycleJobId,
      "ok",
      startedAt,
      `markets=${totalMarkets} signals=${totalSignals}`,
    );
    await db.insert(auditLog).values({
      actor: "openclaw",
      action: "cycle.complete",
      target: null,
      payload: { totalMarkets, totalSignals },
    });
  } catch (err) {
    await recordJobFinish(
      cycleJobId,
      "error",
      startedAt,
      err instanceof Error ? err.message : String(err),
    );
    logger.error({ err }, "openclaw cycle failed");
  }
}

export function startOpenClaw(): void {
  if (state.running) return;
  state.running = true;
  state.nextRunAt = new Date(Date.now() + 1000);
  // Kick off an immediate first cycle so the UI is never empty on first load.
  runCycle().catch((err) => logger.error({ err }, "initial cycle failed"));
  state.intervalHandle = setInterval(() => {
    runCycle().catch((err) => logger.error({ err }, "scheduled cycle failed"));
  }, CYCLE_INTERVAL_SEC * 1000);
}

export function stopOpenClaw(): void {
  state.running = false;
  if (state.intervalHandle) {
    clearInterval(state.intervalHandle);
    state.intervalHandle = null;
  }
}

export function openClawSnapshot(): {
  running: boolean;
  lastCycleAt: Date | null;
  nextRunAt: Date | null;
  cycleIntervalSec: number;
  connectors: Array<{
    name: string;
    status: "ok" | "degraded" | "error" | "idle";
    lastSyncAt: Date | null;
    note?: string;
  }>;
} {
  return {
    running: state.running,
    lastCycleAt: state.lastCycleAt,
    nextRunAt: state.nextRunAt,
    cycleIntervalSec: CYCLE_INTERVAL_SEC,
    connectors: Array.from(state.connectorStatus.entries()).map(
      ([name, status]) => ({
        name,
        status: status.status,
        lastSyncAt: status.lastSyncAt,
        note: status.note,
      }),
    ),
  };
}

export const OPENCLAW_CYCLE_INTERVAL_SEC = CYCLE_INTERVAL_SEC;
