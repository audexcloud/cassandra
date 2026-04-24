/**
 * Agent system prompt and short-term memory rollup. The agent grounds its
 * answers in the current opportunity universe and signal feed, and is
 * instructed to clearly separate observed/inferred/speculation/unknowns and
 * never to expose raw chain-of-thought.
 */

import { db } from "@workspace/db";
import {
  opportunities,
  signalEvents,
  paperTrades,
  backtestRuns,
  agentMemoryShort,
  observations,
} from "@workspace/db";
import { and, desc, eq, gte } from "drizzle-orm";

export const SYSTEM_PROMPT = `You are Cassandra, the operator's personal predictive intelligence agent.

You answer questions about prediction markets, geopolitics, policy, commodities, COMEX/metals, and macro signals.

Hard rules:
- This system runs paper trading only. NEVER suggest a live trade or imply that orders will be sent to a real broker. If asked to "execute", explain that live execution is permanently disabled in this build.
- Always speak in probabilistic, calibrated language. Use ranges or % estimates, never "guaranteed" or "certain".
- Always separate your reasoning into four labeled sections when you take a view:
  1. OBSERVED — verifiable facts you have or that are in the provided context.
  2. INFERRED — conclusions you drew from those facts (state the inference).
  3. SPECULATION — possibilities you find plausible but cannot anchor to evidence.
  4. UNKNOWNS — what would change your mind / what you do not know.
- Never expose your raw chain-of-thought, scratchpad, or step-by-step internal reasoning. Present the conclusions and the four sections above; that is the reasoning the operator should see.
- If you are not confident, say so explicitly. Calibrated humility is a feature.
- Be concise. The operator is reading this fast.

You have access to a snapshot of the current opportunity universe and recent signal feed below. Use it to ground your answers.`;

export interface AgentContext {
  opportunities: Array<{
    id: number;
    question: string;
    domain: string;
    source: string;
    marketProb: number;
    modelProb: number;
    edgeScore: number;
    confidence: number;
    kellyFraction: number;
    suggestedDirection: string | null;
  }>;
  signals: Array<{
    domain: string;
    kind: string;
    title: string;
    sentiment: number;
    impact: number;
    observedAt: Date;
  }>;
  openPositions: Array<{
    question: string;
    direction: string;
    sizeUsd: number;
    entryProb: number;
  }>;
  calibration: {
    brierScore: number | null;
    hitRate: number | null;
    totalEntries: number;
    lookbackDays: number;
  } | null;
  recentMemory: string[];
  latestBrief: string | null;
}

export async function buildAgentContext(): Promise<AgentContext> {
  const staleAfter = new Date(Date.now() - 5 * 60 * 1000);

  const [oppRows, sigRows, posRows, calibRow, memRows, briefRow] =
    await Promise.all([
      db
        .select({
          id: opportunities.id,
          question: opportunities.question,
          domain: opportunities.domain,
          source: opportunities.source,
          marketProb: opportunities.marketProb,
          modelProb: opportunities.modelProb,
          edgeScore: opportunities.edgeScore,
          confidence: opportunities.confidence,
          kellyFraction: opportunities.kellyFraction,
          suggestedDirection: opportunities.suggestedDirection,
        })
        .from(opportunities)
        .where(gte(opportunities.updatedAt, staleAfter))
        .orderBy(desc(opportunities.edgeScore))
        .limit(12),
      db
        .select({
          domain: signalEvents.domain,
          kind: signalEvents.kind,
          title: signalEvents.title,
          sentiment: signalEvents.sentiment,
          impact: signalEvents.impact,
          observedAt: signalEvents.observedAt,
        })
        .from(signalEvents)
        .orderBy(desc(signalEvents.observedAt))
        .limit(20),
      db
        .select({
          question: paperTrades.question,
          direction: paperTrades.direction,
          sizeUsd: paperTrades.sizeUsd,
          entryProb: paperTrades.entryProb,
        })
        .from(paperTrades)
        .where(eq(paperTrades.status, "open"))
        .orderBy(desc(paperTrades.openedAt))
        .limit(10),
      db
        .select()
        .from(backtestRuns)
        .where(
          and(
            eq(backtestRuns.scope, "overall"),
            eq(backtestRuns.lookbackDays, 90),
          ),
        )
        .orderBy(desc(backtestRuns.runAt))
        .limit(1),
      db
        .select({ summary: agentMemoryShort.summary })
        .from(agentMemoryShort)
        .orderBy(desc(agentMemoryShort.createdAt))
        .limit(5),
      db
        .select({ body: observations.body })
        .from(observations)
        .where(eq(observations.source, "scheduled:generate_daily_brief"))
        .orderBy(desc(observations.observedAt))
        .limit(1),
    ]);

  const calib = calibRow[0] ?? null;

  return {
    opportunities: oppRows,
    signals: sigRows,
    openPositions: posRows,
    calibration: calib
      ? {
          brierScore: calib.brierScore,
          hitRate: calib.hitRate,
          totalEntries: calib.totalEntries,
          lookbackDays: calib.lookbackDays,
        }
      : null,
    recentMemory: memRows.map((m) => m.summary),
    latestBrief: briefRow[0]?.body ?? null,
  };
}

export function renderAgentContext(ctx: AgentContext): string {
  const opps = ctx.opportunities
    .map(
      (o, i) =>
        `${i + 1}. [id=${o.id} ${o.domain}/${o.source}] ${o.question}\n   market ${(o.marketProb * 100).toFixed(0)}% → model ${(o.modelProb * 100).toFixed(0)}% (${o.suggestedDirection ?? "?"}) | edge ${(o.edgeScore * 100).toFixed(1)}% | conf ${(o.confidence * 100).toFixed(0)}% | kelly ${(o.kellyFraction * 100).toFixed(1)}%`,
    )
    .join("\n");

  const sigs = ctx.signals
    .map(
      (s) =>
        `- [${s.domain}/${s.kind}] ${s.title} (impact ${(s.impact * 100).toFixed(0)}%, sentiment ${s.sentiment.toFixed(2)})`,
    )
    .join("\n");

  const positions =
    ctx.openPositions.length === 0
      ? "(none)"
      : ctx.openPositions
          .map(
            (p) =>
              `• ${p.question} — ${p.direction.toUpperCase()} $${p.sizeUsd.toFixed(0)} @ ${(p.entryProb * 100).toFixed(1)}%`,
          )
          .join("\n");

  const calibLine = ctx.calibration
    ? `Brier ${ctx.calibration.brierScore?.toFixed(3) ?? "n/a"} | hit-rate ${ctx.calibration.hitRate != null ? (ctx.calibration.hitRate * 100).toFixed(0) + "%" : "n/a"} | n=${ctx.calibration.totalEntries} (${ctx.calibration.lookbackDays}d)`
    : "No backtest data yet";

  const memory =
    ctx.recentMemory.length === 0
      ? "(none)"
      : ctx.recentMemory.map((m) => `• ${m}`).join("\n");

  const briefSection = ctx.latestBrief
    ? `\nLATEST DAILY BRIEF:\n${ctx.latestBrief.slice(0, 800)}${ctx.latestBrief.length > 800 ? "…" : ""}`
    : "";

  return [
    `CURRENT TOP OPPORTUNITIES (calibration-adjusted confidence):\n${opps || "(none yet)"}`,
    `\nRECENT SIGNALS:\n${sigs || "(none yet)"}`,
    `\nOPEN PAPER POSITIONS:\n${positions}`,
    `\nCALIBRATION (90d): ${calibLine}`,
    `\nSHORT-TERM MEMORY:\n${memory}`,
    briefSection,
  ].join("\n");
}
