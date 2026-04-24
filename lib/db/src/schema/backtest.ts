import {
  pgTable,
  serial,
  text,
  timestamp,
  doublePrecision,
  integer,
  index,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * Snapshot of one confidence bucket. Confidence is |2p - 1|, so this is
 * "how often did we get the answer right when we said we were this sure".
 * Stored as JSON on the run row because it is small (<= NUM_BUCKETS rows),
 * write-once, and only ever read alongside the parent run.
 */
export interface HitRateBucketSnapshot {
  low: number;
  high: number;
  hitRate: number;
  count: number;
}

/**
 * One row per (run, scope) tuple. A "scope" is one of:
 *   - "overall"
 *   - "domain:<domain>"            (e.g. "domain:macro")
 *   - "signalCategory:<category>"  (e.g. "signalCategory:observation_heavy")
 *
 * Multiple `backtestRuns` rows therefore share the same `runAt` timestamp —
 * one per scope. The companion `calibrationBuckets` table holds the
 * predicted-vs-realized buckets that drive the calibration curve for that
 * scope.
 */
export const backtestRuns = pgTable(
  "backtest_runs",
  {
    id: serial("id").primaryKey(),
    runAt: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
    lookbackDays: integer("lookback_days").notNull(),
    scope: text("scope").notNull(),
    totalEntries: integer("total_entries").notNull().default(0),
    brierScore: doublePrecision("brier_score"),
    logLoss: doublePrecision("log_loss"),
    hitRate: doublePrecision("hit_rate"),
    hitRateBuckets: jsonb("hit_rate_buckets")
      .$type<HitRateBucketSnapshot[]>()
      .default([])
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    // The hot read pattern is "latest run for (scope, lookbackDays)".
    scopeLookbackIdx: index("backtest_runs_scope_lookback_runat_idx").on(
      t.scope,
      t.lookbackDays,
      t.runAt,
    ),
  }),
);

export const calibrationBuckets = pgTable(
  "calibration_buckets",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => backtestRuns.id, { onDelete: "cascade" }),
    bucketLow: doublePrecision("bucket_low").notNull(),
    bucketHigh: doublePrecision("bucket_high").notNull(),
    predictedAvg: doublePrecision("predicted_avg").notNull(),
    realizedRate: doublePrecision("realized_rate").notNull(),
    count: integer("count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    runIdIdx: index("calibration_buckets_run_id_idx").on(t.runId),
  }),
);

export type BacktestRunRow = typeof backtestRuns.$inferSelect;
export type CalibrationBucketRow = typeof calibrationBuckets.$inferSelect;
