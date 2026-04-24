/**
 * Real implementations for the five on-demand job types.
 *
 * Each function calls Claude with relevant context from the DB, parses the
 * response, and persists results to the appropriate tables. Callers should
 * catch and surface errors — these functions throw on hard failures.
 */

import { db } from "@workspace/db";
import {
  opportunities,
  signalEvents,
  paperTrades,
  journalEntries,
  investigations,
  historicalParallels,
  historicalPatterns,
  tradePlans,
  observations,
  riskConfig,
} from "@workspace/db";
import { and, desc, eq, gte } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "../logger";

// ─── helpers ────────────────────────────────────────────────────────────────

async function claudeText(
  system: string,
  user: string,
  maxTokens = 1024,
): Promise<string> {
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  const block = msg.content[0];
  return block.type === "text" ? block.text : "";
}

async function getOpportunity(id: number) {
  const [row] = await db
    .select()
    .from(opportunities)
    .where(eq(opportunities.id, id))
    .limit(1);
  return row ?? null;
}

async function getRecentSignals(domain?: string, limit = 20) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(signalEvents)
    .where(
      domain
        ? and(
            gte(signalEvents.observedAt, cutoff),
            eq(signalEvents.domain, domain as any),
          )
        : gte(signalEvents.observedAt, cutoff),
    )
    .orderBy(desc(signalEvents.observedAt))
    .limit(limit);
  return rows;
}

// ─── investigate_topic ───────────────────────────────────────────────────────

export async function runInvestigateTopic(
  topic: string,
): Promise<{ investigationId: number; summary: string }> {
  // Pull relevant recent signals and opportunities for context.
  const [sigs, opps] = await Promise.all([
    db
      .select()
      .from(signalEvents)
      .where(gte(signalEvents.observedAt, new Date(Date.now() - 48 * 3600_000)))
      .orderBy(desc(signalEvents.observedAt))
      .limit(30),
    db
      .select()
      .from(opportunities)
      .where(
        gte(opportunities.updatedAt, new Date(Date.now() - 5 * 60_000)),
      )
      .orderBy(desc(opportunities.edgeScore))
      .limit(15),
  ]);

  const sigContext = sigs
    .map(
      (s) =>
        `[${s.domain}/${s.kind}] ${s.title} (sentiment ${s.sentiment.toFixed(2)}, impact ${(s.impact * 100).toFixed(0)}%)`,
    )
    .join("\n");

  const oppContext = opps
    .map(
      (o) =>
        `[${o.domain}/${o.source}] ${o.question} — market ${(o.marketProb * 100).toFixed(0)}%, model ${(o.modelProb * 100).toFixed(0)}%, edge ${(o.edgeScore * 100).toFixed(1)}%`,
    )
    .join("\n");

  const system = `You are Cassandra's deep research agent. You produce structured intelligence
briefings on a given topic by synthesising the provided signals and market data.

Format your response as:
SUMMARY: <2-3 sentence executive summary>
OBSERVED: <bullet list of confirmed facts>
INFERRED: <bullet list of reasonable conclusions from the facts>
SPECULATION: <bullet list of plausible but unconfirmed possibilities>
UNKNOWNS: <bullet list of key open questions>
MARKETS AFFECTED: <comma-separated list of markets this topic most affects>
CONFIDENCE: <your overall confidence in the analysis, 0–100>

Be concise, calibrated, and probabilistic.`;

  const user = `Investigate the following topic: "${topic}"

Recent signals (last 48h):
${sigContext || "(none)"}

Current active opportunities:
${oppContext || "(none)"}

Produce a complete intelligence briefing on this topic.`;

  const text = await claudeText(system, user, 1500);

  // Parse confidence from the response.
  const confMatch = text.match(/CONFIDENCE:\s*(\d+)/i);
  const confidence = confMatch ? parseInt(confMatch[1], 10) / 100 : 0.5;

  // Persist to investigations table.
  const [row] = await db
    .insert(investigations)
    .values({
      topic,
      status: "open",
      summary: text,
    })
    .returning({ id: investigations.id });

  // Also persist as an observation.
  await db.insert(observations).values({
    source: "on_demand:investigate_topic",
    domain: "prediction_market",
    body: text,
    metadata: { topic, confidence },
  });

  logger.info({ topic, investigationId: row.id }, "investigate_topic completed");
  return { investigationId: row.id, summary: text };
}

// ─── explain_prediction ──────────────────────────────────────────────────────

