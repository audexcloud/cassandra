import { describe, expect, it } from "vitest";
import {
  ingestSignals,
  deduplicateSignals,
  validateSignalQuality,
  detectAnomalies,
  scorePredictionMarketActivity,
  scoreSocialVelocity,
  scorePolicySignal,
  scoreCommodityFundamentals,
  scoreMacroFinancialStress,
  detectCrossDomainAnomaly,
  compareToHistoricalPatterns,
  generateHistoricalParallels,
  calculateOpportunityScore,
  generateReasoningSummary,
  generateTradePlan,
  generateCashOutLadder,
  generateExitStrategy,
  updatePredictionJournal,
  type NormalizedSignal,
} from "./pipeline";

const sig = (over: Partial<NormalizedSignal>): NormalizedSignal => ({
  source: "manifold",
  kind: "market_move",
  domain: "prediction_market",
  title: "t",
  body: "b",
  impact: 0.5,
  sentiment: 0,
  weight: 0.5,
  ...over,
});

describe("ingestSignals", () => {
  it("normalizes and clamps fields", () => {
    const out = ingestSignals([
      { source: "x", kind: "k", domain: "d", title: "t", impact: 1.5, sentiment: -2, weight: -1 },
      {},
    ]);
    expect(out[0].impact).toBe(1);
    expect(out[0].sentiment).toBe(-1);
    expect(out[0].weight).toBe(0);
    expect(out[1].source).toBe("unknown");
    expect(out[1].kind).toBe("unknown");
  });
});

