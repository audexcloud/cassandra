/**
 * Calibration feedback loop.
 *
 * Reads resolved backtest results and computes per-domain calibration factors
 * (how over- or under-confident we have been). These factors are then applied
 * to raw `confidenceFromSignals()` values during ingest so that historically
 * over-confident domains get penalised and under-confident ones get a boost.
 *
 * factor < 1.0  →  we predicted more YES outcomes than actually happened
 *                   (over-confident) → reduce future confidence
 * factor > 1.0  →  fewer outcomes resolved as predicted than we expected
 *                   (under-confident) → raise future confidence
 *
 * The factor is smoothed toward 1.0 for small sample sizes and hard-clamped
 * to [0.5, 1.5] so a handful of bad predictions never zero-out a domain.
 */

import { db } from "@workspace/db";
import { backtestRuns, calibrationBuckets } from "@workspace/db";
import { and, desc, eq, gte } from "drizzle-orm";
import { clamp01 } from "./scoring";

interface CachedFactor {
  factor: number;
  sampleSize: number;
  computedAt: Date;
}

const _cache = new Map<string, CachedFactor>();
const CACHE_TTL_MS = 60 * 60 * 1000;
const LOOKBACK_DAYS = 90;
const MIN_SAMPLE = 5;
const DOMAINS = [
  "overall",
  "prediction_market",
  "geopolitics",
  "policy",
  "commodities",
  "metals",
  "macro",
] as const;

async function computeFactor(domain: string): Promise<CachedFactor> {
  const scope = domain === "overall" ? "overall" : `domain:${domain}`;
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  const [run] = await db
    .select()
    .from(backtestRuns)
    .where(
      and(
        eq(backtestRuns.scope, scope),
        eq(backtestRuns.lookbackDays, LOOKBACK_DAYS),
        gte(backtestRuns.runAt, since),
      ),
    )
    .orderBy(desc(backtestRuns.runAt))
    .limit(1);

  if (!run || (run.totalEntries ?? 0) < MIN_SAMPLE) {
    return { factor: 1.0, sampleSize: 0, computedAt: new Date() };
  }

  const buckets = await db
    .select()
    .from(calibrationBuckets)
    .where(eq(calibrationBuckets.runId, run.id));

  let totalCount = 0;
  let sumRealized = 0;
  let sumPredicted = 0;

  for (const b of buckets) {
    if (b.count === 0) continue;
    totalCount += b.count;
    sumRealized += b.count * b.realizedRate;
    sumPredicted += b.count * b.predictedAvg;
  }

  if (sumPredicted === 0 || totalCount < MIN_SAMPLE) {
    return { factor: 1.0, sampleSize: totalCount, computedAt: new Date() };
  }

  const rawFactor = sumRealized / sumPredicted;

  // Blend toward 1.0 for small samples: at n=5 we're ~55% empirical;
  // at n=25 we're ~80%; at n=100 we're ~90%.
  const empiricalWeight = 1 - 1 / Math.sqrt(totalCount);
  const smoothed = 1.0 * (1 - empiricalWeight) + rawFactor * empiricalWeight;

  // Hard clamp: never halve or double a confidence value.
  const factor = Math.max(0.5, Math.min(1.5, smoothed));

  return { factor, sampleSize: totalCount, computedAt: new Date() };
}

/**
 * Return a domain → calibration-factor map. Values are cached for 1 hour so
 * the backtest tables are not re-read on every ingest cycle.
 */
export async function getDomainCalibrationFactors(): Promise<
  Map<string, number>
> {
  const now = new Date();
  const result = new Map<string, number>();

  for (const domain of DOMAINS) {
    const cached = _cache.get(domain);
    if (cached && now.getTime() - cached.computedAt.getTime() < CACHE_TTL_MS) {
      result.set(domain, cached.factor);
    } else {
      const state = await computeFactor(domain);
      _cache.set(domain, state);
      result.set(domain, state.factor);
    }
  }

  return result;
}

/**
 * Evict the in-memory cache so the next `getDomainCalibrationFactors()` call
 * re-reads from the database. Call this immediately after a fresh backtest run
 * so the next ingest cycle picks up the updated factors.
 */
export function invalidateCalibrationCache(): void {
  _cache.clear();
}

/**
 * Apply a domain-specific calibration multiplier to a raw confidence value.
 * Falls back to the "overall" factor when the domain has no calibration data.
 * Clamped to [0.10, 0.95] to prevent degenerate outputs.
 */
export function calibratedConfidence(
  rawConfidence: number,
  domain: string,
  factors: Map<string, number>,
): number {
  const factor = factors.get(domain) ?? factors.get("overall") ?? 1.0;
  const adjusted = rawConfidence * factor;
  return Math.max(0.10, Math.min(0.95, clamp01(adjusted)));
}
