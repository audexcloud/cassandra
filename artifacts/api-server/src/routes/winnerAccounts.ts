import { Router, type IRouter } from "express";
import {
  DismissWinnerSuggestionParams,
  DismissWinnerSuggestionResponse,
  GetWinnerAccountParams,
  GetWinnerAccountResponse,
  ListWinnerAccountsQueryParams,
  ListWinnerAccountsResponse,
  MirrorWinnerSuggestionBody,
  MirrorWinnerSuggestionParams,
  MirrorWinnerSuggestionResponse,
  RefreshWinnerAccountsResponse,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  walletProfiles,
  walletSnapshots,
  mirrorSuggestions,
  opportunities,
  paperTrades,
  riskConfig,
  auditLog,
} from "@workspace/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { evaluateRiskGate, priceForSide } from "../lib/cassandra/scoring";
import {
  refreshWinnerWallets,
  snapshotWalletPositions,
} from "../lib/cassandra/winnerWallets";
import { serializePaperTrade } from "./opportunities";

const router: IRouter = Router();

const SPARKLINE_LIMIT = 24;
const SNAPSHOT_HISTORY_LIMIT = 96;

router.get("/winner-accounts", async (req, res) => {
  const parsed = ListWinnerAccountsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { source, limit } = parsed.data;

  const filters = [eq(walletProfiles.tracked, true)];
  if (source) filters.push(eq(walletProfiles.source, source));

  const wallets = await db
    .select()
    .from(walletProfiles)
    .where(and(...filters))
    .orderBy(asc(walletProfiles.rank), desc(walletProfiles.pnlUsd))
    .limit(limit ?? 50);

  // Pull recent snapshots for every wallet in one query, then bucket by id.
  // Filter at the SQL level by the wallet IDs in this page so the snapshots
  // table can grow without scanning the whole relation.
  const ids = wallets.map((w) => w.id);
  const sparkRows = ids.length
    ? await db
        .select({
          walletId: walletSnapshots.walletId,
          pnlUsd: walletSnapshots.pnlUsd,
          capturedAt: walletSnapshots.capturedAt,
        })
        .from(walletSnapshots)
        .where(inArray(walletSnapshots.walletId, ids))
        .orderBy(desc(walletSnapshots.capturedAt))
    : [];
  const sparkByWallet = new Map<number, Array<{ t: string; pnlUsd: number }>>();
  for (const row of sparkRows) {
    const list = sparkByWallet.get(row.walletId) ?? [];
    if (list.length < SPARKLINE_LIMIT) {
      list.push({ t: row.capturedAt.toISOString(), pnlUsd: row.pnlUsd });
      sparkByWallet.set(row.walletId, list);
    }
  }

  const data = wallets.map((w) => ({
    id: w.id,
    source: w.source,
    address: w.address,
    label: w.label,
    notes: w.notes,
    rank: w.rank,
    hitRate: w.hitRate,
    avgEdge: w.avgEdge,
    pnlUsd: w.pnlUsd,
    activePositions: w.activePositions,
    closedPositions: w.closedPositions,
    tracked: w.tracked,
    lastSyncedAt: w.lastSyncedAt ? w.lastSyncedAt.toISOString() : null,
    pnlSparkline: (sparkByWallet.get(w.id) ?? []).slice().reverse(),
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  }));

  res.json(ListWinnerAccountsResponse.parse(data));
});

router.post("/winner-accounts/refresh", async (_req, res) => {
  const r = await refreshWinnerWallets();
  res.json(
    RefreshWinnerAccountsResponse.parse({
      walletsRefreshed: r.walletsRefreshed,
      snapshotsInserted: r.snapshotsInserted,
      suggestionsCreated: r.suggestionsCreated,
      ranAt: r.ranAt.toISOString(),
    }),
  );
});

