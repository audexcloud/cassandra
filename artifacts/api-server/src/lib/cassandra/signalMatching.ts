/**
 * Signal → opportunity matching layer.
 *
 * Most of our real connectors only produce ambient signals (COMEX price moves,
 * news headlines) without directly attaching them to specific prediction
 * markets. Without a routing step, those signals never influence any
 * opportunity's `modelProb`, so the published "edge over market" stays near
 * zero.
 *
 * This module bridges that gap: given a market and a pool of ambient signals,
 * it returns the subset that plausibly bear on that market, plus a
 * per-match score that downstream code feeds back into `aggregateModelProb`.
 *
 * Matching is intentionally simple and fully explainable — domain alignment
 * plus keyword overlap. The result includes a human-readable `matchReason`
 * so the dashboard can show *why* a particular signal was applied.
 */
import type { ConnectorMarket, ConnectorSignal } from "./connectors";
import { aggregateModelProb, clamp, clamp01, type RawSignal } from "./scoring";

/**
 * Topic keywords mapped to their canonical domain. A signal's title/body and
 * a market's question are tokenized; any keyword present in either is
 * treated as a topic hit. Two-word phrases (e.g. "natural gas") are matched
 * with `String.includes` rather than token-wise.
 */
const TOPIC_KEYWORDS: Array<{
  keyword: string;
  domain:
    | "metals"
    | "commodities"
    | "macro"
    | "policy"
    | "geopolitics"
    | "prediction_market";
}> = [
  // metals
  { keyword: "gold", domain: "metals" },
  { keyword: "silver", domain: "metals" },
  { keyword: "platinum", domain: "metals" },
  { keyword: "palladium", domain: "metals" },
  { keyword: "copper", domain: "metals" },
  { keyword: "bullion", domain: "metals" },
  // commodities
  { keyword: "oil", domain: "commodities" },
  { keyword: "crude", domain: "commodities" },
  { keyword: "wti", domain: "commodities" },
  { keyword: "brent", domain: "commodities" },
  { keyword: "opec", domain: "commodities" },
  { keyword: "natural gas", domain: "commodities" },
  { keyword: "wheat", domain: "commodities" },
  { keyword: "corn", domain: "commodities" },
  { keyword: "soy", domain: "commodities" },
  { keyword: "lithium", domain: "commodities" },
  // macro
  { keyword: "fed", domain: "macro" },
  { keyword: "federal reserve", domain: "macro" },
  { keyword: "inflation", domain: "macro" },
  { keyword: "cpi", domain: "macro" },
  { keyword: "gdp", domain: "macro" },
  { keyword: "jobs", domain: "macro" },
  { keyword: "payroll", domain: "macro" },
  { keyword: "unemployment", domain: "macro" },
  { keyword: "recession", domain: "macro" },
  { keyword: "treasury", domain: "macro" },
  { keyword: "yield", domain: "macro" },
  { keyword: "bond", domain: "macro" },
  { keyword: "s&p", domain: "macro" },
  { keyword: "nasdaq", domain: "macro" },
  { keyword: "rate", domain: "macro" },
  { keyword: "rates", domain: "macro" },
  // policy
  { keyword: "senate", domain: "policy" },
  { keyword: "congress", domain: "policy" },
  { keyword: "tariff", domain: "policy" },
  { keyword: "tariffs", domain: "policy" },
  { keyword: "sanction", domain: "policy" },
  { keyword: "sanctions", domain: "policy" },
  { keyword: "regulator", domain: "policy" },
  { keyword: "sec", domain: "policy" },
  { keyword: "cftc", domain: "policy" },
  { keyword: "court", domain: "policy" },
  { keyword: "ruling", domain: "policy" },
  { keyword: "biden", domain: "policy" },
  { keyword: "trump", domain: "policy" },
  // geopolitics
  { keyword: "iran", domain: "geopolitics" },
  { keyword: "israel", domain: "geopolitics" },
  { keyword: "ukraine", domain: "geopolitics" },
  { keyword: "russia", domain: "geopolitics" },
  { keyword: "china", domain: "geopolitics" },
  { keyword: "taiwan", domain: "geopolitics" },
  { keyword: "north korea", domain: "geopolitics" },
  { keyword: "gaza", domain: "geopolitics" },
  { keyword: "nato", domain: "geopolitics" },
  { keyword: "ceasefire", domain: "geopolitics" },
];

/**
 * Maximum percentage-point shift a matched-ambient pool may apply to
 * `modelProb` away from `marketProb`. Per-market signals (already attached
 * upstream by a connector) are *not* subject to this cap — only the ambient
 * routing layer is, since matching is necessarily fuzzier than a direct
 * connector-attached signal.
 */
export const MAX_AMBIENT_SHIFT = 0.15;

export interface MatchedSignal {
  signal: ConnectorSignal;
  /** 0..1 multiplier applied to the signal's underlying weight. */
  matchScore: number;
  matchReason: string;
}

