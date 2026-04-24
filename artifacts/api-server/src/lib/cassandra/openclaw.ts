/**
 * OpenClaw orchestrator. Runs the live upstream connectors (Manifold,
 * Polymarket, Kalshi, Metaculus, COMEX/metals, news wires) on a periodic
 * cadence, ingests markets/signals into the database, recomputes scoring,
 * and records each job's outcome. All state lives in Postgres so the UI
 * can show real history even after restarts.
 */

import { db } from "@workspace/db";
import {
  opportunities,
  opportunityScoreSnapshots,
  signalEvents,
  openclawJobs,
  riskConfig,
  auditLog,
  connectorStatus,
  observations,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";

import {
  connectors,
  type ConnectorResult,
  type ConnectorSignal,
} from "./connectors";
import { edgeScore, kellyFraction, suggestedDirection } from "./scoring";
import {
  applyMatchedSignals,
  buildMatchRationale,
  matchSignalsToMarket,
  summarizeAppliedSignals,
} from "./signalMatching";
import {
  backtestRanRecently,
  runStandardBacktests,
} from "./backtest";
import { refreshWinnerWallets } from "./winnerWallets";
import { tuneAmbientShiftCaps } from "./signalCapTuning";
import {
  getDomainCalibrationFactors,
  calibratedConfidence,
  invalidateCalibrationCache,
} from "./calibration";
import {
  runInvestigateTopic,
  runExplainPrediction,
  runFindHistoricalParallels,
  runEvaluateMarket,
  runCreateTradePlan,
} from "./onDemandJobs";
import { buildAgentContext, renderAgentContext } from "./agent";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "../logger";

const CYCLE_INTERVAL_SEC = 60;

/**
 * Window an opportunity must have been refreshed within to be considered
 * "fresh" by list endpoints. Opportunities are upserted by (source,
 * marketKey), so rows from earlier connector implementations (or from old
 * mock seeds) can linger in the table even after the active connectors
 * stop emitting them. Anything not touched by any connector cycle in the
 * last `OPPORTUNITY_STALE_AFTER_MS` is excluded from the dashboard, top
 * 10, universe, and random pickers so the UI only shows live markets.
 *
 * Sized at five cycles: enough headroom that a single missed cycle (or a
 * connector blip) does not flap rows in and out of the UI, but tight
 * enough that genuinely abandoned market keys disappear quickly.
 */
export const OPPORTUNITY_STALE_AFTER_MS = 5 * CYCLE_INTERVAL_SEC * 1000;

/**
 * Named scheduled job kinds the orchestrator runs each cycle. The ingest
 * jobs are per-connector; the named jobs below are higher-level passes
 * that operate on the *output* of ingestion (scoring, monitoring, briefs).
 * They each get their own openclaw_jobs row so the command center can show
 * a per-job status board.
 */
export const SCHEDULED_JOB_KINDS = [
  "scan_prediction_markets",
  "scan_social_signals",
  "scan_policy_signals",
  "scan_commodity_signals",
  "scan_macro_signals",
  "check_connector_health",
  "monitor_open_positions",
  "generate_top_10_predictions",
  "generate_daily_brief",
  "compute_calibration_backtest",
  "refresh_winner_wallets",
  "tune_ambient_shift_caps",
] as const;
export type ScheduledJobKind = (typeof SCHEDULED_JOB_KINDS)[number];

/**
 * Named on-demand jobs that the operator (or the Agent surface) can invoke
 * via POST /openclaw/jobs/:kind/run. Each invocation records its own
 * openclaw_jobs row so the command center shows what was asked, when, and
 * with what payload. Bodies are stub no-ops for the foundation — what
 * matters is that the contract (existence, naming, recording) is in place.
 */
export const ON_DEMAND_JOB_KINDS = [
  "investigate_topic",
  "explain_prediction",
  "find_historical_parallels",
  "evaluate_market",
  "create_trade_plan",
] as const;
export type OnDemandJobKind = (typeof ON_DEMAND_JOB_KINDS)[number];

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
  /**
   * Last time the `generate_daily_brief` named job completed successfully.
   * Surfaced in the OpenClaw command center and in the dashboard agent
   * status so the operator can see whether long-form context is fresh.
   */
  lastDailyBriefAt: Date | null;
}

