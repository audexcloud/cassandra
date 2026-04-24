import { Router, type IRouter } from "express";
import {
  ClosePaperTradeBody,
  ClosePaperTradeParams,
  ClosePaperTradeResponse,
  CreatePaperTradeBody,
  ListPaperTradesQueryParams,
  ListPaperTradesResponse,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  opportunities,
  paperTrades,
  riskConfig,
  auditLog,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { paperPnl, priceForSide } from "../lib/cassandra/scoring";
import { serializePaperTrade } from "./opportunities";

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
  if (cfg.killSwitchEngaged) {
    res.status(400).json({
      error: "Kill switch is engaged — paper trades are blocked.",
    });
    return;
  }
  if (cfg.liveExecutionEnabled) {
    // Defensive: this build hard-disables live execution in code. If this
    // ever flips true via the DB, refuse to act on it.
    res.status(400).json({
      error:
        "liveExecutionEnabled is set but live execution is permanently disabled in this build.",
    });
    return;
  }
  if (sizeUsd > cfg.maxPositionUsd) {
    res.status(400).json({
      error: `Size ${sizeUsd} exceeds maxPositionUsd ${cfg.maxPositionUsd}`,
    });
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
  const parsedBody = ClosePaperTradeBody.safeParse(req.body ?? {});
  const note = parsedBody.success ? parsedBody.data.note : undefined;
  const { id } = parsedParams.data;

  const [trade] = await db
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.id, id))
    .limit(1);
  if (!trade) {
    res.status(404).json({ error: "Paper trade not found" });
    return;
  }
  if (trade.status === "closed") {
    res.json(serializePaperTrade(trade));
    return;
  }

  const [opp] = await db
    .select()
    .from(opportunities)
    .where(eq(opportunities.id, trade.opportunityId))
    .limit(1);
  // MTM uses the implied market price (not our internal model), so closing a
  // freshly opened position at the same instant nets ~$0, not "free alpha".
  const dir = trade.direction as "yes" | "no";
  const exitProb = opp ? priceForSide(dir, opp.marketProb) : trade.entryProb;
  const pnl = paperPnl({
    direction: dir,
    sizeUsd: trade.sizeUsd,
    entryProb: trade.entryProb,
    exitProb,
  });

  const [updated] = await db
    .update(paperTrades)
    .set({
      status: "closed",
      exitProb,
      pnlUsd: Number(pnl.toFixed(2)),
      closedAt: new Date(),
      rationale: note ? `${trade.rationale ?? ""}\nclose: ${note}`.trim() : trade.rationale,
    })
    .where(eq(paperTrades.id, id))
    .returning();

  await db.insert(auditLog).values({
    actor: "user",
    action: "paper_trade.close",
    target: `paper_trade:${id}`,
    payload: { exitProb, pnlUsd: pnl, note },
  });

  res.json(ClosePaperTradeResponse.parse(serializePaperTrade(updated)));
});

export default router;
