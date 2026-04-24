import { describe, it, expect } from "vitest";
import {
  applyMatchedSignals,
  buildMatchRationale,
  matchSignalsToMarket,
  MAX_AMBIENT_SHIFT,
} from "./signalMatching";
import { DEFAULT_AMBIENT_SHIFT_CAPS } from "./signalCapTuning";
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
        // metals-domain signal but with multiple macro keywords (fed + rate)
        // so the weak-keyword filter still lets the match through.
        makeAmbient({
          domain: "metals",
          title: "Gold rallies as Fed signals rate cut",
          body: "Gold up on dovish Fed comments and an expected rate cut.",
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

  // --- Entity disambiguation / weak-keyword filter ------------------------

  it("drops a 'trump' match on an unrelated golf-tournament headline", () => {
    // Real-world noise: a Trump-branded golf tournament headline matches
    // 'trump' but has nothing to do with politics or tariffs.
    const matched = matchSignalsToMarket(
      makeMarket({
        domain: "policy",
        question: "Will Trump sign new tariffs by July?",
      }),
      [
        makeAmbient({
          domain: "policy", // upstream connector tagged it 'policy' off 'trump'
          source: "bbc_world",
          kind: "news",
          title: "Trump International golf tournament returns to Doral",
          body: "PGA event hosted at Trump-branded resort this weekend.",
        }),
      ],
    );
    expect(matched).toHaveLength(0);
  });

  it("keeps a 'trump' match when a second policy keyword co-occurs", () => {
    const matched = matchSignalsToMarket(
      makeMarket({
        domain: "policy",
        question: "Will Trump sign new tariffs by July?",
      }),
      [
        makeAmbient({
          domain: "policy",
          source: "bbc_world",
          kind: "news",
          title: "Trump promises sweeping tariffs on EU imports",
          body: "Tariff package to be signed in the coming weeks.",
        }),
      ],
    );
    expect(matched).toHaveLength(1);
    expect(matched[0].matchReason).toContain("trump");
    expect(matched[0].matchReason).toContain("tariff");
  });

  it("does not match 'fed' inside 'Federer' (word-boundary regex)", () => {
    // Substring matching used to fire 'fed' on any Federer headline, then
    // route the (misclassified) signal into Fed-rate markets.
    const matched = matchSignalsToMarket(
      makeMarket({
        domain: "macro",
        question: "Will the Fed cut rates in June?",
      }),
      [
        makeAmbient({
          domain: "geopolitics",
          source: "bbc_world",
          kind: "news",
          title: "Federer announces final tour stop in Basel",
          body: "Roger Federer to retire after one last home appearance.",
        }),
      ],
    );
    expect(matched).toHaveLength(0);
  });

  it("drops a 'court' match on a basketball recap", () => {
    const matched = matchSignalsToMarket(
      makeMarket({
        domain: "policy",
        question: "Will the Supreme Court overturn the ruling by Q4?",
      }),
      [
        makeAmbient({
          domain: "policy",
          source: "hackernews",
          kind: "social_cluster",
          title: "Lakers dominate on the court vs Celtics",
          body: "NBA playoff coverage continues tonight on TNT.",
        }),
      ],
    );
    expect(matched).toHaveLength(0);
  });

  it("keeps a 'court' match when 'ruling' also fires (both policy)", () => {
    // Two weak keywords from the same domain mutually qualify each other.
    const matched = matchSignalsToMarket(
      makeMarket({
        domain: "policy",
        question: "Will the Supreme Court overturn the ruling by Q4?",
      }),
      [
        makeAmbient({
          domain: "policy",
          source: "bbc_world",
          kind: "news",
          title: "Court ruling expected next week in landmark case",
          body: "Justices to issue ruling on long-running antitrust dispute.",
        }),
      ],
    );
    expect(matched).toHaveLength(1);
  });

  it("keeps a strong keyword (e.g. 'iran') even when it's the only hit", () => {
    // Strong keywords are not subject to the disambiguation filter.
    const matched = matchSignalsToMarket(
      makeMarket({
        domain: "geopolitics",
        question: "Will Iran-Israel ceasefire hold by July?",
      }),
      [
        makeAmbient({
          domain: "geopolitics",
          source: "bbc_world",
          kind: "news",
          title: "Iran tests new ballistic missile, IAEA reports",
          body: "Tehran announces expansion of its missile test program.",
        }),
      ],
    );
    expect(matched).toHaveLength(1);
  });

  it("does not match 'oil' inside 'snake oil' (word-boundary regex)", () => {
    // 'snake oil' is one word away from 'oil' but the substring is real;
    // word-boundary matching handles this correctly because 'snake oil'
    // genuinely contains the token 'oil'. To exercise the actual entity-
    // disambiguation path we pick a headline where 'oil' is the only
    // commodities token.
    const matched = matchSignalsToMarket(
      makeMarket({
        domain: "commodities",
        question: "Will WTI crude oil close above $90 by year end?",
      }),
      [
        makeAmbient({
          domain: "commodities",
          source: "hackernews",
          kind: "social_cluster",
          title: "Snake oil salesmen are back, this time in AI",
          body: "Op-ed argues much of the hype is overstated.",
        }),
      ],
    );
    // 'oil' alone is weak and there is no other commodities token in the
    // signal, so the match should be dropped.
    expect(matched).toHaveLength(0);
  });

  it("keeps an 'oil' headline when 'crude' or 'opec' also fires", () => {
    const matched = matchSignalsToMarket(
      makeMarket({
        domain: "commodities",
        question: "Will WTI crude oil close above $90 by year end?",
      }),
      [
        makeAmbient({
          domain: "commodities",
          source: "bbc_world",
          kind: "news",
          title: "OPEC weighs deeper oil output cuts as crude slips",
          body: "Saudi-led group considers further crude production cuts.",
        }),
      ],
    );
    expect(matched).toHaveLength(1);
    expect(matched[0].matchScore).toBe(0.6);
  });

  it("measurably reduces the matched count over a noisy real-world batch", () => {
    // Mixed batch of headlines drawn from typical BBC/HN content. About
    // half have a single weak keyword on an off-topic story; the rest are
    // genuinely on-topic. The post-filter should drop the noisy ones
    // without touching the high-signal matches.
    const policyMarket = makeMarket({
      domain: "policy",
      question: "Will Trump sign new tariffs by July?",
    });
    const ambient = [
      // --- noise (single weak keyword, off-topic) ---
      makeAmbient({
        domain: "policy",
        title: "Trump golf course wins design award",
        body: "Industry magazine highlights resort architecture.",
      }),
      makeAmbient({
        domain: "policy",
        title: "Trump-branded steaks return to retail",
        body: "Limited-edition launch announced this week.",
      }),
      makeAmbient({
        domain: "geopolitics",
        title: "Lakers win on the court in overtime",
        body: "NBA recap from last night.",
      }),
      makeAmbient({
        domain: "macro",
        title: "Federer announces farewell tour",
        body: "Tennis great to retire after season.",
      }),
      // --- genuine signal (multiple domain-aligned keywords) ---
      makeAmbient({
        domain: "policy",
        title: "Trump promises sweeping tariffs on EU imports",
        body: "Senate response to the tariff package expected next week.",
      }),
      makeAmbient({
        domain: "policy",
        title: "White House drafts new tariff order",
        body: "Trump administration weighs sanctions alongside tariffs.",
      }),
    ];
    const matched = matchSignalsToMarket(policyMarket, ambient);
    // Only the two genuine signals should survive.
    expect(matched).toHaveLength(2);
    for (const m of matched) {
      expect(m.signal.title.toLowerCase()).toMatch(/tariff|trump promises/);
    }
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

  it("caps the ambient-driven shift at MAX_AMBIENT_SHIFT when no domain is given", () => {
    // No domain passed -> falls back to the legacy global cap, exactly
    // as before per-domain caps were introduced.
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
    expect(out.modelProb - 0.4).toBeCloseTo(MAX_AMBIENT_SHIFT, 5);
    expect(out.ambientShift).toBeCloseTo(MAX_AMBIENT_SHIFT, 5);
    expect(out.cap).toBe(MAX_AMBIENT_SHIFT);
  });

  it("uses the per-domain cap when domain is provided", () => {
    // metals default cap is 0.08 — much tighter than the legacy 0.15.
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
      domain: "metals",
    });
    expect(out.cap).toBe(DEFAULT_AMBIENT_SHIFT_CAPS.metals);
    expect(out.ambientShift).toBeCloseTo(DEFAULT_AMBIENT_SHIFT_CAPS.metals, 5);
  });

  it("looser cap for geopolitics permits wider shifts", () => {
    const matched = matchSignalsToMarket(
      makeMarket({
        domain: "geopolitics",
        question: "Will Iran-Israel ceasefire hold by July?",
      }),
      Array.from({ length: 20 }, () =>
        makeAmbient({
          domain: "geopolitics",
          title: "Israel-Iran ceasefire holding overnight",
          body: "Diplomatic breakthrough.",
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
      domain: "geopolitics",
    });
    expect(out.cap).toBe(DEFAULT_AMBIENT_SHIFT_CAPS.geopolitics);
    expect(out.ambientShift).toBeCloseTo(
      DEFAULT_AMBIENT_SHIFT_CAPS.geopolitics,
      5,
    );
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
