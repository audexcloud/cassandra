import { describe, it, expect } from "vitest";
import {
  applyMatchedSignals,
  buildMatchRationale,
  matchSignalsToMarket,
  MAX_AMBIENT_SHIFT,
} from "./signalMatching";
import type { ConnectorMarket, ConnectorSignal } from "./connectors";

const makeAmbient = (overrides: Partial<ConnectorSignal> = {}): ConnectorSignal => ({
  domain: "metals",
  source: "comex",
  kind: "price_move",
  title: "Gold up 2.0% this week",
  body: "Gold (GC=F) trading near $2400/oz; up 2.0% this week.",
  impact: 0.6,
  sentiment: 0.5,
  weight: 0.7,
  ...overrides,
});

const makeMarket = (overrides: Partial<ConnectorMarket> = {}): ConnectorMarket => ({
  marketKey: "test-key",
  source: "polymarket",
  domain: "metals",
  question: "Will gold close above $2500 by year end?",
  marketProb: 0.4,
  modelProb: 0.4,
  confidence: 0.5,
  liquidity: 50000,
  spread: 0.02,
  rationale: { observed: [], inferred: [], speculation: [], unknowns: [], riskFlags: [] },
  signals: [],
  ...overrides,
});

describe("matchSignalsToMarket", () => {
  it("matches a metals signal to a metals/gold question", () => {
    const matched = matchSignalsToMarket(makeMarket(), [makeAmbient()]);
    expect(matched).toHaveLength(1);
    expect(matched[0].matchScore).toBe(0.6);
    expect(matched[0].matchReason).toContain("metals");
    expect(matched[0].matchReason).toContain("gold");
  });

  it("matches keyword-only when domains differ", () => {
    const matched = matchSignalsToMarket(
      makeMarket({ domain: "geopolitics", question: "Will Iran-Israel ceasefire hold by July?" }),
      [
        makeAmbient({
          domain: "geopolitics",
          title: "Israel and Iran agree to ceasefire framework",
          body: "Diplomatic breakthrough overnight.",
        }),
      ],
    );
    expect(matched).toHaveLength(1);
    expect(matched[0].matchScore).toBe(0.6); // same domain too
  });

  it("scores keyword-only matches lower than keyword+domain", () => {
    const matched = matchSignalsToMarket(
      makeMarket({ domain: "macro", question: "Will the Fed cut rates in June?" }),
      [
        // metals-domain signal but mentions 'fed' keyword in body
        makeAmbient({
          domain: "metals",
          title: "Gold rallies as Fed sounds dovish",
          body: "Gold up on dovish Fed comments.",
        }),
      ],
    );
    expect(matched).toHaveLength(1);
    expect(matched[0].matchScore).toBe(0.4);
    expect(matched[0].matchReason).toMatch(/^keyword/);
  });

  it("ignores ambient signals with no shared keyword (no domain-only matches)", () => {
    const matched = matchSignalsToMarket(
      makeMarket({ domain: "macro", question: "Will GDP growth exceed 3% in Q3?" }),
      [
        makeAmbient({
          domain: "macro",
          title: "Random unrelated headline about widgets",
          body: "Widgets are interesting.",
        }),
      ],
    );
    expect(matched).toHaveLength(0);
  });

  it("orders matches by descending score then descending impact", () => {
    const matched = matchSignalsToMarket(
      makeMarket(),
      [
        // keyword-only match
        makeAmbient({
          domain: "macro",
          title: "Dollar weakens vs gold",
          body: "Gold beneficiary as dollar slides.",
          impact: 0.9,
        }),
        // keyword+domain match, mid impact
        makeAmbient({ impact: 0.5 }),
        // keyword+domain match, high impact
        makeAmbient({ impact: 0.8, title: "Gold surges 4% today" }),
      ],
    );
    expect(matched).toHaveLength(3);
    expect(matched[0].signal.title).toBe("Gold surges 4% today"); // 0.6 score, 0.8 impact
    expect(matched[1].signal.title).toBe("Gold up 2.0% this week"); // 0.6 score, 0.5 impact
    expect(matched[2].signal.title).toBe("Dollar weakens vs gold"); // 0.4 score
  });
});