router.get("/winner-accounts/:id", async (req, res) => {
  const parsed = GetWinnerAccountParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { id } = parsed.data;

  const [wallet] = await db
    .select()
    .from(walletProfiles)
    .where(eq(walletProfiles.id, id))
    .limit(1);

  if (!wallet) {
    res.status(404).json({ error: "Wallet not found" });
    return;
  }

  const [snapshots, suggestions, allMarkets] = await Promise.all([
    db
      .select()
      .from(walletSnapshots)
      .where(eq(walletSnapshots.walletId, id))
      .orderBy(desc(walletSnapshots.capturedAt))
      .limit(SNAPSHOT_HISTORY_LIMIT),
    db
      .select()
      .from(mirrorSuggestions)
      .where(eq(mirrorSuggestions.walletId, id))
      .orderBy(desc(mirrorSuggestions.createdAt))
      .limit(50),
    db
      .select({
        id: opportunities.id,
        marketKey: opportunities.marketKey,
        question: opportunities.question,
        marketProb: opportunities.marketProb,
      })
      .from(opportunities),
  ]);

  const state = snapshotWalletPositions(wallet, allMarkets);

  // Pull current implied prices for each open position so the UI can show
  // unrealized P&L from the wallet's entry to right now.
  const marketByKey = new Map<string, { id: number; marketProb: number }>();
  for (const m of allMarkets) marketByKey.set(m.marketKey, m);

  const sparkline = snapshots
    .slice(0, SPARKLINE_LIMIT)
    .slice()
    .reverse()
    .map((s) => ({ t: s.capturedAt.toISOString(), pnlUsd: s.pnlUsd }));

  const data = {
    id: wallet.id,
    source: wallet.source,
    address: wallet.address,
    label: wallet.label,
    notes: wallet.notes,
    rank: wallet.rank,
    hitRate: wallet.hitRate,
    avgEdge: wallet.avgEdge,
    pnlUsd: wallet.pnlUsd,
    activePositions: wallet.activePositions,
    closedPositions: wallet.closedPositions,
    tracked: wallet.tracked,
    lastSyncedAt: wallet.lastSyncedAt ? wallet.lastSyncedAt.toISOString() : null,
    pnlSparkline: sparkline,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
    snapshots: snapshots
      .slice()
      .reverse()
      .map((s) => ({
        capturedAt: s.capturedAt.toISOString(),
        pnlUsd: s.pnlUsd,
        activePositions: s.activePositions,
        closedPositions: s.closedPositions,
        hitRate: s.hitRate,
        avgEdge: s.avgEdge,
      })),
    openPositions: state.open.map((pos) => {
      const m = marketByKey.get(pos.marketKey);
      const entry = Math.max(0.001, pos.entryProb);
      const current = m ? priceForSide(pos.direction, m.marketProb) : null;
      const unrealizedPnl =
        current === null
          ? null
          : Number(((pos.sizeUsd / entry) * (current - entry)).toFixed(2));
      return {
        marketKey: pos.marketKey,
        question: pos.question,
        direction: pos.direction,
        entryProb: pos.entryProb,
        currentProb: current,
        sizeUsd: pos.sizeUsd,
        unrealizedPnl,
        openedAt: pos.openedAt.toISOString(),
        opportunityId: m?.id ?? null,
      };
    }),
    recentClosedPositions: state.closed.map((pos) => ({
      marketKey: pos.marketKey,
      question: pos.question,
      direction: pos.direction,
      entryProb: pos.entryProb,
      exitProb: pos.exitProb,
      sizeUsd: pos.sizeUsd,
      pnlUsd: pos.pnlUsd,
      closedAt: pos.closedAt.toISOString(),
    })),
    suggestions: suggestions.map(serializeMirrorSuggestion),
  };

  res.json(GetWinnerAccountResponse.parse(data));
});

