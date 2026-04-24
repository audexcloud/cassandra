import { Router, type IRouter } from "express";
import {
  ClosePaperTradeBody,
  ClosePaperTradeParams,
  ClosePaperTradeResponse,
  CreatePaperTradeBody,
  ListPaperTradesQueryParams,
  ListPaperTradesResponse,
  SweepPaperTradeParams,
  SweepPaperTradeResponse,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  opportunities,
  paperTrades,
  riskConfig,
  auditLog,
  paperTradeOutcomes,
  signalEvents,
} from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { paperPnl, priceForSide, evaluateRiskGate } from "../lib/cassandra/scoring";
import { serializePaperTrade } from "./opportunities";
import { ingestSignals, updatePredictionJournal } from "../lib/cassandra/pipeline";

const router: IRouter = Router();

router.get("/paper-trades", async (req, res) => {
  const parsed = ListPaperTradesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { status } = parsed.data;
  const where =
    status === "open"
      ? eq(paperTrades.status, "open")
      : status === "closed"
        ? eq(paperTrades.status, "closed")
        : undefined;
  const rows = await db
    .select()
    .from(paperTrades)
    .where(where)
    .orderBy(desc(paperTrades.openedAt));
  res.json(ListPaperTradesResponse.parse(rows.map(serializePaperTrade)));
});

router.post("/paper-trades", async (req, res) => {
  const parsed = CreatePaperTradeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { opportunityId, direction, sizeUsd, rationale } = parsed.data;

  const [cfg] = await db.select().from(riskConfig).limit(1);
  if (!cfg) {
    res.status(500).json({ error: "Risk config not initialised" });
    return;
  }

  const [opp] = await db
    .select()
    .from(opportunities)
    .where(eq(opportunities.id, opportunityId))
    .limit(1);
  if (!opp) {
    res.status(400).json({ error: "Opportunity not found" });
    return;
  }

  // Structured risk gate: returns every reason the trade is blocked so the
  // UI can display a "why not trade?" explanation rather than a single
  // opaque error.
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
    await db.insert(auditLog).values({
      actor: "user",
      action: "paper_trade.blocked",
      target: `opportunity:${opp.id}`,
      payload: { sizeUsd, direction, reasons: gate.reasons },
    });
    res.status(400).json({
      blocked: true,
      reasons: gate.reasons,
      error: gate.reasons.map((r) => r.message).join(" "),
    });
    return;
  }

  // Store the side-appropriate price as entryProb. For YES, that's marketProb;
  // for NO, that's 1 - marketProb. PnL math downstream is symmetric in price.
  const entryProb = priceForSide(direction, opp.marketProb);

  const [row] = await db
    .insert(paperTrades)
    .values({
      opportunityId: opp.id,
      marketKey: opp.marketKey,
      question: opp.question,
      direction,
      sizeUsd,
      entryProb,
      rationale: rationale ?? null,
    })
    .returning();

  await db.insert(auditLog).values({
    actor: "user",
    action: "paper_trade.open",
    target: `paper_trade:${row.id}`,
    payload: { opportunityId: opp.id, direction, sizeUsd, entryProb },
  });

  res.status(201).json(serializePaperTrade(row));
});