describe("deduplicateSignals", () => {
  it("keeps the highest-impact instance per (source, kind, title)", () => {
    const out = deduplicateSignals([
      sig({ title: "A", impact: 0.3 }),
      sig({ title: "A", impact: 0.7 }),
      sig({ title: "B", impact: 0.2 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((s) => s.title === "A")?.impact).toBe(0.7);
  });
});

describe("validateSignalQuality", () => {
  it("drops signals missing required fields", () => {
    const out = validateSignalQuality([sig({}), sig({ source: "" }), sig({ kind: "" })]);
    expect(out).toHaveLength(1);
  });
});

describe("detectAnomalies", () => {
  it("returns nothing when count < 3 or std == 0", () => {
    expect(detectAnomalies([sig({})])).toEqual([]);
    expect(detectAnomalies([sig({ impact: 0.5 }), sig({ impact: 0.5 }), sig({ impact: 0.5 })])).toEqual([]);
  });
  it("flags a >2σ outlier", () => {
    const signals = [
      sig({ impact: 0.1, title: "a" }),
      sig({ impact: 0.1, title: "b" }),
      sig({ impact: 0.1, title: "c" }),
      sig({ impact: 0.1, title: "d" }),
      sig({ impact: 0.1, title: "e" }),
      sig({ impact: 0.1, title: "f" }),
      sig({ impact: 0.1, title: "g" }),
      sig({ impact: 0.1, title: "h" }),
      sig({ impact: 0.95, title: "spike" }),
    ];
    const out = detectAnomalies(signals);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].signal.title).toBe("spike");
  });
});

describe("domain scorers", () => {
  const mixed = [
    sig({ domain: "prediction_market", kind: "market_move", impact: 0.8, weight: 1 }),
    sig({ domain: "social", kind: "social_chatter", impact: 0.6, weight: 1 }),
    sig({ domain: "policy", kind: "policy_release", impact: 0.7, weight: 1 }),
    sig({ domain: "commodities", kind: "supply_release", impact: 0.5, weight: 1 }),
    sig({ domain: "macro", kind: "data_release", impact: 0.9, sentiment: -0.8, weight: 1 }),
  ];
  it("predictionMarket isolates prediction_market", () => {
    expect(scorePredictionMarketActivity(mixed)).toBeCloseTo(0.8, 2);
  });
  it("socialVelocity returns >0 with social signals", () => {
    expect(scoreSocialVelocity(mixed)).toBeGreaterThan(0);
  });
  it("policy isolates policy", () => {
    expect(scorePolicySignal(mixed)).toBeCloseTo(0.7, 2);
  });
  it("commodity isolates commodities", () => {
    expect(scoreCommodityFundamentals(mixed)).toBeCloseTo(0.5, 2);
  });
  it("macro stress is positive when sentiment is negative", () => {
    expect(scoreMacroFinancialStress(mixed)).toBeGreaterThan(0);
  });
});

describe("detectCrossDomainAnomaly", () => {
  it("returns null when fewer than 3 hot domains", () => {
    expect(detectCrossDomainAnomaly([sig({ domain: "macro", impact: 0.8 })])).toBeNull();
  });
  it("fires when 3+ domains are hot", () => {
    const signals = [
      sig({ domain: "macro", impact: 0.8 }),
      sig({ domain: "policy", impact: 0.7 }),
      sig({ domain: "commodities", impact: 0.9 }),
    ];
    const out = detectCrossDomainAnomaly(signals);
    expect(out).not.toBeNull();
    expect(out!.domains.length).toBeGreaterThanOrEqual(3);
  });
});

describe("historical patterns + parallels", () => {
  const patterns: import("./pipeline").HistoricalPattern[] = [
    { id: 1, label: "trade-war", fingerprint: { tariff: 0.9, equity_vol: 0.6 }, baseRate: 0.5 },
    { id: 2, label: "energy-crisis", fingerprint: { energy: 0.95 }, baseRate: 0.4 },
  ];
  it("ranks the most-similar pattern first", () => {
    const matches = compareToHistoricalPatterns({ tariff: 0.8, equity_vol: 0.5 }, patterns);
    expect(matches[0].pattern.label).toBe("trade-war");
    expect(matches[0].similarity).toBeGreaterThan(matches[1].similarity);
  });
  it("generateHistoricalParallels respects topN and minSimilarity", () => {
    const matches = compareToHistoricalPatterns({ tariff: 0.8 }, patterns);
    const parallels = generateHistoricalParallels(matches, 1, 0.0);
    expect(parallels).toHaveLength(1);
    expect(parallels[0].label).toBe("trade-war");
  });
});

describe("calculateOpportunityScore", () => {
  it("is in [0, 1] and increases with similarity", () => {
    const inputs = { marketProb: 0.5, modelProb: 0.7, confidence: 0.8, liquidity: 50000 };
    const a = calculateOpportunityScore(inputs);
    const b = calculateOpportunityScore({ ...inputs, historicalSimilarity: 0.9 });
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThanOrEqual(1);
    expect(b).toBeGreaterThan(a);
  });
});

describe("generateReasoningSummary", () => {
  it("appends top signals to observed and parallels to inferred", () => {
    const out = generateReasoningSummary(
      { observed: ["seed"], inferred: [], speculation: [], unknowns: [], riskFlags: [] },
      [sig({ title: "high", impact: 0.95 }), sig({ title: "low", impact: 0.1 })],
      [{ label: "L", summary: "S", outcome: "O", similarity: 0.8 }],
    );
    expect(out.observed).toContain("seed");
    expect(out.observed.some((x) => x.includes("high"))).toBe(true);
    expect(out.inferred.some((x) => x.includes("L"))).toBe(true);
  });
});

describe("trade plan generation", () => {
  it("picks YES when modelProb > marketProb", () => {
    const plan = generateTradePlan({
      inputs: { marketProb: 0.4, modelProb: 0.6, confidence: 0.8, liquidity: 50000 },
      bankrollUsd: 10000,
      maxKellyFraction: 0.25,
      maxPositionUsd: 500,
      invalidations: ["x"],
    });
    expect(plan.direction).toBe("yes");
    expect(plan.sizeUsd).toBeGreaterThan(0);
    expect(plan.sizeUsd).toBeLessThanOrEqual(500);
    expect(plan.cashOutLadder.length).toBeGreaterThan(0);
    expect(plan.exitStrategy.length).toBeGreaterThan(0);
    expect(plan.invalidations).toEqual(["x"]);
  });
  it("picks NO when marketProb > modelProb", () => {
    const plan = generateTradePlan({
      inputs: { marketProb: 0.7, modelProb: 0.3, confidence: 0.8, liquidity: 50000 },
      bankrollUsd: 10000,
      maxKellyFraction: 0.25,
      maxPositionUsd: 500,
      invalidations: [],
    });
    expect(plan.direction).toBe("no");
  });
  it("ladder length matches steps", () => {
    expect(generateCashOutLadder(0.5, "yes", 4)).toHaveLength(4);
  });
  it("yes ladder steps upward toward 1", () => {
    const ladder = generateCashOutLadder(0.4, "yes", 3);
    expect(ladder[0].price).toBeGreaterThan(0.4);
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i].price).toBeGreaterThan(ladder[i - 1].price);
    }
  });
  it("no ladder steps downward toward 0", () => {
    const ladder = generateCashOutLadder(0.6, "no", 3);
    expect(ladder[0].price).toBeLessThan(0.6);
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i].price).toBeLessThan(ladder[i - 1].price);
    }
    for (const rung of ladder) expect(rung.price).toBeGreaterThanOrEqual(0.01);
  });
  it("exit strategy mentions cut threshold", () => {
    const s = generateExitStrategy({ direction: "yes", entryZone: { low: 0.3, high: 0.4 } });
    expect(s.length).toBeGreaterThan(0);
    expect(s).toMatch(/30%/);
  });
});

describe("updatePredictionJournal", () => {
  it("frames a winner positively", () => {
    const j = updatePredictionJournal({
      paperTradeId: 1,
      realizedPnlUsd: 50,
      rationale: { observed: [], inferred: [], speculation: [], unknowns: [], riskFlags: [] },
      signals: [sig({ title: "good", sentiment: 0.5 })],
    });
    expect(j.realizedPnlUsd).toBe(50);
    expect(j.whatWasRight.toLowerCase()).toContain("paid off");
  });
  it("frames a loser as a loss", () => {
    const j = updatePredictionJournal({
      paperTradeId: 2,
      realizedPnlUsd: -25,
      rationale: { observed: [], inferred: [], speculation: [], unknowns: [], riskFlags: ["x"] },
      signals: [sig({ title: "bad", sentiment: -0.5 })],
    });
    expect(j.whatWasRight.toLowerCase()).toContain("didn't pay off");
  });
});
