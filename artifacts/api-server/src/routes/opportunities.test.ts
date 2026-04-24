import { describe, it, expect } from "vitest";
import { serializeOpportunity } from "./opportunities";
import type { opportunities } from "@workspace/db";

type OpportunityRow = typeof opportunities.$inferSelect;

const baseOpportunity = (
  rationale: Record<string, unknown> | null,
): OpportunityRow => ({
  id: 1,
  marketKey: "test/test",
  source: "polymarket",
  domain: "metals",
  question: "Will gold close above $5000?",
  closeAt: new Date(),
  marketProb: 0.5,
  modelProb: 0.55,
  edge: 0.05,
  edgeScore: 0.5,
  confidence: 0.6,
  liquidity: 10000,
  spread: 0.01,
  kellyFraction: 0.05,
  suggestedDirection: "yes",
  url: null,
  tradePlan: null,
  rationale: rationale as never,
  active: true,
  updatedAt: new Date(),
  createdAt: new Date(),
} as unknown as OpportunityRow);

const validSignal = {
  title: "Gold up 2% this week",
  source: "comex",
  kind: "price_move",
  domain: "metals",
  keywords: ["gold"],
  direction: "up" as const,
  sentiment: 0.5,
  impact: 0.6,
  effectiveWeight: 0.3,
  matchScore: 0.6,
};

describe("serializeOpportunity — appliedSignals shape guard", () => {
  it("returns empty appliedSignals and zero shift when rationale is null", () => {
    const out = serializeOpportunity(baseOpportunity(null));
    expect(out.appliedSignals).toEqual([]);
    expect(out.ambientShift).toBe(0);
  });

  it("returns empty appliedSignals when rationale.appliedSignals is missing", () => {
    const out = serializeOpportunity(
      baseOpportunity({ observed: ["x"], inferred: ["y"] }),
    );
    expect(out.appliedSignals).toEqual([]);
    expect(out.ambientShift).toBe(0);
  });

  it("forwards a well-formed appliedSignal entry and a numeric ambientShift", () => {
    const out = serializeOpportunity(
      baseOpportunity({
        appliedSignals: [validSignal],
        ambientShift: 0.012,
      }),
    );
    expect(out.appliedSignals).toHaveLength(1);
    expect(out.appliedSignals[0]).toMatchObject(validSignal);
    expect(out.ambientShift).toBeCloseTo(0.012, 5);
  });

  it("filters out malformed legacy entries while keeping valid ones", () => {
    const out = serializeOpportunity(
      baseOpportunity({
        appliedSignals: [
          validSignal,
          // Missing required fields entirely
          { foo: "bar" },
          // Wrong direction value
          { ...validSignal, direction: "sideways" },
          // Sentiment is a string, not a number
          { ...validSignal, sentiment: "0.5" },
          // Unknown domain — should be dropped
          { ...validSignal, domain: "sports" },
          // keywords missing
          {
            title: "x",
            source: "y",
            kind: "z",
            domain: "metals",
            direction: "up",
            sentiment: 0.1,
            impact: 0.1,
            effectiveWeight: 0.1,
            matchScore: 0.1,
          },
          null,
          "not an object",
        ],
        ambientShift: -0.005,
      }),
    );
    expect(out.appliedSignals).toHaveLength(1);
    expect(out.appliedSignals[0].title).toBe(validSignal.title);
    expect(out.ambientShift).toBeCloseTo(-0.005, 5);
  });

  it("coerces a non-numeric ambientShift to 0", () => {
    const out = serializeOpportunity(
      baseOpportunity({
        appliedSignals: [validSignal],
        ambientShift: "not a number",
      }),
    );
    expect(out.ambientShift).toBe(0);
  });

  it("drops non-string entries from the keywords array on a valid signal", () => {
    const out = serializeOpportunity(
      baseOpportunity({
        appliedSignals: [
          { ...validSignal, keywords: ["gold", 42, null, "silver"] },
        ],
        ambientShift: 0,
      }),
    );
    expect(out.appliedSignals[0].keywords).toEqual(["gold", "silver"]);
  });
});
