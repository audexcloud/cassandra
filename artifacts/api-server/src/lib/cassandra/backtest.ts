/**
 * Backtest engine. Reads resolved journal entries inside a lookback window,
 * computes Brier / log-loss / hit-rate-by-confidence and a calibration
 * curve overall, per-domain, and per-signal-category, and writes one
 * `backtest_runs` row per scope (with N `calibration_buckets` rows).
 *
 * Lookback semantics: the window is measured against `journal_entries.createdAt`
 * (the *prediction* timestamp), not the resolution timestamp. So "last 30
 * days" means "predictions logged in the last 30 days that have since been
 * resolved", which is the right framing for asking "are my recent forecasts
 * calibrated?".
 *
 * Idempotency lives one level up: the OpenClaw scheduler calls
 * `backtestRanRecently()` first and skips invocation when every standard
 * lookback already has a recent overall row. `runBacktest()` itself always
 * inserts fresh rows — that is intentional, so `POST /backtest/run` can
 * force a recompute on demand.
 */

import { db } from "@workspace/db";
import {
  journalEntries,
  backtestRuns,
  calibrationBuckets,
  auditLog,
} from "@workspace/db";
import { and, desc, eq, gte } from "drizzle-orm";

import {
  brierScore,
  bucketize,
  hitRateByConfidenceBucket,
  logLoss,
  signalCategoryFromEvidence,
  type CalibrationDatum,
  type SignalCategory,
} from "./scoring";

export const DEFAULT_LOOKBACK_DAYS = 30;
export const SUPPORTED_LOOKBACK_DAYS = [30, 90, 365] as const;
export type LookbackDays = (typeof SUPPORTED_LOOKBACK_DAYS)[number];

const NUM_BUCKETS = 10;

export interface BacktestSummary {
  scope: string;
  lookbackDays: number;
  runAt: string;
  totalEntries: number;
  brierScore: number | null;
  logLoss: number | null;
  hitRate: number | null;
  buckets: Array<{
    bucketLow: number;
    bucketHigh: number;
    predictedAvg: number;
    realizedRate: number;
    count: number;
  }>;
  /**
   * Per-confidence-bucket hit rate. Same N buckets as `buckets` but keyed
   * by |2p - 1| rather than raw p.
   */
  hitRateByBucket: Array<{
    low: number;
    high: number;
    hitRate: number;
    count: number;
  }>;
}

interface ScopeBundle {
  scope: string;
  items: CalibrationDatum[];
}

/**
 * Run a backtest for the given lookback window and persist one
 * `backtest_runs` row per scope. Returns the IDs of the inserted runs.
 */
export async function runBacktest(
  lookbackDays: LookbackDays = DEFAULT_LOOKBACK_DAYS,
): Promise<{ insertedRuns: number; scopes: string[] }> {
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(journalEntries)
    .where(gte(journalEntries.createdAt, cutoff));

  // Keep only resolved binary outcomes (yes/no). Pending and na are excluded
  // from calibration math because there is no realized binary outcome.
  const resolved = rows.filter(
    (r) => r.outcome === "yes" || r.outcome === "no",
  );

  // Build per-scope bundles. Every resolved entry contributes to "overall",
  // its domain bucket, and its signal-category bucket.
  const overall: CalibrationDatum[] = [];
  const byDomain = new Map<string, CalibrationDatum[]>();
  const byCategory = new Map<SignalCategory, CalibrationDatum[]>();

  for (const r of resolved) {
    const datum: CalibrationDatum = {
      predicted: r.forecastProb,
      realized: r.outcome === "yes" ? 1 : 0,
    };
    overall.push(datum);

    const domainList = byDomain.get(r.domain) ?? [];
    domainList.push(datum);
    byDomain.set(r.domain, domainList);

    const cat = signalCategoryFromEvidence({
      observed: r.observed as unknown[] | null,
      inferred: r.inferred as unknown[] | null,
      speculation: r.speculation as unknown[] | null,
    });
    const catList = byCategory.get(cat) ?? [];
    catList.push(datum);
    byCategory.set(cat, catList);
  }

  const bundles: ScopeBundle[] = [{ scope: "overall", items: overall }];
  for (const [domain, items] of byDomain) {
    bundles.push({ scope: `domain:${domain}`, items });
  }
  for (const [cat, items] of byCategory) {
    bundles.push({ scope: `signalCategory:${cat}`, items });
  }

  const runAt = new Date();
  const insertedScopes: string[] = [];

  for (const bundle of bundles) {
    const items = bundle.items;
    const total = items.length;
    const brier = total === 0 ? null : brierScore(items);
    const ll = total === 0 ? null : logLoss(items);
    const hits = items.reduce(
      (sum, it) => sum + ((it.predicted >= 0.5 ? 1 : 0) === it.realized ? 1 : 0),
      0,
    );
    const hitRate = total === 0 ? null : hits / total;
    const hitRateBuckets =
      total === 0 ? [] : hitRateByConfidenceBucket(items, NUM_BUCKETS);

    const [run] = await db
      .insert(backtestRuns)
      .values({
        runAt,
        lookbackDays,
        scope: bundle.scope,
        totalEntries: total,
        brierScore: brier,
        logLoss: ll,
        hitRate,
        hitRateBuckets,
      })
      .returning({ id: backtestRuns.id });

    if (total > 0) {
      const buckets = bucketize(items, NUM_BUCKETS);
      await db.insert(calibrationBuckets).values(
        buckets.map((b) => ({
          runId: run.id,
          bucketLow: b.low,
          bucketHigh: b.high,
          predictedAvg: b.predictedAvg,
          realizedRate: b.realizedRate,
          count: b.count,
        })),
      );
    }
    insertedScopes.push(bundle.scope);
  }

  await db.insert(auditLog).values({
    actor: "openclaw",
    action: "backtest.run",
    target: `lookback:${lookbackDays}d`,
    payload: {
      lookbackDays,
      scopes: insertedScopes.length,
      totalResolved: resolved.length,
    },
  });

  return { insertedRuns: insertedScopes.length, scopes: insertedScopes };
}

