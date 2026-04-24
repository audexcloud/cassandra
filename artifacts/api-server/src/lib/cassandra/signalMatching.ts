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
import type { ConnectorDomain, ConnectorMarket, ConnectorSignal } from "./connectors";
import { aggregateModelProb, clamp, clamp01, type RawSignal } from "./scoring";
import {
  FALLBACK_AMBIENT_SHIFT,
  getAmbientShiftCap,
} from "./signalCapTuning";

/**
 * Topic keywords mapped to their canonical domain. A signal's title/body and
 * a market's question are scanned with word-boundary regexes; any keyword
 * present in either is treated as a topic hit. Word boundaries mean
 * "Federer" no longer matches "fed", "Fedex" no longer matches "fed", etc.
 *
 * Each keyword can be marked `weak: true`. Weak keywords are generic English
 * words or proper nouns that show up frequently in unrelated contexts
 * ("trump" in a golf-tournament headline, "court" in a basketball recap,
 * "fed" inside "Federer"…). A weak keyword on its own is not enough to
 * route a signal into a market — it must co-occur with at least one other
 * topic keyword from the same domain inside the signal text. See
 * `qualifyWeakHits` for the exact rule.
 */
type TopicDomain =
  | "metals"
  | "commodities"
  | "macro"
  | "policy"
  | "geopolitics"
  | "prediction_market";

const TOPIC_KEYWORDS: Array<{
  keyword: string;
  domain: TopicDomain;
  weak?: boolean;
}> = [
  // metals
  { keyword: "gold", domain: "metals" },
  { keyword: "silver", domain: "metals" },
  { keyword: "platinum", domain: "metals" },
  { keyword: "palladium", domain: "metals" },
  { keyword: "copper", domain: "metals" },
  { keyword: "bullion", domain: "metals" },
  // commodities
  { keyword: "oil", domain: "commodities", weak: true },
  { keyword: "crude", domain: "commodities" },
  { keyword: "wti", domain: "commodities" },
  { keyword: "brent", domain: "commodities" },
  { keyword: "opec", domain: "commodities" },
  { keyword: "natural gas", domain: "commodities" },
  { keyword: "wheat", domain: "commodities", weak: true },
  { keyword: "corn", domain: "commodities", weak: true },
  { keyword: "soy", domain: "commodities", weak: true },
  { keyword: "lithium", domain: "commodities" },
  // macro
  { keyword: "fed", domain: "macro", weak: true },
  { keyword: "federal reserve", domain: "macro" },
  { keyword: "inflation", domain: "macro" },
  { keyword: "cpi", domain: "macro" },
  { keyword: "gdp", domain: "macro" },
  { keyword: "jobs", domain: "macro", weak: true },
  { keyword: "payroll", domain: "macro" },
  { keyword: "unemployment", domain: "macro" },
  { keyword: "recession", domain: "macro" },
  { keyword: "treasury", domain: "macro" },
  { keyword: "yield", domain: "macro", weak: true },
  { keyword: "bond", domain: "macro", weak: true },
  { keyword: "s&p", domain: "macro" },
  { keyword: "nasdaq", domain: "macro" },
  { keyword: "rate", domain: "macro", weak: true },
  { keyword: "rates", domain: "macro", weak: true },
  // policy
  { keyword: "senate", domain: "policy" },
  { keyword: "congress", domain: "policy" },
  { keyword: "tariff", domain: "policy" },
  { keyword: "tariffs", domain: "policy" },
  { keyword: "sanction", domain: "policy" },
  { keyword: "sanctions", domain: "policy" },
  { keyword: "regulator", domain: "policy", weak: true },
  { keyword: "sec", domain: "policy", weak: true },
  { keyword: "cftc", domain: "policy" },
  { keyword: "court", domain: "policy", weak: true },
  { keyword: "ruling", domain: "policy", weak: true },
  { keyword: "biden", domain: "policy" },
  { keyword: "trump", domain: "policy", weak: true },
  // geopolitics
  { keyword: "iran", domain: "geopolitics" },
  { keyword: "israel", domain: "geopolitics" },
  { keyword: "ukraine", domain: "geopolitics" },
  { keyword: "russia", domain: "geopolitics" },
  { keyword: "china", domain: "geopolitics", weak: true },
  { keyword: "taiwan", domain: "geopolitics" },
  { keyword: "north korea", domain: "geopolitics" },
  { keyword: "gaza", domain: "geopolitics" },
  { keyword: "nato", domain: "geopolitics" },
  { keyword: "ceasefire", domain: "geopolitics" },
];

