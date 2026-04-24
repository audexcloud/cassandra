import { describe, it, expect } from "vitest";
import {
  aggregateModelProb,
  edgeScore,
  evaluateRiskGate,
  kellyFraction,
  paperPnl,
  priceForSide,
  suggestedDirection,
  weightedRandomPick,
} from "./scoring";

describe("aggregateModelProb", () => {
  it("returns the prior when there are no signals", () => {
    expect(aggregateModelProb(0.4, [])).toBeCloseTo(0.4, 6);
  });

  it("nudges up on positive signals and down on negative", () => {
    const up = aggregateModelProb(0.5, [{ sentiment: 1, impact: 1, weight: 1 }]);
    const down = aggregateModelProb(0.5, [{ sentiment: -1, impact: 1, weight: 1 }]);
    expect(up).toBeGreaterThan(0.5);
    expect(down).toBeLessThan(0.5);
    expect(up + down).toBeCloseTo(1, 4);
  });

  it("clamps into the open (0, 1) interval", () => {
    const p = aggregateModelProb(0.999, [{ sentiment: 1, impact: 1, weight: 1 }]);
    expect(p).toBeLessThan(1);
    expect(p).toBeGreaterThan(0);
  });
});

describe("edgeScore", () => {
  it("is zero when model and market agree", () => {
    expect(edgeScore({ marketProb: 0.6, modelProb: 0.6, confidence: 1, liquidity: 100000 })).toBeCloseTo(0, 6);
  });
  it("scales with confidence and liquidity", () => {
    const lowConf = edgeScore({ marketProb: 0.3, modelProb: 0.5, confidence: 0.1, liquidity: 100000 });
    const highConf = edgeScore({ marketProb: 0.3, modelProb: 0.5, confidence: 1, liquidity: 100000 });
    expect(highConf).toBeGreaterThan(lowConf);
  });
});

describe("suggestedDirection / kellyFraction", () => {
  it("suggests YES when model > market and NO when model < market", () => {
    expect(suggestedDirection({ marketProb: 0.4, modelProb: 0.6, confidence: 1, liquidity: 1 })).toBe("yes");
    expect(suggestedDirection({ marketProb: 0.6, modelProb: 0.4, confidence: 1, liquidity: 1 })).toBe("no");
  });
  it("never exceeds the maxKellyFraction cap", () => {
    const f = kellyFraction({ marketProb: 0.1, modelProb: 0.9, confidence: 1, liquidity: 1 }, 0.25);
    expect(f).toBeLessThanOrEqual(0.25);
    expect(f).toBeGreaterThan(0);
  });
  it("returns 0 when there is no edge", () => {
    expect(kellyFraction({ marketProb: 0.5, modelProb: 0.5, confidence: 1, liquidity: 1 }, 0.25)).toBeCloseTo(0, 6);
  });
});

describe("priceForSide / paperPnl", () => {
  it("prices NO at 1 - marketProb", () => {
    expect(priceForSide("yes", 0.4)).toBeCloseTo(0.4, 6);
    expect(priceForSide("no", 0.4)).toBeCloseTo(0.6, 6);
  });

  it("flat MTM when entry equals exit", () => {
    expect(paperPnl({ direction: "yes", sizeUsd: 100, entryProb: 0.4, exitProb: 0.4 })).toBeCloseTo(0, 6);
    expect(paperPnl({ direction: "no", sizeUsd: 100, entryProb: 0.6, exitProb: 0.6 })).toBeCloseTo(0, 6);
  });

  it("YES profits when exit > entry", () => {
    const pnl = paperPnl({ direction: "yes", sizeUsd: 100, entryProb: 0.4, exitProb: 0.5 });
    // shares = 100/0.4 = 250; PnL = 250 * (0.5 - 0.4) = 25
    expect(pnl).toBeCloseTo(25, 6);
  });

  it("NO profits when its side-appropriate exit > entry (i.e. marketProb falls)", () => {
    // Open NO at marketProb=0.4 -> entry = 0.6. Market falls to 0.3 -> exit = 0.7.
    const pnl = paperPnl({ direction: "no", sizeUsd: 100, entryProb: 0.6, exitProb: 0.7 });
    // shares = 100/0.6 = 166.667; PnL = 166.667 * (0.7 - 0.6) = ~16.67
    expect(pnl).toBeCloseTo(16.6667, 3);
  });

  it("YES and NO are symmetric for the same marketProb move", () => {
    // YES @ marketProb=0.4 then market goes to 0.5 -> YES wins
    const yes = paperPnl({ direction: "yes", sizeUsd: 100, entryProb: 0.4, exitProb: 0.5 });
    // NO @ marketProb=0.4 (entry 0.6), market goes to 0.5 (exit 0.5) -> NO loses
    const no = paperPnl({ direction: "no", sizeUsd: 100, entryProb: 0.6, exitProb: 0.5 });
    expect(yes).toBeGreaterThan(0);
    expect(no).toBeLessThan(0);
  });
});

