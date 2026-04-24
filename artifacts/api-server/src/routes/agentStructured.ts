/**
 * Structured agent endpoint. Unlike the streaming chat (free-form prose),
 * this endpoint returns the spec-required structured response:
 *   { summary, sources, evidence, parallels, confidence, uncertainty,
 *     nextSteps, watchlist, candidates, tradePlan? }
 *
 * The model is instructed to fill JSON with this shape; we then validate
 * with zod and respond. Grounded in the live opportunity universe + signal
 * feed (same context as the streaming chat).
 */

import { Router, type IRouter } from "express";
import { StructuredAgentQueryBody, StructuredAgentQueryResponse } from "@workspace/api-zod";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "../lib/logger";
import { buildAgentContext, renderAgentContext, SYSTEM_PROMPT } from "../lib/cassandra/agent";
import { db, riskConfig, opportunities, historicalParallels as histParallelsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { generateTradePlan } from "../lib/cassandra/pipeline";

const router: IRouter = Router();

router.post("/agent/structured-query", async (req, res) => {
  const parsed = StructuredAgentQueryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { query } = parsed.data;

  const ctx = await buildAgentContext();
  const contextBlock = renderAgentContext(ctx);

  const STRUCTURED_PROMPT = `${SYSTEM_PROMPT}

You will respond ONLY with a JSON object matching this exact schema (no prose, no markdown fences):
{
  "summary": string (1-3 sentence calibrated takeaway),
  "sources": string[] (2-6 source labels you grounded the answer in, e.g. "manifold:fed-cuts-2026q3"),
  "evidence": Array<{ "kind": "observed" | "inferred" | "speculation", "statement": string }>,
  "parallels": Array<{ "label": string, "summary": string, "outcome"?: string }>,
  "confidence": number in [0, 1],
  "uncertainty": string[] (what would change your mind / what you don't know),
  "nextSteps": string[] (concrete things the operator could do),
  "watchlist": string[] (signals or entities to monitor),
  "candidates": Array<{ "marketKey": string, "rationale": string }> (zero or more market candidates from the context above)
}

If the user asked about a specific market, set candidates to that one. If asking generally, return the most relevant candidates from the provided context.
${contextBlock}`;

  let raw = "";
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: STRUCTURED_PROMPT,
      messages: [{ role: "user", content: query }],
    });
    raw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");
  } catch (err) {
    logger.error({ err }, "structured agent call failed");
    res.status(502).json({ error: "Agent call failed" });
    return;
  }

  // Extract first {...} JSON block to be tolerant of stray prose.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    res.status(502).json({ error: "Agent did not return structured JSON.", raw });
    return;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    res.status(502).json({ error: "Agent returned invalid JSON.", raw });
    return;
  }
  const validated = StructuredAgentQueryResponse.safeParse(parsedJson);
  if (!validated.success) {
    res.status(502).json({ error: validated.error.message, raw });
    return;
  }

  // Optionally build a TradePlan when the agent surfaced a concrete candidate
  // we can find in the opportunity universe.
  let tradePlan: ReturnType<typeof generateTradePlan> | null = null;
  const candidate = validated.data.candidates[0];
  if (candidate) {
    const [opp] = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.marketKey, candidate.marketKey))
      .limit(1);
    if (opp) {
      const [cfg] = await db.select().from(riskConfig).limit(1);
      tradePlan = generateTradePlan({
        inputs: {
          marketProb: opp.marketProb,
          modelProb: opp.modelProb,
          confidence: opp.confidence,
          liquidity: opp.liquidity,
        },
        bankrollUsd: cfg?.bankrollUsd ?? 10000,
        maxKellyFraction: cfg?.maxKellyFraction ?? 0.25,
        maxPositionUsd: cfg?.maxPositionUsd ?? 500,
        invalidations:
          (opp.rationale as { unknowns?: string[] } | null)?.unknowns ?? [],
      });
    }
  }

  // Surface up to 3 historical parallels from the long-term memory if any.
  const parallelsRows = await db
    .select()
    .from(histParallelsTable)
    .orderBy(desc(histParallelsTable.similarity))
    .limit(3);
  const stored = parallelsRows.map((p) => ({
    label: p.label,
    summary: p.summary,
    outcome: p.outcome ?? undefined,
  }));

  res.json({
    ...validated.data,
    parallels: validated.data.parallels.length > 0 ? validated.data.parallels : stored,
    tradePlan,
  });
});

export default router;