/**
 * Read the latest backtest summary for a given (scope, lookbackDays). Returns
 * null when no run exists. The "buckets" array is empty when no entries fell
 * inside the lookback window.
 */
export async function getLatestBacktest(
  scope: string,
  lookbackDays: LookbackDays = DEFAULT_LOOKBACK_DAYS,
): Promise<BacktestSummary | null> {
  const [run] = await db
    .select()
    .from(backtestRuns)
    .where(
      and(
        eq(backtestRuns.scope, scope),
        eq(backtestRuns.lookbackDays, lookbackDays),
      ),
    )
    .orderBy(desc(backtestRuns.runAt))
    .limit(1);

  if (!run) return null;

  const buckets = await db
    .select()
    .from(calibrationBuckets)
    .where(eq(calibrationBuckets.runId, run.id))
    .orderBy(calibrationBuckets.bucketLow);

  // hitRateByBucket is snapshotted on the run row, so it is stable for
  // historical runs and never drifts when journal entries are edited later.
  return {
    scope: run.scope,
    lookbackDays: run.lookbackDays,
    runAt: run.runAt.toISOString(),
    totalEntries: run.totalEntries,
    brierScore: run.brierScore,
    logLoss: run.logLoss,
    hitRate: run.hitRate,
    buckets: buckets.map((b) => ({
      bucketLow: b.bucketLow,
      bucketHigh: b.bucketHigh,
      predictedAvg: b.predictedAvg,
      realizedRate: b.realizedRate,
      count: b.count,
    })),
    hitRateByBucket: run.hitRateBuckets,
  };
}

/**
 * Lookback windows we materialise on every daily job, so the dashboard tile
 * and the backtest page can fetch any of them without forcing a fresh run.
 */
export const STANDARD_LOOKBACKS: readonly LookbackDays[] = [30, 90, 365];

/**
 * Returns true if every standard lookback window has an "overall" backtest
 * row inserted within the last `withinHours` hours. Used by the daily job
 * to skip when today's run already produced rows for all of them — but to
 * proceed if a previous attempt only partially succeeded.
 */
export async function backtestRanRecently(
  withinHours = 23,
): Promise<boolean> {
  const since = new Date(Date.now() - withinHours * 60 * 60 * 1000);
  for (const lb of STANDARD_LOOKBACKS) {
    const [row] = await db
      .select({ id: backtestRuns.id })
      .from(backtestRuns)
      .where(
        and(
          eq(backtestRuns.scope, "overall"),
          eq(backtestRuns.lookbackDays, lb),
          gte(backtestRuns.runAt, since),
        ),
      )
      .limit(1);
    if (!row) return false;
  }
  return true;
}

/**
 * Convenience: run a backtest for every standard lookback window.
 */
export async function runStandardBacktests(): Promise<{
  ran: LookbackDays[];
  totalScopes: number;
}> {
  let totalScopes = 0;
  for (const lb of STANDARD_LOOKBACKS) {
    const r = await runBacktest(lb);
    totalScopes += r.insertedRuns;
  }
  return { ran: [...STANDARD_LOOKBACKS], totalScopes };
}
