/**
 * Agent system prompt and short-term memory rollup. The agent grounds its
 * answers in the current opportunity universe and signal feed, and is
 * instructed to clearly separate observed/inferred/speculation/unknowns and
 * never to expose raw chain-of-thought.
 */

import { db } from "@workspace/db";
import { opportunities, signalEvents } from "@workspace/db";
import { desc } from "drizzle-orm";

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
    question: string;
    domain: string;
    source: string;
    marketProb: number;
    modelProb: number;
    edgeScore: number;
    confidence: number;
  }>;
  signals: Array<{
    domain: string;
    kind: string;
    title: string;
    sentiment: number;
    impact: number;
    observedAt: Date;
  }>;
}

export async function buildAgentContext(): Promise<AgentContext> {
  const [oppRows, sigRows] = await Promise.all([
    db
      .select({
        question: opportunities.question,
        domain: opportunities.domain,
        source: opportunities.source,
        marketProb: opportunities.marketProb,
        modelProb: opportunities.modelProb,
        edgeScore: opportunities.edgeScore,
        confidence: opportunities.confidence,
      })
      .from(opportunities)
      .orderBy(desc(opportunities.edgeScore))
      .limit(10),
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
      .limit(15),
  ]);

  return { opportunities: oppRows, signals: sigRows };
}

export function renderAgentContext(ctx: AgentContext): string {
  const opps = ctx.opportunities
    .map(
      (o, i) =>
        `${i + 1}. [${o.domain} / ${o.source}] ${o.question} — market ${(o.marketProb * 100).toFixed(0)}%, model ${(o.modelProb * 100).toFixed(0)}%, edgeScore ${(o.edgeScore * 100).toFixed(0)}%, confidence ${(o.confidence * 100).toFixed(0)}%`,
    )
    .join("\n");
  const sigs = ctx.signals
    .map(
      (s) =>
        `- [${s.domain}/${s.kind}] ${s.title} (impact ${(s.impact * 100).toFixed(0)}%, sentiment ${s.sentiment.toFixed(2)})`,
    )
    .join("\n");
  return `CURRENT TOP OPPORTUNITIES:\n${opps || "(none yet)"}\n\nRECENT SIGNALS:\n${sigs || "(none yet)"}`;
}