describe("applyMatchedSignals", () => {
  it("returns marketProb when no signals or matches", () => {
    const out = applyMatchedSignals({
      marketProb: 0.42,
      marketSignals: [],
      matched: [],
    });
    expect(out.modelProb).toBeCloseTo(0.42, 6);
    expect(out.ambientShift).toBe(0);
  });

  it("nudges modelProb in the matched signal's direction", () => {
    const ambient = makeAmbient({ sentiment: 0.8, impact: 0.8, weight: 0.7 });
    const matched = matchSignalsToMarket(makeMarket(), [ambient]);
    const out = applyMatchedSignals({
      marketProb: 0.4,
      marketSignals: [],
      matched,
    });
    expect(out.modelProb).toBeGreaterThan(0.4);
    expect(out.ambientShift).toBeGreaterThan(0);
  });

  it("nudges down on negative sentiment", () => {
    const ambient = makeAmbient({ sentiment: -0.8, impact: 0.8, weight: 0.7 });
    const matched = matchSignalsToMarket(makeMarket(), [ambient]);
    const out = applyMatchedSignals({
      marketProb: 0.4,
      marketSignals: [],
      matched,
    });
    expect(out.modelProb).toBeLessThan(0.4);
    expect(out.ambientShift).toBeLessThan(0);
  });

  it("caps the ambient-driven shift at MAX_AMBIENT_SHIFT", () => {
    // Pile on many highly-positive matched signals; the cap should kick in.
    const matched = matchSignalsToMarket(
      makeMarket(),
      Array.from({ length: 20 }, (_, i) =>
        makeAmbient({
          title: `Gold up ${5 + i}% today`,
          sentiment: 1,
          impact: 1,
          weight: 1,
        }),
      ),
    );
    const out = applyMatchedSignals({
      marketProb: 0.4,
      marketSignals: [],
      matched,
    });
    // Should saturate at +MAX_AMBIENT_SHIFT.
    expect(out.modelProb - 0.4).toBeCloseTo(MAX_AMBIENT_SHIFT, 5);
    expect(out.ambientShift).toBeCloseTo(MAX_AMBIENT_SHIFT, 5);
  });

  it("respects an explicit smaller cap when supplied", () => {
    const matched = matchSignalsToMarket(
      makeMarket(),
      Array.from({ length: 20 }, () =>
        makeAmbient({ sentiment: 1, impact: 1, weight: 1 }),
      ),
    );
    const out = applyMatchedSignals({
      marketProb: 0.4,
      marketSignals: [],
      matched,
      maxShift: 0.05,
    });
    expect(out.ambientShift).toBeCloseTo(0.05, 5);
    expect(out.modelProb).toBeCloseTo(0.45, 5);
  });
});

describe("buildMatchRationale", () => {
  it("returns empty arrays when no matches", () => {
    const out = buildMatchRationale({
      matched: [],
      marketProb: 0.5,
      modelProb: 0.5,
      ambientShift: 0,
    });
    expect(out.observed).toEqual([]);
    expect(out.inferred).toEqual([]);
  });

  it("attributes matched signals in the observed bucket", () => {
    const matched = matchSignalsToMarket(makeMarket(), [makeAmbient()]);
    const out = buildMatchRationale({
      matched,
      marketProb: 0.4,
      modelProb: 0.45,
      ambientShift: 0.05,
    });
    expect(out.observed.length).toBeGreaterThan(0);
    expect(out.observed[0]).toContain("Signal applied");
    expect(out.observed[0]).toContain("Gold");
    expect(out.inferred[0]).toContain("ambient signal");
    expect(out.inferred[0]).toContain("up");
  });

  it("describes a downward shift correctly", () => {
    const matched = matchSignalsToMarket(makeMarket(), [
      makeAmbient({ sentiment: -0.5 }),
    ]);
    const out = buildMatchRationale({
      matched,
      marketProb: 0.5,
      modelProb: 0.42,
      ambientShift: -0.08,
    });
    expect(out.inferred[0]).toContain("down");
    expect(out.inferred[0]).toContain("8.0 pts");
  });
});