router.post("/winner-accounts/suggestions/:id/mirror", async (req, res) => {
  const parsedParams = MirrorWinnerSuggestionParams.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ error: parsedParams.error.message });
    return;
  }
  const parsedBody = MirrorWinnerSuggestionBody.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    res.status(400).json({ error: parsedBody.error.message });
    return;
  }
  const { id } = parsedParams.data;
  const { sizeUsd: sizeOverride, note } = parsedBody.data;

  const result = await db.transaction(async (tx) => {
    const [suggestion] = await tx
      .select()
      .from(mirrorSuggestions)
      .where(eq(mirrorSuggestions.id, id))
      .limit(1);
    if (!suggestion) return { kind: "not_found" as const };
    if (suggestion.status !== "pending") {
      return { kind: "already_actioned" as const, suggestion };
    }
    if (suggestion.opportunityId === null) {
      return { kind: "no_opportunity" as const };
    }

    const [opp] = await tx
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, suggestion.opportunityId))
      .limit(1);
    if (!opp) {
      return { kind: "no_opportunity" as const };
    }

    const [cfg] = await tx.select().from(riskConfig).limit(1);
    if (!cfg) return { kind: "no_risk_config" as const };

    const sizeUsd = sizeOverride ?? suggestion.suggestedSizeUsd;
    const gate = evaluateRiskGate({
      sizeUsd,
      opportunity: {
        confidence: opp.confidence,
        liquidity: opp.liquidity,
        edgeScore: opp.edgeScore,
        spread: opp.spread,
      },
      config: {
        killSwitchEngaged: cfg.killSwitchEngaged,
        liveExecutionEnabled: cfg.liveExecutionEnabled,
        watchOnlyMode: cfg.watchOnlyMode,
        maxPositionUsd: cfg.maxPositionUsd,
        minConfidence: cfg.minConfidence,
        minLiquidityUsd: cfg.minLiquidityUsd,
        minEdgeScore: cfg.minEdgeScore,
        maxSpread: cfg.maxSpread,
      },
    });
    if (!gate.allowed) {
      await tx.insert(auditLog).values({
        actor: "user",
        action: "mirror_suggestion.blocked",
        target: `mirror_suggestion:${id}`,
        payload: { sizeUsd, reasons: gate.reasons },
      });
      return { kind: "blocked" as const, reasons: gate.reasons };
    }

    const direction = suggestion.direction as "yes" | "no";
    const entryProb = priceForSide(direction, opp.marketProb);
    const rationaleText = `Mirror of ${suggestion.walletId}: ${suggestion.question}`
      + (note ? `\nnote: ${note}` : "");

    const [trade] = await tx
      .insert(paperTrades)
      .values({
        opportunityId: opp.id,
        marketKey: opp.marketKey,
        question: opp.question,
        direction,
        sizeUsd,
        entryProb,
        rationale: rationaleText,
      })
      .returning();

    const [updated] = await tx
      .update(mirrorSuggestions)
      .set({
        status: "mirrored",
        paperTradeId: trade.id,
        updatedAt: new Date(),
      })
      .where(eq(mirrorSuggestions.id, id))
      .returning();

    await tx.insert(auditLog).values({
      actor: "user",
      action: "mirror_suggestion.mirrored",
      target: `mirror_suggestion:${id}`,
      payload: {
        paperTradeId: trade.id,
        sizeUsd,
        direction,
        entryProb,
        walletId: suggestion.walletId,
      },
    });

    return { kind: "ok" as const, suggestion: updated, trade };
  });

  if (result.kind === "not_found") {
    res.status(404).json({ error: "Suggestion not found" });
    return;
  }
  if (result.kind === "already_actioned") {
    res.status(400).json({
      error: `Suggestion already ${result.suggestion.status}`,
    });
    return;
  }
  if (result.kind === "no_opportunity") {
    res.status(400).json({
      error:
        "Suggestion is not linked to a known opportunity yet — wait for the next ingest cycle to capture this market.",
    });
    return;
  }
  if (result.kind === "no_risk_config") {
    res.status(500).json({ error: "Risk config not initialised" });
    return;
  }
  if (result.kind === "blocked") {
    res.status(400).json({
      blocked: true,
      reasons: result.reasons,
      error: result.reasons.map((r) => r.message).join(" "),
    });
    return;
  }

  res.json(
    MirrorWinnerSuggestionResponse.parse({
      suggestion: serializeMirrorSuggestion(result.suggestion),
      paperTrade: serializePaperTrade(result.trade),
    }),
  );
});

router.post("/winner-accounts/suggestions/:id/dismiss", async (req, res) => {
  const parsed = DismissWinnerSuggestionParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { id } = parsed.data;

  const [existing] = await db
    .select()
    .from(mirrorSuggestions)
    .where(eq(mirrorSuggestions.id, id))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Suggestion not found" });
    return;
  }

  // Idempotent dismiss: if it's already mirrored, we leave the audit trail
  // intact and just return the row. Dismissing a mirrored suggestion would
  // be misleading — the trade still exists.
  if (existing.status === "mirrored") {
    res.json(DismissWinnerSuggestionResponse.parse(serializeMirrorSuggestion(existing)));
    return;
  }

  const [updated] = await db
    .update(mirrorSuggestions)
    .set({ status: "dismissed", updatedAt: new Date() })
    .where(eq(mirrorSuggestions.id, id))
    .returning();

  await db.insert(auditLog).values({
    actor: "user",
    action: "mirror_suggestion.dismissed",
    target: `mirror_suggestion:${id}`,
    payload: { walletId: updated.walletId, marketKey: updated.marketKey },
  });

  res.json(DismissWinnerSuggestionResponse.parse(serializeMirrorSuggestion(updated)));
});

function serializeMirrorSuggestion(row: typeof mirrorSuggestions.$inferSelect) {
  // Defensive defaults — the column is jsonb so the type is unknown until
  // we shape it; the writer always sets every field, but cover the
  // partial-write case so the response stays well-formed.
  const r = (row.rationale ?? {}) as Partial<{
    observed: string[];
    inferred: string[];
    speculation: string[];
    unknowns: string[];
    riskFlags: string[];
  }>;
  return {
    id: row.id,
    walletId: row.walletId,
    opportunityId: row.opportunityId,
    marketKey: row.marketKey,
    question: row.question,
    direction: row.direction as "yes" | "no",
    entryProb: row.entryProb,
    suggestedSizeUsd: row.suggestedSizeUsd,
    walletSizeUsd: row.walletSizeUsd,
    rationale: {
      observed: r.observed ?? [],
      inferred: r.inferred ?? [],
      speculation: r.speculation ?? [],
      unknowns: r.unknowns ?? [],
      riskFlags: r.riskFlags ?? [],
    },
    status: row.status as "pending" | "mirrored" | "dismissed",
    paperTradeId: row.paperTradeId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default router;
