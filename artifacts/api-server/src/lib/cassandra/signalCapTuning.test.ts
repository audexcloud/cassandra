import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIENT_SHIFT_CAPS,
  FALLBACK_AMBIENT_SHIFT,
  MIN_SAMPLES_PER_DOMAIN,
  TARGET_QUANTILE,
  _resetTunedCaps,
  applyTunedCaps,
  buildSignalOutcomeObservations,
  computeRecommendedCapsFromObservations,
  getAmbientShiftCap,
  getLastTunedAt,
  quantile,
  type AmbientCapStat,
  type AnalysisInputs,
  type AnalysisOpportunity,
  type AnalysisSignal,
  type AnalysisSnapshot,
  type SignalOutcomeObservation,
} from "./signalCapTuning";

describe("getAmbientShiftCap", () => {
  beforeEach(() => _resetTunedCaps());
  afterEach(() => _resetTunedCaps());

  it("returns the per-domain default when nothing has been tuned", () => {
    expect(getAmbientShiftCap("metals")).toBe(
      DEFAULT_AMBIENT_SHIFT_CAPS.metals,
    );
    expect(getAmbientShiftCap("geopolitics")).toBe(
      DEFAULT_AMBIENT_SHIFT_CAPS.geopolitics,
    );
  });

  it("falls back to the global fallback for unknown domains", () => {
    expect(getAmbientShiftCap("not-a-real-domain")).toBe(
      FALLBACK_AMBIENT_SHIFT,
    );
  });

  it("prefers a tuned cap once one has been applied", () => {
    const stats: AmbientCapStat[] = [
      {
        domain: "metals",
        sampleSize: 200,
        p90AbsDelta: 0.06,
        recommendedCap: 0.06,
        source: "empirical",
      },
    ];
    const applied = applyTunedCaps(stats);
    expect(applied).toBe(1);
    expect(getAmbientShiftCap("metals")).toBe(0.06);
    // Other domains still resolve to their hand-tuned defaults.
    expect(getAmbientShiftCap("policy")).toBe(
      DEFAULT_AMBIENT_SHIFT_CAPS.policy,
    );
    expect(getLastTunedAt()).toBeInstanceOf(Date);
  });
});

describe("default cap configuration", () => {
  it("covers every connector domain", () => {
    const expected = [
      "prediction_market",
      "metals",
      "commodities",
      "macro",
      "policy",
      "geopolitics",
    ];
    for (const d of expected) {
      expect(
        (DEFAULT_AMBIENT_SHIFT_CAPS as Record<string, number>)[d],
      ).toBeGreaterThan(0);
    }
  });

  it("keeps every default within a sane band", () => {
    for (const v of Object.values(DEFAULT_AMBIENT_SHIFT_CAPS)) {
      expect(v).toBeGreaterThanOrEqual(0.05);
      expect(v).toBeLessThanOrEqual(0.3);
    }
  });

  it("uses a recognisable target quantile and minimum sample size", () => {
    expect(TARGET_QUANTILE).toBe(0.9);
    expect(MIN_SAMPLES_PER_DOMAIN).toBeGreaterThanOrEqual(10);
  });
});

describe("quantile", () => {
  it("returns null for an empty array", () => {
    expect(quantile([], 0.9)).toBeNull();
  });

  it("returns the only sample for a single-element array", () => {
    expect(quantile([0.05], 0.9)).toBe(0.05);
  });

  it("interpolates between samples at the target quantile", () => {
    // p90 over [0..10] is 9.0 by linear interpolation on 11 sorted samples.
    const arr = Array.from({ length: 11 }, (_, i) => i);
    expect(quantile(arr, 0.9)).toBeCloseTo(9, 6);
  });
});

