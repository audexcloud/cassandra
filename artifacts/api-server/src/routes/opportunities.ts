import { Router, type IRouter } from "express";
import {
  GetOpportunityParams,
  GetOpportunityResponse,
  GetRandomOpportunityResponse,
  ListOpportunitiesQueryParams,
  ListOpportunitiesResponse,
  ListTopOpportunitiesResponse,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import { opportunities, signalEvents, paperTrades } from "@workspace/db";
import { and, desc, eq, gte } from "drizzle-orm";
import { weightedRandomPick } from "../lib/cassandra/scoring";
import { generateTradePlan, type ReasoningSummary } from "../lib/cassandra/pipeline";

const STALE_AFTER_MS = 5 * 60 * 1000;
// Trade-plan defaults — reflect realistic single-user paper bankroll.
const PLAN_BANKROLL_USD = 10_000;
const PLAN_MAX_KELLY = 0.25;
const PLAN_MAX_POSITION_USD = 500;

const router: IRouter = Router();

router.get("/opportunities", async (req, res) => {
  const parsed = ListOpportunitiesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { domain, source, minEdge, limit } = parsed.data;
  const filters = [];
  if (domain) filters.push(eq(opportunities.domain, domain));
  if (source) filters.push(eq(opportunities.source, source));
  if (typeof minEdge === "number") filters.push(gte(opportunities.edgeScore, minEdge));

  const rows = await db
    .select()
    .from(opportunities)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(opportunities.edgeScore))
    .limit(limit ?? 50);

  res.json(ListOpportunitiesResponse.parse(rows.map(serializeOpportunity)));
});

router.get("/opportunities/top10", async (_req, res) => {
  const rows = await db
    .select()
    .from(opportunities)
    .orderBy(desc(opportunities.edgeScore))
    .limit(10);
  res.json(ListTopOpportunitiesResponse.parse(rows.map(serializeOpportunity)));
});

router.get("/opportunities/random", async (_req, res) => {
  // Weighted random: opportunities with higher edgeScore are proportionally
  // more likely to be surfaced. This is what the spec calls a "weighted
  // random surprise" — uniform random would bias toward low-edge noise.
  const rows = await db.select().from(opportunities);
  const pick = weightedRandomPick(rows);
  if (!pick) {
    res.status(404).json({ error: "No opportunities yet" });
    return;
  }
  res.json(GetRandomOpportunityResponse.parse(serializeOpportunity(pick)));
});

router.get("/opportunities/:id", async (req, res) => {
  const parsed = GetOpportunityParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { id } = parsed.data;

  const [oppRow] = await db
    .select()
    .from(opportunities)
    .where(eq(opportunities.id, id))
    .limit(1);

  if (!oppRow) {
    res.status(404).json({ error: "Opportunity not found" });
    return;
  }

  const [signalRows, tradeRows] = await Promise.all([
    db
      .select()
      .from(signalEvents)
      .where(eq(signalEvents.opportunityId, id))
      .orderBy(desc(signalEvents.observedAt))
      .limit(20),
    db
      .select()
      .from(paperTrades)
      .where(eq(paperTrades.opportunityId, id))
      .orderBy(desc(paperTrades.openedAt))
      .limit(20),
  ]);

  const data = GetOpportunityResponse.parse({
    ...serializeOpportunity(oppRow),
    rationale: oppRow.rationale,
    recentSignals: signalRows.map(serializeSignal),
    paperTrades: tradeRows.map(serializePaperTrade),
  });
  res.json(data);
});

function serializeOpportunity(o: typeof opportunities.$inferSelect) {
  // rationale is stored as jsonb (drizzle types it as `unknown`); the writer
  // (pipeline.ts) always shapes it as ReasoningSummary, so the cast is safe.
  const rationale = (o.rationale ?? {}) as Partial<ReasoningSummary>;

  // Trade plan: derive once at serialization time so every consumer
  // (top board, detail page, dashboard preview) sees the same plan
  // numbers without duplicating the math in the UI layer.
  const plan = generateTradePlan({
    inputs: {
      marketProb: o.marketProb,
      modelProb: o.modelProb,
      confidence: o.confidence,
      liquidity: o.liquidity,
    },
    bankrollUsd: PLAN_BANKROLL_USD,
    maxKellyFraction: PLAN_MAX_KELLY,
    maxPositionUsd: PLAN_MAX_POSITION_USD,
    invalidations: rationale.riskFlags ?? [],
  });

  // recommendedAction: human_review wins over watch; both lose to trade.
  const riskFlags = rationale.riskFlags ?? [];
  const observed = rationale.observed ?? [];
  const inferred = rationale.inferred ?? [];
  const recommendedAction: "trade" | "watch" | "human_review" =
    riskFlags.length > 0
      ? "human_review"
      : o.edgeScore < 0.05
        ? "watch"
        : "trade";

  const keyReason = observed[0] ?? inferred[0] ?? null;
  const status: "active" | "stale" =
    Date.now() - o.updatedAt.getTime() < STALE_AFTER_MS ? "active" : "stale";

  return {
    id: o.id,
    marketKey: o.marketKey,
    source: o.source,
    domain: o.domain,
    question: o.question,
    marketProb: o.marketProb,
    modelProb: o.modelProb,
    edge: o.edge,
    edgeScore: o.edgeScore,
    confidence: o.confidence,
    liquidity: o.liquidity,
    kellyFraction: o.kellyFraction,
    suggestedDirection: o.suggestedDirection,
    recommendedAction,
    keyReason,
    historicalParallel: null,
    status,
    tradePlan: plan,
    url: o.url,
    updatedAt: o.updatedAt.toISOString(),
  };
}

function serializeSignal(s: typeof signalEvents.$inferSelect) {
  return {
    id: s.id,
    opportunityId: s.opportunityId,
    domain: s.domain,
    source: s.source,
    kind: s.kind,
    title: s.title,
    body: s.body,
    impact: s.impact,
    sentiment: s.sentiment,
    observedAt: s.observedAt.toISOString(),
  };
}

function serializePaperTrade(t: typeof paperTrades.$inferSelect) {
  return {
    id: t.id,
    opportunityId: t.opportunityId,
    marketKey: t.marketKey,
    question: t.question,
    direction: t.direction,
    sizeUsd: t.sizeUsd,
    entryProb: t.entryProb,
    exitProb: t.exitProb,
    status: t.status,
    pnlUsd: t.pnlUsd,
    rationale: t.rationale,
    openedAt: t.openedAt.toISOString(),
    closedAt: t.closedAt ? t.closedAt.toISOString() : null,
  };
}

export { serializeOpportunity, serializeSignal, serializePaperTrade };

export default router;
