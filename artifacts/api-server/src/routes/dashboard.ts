import { Router, type IRouter } from "express";
import { GetDashboardSummaryResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  opportunities,
  signalEvents,
  paperTrades,
  riskConfig,
} from "@workspace/db";
import { sql, gte, eq, inArray } from "drizzle-orm";
import { openClawSnapshot } from "../lib/cassandra/openclaw";
import { priceForSide } from "../lib/cassandra/scoring";

const router: IRouter = Router();

router.get("/dashboard/summary", async (_req, res) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    totalRow,
    byDomainRows,
    signalsRow,
    openCountRow,
    realizedRow,
    closedAggRow,
    openTradesRows,
    topEdgeRow,
    cfgRow,
  ] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(opportunities),
    db
      .select({
        domain: opportunities.domain,
        count: sql<number>`count(*)::int`,
      })
      .from(opportunities)
      .groupBy(opportunities.domain),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(signalEvents)
      .where(gte(signalEvents.observedAt, since)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(paperTrades)
      .where(eq(paperTrades.status, "open")),
    db
      .select({
        sum: sql<number>`coalesce(sum(${paperTrades.pnlUsd}), 0)::float`,
      })
      .from(paperTrades)
      .where(eq(paperTrades.status, "closed")),
    db
      .select({
        wins: sql<number>`coalesce(sum(case when ${paperTrades.pnlUsd} > 0 then 1 else 0 end), 0)::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(paperTrades)
      .where(eq(paperTrades.status, "closed")),
    db
      .select({
        opportunityId: paperTrades.opportunityId,
        direction: paperTrades.direction,
        sizeUsd: paperTrades.sizeUsd,
        entryProb: paperTrades.entryProb,
      })
      .from(paperTrades)
      .where(eq(paperTrades.status, "open")),
    db
      .select({ topEdge: sql<number>`coalesce(max(${opportunities.edgeScore}), 0)::float` })
      .from(opportunities),
    db.select().from(riskConfig).limit(1),
  ]);

  // Compute mark-to-market unrealized P&L using the implied market price for
  // each side (NOT our internal modelProb), so MTM reflects what we could
  // theoretically realize if we closed right now.
  let unrealized = 0;
  if (openTradesRows.length > 0) {
    const ids = openTradesRows.map((t) => t.opportunityId);
    const probMap = new Map<number, number>();
    const probs = await db
      .select({ id: opportunities.id, marketProb: opportunities.marketProb })
      .from(opportunities)
      .where(inArray(opportunities.id, ids));
    for (const p of probs) probMap.set(p.id, p.marketProb);
    for (const t of openTradesRows) {
      const dir = t.direction as "yes" | "no";
      const market = probMap.get(t.opportunityId);
      const exit = market === undefined ? t.entryProb : priceForSide(dir, market);
      const entry = Math.max(0.001, t.entryProb);
      const shares = t.sizeUsd / entry;
      unrealized += shares * (exit - entry);
    }
  }

  const cfg = cfgRow[0];
  const wins = closedAggRow[0]?.wins ?? 0;
  const total = closedAggRow[0]?.total ?? 0;
  const winRate = total === 0 ? 0 : wins / total;

  const snapshot = openClawSnapshot();

  const data = GetDashboardSummaryResponse.parse({
    opportunitiesTotal: totalRow[0]?.n ?? 0,
    opportunitiesByDomain: byDomainRows.map((r) => ({
      domain: r.domain,
      count: r.count,
    })),
    signalsLast24h: signalsRow[0]?.n ?? 0,
    paperOpenCount: openCountRow[0]?.n ?? 0,
    paperRealizedPnl: Number((realizedRow[0]?.sum ?? 0).toFixed(2)),
    paperUnrealizedPnl: Number(unrealized.toFixed(2)),
    paperWinRate: Number(winRate.toFixed(4)),
    topEdge: Number((topEdgeRow[0]?.topEdge ?? 0).toFixed(4)),
    killSwitchEngaged: cfg?.killSwitchEngaged ?? false,
    // Hard-pinned to false in this build regardless of any DB value.
    liveExecutionEnabled: false,
    lastCycleAt: snapshot.lastCycleAt ? snapshot.lastCycleAt.toISOString() : null,
  });
  res.json(data);
});

export default router;