describe("evaluateRiskGate", () => {
  const baseOpp = { confidence: 0.7, liquidity: 100000, edgeScore: 0.05 };
  const baseCfg = {
    killSwitchEngaged: false,
    liveExecutionEnabled: false,
    maxPositionUsd: 500,
  };

  it("allows a normal trade", () => {
    const r = evaluateRiskGate({ sizeUsd: 100, opportunity: baseOpp, config: baseCfg });
    expect(r.allowed).toBe(true);
    expect(r.reasons).toHaveLength(0);
  });

  it("blocks when kill switch is engaged with a structured reason", () => {
    const r = evaluateRiskGate({
      sizeUsd: 100,
      opportunity: baseOpp,
      config: { ...baseCfg, killSwitchEngaged: true },
    });
    expect(r.allowed).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain("kill_switch_engaged");
  });

  it("returns multiple reasons at once when several gates fail", () => {
    const r = evaluateRiskGate({
      sizeUsd: 9999,
      opportunity: { confidence: 0.1, liquidity: 100, edgeScore: 0.001 },
      config: {
        ...baseCfg,
        killSwitchEngaged: true,
        minConfidence: 0.5,
        minLiquidityUsd: 5000,
        minEdgeScore: 0.02,
      },
    });
    expect(r.allowed).toBe(false);
    const codes = r.reasons.map((x) => x.code).sort();
    expect(codes).toEqual([
      "confidence_below_floor",
      "edge_below_floor",
      "kill_switch_engaged",
      "liquidity_below_floor",
      "size_exceeds_max_position",
    ]);
  });

  it("refuses to allow trades when liveExecutionEnabled is true (defensive invariant)", () => {
    const r = evaluateRiskGate({
      sizeUsd: 100,
      opportunity: baseOpp,
      config: { ...baseCfg, liveExecutionEnabled: true },
    });
    expect(r.allowed).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain("live_execution_blocked");
  });
});

describe("weightedRandomPick", () => {
  it("returns null on empty input", () => {
    expect(weightedRandomPick([])).toBeNull();
  });

  it("returns the only item when there is one", () => {
    const item = { edgeScore: 0.5, name: "x" };
    expect(weightedRandomPick([item])).toBe(item);
  });

  it("biases toward higher edgeScore over many trials", () => {
    const items = [
      { edgeScore: 0.01, label: "low" },
      { edgeScore: 0.99, label: "high" },
    ];
    let highCount = 0;
    // Deterministic mulberry32-style PRNG so the test is reproducible.
    let s = 1;
    const rng = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const N = 5000;
    for (let n = 0; n < N; n++) {
      const pick = weightedRandomPick(items, rng);
      if (pick?.label === "high") highCount++;
    }
    // Items[0] gets weight 0.01, items[1] gets 0.99 -> high should win ~99% of the time.
    expect(highCount / N).toBeGreaterThan(0.97);
  });

  it("falls back to uniform when all weights are zero", () => {
    const items = [
      { edgeScore: 0, label: "a" },
      { edgeScore: 0, label: "b" },
    ];
    const pick = weightedRandomPick(items, () => 0.99);
    expect(pick).toBeDefined();
  });
});