router.post("/paper-trades/:id/close", async (req, res) => {
  const parsedParams = ClosePaperTradeParams.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ error: parsedParams.error.message });
    return;
  }
  // Fail fast on a malformed body — silently clamping invalid input would let
  // bad clients trade with surprise sizes.
  const parsedBody = ClosePaperTradeBody.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    res.status(400).json({ error: parsedBody.error.message });
    return;
  }
  const note = parsedBody.data.note;
  // Partial cash-out: closeFraction in [0.05, 1] tells us how much of the
  // position to realize. 1 (the default) is a full close. Anything < 1
  // splits the trade: original row is closed at the partial size, a new
  // open row is created for the remainder. The OpenAPI/zod schema enforces
  // the [0.05, 1] range — we don't clamp silently here.
  const fraction = parsedBody.data.closeFraction ?? 1;
  const { id } = parsedParams.data;

  const result = await db.transaction(async (tx) => {
    const [trade] = await tx
      .select()
      .from(paperTrades)
      .where(eq(paperTrades.id, id))
      .limit(1);
    if (!trade) return { kind: "not_found" as const };
    if (trade.status === "closed") {
      return { kind: "already_closed" as const, trade };
    }

    const [opp] = await tx
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, trade.opportunityId))
      .limit(1);
    // MTM uses the implied market price (not our internal model), so closing
    // a freshly opened position at the same instant nets ~$0.
    const dir = trade.direction as "yes" | "no";
    const exitProb = opp ? priceForSide(dir, opp.marketProb) : trade.entryProb;
    const closedSize = Number((trade.sizeUsd * fraction).toFixed(2));
    const remainingSize = Number((trade.sizeUsd - closedSize).toFixed(2));
    const pnl = paperPnl({
      direction: dir,
      sizeUsd: closedSize,
      entryProb: trade.entryProb,
      exitProb,
    });

    const [updated] = await tx
      .update(paperTrades)
      .set({
        status: "closed",
        exitProb,
        sizeUsd: closedSize,
        pnlUsd: Number(pnl.toFixed(2)),
        closedAt: new Date(),
        rationale: note ? `${trade.rationale ?? ""}\nclose: ${note}`.trim() : trade.rationale,
      })
      .where(eq(paperTrades.id, id))
      .returning();

    // If this was a partial cash-out, open a new position for the remainder
    // at the SAME entry price (the user is keeping the rest of the position
    // they originally took, not re-entering at the current market).
    let remainder: typeof paperTrades.$inferSelect | null = null;
    if (remainingSize > 0) {
      const [created] = await tx
        .insert(paperTrades)
        .values({
          opportunityId: trade.opportunityId,
          marketKey: trade.marketKey,
          question: trade.question,
          direction: trade.direction,
          sizeUsd: remainingSize,
          entryProb: trade.entryProb,
          rationale: trade.rationale
            ? `${trade.rationale} (remainder of partial cash-out)`
            : "remainder of partial cash-out",
        })
        .returning();
      remainder = created;
    }

    await tx.insert(auditLog).values({
      actor: "user",
      action: "paper_trade.close",
      target: `paper_trade:${id}`,
      payload: {
        exitProb,
        pnlUsd: pnl,
        note,
        closeFraction: fraction,
        remainderTradeId: remainder?.id ?? null,
      },
    });

    // Persist a prediction-journal outcome row tied to this closure. The
    // journal is the calibration substrate: every closed trade gets a
    // structured "what was right / what was wrong" that follow-up
    // calibration work can mine without re-deriving from raw audit logs.
    const recentSignals = opp
      ? await tx
          .select({
            source: signalEvents.source,
            kind: signalEvents.kind,
            domain: signalEvents.domain,
            title: signalEvents.title,
            body: signalEvents.body,
            impact: signalEvents.impact,
            sentiment: signalEvents.sentiment,
          })
          .from(signalEvents)
          .where(eq(signalEvents.opportunityId, opp.id))
          .orderBy(desc(signalEvents.observedAt))
          .limit(20)
      : [];
    const normalized = ingestSignals(
      recentSignals.map((s) => ({ ...s, weight: Math.max(0.1, s.impact) })),
    );
    const rationale = (opp?.rationale ?? {
      observed: [],
      inferred: [],
      speculation: [],
      unknowns: [],
      riskFlags: [],
    }) as {
      observed: string[];
      inferred: string[];
      speculation: string[];
      unknowns: string[];
      riskFlags: string[];
    };
    const journal = updatePredictionJournal({
      paperTradeId: updated.id,
      realizedPnlUsd: Number(pnl.toFixed(2)),
      rationale,
      signals: normalized,
    });
    await tx.insert(paperTradeOutcomes).values({
      paperTradeId: journal.paperTradeId,
      realizedPnlUsd: journal.realizedPnlUsd,
      whatWasRight: journal.whatWasRight,
      whatWasWrong: journal.whatWasWrong,
    });

    return { kind: "ok" as const, updated };
  });

  if (result.kind === "not_found") {
    res.status(404).json({ error: "Paper trade not found" });
    return;
  }
  if (result.kind === "already_closed") {
    res.json(serializePaperTrade(result.trade));
    return;
  }
  res.json(ClosePaperTradeResponse.parse(serializePaperTrade(result.updated)));
});

/**
 * Profit sweep. If the trade is currently in the money, close
 * `risk_config.profitSweepFraction` of the position at the current implied
 * price (locking in some profit) and re-open the remainder at the SAME
 * entry price the operator originally took. If PnL is non-positive, this
 * is a no-op and we report `swept: false` — sweeping a losing trade would
 * just realize a loss, which is not what the mechanic is for.
 */