export async function runExplainPrediction(
  opportunityId: number,
): Promise<{ explanation: string }> {
  const opp = await getOpportunity(opportunityId);
  if (!opp) throw new Error(`Opportunity ${opportunityId} not found`);

  const recentSigs = await getRecentSignals(opp.domain, 15);
  const sigContext = recentSigs
    .map((s) => `• [${s.kind}] ${s.title} (impact ${(s.impact * 100).toFixed(0)}%, sentiment ${s.sentiment.toFixed(2)})`)
    .join("\n");

  const rationale = opp.rationale as Record<string, unknown> | null;

  const system = `You are Cassandra's prediction explanation agent. You produce clear, calibrated
explanations of why a specific prediction market has the model probability it does, what signals
are driving the gap between market price and model price, and what would need to happen for the
prediction to resolve in each direction.

Structure your response as:
WHAT IT IS: <one paragraph explaining the market and what it's measuring>
WHY MODEL DIFFERS FROM MARKET: <explain the modelProb vs marketProb gap with specific reasons>
KEY DRIVERS: <bullet list of the top factors pushing the model in its direction>
BULL CASE (YES): <what would need to happen for this to resolve YES>
BEAR CASE (NO): <what would need to happen for this to resolve NO>
CONFIDENCE ASSESSMENT: <honest assessment of how confident the model should be, and why>
RISK FLAGS: <any concerns about data quality, resolution criteria, or thin markets>

Keep it tight and actionable.`;

  const user = `Explain this prediction:

Question: ${opp.question}
Domain: ${opp.domain} | Source: ${opp.source}
Market probability: ${(opp.marketProb * 100).toFixed(1)}%
Model probability: ${(opp.modelProb * 100).toFixed(1)}%
Edge score: ${(opp.edgeScore * 100).toFixed(1)}%
Confidence: ${(opp.confidence * 100).toFixed(0)}%
Liquidity: $${opp.liquidity.toLocaleString()}
Suggested direction: ${opp.suggestedDirection}

Existing rationale:
Observed: ${JSON.stringify((rationale as any)?.observed ?? [])}
Inferred: ${JSON.stringify((rationale as any)?.inferred ?? [])}
Speculation: ${JSON.stringify((rationale as any)?.speculation ?? [])}

Recent domain signals (last 24h):
${sigContext || "(none)"}

Produce a full explanation of this prediction.`;

  const text = await claudeText(system, user, 1500);

  await db.insert(observations).values({
    source: "on_demand:explain_prediction",
    domain: opp.domain,
    body: text,
    metadata: {
      opportunityId,
      question: opp.question,
      modelProb: opp.modelProb,
      marketProb: opp.marketProb,
    },
  });

  return { explanation: text };
}

// ─── find_historical_parallels ───────────────────────────────────────────────

export async function runFindHistoricalParallels(
  question: string,
  opportunityId?: number,
): Promise<{ parallels: string[]; count: number }> {
  // Pull any existing patterns from DB.
  const existingPatterns = await db
    .select()
    .from(historicalPatterns)
    .limit(20);

  const patternContext = existingPatterns
    .map(
      (p) =>
        `• [${p.domain}] ${p.label}: ${p.description} (base rate ${(p.baseRate * 100).toFixed(0)}%)`,
    )
    .join("\n");

  const system = `You are Cassandra's historical analysis agent. You find historical parallels
for prediction market questions — past events with similar structures, outcomes, and probabilities.

For each parallel, assess:
1. Structural similarity (how similar was the situation?)
2. What the outcome was
3. What the base rate was for similar events
4. What was different about the current situation

Format: produce 3–5 historical parallels as a JSON array with this structure:
[
  {
    "label": "Short name for the parallel",
    "summary": "2–3 sentence description of the parallel event and its outcome",
    "outcome": "What happened (be specific)",
    "similarity": 0.0–1.0,
    "baseRate": 0.0–1.0,
    "year": 2020
  }
]

Return ONLY the JSON array, no other text.`;

  const user = `Find historical parallels for this prediction market question:

"${question}"

Known historical patterns in our database:
${patternContext || "(none yet — this is a fresh database)"}

Produce 3–5 historical parallels that help calibrate the probability for this question.`;

  const text = await claudeText(system, user, 1200);

  // Parse the JSON response.
  let parallels: Array<{
    label: string;
    summary: string;
    outcome: string;
    similarity: number;
    baseRate: number;
    year?: number;
  }> = [];

  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      parallels = JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    logger.warn({ err, text }, "find_historical_parallels: JSON parse failed");
    parallels = [];
  }

  // Persist each parallel to the DB.
  if (parallels.length > 0 && opportunityId !== undefined) {
    await db.insert(historicalParallels).values(
      parallels.map((p) => ({
        opportunityId,
        patternId: null,
        label: p.label,
        summary: `${p.summary} Outcome: ${p.outcome}`,
        outcome: p.outcome,
        similarity: Math.max(0, Math.min(1, p.similarity ?? 0.5)),
      })),
    );
  }

  return {
    parallels: parallels.map(
      (p) => `${p.label} (similarity ${(p.similarity * 100).toFixed(0)}%): ${p.summary}`,
    ),
    count: parallels.length,
  };
}