/**
 * Pre-built lookup tables. Built once at module load:
 *   - `KEYWORD_REGEXES` is keyed by keyword and holds a word-boundary regex
 *     so `"Federer"` no longer matches `"fed"` and `"snake oil"` no longer
 *     matches an oil-prices market via the body.
 *   - `KEYWORD_DOMAINS` maps a hit keyword back to its canonical domain.
 *   - `WEAK_KEYWORDS` is the set of keywords that need disambiguation.
 */
const KEYWORD_REGEXES: ReadonlyMap<string, RegExp> = new Map(
  TOPIC_KEYWORDS.map(({ keyword }) => [keyword, buildKeywordRegex(keyword)]),
);
const KEYWORD_DOMAINS: ReadonlyMap<string, TopicDomain> = new Map(
  TOPIC_KEYWORDS.map(({ keyword, domain }) => [keyword, domain]),
);
const WEAK_KEYWORDS: ReadonlySet<string> = new Set(
  TOPIC_KEYWORDS.filter((k) => k.weak).map((k) => k.keyword),
);

function buildKeywordRegex(keyword: string): RegExp {
  // Defensively escape regex metacharacters; our current keywords have none
  // but future additions might. `\b` works correctly across spaces, so
  // multi-word phrases like "natural gas" and "north korea" still match.
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

/**
 * Legacy global cap retained for back-compat. The live cap is now
 * per-domain and resolved through `getAmbientShiftCap(domain)` (see
 * `signalCapTuning.ts` for how those numbers are derived). This constant
 * is the *fallback* used when a caller does not pass a domain — the same
 * value as before so behaviour does not regress in that path.
 *
 * Per-market signals (already attached upstream by a connector) are *not*
 * subject to this cap — only the ambient routing layer is, since matching
 * is necessarily fuzzier than a direct connector-attached signal.
 */
export const MAX_AMBIENT_SHIFT = FALLBACK_AMBIENT_SHIFT;

export interface MatchedSignal {
  signal: ConnectorSignal;
  /** 0..1 multiplier applied to the signal's underlying weight. */
  matchScore: number;
  matchReason: string;
  /**
   * The topic keywords that overlapped between the market's question and
   * the signal's title/body — surfaced explicitly (alongside the prose
   * `matchReason`) so the UI can render them as structured chips without
   * re-parsing the reason string.
   */
  sharedKeywords: string[];
}

/**
 * Compact, serializable view of a matched ambient signal — the shape
 * persisted into the opportunity rationale jsonb and surfaced on the API
 * so the dashboard's "What moved this prediction" section can render the
 * matched signals as structured rows (no string parsing required).
 */
export interface AppliedSignalSummary {
  /** Headline of the underlying signal. */
  title: string;
  /** Source connector that emitted the signal (e.g. "comex", "newswire"). */
  source: string;
  /** Signal kind (e.g. "price_move", "news"). */
  kind: string;
  /** Signal's domain. */
  domain: ConnectorDomain;
  /** Topic keywords that drove the match. */
  keywords: string[];
  /**
   * Human-readable direction of the contribution: "up" pushes modelProb
   * toward YES, "down" toward NO, "neutral" if the signal was flat.
   */
  direction: "up" | "down" | "neutral";
  /** Original signal sentiment (-1..1). */
  sentiment: number;
  /** Original signal impact magnitude (0..1). */
  impact: number;
  /** Effective weight applied to scoring (signal.weight × matchScore). */
  effectiveWeight: number;
  /** Match score (0..1) — how strongly the signal was tied to the market. */
  matchScore: number;
}

/** Domains we accept on a persisted appliedSignal entry — must stay in
 *  sync with the OpenAPI `Domain` enum and `ConnectorDomain` type. */
const APPLIED_SIGNAL_DOMAINS: ReadonlySet<ConnectorDomain> = new Set<ConnectorDomain>([
  "prediction_market",
  "geopolitics",
  "policy",
  "commodities",
  "metals",
  "macro",
]);

/**
 * Defensively parse a persisted `rationale.appliedSignals` jsonb value into
 * a strongly-typed `AppliedSignalSummary[]`. Used by both the opportunity
 * detail serializer and the dashboard summary route so they agree on what
 * counts as a valid attribution row — and so a malformed/legacy entry
 * cannot fail downstream zod response validation.
 *
 * Entries with the wrong shape, an unknown domain, or a non-up/down/neutral
 * direction are silently dropped. Non-string keywords on an otherwise valid
 * entry are filtered out rather than rejecting the whole row.
 */
export function parsePersistedAppliedSignals(input: unknown): AppliedSignalSummary[] {
  if (!Array.isArray(input)) return [];
  const out: AppliedSignalSummary[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.title !== "string" ||
      typeof e.source !== "string" ||
      typeof e.kind !== "string" ||
      typeof e.domain !== "string" ||
      !APPLIED_SIGNAL_DOMAINS.has(e.domain as ConnectorDomain) ||
      (e.direction !== "up" && e.direction !== "down" && e.direction !== "neutral") ||
      typeof e.sentiment !== "number" ||
      typeof e.impact !== "number" ||
      typeof e.effectiveWeight !== "number" ||
      typeof e.matchScore !== "number" ||
      !Array.isArray(e.keywords)
    ) {
      continue;
    }
    out.push({
      title: e.title,
      source: e.source,
      kind: e.kind,
      domain: e.domain as ConnectorDomain,
      keywords: e.keywords.filter((k): k is string => typeof k === "string"),
      direction: e.direction,
      sentiment: e.sentiment,
      impact: e.impact,
      effectiveWeight: e.effectiveWeight,
      matchScore: e.matchScore,
    });
  }
  return out;
}