/** Find topic keywords that appear in the given lowercased text. */
function topicHits(text: string): Set<string> {
  const t = text.toLowerCase();
  const hits = new Set<string>();
  for (const { keyword } of TOPIC_KEYWORDS) {
    if (t.includes(keyword)) hits.add(keyword);
  }
  return hits;
}

/**
 * Find ambient signals relevant to a given market. A signal is considered
 * relevant when it shares a topic keyword with the market's question (or,
 * weaker, when its domain matches the market's domain *and* it carries any
 * topic keyword at all). Domain-only matches with no keyword overlap are
 * dropped to keep noise out of the model.
 */
export function matchSignalsToMarket(
  market: Pick<ConnectorMarket, "question" | "domain">,
  ambient: ConnectorSignal[],
): MatchedSignal[] {
  const questionHits = topicHits(market.question);
  const matched: MatchedSignal[] = [];

  for (const signal of ambient) {
    const signalText = `${signal.title} ${signal.body}`;
    const signalHits = topicHits(signalText);

    // Shared topic keywords between question and signal text.
    const sharedKeywords = [...signalHits].filter((k) => questionHits.has(k));
    const domainMatch = market.domain === signal.domain;

    let matchScore = 0;
    let matchReason = "";

    if (sharedKeywords.length > 0 && domainMatch) {
      matchScore = 0.6;
      matchReason = `domain ${signal.domain} + keyword(s) ${sharedKeywords.slice(0, 3).join(", ")}`;
    } else if (sharedKeywords.length > 0) {
      matchScore = 0.4;
      matchReason = `keyword(s) ${sharedKeywords.slice(0, 3).join(", ")}`;
    } else {
      // Domain-only matches are intentionally ignored — they generate too
      // many spurious links (e.g. every macro headline tilting every macro
      // market).
      continue;
    }

    matched.push({ signal, matchScore, matchReason });
  }

  // Stable order by descending match score, then by descending impact —
  // makes attribution deterministic for tests and the dashboard.
  matched.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    return b.signal.impact - a.signal.impact;
  });

  return matched;
}

/**
 * Apply a market's own (connector-attached) signals plus any matched ambient
 * signals to produce a new `modelProb`. The shift contributed by the
 * ambient layer is capped at `MAX_AMBIENT_SHIFT` so the routing layer can
 * never single-handedly move a market more than ~15 percentage points.
 */
export function applyMatchedSignals(args: {
  marketProb: number;
  marketSignals: ConnectorSignal[];
  matched: MatchedSignal[];
  maxShift?: number;
}): { modelProb: number; ambientShift: number } {
  const { marketProb, marketSignals, matched } = args;
  const cap = args.maxShift ?? MAX_AMBIENT_SHIFT;

  // First, the prior after the market's own signals (no cap; these are
  // upstream-attached and trusted).
  const baselineSignals: RawSignal[] = marketSignals.map((s) => ({
    sentiment: s.sentiment,
    impact: s.impact,
    weight: s.weight ?? 0.5,
  }));
  const baselineProb =
    baselineSignals.length > 0
      ? aggregateModelProb(marketProb, baselineSignals)
      : marketProb;

  if (matched.length === 0) {
    return { modelProb: baselineProb, ambientShift: 0 };
  }

  // Then, the contribution from matched ambient signals — each scaled by
  // its match score so weaker matches push less.
  const ambientSignals: RawSignal[] = matched.map((m) => ({
    sentiment: m.signal.sentiment,
    impact: m.signal.impact,
    weight: clamp01((m.signal.weight ?? 0.5) * m.matchScore),
  }));
  const combined = aggregateModelProb(baselineProb, ambientSignals);

  // Cap the *additional* shift contributed by the ambient layer.
  const rawAmbientShift = combined - baselineProb;
  const cappedShift = clamp(rawAmbientShift, -cap, cap);
  const modelProb = clamp(baselineProb + cappedShift, 0.001, 0.999);

  return { modelProb, ambientShift: cappedShift };
}

/**
 * Build extra rationale lines describing which ambient signals were applied
 * and how far they moved `modelProb`. Returned as `{ observed, inferred }`
 * arrays the caller can append to the connector's existing rationale.
 */
export function buildMatchRationale(args: {
  matched: MatchedSignal[];
  marketProb: number;
  modelProb: number;
  ambientShift: number;
}): { observed: string[]; inferred: string[] } {
  if (args.matched.length === 0) {
    return { observed: [], inferred: [] };
  }
  const observed = args.matched
    .slice(0, 3)
    .map(
      (m) =>
        `Signal applied (${m.matchReason}): ${m.signal.title}`,
    );
  const direction = args.ambientShift >= 0 ? "up" : "down";
  const ptsAbs = Math.abs(args.ambientShift * 100);
  const inferred = [
    `${args.matched.length} ambient signal(s) shifted modelProb ${direction} ${ptsAbs.toFixed(1)} pts (capped at ${(MAX_AMBIENT_SHIFT * 100).toFixed(0)}); marketProb ${(args.marketProb * 100).toFixed(1)}%, modelProb ${(args.modelProb * 100).toFixed(1)}%.`,
  ];
  return { observed, inferred };
}