// ─── evaluate_market ─────────────────────────────────────────────────────────

export async function runEvaluateMarket(
  opportunityId: number,
): Promise<{ evaluation: string; verdict: string; suggestedProb: number }> {
  const opp = await getOpportunity(opportunityId);
  if (!opp) throw new Error(`Opportunity ${opportunityId} not found`);

  const [domainSigs, openTrades, recentJournal] = await Promise.all([
    getRecentSignals(opp.domain, 20),
    db
      .select()
      .from(paperTrades)
      .where(
        and(eq(paperTrades.status, "open"), eq(paperTrades.marketKey, opp.marketKey)),
      )
      .limit(5),
    db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.domain, opp.domain))
      .orderBy(desc(journalEntries.createdAt))
      .limit(5),
  ]);

  const sigContext = domainSigs
    .map(
      (s) =>
        `• ${s.title} (${s.kind}, impact ${(s.impact * 100).toFixed(0)}%, sentiment ${s.sentiment.toFixed(2)})`,
    )
    .join("\n");

  const journalContext = recentJournal
    .map(
      (j) =>
        `• "${j.question}" — predicted ${(j.forecastProb * 100).toFixed(0)}% → outcome ${j.outcome}`,
    )
    .join("\n");

  const system = `You are Cassandra's market evaluation agent. You produce a rigorous, probabilistic
assessment of a specific prediction market, challenging both the market price AND the model price.

Your evaluation must be structured as JSON:
{
  "verdict": "strong_buy" | "lean_yes" | "neutral" | "lean_no" | "strong_sell" | "avoid",
  "suggestedProb": 0.0–1.0,
  "rationale": "2–3 sentence summary",
  "bullCase": "What drives YES probability",
  "bearCase": "What drives NO probability",
  "marketPricingErrors": "Where you think the crowd is wrong and why",
  "signalQuality": "Assessment of the current signal evidence",
  "calibrationNote": "Any calibration concerns — are we systematically over/under-confident here?",
  "riskFlags": ["list", "of", "flags"]
}

Return ONLY the JSON, no other text.`;

  const user = `Evaluate this prediction market:

Question: ${opp.question}
Domain: ${opp.domain} | Source: ${opp.source}
Market probability (crowd): ${(opp.marketProb * 100).toFixed(1)}%
Our model probability: ${(opp.modelProb * 100).toFixed(1)}%
Edge score: ${(opp.edgeScore * 100).toFixed(1)}%
Confidence: ${(opp.confidence * 100).toFixed(0)}%
Liquidity: $${opp.liquidity.toLocaleString()}
Open paper positions: ${openTrades.length}

Recent domain signals:
${sigContext || "(none)"}

Recent resolved predictions in this domain:
${journalContext || "(none)"}

Evaluate this market rigorously.`;

  const text = await claudeText(system, user, 1200);

  let parsed: {
    verdict: string;
    suggestedProb: number;
    rationale: string;
    bullCase?: string;
    bearCase?: string;
    marketPricingErrors?: string;
    signalQuality?: string;
    calibrationNote?: string;
    riskFlags?: string[];
  } = {
    verdict: "neutral",
    suggestedProb: opp.modelProb,
    rationale: text,
  };

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = { ...parsed, ...JSON.parse(jsonMatch[0]) };
    }
  } catch (err) {
    logger.warn({ err }, "evaluate_market: JSON parse failed, using raw text");
  }

  await db.insert(observations).values({
    source: "on_demand:evaluate_market",
    domain: opp.domain,
    body: text,
    metadata: {
      opportunityId,
      verdict: parsed.verdict,
      suggestedProb: parsed.suggestedProb,
    },
  });

  return {
    evaluation: text,
    verdict: parsed.verdict,
    suggestedProb: Math.max(0.01, Math.min(0.99, parsed.suggestedProb)),
  };
}