describe("computeRecommendedCapsFromObservations", () => {
  function makeObs(
    domain: string,
    deltas: number[],
  ): SignalOutcomeObservation[] {
    return deltas.map((d) => ({ domain, absDelta: d }));
  }

  it("returns a default-source row for every known domain when there are zero observations", () => {
    const out = computeRecommendedCapsFromObservations([]);
    // Every domain in the defaults table should be present.
    const domains = new Set(out.map((s) => s.domain));
    for (const d of Object.keys(DEFAULT_AMBIENT_SHIFT_CAPS)) {
      expect(domains.has(d)).toBe(true);
    }
    for (const stat of out) {
      expect(stat.sampleSize).toBe(0);
      expect(stat.source).toBe("default");
      expect(stat.recommendedCap).toBe(
        (DEFAULT_AMBIENT_SHIFT_CAPS as Record<string, number>)[stat.domain],
      );
    }
  });

  it("falls back to the default when sample size is below the minimum", () => {
    // Five tiny observations — well under MIN_SAMPLES_PER_DOMAIN.
    const obs = makeObs("metals", [0.01, 0.02, 0.03, 0.04, 0.05]);
    const out = computeRecommendedCapsFromObservations(obs);
    const metals = out.find((s) => s.domain === "metals");
    expect(metals).toBeDefined();
    expect(metals!.sampleSize).toBe(5);
    expect(metals!.source).toBe("default");
    expect(metals!.recommendedCap).toBe(DEFAULT_AMBIENT_SHIFT_CAPS.metals);
    // The empirical p90 is still surfaced for diagnostics, even though
    // we didn't use it for the recommendation.
    expect(metals!.p90AbsDelta).not.toBeNull();
  });

  it("uses the empirical p90 once sample size clears the minimum", () => {
    // Build a known distribution: 100 samples uniform 0..0.20. p90 = 0.18.
    const samples = Array.from({ length: 100 }, (_, i) => (i + 1) / 100 * 0.2);
    const out = computeRecommendedCapsFromObservations(
      makeObs("geopolitics", samples),
    );
    const geo = out.find((s) => s.domain === "geopolitics");
    expect(geo).toBeDefined();
    expect(geo!.sampleSize).toBe(100);
    expect(geo!.source).toBe("empirical");
    // p90 of 0.002, 0.004, ..., 0.20 is ~0.18 (rounded to 1pt -> 0.18).
    expect(geo!.recommendedCap).toBeCloseTo(0.18, 2);
  });

  it("clamps a wildly large empirical p90 down to the safety ceiling", () => {
    // 50 samples of 0.6 would suggest a 60pt cap, which is absurd. The
    // hard ceiling MAX_TUNED_CAP (=0.30) must save us.
    const out = computeRecommendedCapsFromObservations(
      makeObs("policy", Array.from({ length: 50 }, () => 0.6)),
    );
    const policy = out.find((s) => s.domain === "policy");
    expect(policy).toBeDefined();
    expect(policy!.source).toBe("empirical");
    expect(policy!.recommendedCap).toBeLessThanOrEqual(0.3);
    expect(policy!.recommendedCap).toBe(0.3);
  });

  it("clamps an empirical p90 of zero up to the safety floor", () => {
    // 50 samples of 0 — markets never moved. We still want a non-zero
    // cap so the matching layer can have *some* effect.
    const out = computeRecommendedCapsFromObservations(
      makeObs("metals", Array.from({ length: 50 }, () => 0)),
    );
    const metals = out.find((s) => s.domain === "metals");
    expect(metals).toBeDefined();
    expect(metals!.source).toBe("empirical");
    expect(metals!.recommendedCap).toBeGreaterThanOrEqual(0.05);
    expect(metals!.recommendedCap).toBe(0.05);
  });

  it("treats negative deltas as their absolute value", () => {
    // The DB-side analysis only emits non-negative deltas, but the
    // helper should be robust to unexpected signed input from any
    // future caller.
    const out = computeRecommendedCapsFromObservations(
      makeObs(
        "macro",
        Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? 0.1 : -0.1)),
      ),
    );
    const macro = out.find((s) => s.domain === "macro");
    expect(macro!.recommendedCap).toBeCloseTo(0.1, 2);
  });

  it("surfaces unknown domains the connectors emit", () => {
    // Defensive: a connector starting to emit a new domain string
    // should still appear in the analysis output.
    const out = computeRecommendedCapsFromObservations(
      makeObs("brand_new_domain", Array.from({ length: 50 }, () => 0.07)),
    );
    const novel = out.find((s) => s.domain === "brand_new_domain");
    expect(novel).toBeDefined();
    expect(novel!.source).toBe("empirical");
  });

  it("ignores non-finite samples", () => {
    const out = computeRecommendedCapsFromObservations([
      { domain: "metals", absDelta: Number.NaN },
      { domain: "metals", absDelta: Number.POSITIVE_INFINITY },
    ]);
    const metals = out.find((s) => s.domain === "metals");
    expect(metals!.sampleSize).toBe(0);
    expect(metals!.source).toBe("default");
  });
});