/**
 * Convert the internal `MatchedSignal[]` (which carries a full
 * `ConnectorSignal` reference) into the compact `AppliedSignalSummary[]`
 * shape suitable for storage in the opportunity rationale jsonb and for
 * direct serialization on the opportunity API. Order is preserved.
 */
export function summarizeAppliedSignals(
  matched: MatchedSignal[],
): AppliedSignalSummary[] {
  return matched.map((m) => {
    const direction: "up" | "down" | "neutral" =
      m.signal.sentiment > 0 ? "up" : m.signal.sentiment < 0 ? "down" : "neutral";
    return {
      title: m.signal.title,
      source: m.signal.source,
      kind: m.signal.kind,
      domain: m.signal.domain,
      keywords: m.sharedKeywords,
      direction,
      sentiment: m.signal.sentiment,
      impact: m.signal.impact,
      effectiveWeight: clamp01((m.signal.weight ?? 0.5) * m.matchScore),
      matchScore: m.matchScore,
    };
  });
}

/** Find topic keywords that appear in the given text (case-insensitive,
 *  word-boundary aware). */
function topicHits(text: string): Set<string> {
  const hits = new Set<string>();
  for (const [keyword, regex] of KEYWORD_REGEXES) {
    if (regex.test(text)) hits.add(keyword);
  }
  return hits;
}

