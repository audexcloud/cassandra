import { Router, type IRouter } from "express";
import {
  GetBacktestCalibrationQueryParams,
  GetBacktestCalibrationResponse,
  GetBacktestSummaryResponse,
  RunBacktestResponse,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import { backtestRuns } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";

import {
  DEFAULT_LOOKBACK_DAYS,
  STANDARD_LOOKBACKS,
  SUPPORTED_LOOKBACK_DAYS,
  getLatestBacktest,
  runStandardBacktests,
  type LookbackDays,
} from "../lib/cassandra/backtest";

const router: IRouter = Router();

router.get("/backtest/summary", async (_req, res) => {
  const headlines = await Promise.all(
    STANDARD_LOOKBACKS.map(async (lb) => {
      const [row] = await db
        .select()
        .from(backtestRuns)
        .where(
          and(
            eq(backtestRuns.scope, "overall"),
            eq(backtestRuns.lookbackDays, lb),
          ),
        )
        .orderBy(desc(backtestRuns.runAt))
        .limit(1);
      return {
        lookbackDays: lb,
        totalEntries: row?.totalEntries ?? 0,
        brierScore: row?.brierScore ?? null,
        logLoss: row?.logLoss ?? null,
        hitRate: row?.hitRate ?? null,
        runAt: row?.runAt ? row.runAt.toISOString() : null,
      };
    }),
  );

  // Distinct scope names actually present in the table — drives the
  // scope dropdown on the Backtest page so we don't show empty groups.
  const scopeRows = await db
    .selectDistinct({ scope: backtestRuns.scope })
    .from(backtestRuns)
    .orderBy(backtestRuns.scope);

  res.json(
    GetBacktestSummaryResponse.parse({
      scopes: scopeRows.map((s) => s.scope),
      headlines,
    }),
  );
});

router.get("/backtest/calibration", async (req, res) => {
  // The codegen produces a literal-union for lookbackDays which doesn't
  // coerce strings; query params arrive as strings, so we coerce here
  // before validating against the generated schema.
  const coerced = {
    ...req.query,
    lookbackDays:
      req.query.lookbackDays != null
        ? Number(req.query.lookbackDays)
        : undefined,
  };
  const parsed = GetBacktestCalibrationQueryParams.safeParse(coerced);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const scope = parsed.data.scope ?? "overall";
  const lookbackDays = (parsed.data.lookbackDays ??
    DEFAULT_LOOKBACK_DAYS) as LookbackDays;

  if (!SUPPORTED_LOOKBACK_DAYS.includes(lookbackDays)) {
    res.status(400).json({
      error: `lookbackDays must be one of ${SUPPORTED_LOOKBACK_DAYS.join(", ")}`,
    });
    return;
  }

  const summary = await getLatestBacktest(scope, lookbackDays);
  if (!summary) {
    res.status(404).json({
      error: `No backtest run found for scope="${scope}" lookbackDays=${lookbackDays}`,
    });
    return;
  }

  res.json(GetBacktestCalibrationResponse.parse(summary));
});

router.post("/backtest/run", async (_req, res) => {
  await runStandardBacktests();
  // Re-issue the same payload as /backtest/summary so the frontend can
  // refresh from a single response.
  const headlines = await Promise.all(
    STANDARD_LOOKBACKS.map(async (lb) => {
      const [row] = await db
        .select()
        .from(backtestRuns)
        .where(
          and(
            eq(backtestRuns.scope, "overall"),
            eq(backtestRuns.lookbackDays, lb),
          ),
        )
        .orderBy(desc(backtestRuns.runAt))
        .limit(1);
      return {
        lookbackDays: lb,
        totalEntries: row?.totalEntries ?? 0,
        brierScore: row?.brierScore ?? null,
        logLoss: row?.logLoss ?? null,
        hitRate: row?.hitRate ?? null,
        runAt: row?.runAt ? row.runAt.toISOString() : null,
      };
    }),
  );
  const scopeRows = await db
    .select({ scope: backtestRuns.scope, n: sql<number>`count(*)::int` })
    .from(backtestRuns)
    .groupBy(backtestRuns.scope)
    .orderBy(backtestRuns.scope);

  res.json(
    RunBacktestResponse.parse({
      scopes: scopeRows.map((s) => s.scope),
      headlines,
    }),
  );
});

export default router;
