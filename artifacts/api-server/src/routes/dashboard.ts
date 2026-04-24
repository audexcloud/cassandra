import { Router, type IRouter } from "express";
import { GetDashboardSummaryResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  opportunities,
  signalEvents,
  paperTrades,
  riskConfig,
  connectorStatus,
  scoringModelVersions,
} from "@workspace/db";
import { sql, gte, eq, inArray, desc } from "drizzle-orm";
import { openClawSnapshot, OPPORTUNITY_STALE_AFTER_MS } from "../lib/cassandra/openclaw";
import { priceForSide } from "../lib/cassandra/scoring";
import { parsePersistedAppliedSignals } from "../lib/cassandra/signalMatching";

const router: IRouter = Router();

router.get("/dashboard/summary", async (_req, res) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // Hide opportunities not refreshed in the last several connector cycles
  // so the dashboard counts, top-edge, top-opportunities preview, and
  // domain breakdown all reflect only live markets — not stale rows from
  // earlier connector versions or seed data.
  const freshOppCutoff = new Date(Date.now() - OPPORTUNITY_STALE_AFTER_MS);

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
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(opportunities)
      .where(gte(opportunities.updatedAt, freshOppCutoff)),
    db
      .select({
        domain: opportunities.domain,
        count: sql<number>`count(*)::int`,
      })
      .from(opportunities)
      .where(gte(opportunities.updatedAt, freshOppCutoff))
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
      .from(opportunities)
      .where(gte(opportunities.updatedAt, freshOppCutoff)),
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

  // Top opportunities + active trades + alerts + agent status: the operator
  // hits ONE endpoint and sees everything they need to start the morning.
  const [topOppRows, activeTradeRows, connectorStatusRows, modelVersionRow] =
    await Promise.all([
      db
        .select({
          id: opportunities.id,
          marketKey: opportunities.marketKey,
          question: opportunities.question,
          domain: opportunities.domain,
          source: opportunities.source,
          edge: opportunities.edge,
          edgeScore: opportunities.edgeScore,
          modelProb: opportunities.modelProb,
          marketProb: opportunities.marketProb,
          // Pull rationale so we can surface signal-attribution at-a-glance
          // on the dashboard cards (count + numeric ambient shift) without
          // a second round-trip per row.
          rationale: opportunities.rationale,
        })
        .from(opportunities)
        .where(gte(opportunities.updatedAt, freshOppCutoff))
        .orderBy(desc(opportunities.edgeScore))
        .limit(5),
      db
        .select({
          id: paperTrades.id,
          opportunityId: paperTrades.opportunityId,
          marketKey: paperTrades.marketKey,
          question: paperTrades.question,
          direction: paperTrades.direction,
          sizeUsd: paperTrades.sizeUsd,
          entryProb: paperTrades.entryProb,
          openedAt: paperTrades.openedAt,
        })
        .from(paperTrades)
        .where(eq(paperTrades.status, "open"))
        .orderBy(desc(paperTrades.openedAt))
        .limit(10),
      db.select().from(connectorStatus),
      db
        .select()
        .from(scoringModelVersions)
        .orderBy(desc(scoringModelVersions.createdAt))
        .limit(1),
    ]);

  // Compute per-trade unrealized P&L for the activeTrades payload.
  const probMap = new Map<number, number>();
  if (activeTradeRows.length > 0) {
    const ids = activeTradeRows.map((t) => t.opportunityId);
    const probs = await db
      .select({ id: opportunities.id, marketProb: opportunities.marketProb })
      .from(opportunities)
      .where(inArray(opportunities.id, ids));
    for (const p of probs) probMap.set(p.id, p.marketProb);
  }

  const activeTrades = activeTradeRows.map((t) => {
    const dir = t.direction as "yes" | "no";
    const market = probMap.get(t.opportunityId);
    const exit = market === undefined ? t.entryProb : priceForSide(dir, market);
    const entry = Math.max(0.001, t.entryProb);
    const shares = t.sizeUsd / entry;
    const upnl = shares * (exit - entry);
    return {
      id: t.id,
      opportunityId: t.opportunityId,
      marketKey: t.marketKey,
      question: t.question,
      direction: dir,
      sizeUsd: t.sizeUsd,
      entryProb: t.entryProb,
      unrealizedPnl: Number(upnl.toFixed(2)),
      openedAt: t.openedAt.toISOString(),
    };
  });

  // Alerts: surface anything that should change operator behaviour today.
  const alerts: Array<{ severity: "info" | "warning" | "critical"; kind: string; message: string }> = [];
  if (cfg?.killSwitchEngaged) {
    alerts.push({
      severity: "critical",
      kind: "kill_switch_engaged",
      message: "Kill switch is engaged — all new trades are blocked.",
    });
  }
  for (const cs of connectorStatusRows) {
    if (cs.status === "error") {
      alerts.push({
        severity: "warning",
        kind: "connector_error",
        message: `Connector "${cs.name}" is in error state: ${cs.lastError ?? "unknown"}.`,
      });
    } else if (cs.status === "degraded") {
      alerts.push({
        severity: "info",
        kind: "connector_degraded",
        message: `Connector "${cs.name}" is degraded.`,
      });
    }
  }
  // Highlight any unusually large edge as an "opportunity_spotlight" alert.
  if ((topOppRows[0]?.edgeScore ?? 0) >= 0.7) {
    alerts.push({
      severity: "info",
      kind: "opportunity_spotlight",
      message: `Top edge score is ${(topOppRows[0].edgeScore * 100).toFixed(0)}% — review "${topOppRows[0].question}".`,
    });
  }

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
    topOpportunities: topOppRows.map((o) => {
      // Rationale is jsonb; the new attribution fields land there when
      // openclaw matches ambient signals to a market. Use the same shape
      // guard as the opportunity detail serializer so the count we show
      // here matches the rows the UI will actually render on drill-in
      // (malformed/legacy entries are dropped, not counted).
      const r = (o.rationale ?? {}) as {
        appliedSignals?: unknown;
        ambientShift?: unknown;
      };
      const appliedSignalCount = parsePersistedAppliedSignals(
        r.appliedSignals,
      ).length;
      const ambientShift =
        typeof r.ambientShift === "number" ? r.ambientShift : 0;
      return {
        id: o.id,
        marketKey: o.marketKey,
        question: o.question,
        domain: o.domain,
        source: o.source,
        edge: o.edge,
        edgeScore: o.edgeScore,
        modelProb: o.modelProb,
        marketProb: o.marketProb,
        appliedSignalCount,
        ambientShift,
      };
    }),
    activeTrades,
    alerts,
    agentStatus: {
      openclawRunning: snapshot.running,
      cycleIntervalSec: snapshot.cycleIntervalSec,
      lastCycleAt: snapshot.lastCycleAt ? snapshot.lastCycleAt.toISOString() : null,
      lastDailyBriefAt: snapshot.lastDailyBriefAt
        ? snapshot.lastDailyBriefAt.toISOString()
        : null,
      scoringModelVersion: modelVersionRow[0]?.version ?? null,
    },
  });
  res.json(data);
});

export default router;