// ─── create_trade_plan ───────────────────────────────────────────────────────

export async function runCreateTradePlan(
  opportunityId: number,
): Promise<{ tradePlanId: number; plan: string }> {
  const opp = await getOpportunity(opportunityId);
  if (!opp) throw new Error(`Opportunity ${opportunityId} not found`);

  const [cfg] = await db.select().from(riskConfig).limit(1);
  const bankrollUsd = cfg?.bankrollUsd ?? 10000;
  const maxKelly = cfg?.maxKellyFraction ?? 0.25;

  const openTrades = await db
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.status, "open"));

  const totalExposure = openTrades.reduce((sum, t) => sum + t.sizeUsd, 0);
  const availableBankroll = Math.max(0, bankrollUsd - totalExposure);

  const system = `You are Cassandra's trade planning agent. You produce structured,
Kelly-sized trade plans for binary prediction markets. All plans are for paper trading only.

Produce a JSON trade plan:
{
  "direction": "yes" | "no",
  "rationale": "2–3 sentence explanation of the trade thesis",
  "entryZone": { "low": 0.0, "high": 0.0 },
  "sizingUsd": 0.0,
  "kellySizing": "explanation of the Kelly calculation",
  "cashOutLadder": [
    { "price": 0.0, "fraction": 0.0, "note": "why take off here" }
  ],
  "exitStrategy": "description of the full exit plan",
  "invalidations": [
    "Event that would invalidate this thesis",
    "Trigger to close the position early at a loss"
  ],
  "timeHorizon": "description of resolution timeline",
  "riskRewardRatio": 0.0
}

Return ONLY the JSON, no other text.`;

  const user = `Create a trade plan for this opportunity:

Question: ${opp.question}
Domain: ${opp.domain} | Source: ${opp.source}
Market prob: ${(opp.marketProb * 100).toFixed(1)}% | Model prob: ${(opp.modelProb * 100).toFixed(1)}%
Edge: ${((opp.modelProb - opp.marketProb) * 100).toFixed(1)} pts | Edge score: ${(opp.edgeScore * 100).toFixed(1)}%
Kelly fraction: ${(opp.kellyFraction * 100).toFixed(1)}% | Suggested direction: ${opp.suggestedDirection}
Liquidity: $${opp.liquidity.toLocaleString()} | Spread: ${(opp.spread * 100).toFixed(1)}%
Confidence: ${(opp.confidence * 100).toFixed(0)}%

Bankroll: $${bankrollUsd.toLocaleString()} | Max Kelly: ${(maxKelly * 100).toFixed(0)}%
Available after open positions: $${availableBankroll.toLocaleString()}
Open positions: ${openTrades.length} (total exposure: $${totalExposure.toLocaleString()})

URL: ${opp.url ?? "N/A"}

Create a complete, Kelly-sized trade plan.`;

  const text = await claudeText(system, user, 1500);

  let planData: {
    direction: "yes" | "no";
    entryZone: { low: number; high: number };
    cashOutLadder: Array<{ price: number; fraction: number }>;
    exitStrategy: string;
    invalidations: string[];
  } = {
    direction: opp.suggestedDirection as "yes" | "no",
    entryZone: {
      low: Math.max(0.01, opp.marketProb - 0.03),
      high: Math.min(0.99, opp.marketProb + 0.03),
    },
    cashOutLadder: [
      { price: Math.min(0.99, opp.modelProb * 0.9), fraction: 0.5 },
      { price: Math.min(0.99, opp.modelProb * 0.95), fraction: 0.5 },
    ],
    exitStrategy: `Close at ${(opp.modelProb * 100).toFixed(0)}% or on invalidating event`,
    invalidations: ["Market moves against thesis by >10 pts without new information"],
  };

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      planData = { ...planData, ...parsed };
    }
  } catch (err) {
    logger.warn({ err }, "create_trade_plan: JSON parse failed, using defaults");
  }

  const [row] = await db
    .insert(tradePlans)
    .values({
      opportunityId,
      direction: planData.direction,
      entryZone: planData.entryZone,
      cashOutLadder: planData.cashOutLadder,
      exitStrategy: planData.exitStrategy,
      invalidations: planData.invalidations,
    })
    .returning({ id: tradePlans.id });

  return { tradePlanId: row.id, plan: text };
}