const state: OrchestratorState = {
  running: false,
  intervalHandle: null,
  lastCycleAt: null,
  nextRunAt: null,
  cycleInFlight: null,
  connectorStatus: new Map(),
  lastDailyBriefAt: null,
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

async function ingestConnector(
  result: ConnectorResult,
  ambientPool: ConnectorSignal[],
  maxKelly: number,
  calibrationFactors: Map<string, number>,
): Promise<{
  upserted: number;
  signalsInserted: number;
  matchedAmbient: number;
}> {
  let upserted = 0;
  let signalsInserted = 0;
  let matchedAmbient = 0;

  for (const market of result.markets) {
    // Route ambient signals (COMEX moves, news headlines) to this market
    // based on domain + keyword overlap, then re-derive modelProb so the
    // routing layer actually moves the published edge instead of the
    // upstream-shaped market.modelProb (which equals market.marketProb on
    // every real connector since they don't ship per-market signals).
    const matched = matchSignalsToMarket(market, ambientPool);
    matchedAmbient += matched.length;
    // Per-domain cap: the legacy global ±15pt cap was a guess. The cap
    // applied here comes from `getAmbientShiftCap(domain)`, which
    // prefers an empirically-tuned value over a hand-tuned default.
    // The empirical value is the p90 of |Δ marketProb| in the
    // `WINDOW_MINUTES` after a `signal_events` row was observed,
    // measured against `opportunity_score_snapshots` and grouped by
    // domain — i.e. how far markets in this domain *actually* move
    // after a matched signal. The `tune_ambient_shift_caps` scheduled
    // job below refreshes those numbers each cycle as more snapshots
    // accumulate. See `signalCapTuning.ts` for the full derivation.
    const { modelProb, ambientShift, cap } = applyMatchedSignals({
      marketProb: market.marketProb,
      marketSignals: market.signals,
      matched,
      domain: market.domain,
    });

    const adjustedConfidence = calibratedConfidence(
      market.confidence,
      market.domain,
      calibrationFactors,
    );
    const inputs = {
      marketProb: market.marketProb,
      modelProb,
      confidence: adjustedConfidence,
      liquidity: market.liquidity,
    };
    const score = edgeScore(inputs);
    const direction = suggestedDirection(inputs);
    const kelly = kellyFraction(inputs, maxKelly);

    // Augment the connector's rationale with attribution for any matched
    // ambient signals, so the dashboard explains *why* modelProb moved.
    // We persist both:
    //  - prose lines (`observed` / `inferred`) for the legacy rationale
    //    buckets and any text-based readers, AND
    //  - a structured `appliedSignals` array (+ `ambientShift`) so the
    //    dashboard's "What moved this prediction" section can render
    //    chips/rows directly without re-parsing the prose.
    const matchExtras = buildMatchRationale({
      matched,
      marketProb: market.marketProb,
      modelProb,
      ambientShift,
      cap,
    });
    const rationale =
      matched.length > 0
        ? {
            ...market.rationale,
            observed: [...market.rationale.observed, ...matchExtras.observed],
            inferred: [...market.rationale.inferred, ...matchExtras.inferred],
            appliedSignals: summarizeAppliedSignals(matched),
            ambientShift,
          }
        : market.rationale;

    const [row] = await db
      .insert(opportunities)
      .values({
        marketKey: market.marketKey,
        source: market.source,
        domain: market.domain,
        question: market.question,
        marketProb: market.marketProb,
        modelProb,
        edge: modelProb - market.marketProb,
        edgeScore: score,
        confidence: adjustedConfidence,
        liquidity: market.liquidity,
        spread: market.spread,
        kellyFraction: kelly,
        suggestedDirection: direction,
        url: market.url ?? null,
        rationale,
      })
      .onConflictDoUpdate({
        target: [opportunities.source, opportunities.marketKey],
        set: {
          marketProb: market.marketProb,
          modelProb,
          edge: modelProb - market.marketProb,
          edgeScore: score,
          confidence: adjustedConfidence,
          liquidity: market.liquidity,
          spread: market.spread,
          kellyFraction: kelly,
          suggestedDirection: direction,
          rationale,
          updatedAt: new Date(),
        },
      })
      .returning({ id: opportunities.id });

    upserted++;

    // Snapshot the post-ingest scoring so the cap-tuning job has a
    // time-series of marketProb to mine. Without these rows, we cannot
    // measure how far a market actually moved after a matched ambient
    // signal — the opportunities row only ever holds the latest values.
    await db.insert(opportunityScoreSnapshots).values({
      opportunityId: row.id,
      marketProb: market.marketProb,
      modelProb,
      edgeScore: score,
      confidence: adjustedConfidence,
    });

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

  return { upserted, signalsInserted, matchedAmbient };
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

async function pruneScoreSnapshots(keepMostRecent = 5000): Promise<void> {
  // Score snapshots accumulate one per (cycle × market). They're the
  // input to the cap-tuning analysis (see signalCapTuning.ts), but we
  // don't need unlimited history — a few days of cycles is plenty for
  // the quantile to stabilise.
  await db.execute(sql`
    DELETE FROM opportunity_score_snapshots
    WHERE id NOT IN (
      SELECT id FROM opportunity_score_snapshots
      ORDER BY captured_at DESC LIMIT ${keepMostRecent}
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
    const [maxKelly, calibrationFactors] = await Promise.all([
      getMaxKelly(),
      getDomainCalibrationFactors(),
    ]);

    // ----- Phase 1: fetch every connector and collect all ambient signals.
    // We do all fetches before any ingest so that every market in this cycle
    // can be matched against the *full* ambient pool (COMEX moves + news
    // headlines from every wire), regardless of connector ordering.
    interface FetchOutcome {
      connector: (typeof connectors)[number];
      jobId: number;
      jobStartedAt: Date;
      result?: ConnectorResult;
      error?: string;
    }
    const fetchOutcomes: FetchOutcome[] = [];
    const ambientPool: ConnectorSignal[] = [];

    for (const connector of connectors) {
      const jobStartedAt = new Date();
      const jobId = await recordJobStart(`ingest_${connector.name}`);
      try {
        const result = await connector.run();
        ambientPool.push(...result.ambientSignals);
        fetchOutcomes.push({ connector, jobId, jobStartedAt, result });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        fetchOutcomes.push({ connector, jobId, jobStartedAt, error: errMsg });
      }
    }

    // ----- Phase 2: ingest each connector's markets, applying matched
    // ambient signals, and finalize the per-connector job rows.
    for (const outcome of fetchOutcomes) {
      const { connector, jobId, jobStartedAt, result, error } = outcome;
      if (error !== undefined || !result) {
        const errMsg = error ?? "connector returned no result";
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
        logger.warn({ connector: connector.name, err: errMsg }, "connector run failed");
        continue;
      }

      try {
        const { upserted, signalsInserted, matchedAmbient } =
          await ingestConnector(result, ambientPool, maxKelly, calibrationFactors);
        totalMarkets += upserted;
        totalSignals += signalsInserted;
        state.connectorStatus.set(connector.name, {
          status: result.status,
          lastSyncAt: result.fetchedAt,
          note: result.note,
        });
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
          `markets=${upserted} signals=${signalsInserted} matchedAmbient=${matchedAmbient}`,
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
        logger.warn({ connector: connector.name, err }, "connector ingest failed");
      }
    }

    await pruneSignals();
    await pruneScoreSnapshots();

    // Run the named scheduled jobs after ingestion. Each one gets its own
    // openclaw_jobs row so the command center shows per-job status, and
    // each is wrapped in try/catch so one failure does not abort the cycle.
    await runScheduledJobs();

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

/**
 * Iterate the named scheduled jobs. Each one is recorded as its own
 * openclaw_jobs row so the command center can show a per-job status board.
 */
async function runScheduledJobs(): Promise<void> {
  for (const kind of SCHEDULED_JOB_KINDS) {
    const start = new Date();
    const id = await recordJobStart(kind);
    try {
      let message = `${kind} ok`;
      if (kind === "check_connector_health") {
        // Real work: poll healthCheck() on every connector and surface any
        // degraded/error state on the job row.
        const results: string[] = [];
        for (const c of connectors) {
          try {
            const h = await c.healthCheck();
            results.push(`${c.name}=${h.status}`);
          } catch (err) {
            results.push(`${c.name}=error(${err instanceof Error ? err.message : String(err)})`);
          }
        }
        message = `health: ${results.join(", ")}`;
      } else if (kind === "generate_daily_brief") {
        const brief = await generateDailyBrief();
        state.lastDailyBriefAt = new Date();
        message = `brief generated at ${state.lastDailyBriefAt.toISOString()} (${brief.length} chars)`;
      } else if (kind === "compute_calibration_backtest") {
        // Idempotent: skip when one already ran in the last ~23h. The cycle
        // tick is every 60s, so without this guard we'd spam the backtest
        // tables with redundant rows.
        if (await backtestRanRecently(23)) {
          message = `${kind} skipped (ran within last 23h)`;
        } else {
          const r = await runStandardBacktests();
          // Invalidate the in-memory calibration cache so the next ingest
          // cycle re-reads the freshly computed calibration factors.
          invalidateCalibrationCache();
          message = `${kind} ok (lookbacks=${r.ran.join(",")} scopes=${r.totalScopes}) — calibration cache invalidated`;
        }
      } else if (kind === "refresh_winner_wallets") {
        // Real work: pull a fresh snapshot for every tracked Polymarket
        // wallet, recompute rank, and emit any new mirror suggestions.
        const r = await refreshWinnerWallets();
        message = `wallets=${r.walletsRefreshed} snapshots=${r.snapshotsInserted} suggestions=${r.suggestionsCreated}`;
      } else if (kind === "tune_ambient_shift_caps") {
        // Mine signal_events × opportunity_score_snapshots to derive the
        // per-domain empirical p90 of |Δ marketProb| in the window
        // following each signal, and use that as the ambient-shift cap
        // for each domain. Replaces the legacy global ±15pt guess with a
        // number backed by how markets actually move after matched
        // signals. Domains with too few samples keep their hand-tuned
        // default. See `signalCapTuning.ts` for the full derivation.
        const r = await tuneAmbientShiftCaps();
        const summary = r.stats
          .map(
            (s) =>
              `${s.domain}=${(s.recommendedCap * 100).toFixed(0)}pt(n=${s.sampleSize}/${s.source})`,
          )
          .join(", ");
        message = `applied=${r.applied} ${summary}`;
      }
      await recordJobFinish(id, "ok", start, message);
    } catch (err) {
      await recordJobFinish(
        id,
        "error",
        start,
        err instanceof Error ? err.message : String(err),
      );
      logger.warn({ kind, err }, "scheduled job failed");
    }
  }
}

/**
 * Invoke a named on-demand job. Records an openclaw_jobs row, executes the
 * Claude-powered job body, persists results to the appropriate tables, and
 * returns the finished row id.
 */
export async function runOnDemandJob(
  kind: OnDemandJobKind,
  payload: Record<string, unknown> | undefined,
): Promise<number> {
  const start = new Date();
  const id = await recordJobStart(kind);
  const p = payload ?? {};

  try {
    let message = "";

    switch (kind) {
      case "investigate_topic": {
        const topic = String(p.topic ?? "general market overview");
        const result = await runInvestigateTopic(topic);
        message = `investigation #${result.investigationId} created for topic="${topic}" (${result.summary.length} chars)`;
        break;
      }
      case "explain_prediction": {
        const oppId = Number(p.opportunityId);
        if (isNaN(oppId)) throw new Error("opportunityId must be a number");
        const result = await runExplainPrediction(oppId);
        message = `explanation generated for opportunity ${oppId} (${result.explanation.length} chars)`;
        break;
      }
      case "find_historical_parallels": {
        const question = String(p.question ?? "");
        if (!question) throw new Error("question is required");
        const oppId = p.opportunityId != null ? Number(p.opportunityId) : undefined;
        const result = await runFindHistoricalParallels(question, oppId);
        message = `found ${result.count} historical parallels for "${question.slice(0, 60)}"`;
        break;
      }
      case "evaluate_market": {
        const oppId = Number(p.opportunityId);
        if (isNaN(oppId)) throw new Error("opportunityId must be a number");
        const result = await runEvaluateMarket(oppId);
        message = `evaluation: verdict=${result.verdict} suggestedProb=${(result.suggestedProb * 100).toFixed(1)}% for opportunity ${oppId}`;
        break;
      }
      case "create_trade_plan": {
        const oppId = Number(p.opportunityId);
        if (isNaN(oppId)) throw new Error("opportunityId must be a number");
        const result = await runCreateTradePlan(oppId);
        message = `trade plan #${result.tradePlanId} created for opportunity ${oppId}`;
        break;
      }
    }

    await recordJobFinish(id, "ok", start, message);
    await db.insert(auditLog).values({
      actor: "user",
      action: "openclaw.on_demand_job",
      target: kind,
      payload: payload ?? {},
    });
    return id;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await recordJobFinish(id, "error", start, errMsg);
    logger.warn({ kind, payload, err }, "on-demand job failed");
    throw err;
  }
}

/**
 * Generate the daily intelligence brief: a Claude-written summary of the
 * current opportunity universe, top signals, calibration health, and open
 * positions. Stored as an observation so the agent can reference it.
 */
async function generateDailyBrief(): Promise<string> {
  const ctx = await buildAgentContext();
  const contextBlock = renderAgentContext(ctx);

  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system: `You are Cassandra's daily briefing agent. Produce a concise, actionable daily
intelligence brief covering: (1) top prediction market opportunities with edge, (2) key signals
driving predictions, (3) open positions status, (4) calibration health, (5) risks to watch today.

Format: markdown with sections. Be specific with numbers. Calibrated, no hype.`,
    messages: [
      {
        role: "user",
        content: `Generate today's Cassandra daily brief based on this live context:\n\n${contextBlock}`,
      },
    ],
  });

  const block = msg.content[0];
  const brief = block.type === "text" ? block.text : "(brief generation failed)";

  await db.insert(observations).values({
    source: "scheduled:generate_daily_brief",
    domain: "prediction_market",
    body: brief,
    metadata: { generatedAt: new Date().toISOString() },
  });

  return brief;
}

export function openClawSnapshot(): {
  running: boolean;
  lastCycleAt: Date | null;
  nextRunAt: Date | null;
  cycleIntervalSec: number;
  scheduledJobs: readonly string[];
  lastDailyBriefAt: Date | null;
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
    scheduledJobs: SCHEDULED_JOB_KINDS,
    lastDailyBriefAt: state.lastDailyBriefAt,
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