describe("buildSignalOutcomeObservations", () => {
  // Deterministic clock anchor for the fixtures.
  const T0 = new Date("2026-01-01T00:00:00Z").getTime();
  const minutes = (n: number) => new Date(T0 + n * 60_000);

  function sig(overrides: Partial<AnalysisSignal>): AnalysisSignal {
    return {
      id: 1,
      opportunityId: null,
      domain: "metals",
      source: "test",
      kind: "news",
      title: "",
      body: "",
      impact: 0.5,
      sentiment: 0,
      observedAt: minutes(0),
      ...overrides,
    };
  }
  function opp(
    id: number,
    domain: string,
    question: string,
  ): AnalysisOpportunity {
    return { id, domain, question };
  }
  function snap(
    opportunityId: number,
    marketProb: number,
    capturedAtMin: number,
  ): AnalysisSnapshot {
    return { opportunityId, marketProb, capturedAt: minutes(capturedAtMin) };
  }

  it("attributes a per-market signal to its own opportunity only", () => {
    const inputs: AnalysisInputs = {
      signals: [
        sig({
          id: 1,
          opportunityId: 100,
          domain: "metals",
          title: "private wire",
          body: "",
          observedAt: minutes(10),
        }),
      ],
      opportunities: [
        opp(100, "metals", "Will gold close above $2500?"),
        // Same-domain decoy that should NOT be credited even though it's
        // in the same domain — per-market signals route to one market.
        opp(101, "metals", "Will silver hit $30?"),
      ],
      snapshots: [
        snap(100, 0.5, 5),
        snap(100, 0.58, 15),
        snap(101, 0.4, 5),
        snap(101, 0.7, 15),
      ],
    };
    const out = buildSignalOutcomeObservations(inputs);
    expect(out).toHaveLength(1);
    expect(out[0].domain).toBe("metals");
    expect(out[0].absDelta).toBeCloseTo(0.08, 6);
  });

  it("only fans an ambient signal out to opportunities the live router would actually match", () => {
    // Ambient signal mentions "gold" — should match only the gold market,
    // NOT every metals market in the same domain (the regression the
    // reviewer flagged).
    const inputs: AnalysisInputs = {
      signals: [
        sig({
          id: 1,
          opportunityId: null,
          domain: "metals",
          title: "Gold rallies on Fed pivot speculation",
          body: "Spot gold extends gains.",
          observedAt: minutes(10),
        }),
      ],
      opportunities: [
        opp(100, "metals", "Will gold close above $2500?"),
        opp(101, "metals", "Will silver hit $30?"),
        opp(102, "metals", "Will copper end the year above $4?"),
      ],
      snapshots: [
        snap(100, 0.5, 5),
        snap(100, 0.6, 15),
        snap(101, 0.4, 5),
        snap(101, 0.9, 15),
        snap(102, 0.3, 5),
        snap(102, 0.1, 15),
      ],
    };
    const out = buildSignalOutcomeObservations(inputs);
    // Exactly one observation: the gold market. The silver/copper deltas
    // (0.50 and 0.20) must NOT appear, because the matching layer would
    // have rejected those routes.
    expect(out).toHaveLength(1);
    expect(out[0].absDelta).toBeCloseTo(0.1, 6);
  });

  it("never crosses domains for ambient signals", () => {
    // Ambient signal in geopolitics that mentions "iran" — it should
    // never attribute to a metals market even if some metals question
    // happened to contain a topic keyword from another domain.
    const inputs: AnalysisInputs = {
      signals: [
        sig({
          id: 1,
          opportunityId: null,
          domain: "geopolitics",
          title: "Iran negotiations stall",
          body: "Tehran walks back commitments.",
          observedAt: minutes(10),
        }),
      ],
      opportunities: [
        opp(100, "metals", "Will gold rally on Iran tensions?"),
      ],
      snapshots: [snap(100, 0.5, 5), snap(100, 0.7, 15)],
    };
    const out = buildSignalOutcomeObservations(inputs);
    expect(out).toHaveLength(0);
  });

  it("ignores signals with no snapshot before observed_at", () => {
    const inputs: AnalysisInputs = {
      signals: [
        sig({
          id: 1,
          opportunityId: 100,
          observedAt: minutes(10),
        }),
      ],
      opportunities: [opp(100, "metals", "Will gold close above $2500?")],
      // Only post-signal snapshots — no baseline to measure from.
      snapshots: [snap(100, 0.6, 15), snap(100, 0.7, 20)],
    };
    expect(buildSignalOutcomeObservations(inputs)).toHaveLength(0);
  });

  it("ignores signals whose post-signal snapshot is outside the window", () => {
    const inputs: AnalysisInputs = {
      signals: [
        sig({
          id: 1,
          opportunityId: 100,
          observedAt: minutes(10),
        }),
      ],
      opportunities: [opp(100, "metals", "Will gold close above $2500?")],
      // Baseline at t=5 is fine, but the next snapshot is at t=10 + 60
      // minutes — outside the 30-minute window. Should be dropped.
      snapshots: [snap(100, 0.5, 5), snap(100, 0.9, 70)],
    };
    expect(buildSignalOutcomeObservations(inputs)).toHaveLength(0);
  });

  it("respects a custom window length", () => {
    const inputs: AnalysisInputs = {
      signals: [
        sig({
          id: 1,
          opportunityId: 100,
          observedAt: minutes(10),
        }),
      ],
      opportunities: [opp(100, "metals", "Will gold close above $2500?")],
      // Post-signal snapshot is 45 minutes after observed_at. Default
      // 30-min window would drop it; a 60-min window includes it.
      snapshots: [snap(100, 0.5, 5), snap(100, 0.55, 55)],
    };
    expect(buildSignalOutcomeObservations(inputs, 30)).toHaveLength(0);
    const out60 = buildSignalOutcomeObservations(inputs, 60);
    expect(out60).toHaveLength(1);
    expect(out60[0].absDelta).toBeCloseTo(0.05, 6);
  });
});