router.post("/paper-trades/:id/sweep", async (req, res) => {
  const parsedParams = SweepPaperTradeParams.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ error: parsedParams.error.message });
    return;
  }
  const { id } = parsedParams.data;

  const [cfg] = await db.select().from(riskConfig).limit(1);
  if (!cfg) {
    res.status(500).json({ error: "Risk config not initialised" });
    return;
  }
  const sweepFraction = Math.min(1, Math.max(0, cfg.profitSweepFraction));

  const result = await db.transaction(async (tx) => {
    const [trade] = await tx
      .select()
      .from(paperTrades)
      .where(eq(paperTrades.id, id))
      .limit(1);
    if (!trade) return { kind: "not_found" as const };
    if (trade.status === "closed") {
      return { kind: "already_closed" as const, trade };
    }

    const [opp] = await tx
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, trade.opportunityId))
      .limit(1);

    const dir = trade.direction as "yes" | "no";
    const exitProb = opp ? priceForSide(dir, opp.marketProb) : trade.entryProb;
    const fullPnl = paperPnl({
      direction: dir,
      sizeUsd: trade.sizeUsd,
      entryProb: trade.entryProb,
      exitProb,
    });

    if (fullPnl <= 0 || sweepFraction <= 0) {
      // Nothing to sweep — refuse silently and return the trade as-is.
      await tx.insert(auditLog).values({
        actor: "user",
        action: "paper_trade.sweep_skipped",
        target: `paper_trade:${id}`,
        payload: { reason: fullPnl <= 0 ? "non_positive_pnl" : "sweep_fraction_zero", fullPnl },
      });
      return { kind: "noop" as const, trade };
    }

    const closedSize = Number((trade.sizeUsd * sweepFraction).toFixed(2));
    const remainingSize = Number((trade.sizeUsd - closedSize).toFixed(2));
    const realized = paperPnl({
      direction: dir,
      sizeUsd: closedSize,
      entryProb: trade.entryProb,
      exitProb,
    });

    const [updated] = await tx
      .update(paperTrades)
      .set({
        status: "closed",
        exitProb,
        sizeUsd: closedSize,
        pnlUsd: Number(realized.toFixed(2)),
        closedAt: new Date(),
        rationale: `${trade.rationale ?? ""}\nprofit_sweep: ${(sweepFraction * 100).toFixed(0)}% closed at ${exitProb.toFixed(3)} (PnL $${realized.toFixed(2)})`.trim(),
      })
      .where(eq(paperTrades.id, id))
      .returning();

    let remainder: typeof paperTrades.$inferSelect | null = null;
    if (remainingSize > 0) {
      const [created] = await tx
        .insert(paperTrades)
        .values({
          opportunityId: trade.opportunityId,
          marketKey: trade.marketKey,
          question: trade.question,
          direction: trade.direction,
          sizeUsd: remainingSize,
          entryProb: trade.entryProb,
          rationale: trade.rationale
            ? `${trade.rationale} (remainder of profit sweep)`
            : "remainder of profit sweep",
        })
        .returning();
      remainder = created;
    }

    await tx.insert(auditLog).values({
      actor: "user",
      action: "paper_trade.profit_sweep",
      target: `paper_trade:${id}`,
      payload: {
        sweepFraction,
        exitProb,
        realizedPnlUsd: Number(realized.toFixed(2)),
        remainderTradeId: remainder?.id ?? null,
      },
    });

    return { kind: "ok" as const, updated, remainder };
  });

  if (result.kind === "not_found") {
    res.status(404).json({ error: "Paper trade not found" });
    return;
  }
  if (result.kind === "already_closed") {
    res.json(
      SweepPaperTradeResponse.parse({
        swept: false,
        sweepFraction: 0,
        original: serializePaperTrade(result.trade),
        remainder: null,
      }),
    );
    return;
  }
  if (result.kind === "noop") {
    res.json(
      SweepPaperTradeResponse.parse({
        swept: false,
        sweepFraction: 0,
        original: serializePaperTrade(result.trade),
        remainder: null,
      }),
    );
    return;
  }
  res.json(
    SweepPaperTradeResponse.parse({
      swept: true,
      sweepFraction,
      original: serializePaperTrade(result.updated),
      remainder: result.remainder ? serializePaperTrade(result.remainder) : null,
    }),
  );
});

export default router;