/**
 * Apply the entity-disambiguation filter to the shared-keyword list. A
 * shared keyword `K` is kept when:
 *   - it is not weak (e.g. `gold`, `iran`, `cpi`, `tariff`), or
 *   - the signal text contains at least one *other* topic keyword from the
 *     same domain as `K` (e.g. `trump` is kept when the signal also
 *     mentions `tariff`/`senate`; `fed` is kept when the signal also
 *     mentions `rate`/`inflation`).
 *
 * The signal's own connector-tagged `domain` field is intentionally not
 * used to qualify a weak keyword: that field is itself derived from the
 * same fuzzy keyword scan upstream, so trusting it would re-introduce the
 * exact noise we are trying to suppress (a "Trump golf" headline is
 * tagged policy and would self-validate).
 */
function qualifyWeakHits(
  sharedKeywords: string[],
  signalHits: ReadonlySet<string>,
): string[] {
  return sharedKeywords.filter((k) => {
    if (!WEAK_KEYWORDS.has(k)) return true;
    const kwDomain = KEYWORD_DOMAINS.get(k);
    if (!kwDomain) return false;
    for (const other of signalHits) {
      if (other === k) continue;
      if (KEYWORD_DOMAINS.get(other) === kwDomain) return true;
    }
    return false;
  });
}

/**
 * Find ambient signals relevant to a given market. A signal is considered
 * relevant when it shares at least one *qualified* topic keyword with the
 * market's question. A keyword is qualified when it is either domain-
 * specific on its own, or it is weak/generic but co-occurs with another
 * domain-aligned keyword in the signal text (see `qualifyWeakHits`).
 *
 * Headlines that hit only a single weak keyword (a Federer story matching
 * "fed", a Trump golf-tournament story matching "trump", a basketball
 * recap matching "court") are dropped here, which is the whole point of
 * this filter — they were the dominant source of noise nudging modelProb
 * away from marketProb on unrelated markets.
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

    // Shared topic keywords between question and signal text, then drop any
    // weak hits that aren't backed up by a domain co-occurrence.
    const rawShared = [...signalHits].filter((k) => questionHits.has(k));
    const sharedKeywords = qualifyWeakHits(rawShared, signalHits);
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
      // Either no keyword overlap at all, or every overlap was a weak
      // keyword that failed disambiguation. Domain-only matches are also
      // intentionally ignored — they generate too many spurious links
      // (e.g. every macro headline tilting every macro market).
      continue;
    }

    matched.push({
      signal,
      matchScore,
      matchReason,
      sharedKeywords: sharedKeywords.slice(0, 3),
    });
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
 * ambient layer is capped per-domain via `getAmbientShiftCap(domain)` —
 * see `signalCapTuning.ts` for how those numbers are derived (empirical
 * p90 of |Δ marketProb| from `signal_events × opportunity_score_snapshots`
 * inside a short post-signal window, with a hand-tuned default per domain
 * when sample size is too small to trust). Callers may still pass an
 * explicit `maxShift` to override; if neither is provided we fall back to
 * the historical global cap so behaviour does not regress.
 */
export function applyMatchedSignals(args: {
  marketProb: number;
  marketSignals: ConnectorSignal[];
  matched: MatchedSignal[];
  domain?: string;
  maxShift?: number;
}): { modelProb: number; ambientShift: number; cap: number } {
  const { marketProb, marketSignals, matched } = args;
  const cap =
    args.maxShift ??
    (args.domain ? getAmbientShiftCap(args.domain) : MAX_AMBIENT_SHIFT);

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
    return { modelProb: baselineProb, ambientShift: 0, cap };
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

  return { modelProb, ambientShift: cappedShift, cap };
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
  /**
   * The cap that was actually used for this market — comes from
   * `applyMatchedSignals`'s return so the rationale shows the per-domain
   * number rather than the global default.
   */
  cap?: number;
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
  const cap = args.cap ?? MAX_AMBIENT_SHIFT;
  const inferred = [
    `${args.matched.length} ambient signal(s) shifted modelProb ${direction} ${ptsAbs.toFixed(1)} pts (capped at ${(cap * 100).toFixed(0)}); marketProb ${(args.marketProb * 100).toFixed(1)}%, modelProb ${(args.modelProb * 100).toFixed(1)}%.`,
  ];
  return { observed, inferred };
}
