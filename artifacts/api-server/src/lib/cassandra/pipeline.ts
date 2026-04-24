/**
 * Cassandra scoring + reasoning pipeline. Pure functions composing the named
 * stages from the foundation spec. Each stage is small, deterministic, and
 * unit-testable; the OpenClaw orchestrator calls them in order.
 *
 * Stages:
 *   ingestSignals           normalize external signals into a uniform shape
 *   normalizeSignals        (alias of ingestSignals; kept for spec parity)
 *   deduplicateSignals      collapse near-duplicates by source+kind+title
 *   validateSignalQuality   drop signals missing required fields or out of bounds
 *   detectAnomalies         flag signals whose impact is >2σ above the rolling mean
 *   scorePredictionMarketActivity  domain scorer for prediction-market signals
 *   scoreSocialVelocity     domain scorer for social/narrative signals
 *   scorePolicySignal       domain scorer for policy signals
 *   scoreCommodityFundamentals  domain scorer for commodity fundamentals
 *   scoreMacroFinancialStress  domain scorer for macro stress signals
 *   detectCrossDomainAnomaly   flag signals that fire across multiple domains at once
 *   compareToHistoricalPatterns  match a signal cluster to the closest stored pattern
 *   generateHistoricalParallels  produce a list of plausible historical parallels
 *   calculateOpportunityScore   composite opportunity score in [0, 1]
 *   generateReasoningSummary    structured Observed/Inferred/Speculation/Unknowns
 *   generateTradePlan        direction + size + invalidations
 *   generateCashOutLadder    list of (price, fraction) cash-out levels
 *   generateExitStrategy     plain-text exit strategy
 *   updatePredictionJournal  derive a journal row from a closed trade
 */

import {
  clamp,
  clamp01,
  confidenceFromSignals,
  edgeScore as edgeScoreFn,
  kellyFraction,
  type EdgeInputs,
  type RawSignal,
} from "./scoring";

export interface RawIncomingSignal {
  source?: string;
  kind?: string;
  domain?: string;
  title?: string;
  body?: string;
  impact?: number;
  sentiment?: number;
  weight?: number;
}

export interface NormalizedSignal {
  source: string;
  kind: string;
  domain: string;
  title: string;
  body: string;
  impact: number;
  sentiment: number;
  weight: number;
}

export function ingestSignals(raw: RawIncomingSignal[]): NormalizedSignal[] {
  return raw.map((s) => ({
    source: s.source ?? "unknown",
    kind: s.kind ?? "unknown",
    domain: s.domain ?? "unknown",
    title: s.title ?? "",
    body: s.body ?? "",
    impact: clamp01(typeof s.impact === "number" ? s.impact : 0),
    sentiment: clamp(typeof s.sentiment === "number" ? s.sentiment : 0, -1, 1),
    weight: clamp01(typeof s.weight === "number" ? s.weight : 0.5),
  }));
}

/** Alias kept to match the foundation spec's `normalize_signals` name. */
export const normalizeSignals = ingestSignals;

export function deduplicateSignals(signals: NormalizedSignal[]): NormalizedSignal[] {
  const seen = new Map<string, NormalizedSignal>();
  for (const s of signals) {
    const key = `${s.source}|${s.kind}|${s.title.trim().toLowerCase()}`;
    const prior = seen.get(key);
    if (!prior || s.impact > prior.impact) seen.set(key, s);
  }
  return [...seen.values()];
}

export function validateSignalQuality(signals: NormalizedSignal[]): NormalizedSignal[] {
  return signals.filter(
    (s) =>
      s.source.length > 0 &&
      s.kind.length > 0 &&
      s.domain.length > 0 &&
      s.impact >= 0 &&
      s.impact <= 1 &&
      s.sentiment >= -1 &&
      s.sentiment <= 1,
  );
}

export interface DetectedAnomaly {
  signal: NormalizedSignal;
  zScore: number;
  reason: string;
}

export function detectAnomalies(signals: NormalizedSignal[], stdThreshold = 2): DetectedAnomaly[] {
  if (signals.length < 3) return [];
  const impacts = signals.map((s) => s.impact);
  const mean = impacts.reduce((a, b) => a + b, 0) / impacts.length;
  const variance = impacts.reduce((acc, x) => acc + (x - mean) ** 2, 0) / impacts.length;
  const std = Math.sqrt(variance);
  if (std === 0) return [];
  const out: DetectedAnomaly[] = [];
  for (const s of signals) {
    const z = (s.impact - mean) / std;
    if (Math.abs(z) >= stdThreshold) {
      out.push({
        signal: s,
        zScore: Number(z.toFixed(2)),
        reason: `impact ${s.impact.toFixed(2)} is ${z >= 0 ? "above" : "below"} ${stdThreshold}σ from mean ${mean.toFixed(2)}`,
      });
    }
  }
  return out;
}

const meanWeightedImpact = (signals: NormalizedSignal[]): number => {
  if (signals.length === 0) return 0;
  let num = 0;
  let den = 0;
  for (const s of signals) {
    num += s.weight * s.impact;
    den += s.weight;
  }
  return den === 0 ? 0 : num / den;
};

export function scorePredictionMarketActivity(signals: NormalizedSignal[]): number {
  return meanWeightedImpact(signals.filter((s) => s.domain === "prediction_market" || s.kind.includes("market")));
}

export function scoreSocialVelocity(signals: NormalizedSignal[]): number {
  const social = signals.filter((s) => s.domain === "social" || s.kind.includes("social") || s.kind.includes("narrative"));
  if (social.length === 0) return 0;
  // Velocity = mean impact * sqrt(count). Caps at 1.
  return clamp01(meanWeightedImpact(social) * Math.sqrt(social.length) * 0.5);
}

export function scorePolicySignal(signals: NormalizedSignal[]): number {
  return meanWeightedImpact(signals.filter((s) => s.domain === "policy" || s.kind.includes("policy")));
}

export function scoreCommodityFundamentals(signals: NormalizedSignal[]): number {
  return meanWeightedImpact(
    signals.filter((s) => s.domain === "commodities" || s.domain === "metals" || s.kind.includes("supply")),
  );
}

export function scoreMacroFinancialStress(signals: NormalizedSignal[]): number {
  // Macro stress is mostly negative-sentiment, high-impact data releases.
  const macro = signals.filter((s) => s.domain === "macro");
  if (macro.length === 0) return 0;
  let stress = 0;
  let total = 0;
  for (const s of macro) {
    const w = s.weight;
    stress += w * s.impact * Math.max(0, -s.sentiment + 0.2);
    total += w;
  }
  return clamp01(total === 0 ? 0 : stress / total);
}

export interface CrossDomainAnomaly {
  domains: string[];
  combinedImpact: number;
  reason: string;
}

export function detectCrossDomainAnomaly(signals: NormalizedSignal[]): CrossDomainAnomaly | null {
  const byDomain = new Map<string, NormalizedSignal[]>();
  for (const s of signals) {
    const arr = byDomain.get(s.domain) ?? [];
    arr.push(s);
    byDomain.set(s.domain, arr);
  }
  // Cross-domain anomaly: 3+ domains all show >0.5 mean impact in the same window.
  const hot: string[] = [];
  let combinedImpact = 0;
  for (const [domain, ss] of byDomain.entries()) {
    const m = meanWeightedImpact(ss);
    if (m >= 0.5) {
      hot.push(domain);
      combinedImpact += m;
    }
  }
  if (hot.length < 3) return null;
  return {
    domains: hot,
    combinedImpact: Number(combinedImpact.toFixed(2)),
    reason: `Elevated impact concurrently in ${hot.join(", ")}`,
  };
}

export interface HistoricalPattern {
  id: string | number;
  label: string;
  fingerprint: Record<string, number>;
  baseRate: number;
}

export interface PatternMatch {
  pattern: HistoricalPattern;
  similarity: number;
}

const cosine = (a: Record<string, number>, b: Record<string, number>): number => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of keys) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

export function compareToHistoricalPatterns(
  fingerprint: Record<string, number>,
  patterns: HistoricalPattern[],
): PatternMatch[] {
  return patterns
    .map((p) => ({ pattern: p, similarity: Number(cosine(fingerprint, p.fingerprint).toFixed(3)) }))
    .sort((a, b) => b.similarity - a.similarity);
}

export interface HistoricalParallel {
  label: string;
  summary: string;
  outcome: string;
  similarity: number;
}

export function generateHistoricalParallels(
  matches: PatternMatch[],
  topN = 3,
  minSimilarity = 0.3,
): HistoricalParallel[] {
  return matches
    .filter((m) => m.similarity >= minSimilarity)
    .slice(0, topN)
    .map((m) => ({
      label: m.pattern.label,
      summary: `Closest pattern: "${m.pattern.label}" (similarity ${m.similarity.toFixed(2)}).`,
      outcome: `Historical base rate ${(m.pattern.baseRate * 100).toFixed(0)}%.`,
      similarity: m.similarity,
    }));
}

export function calculateOpportunityScore(inputs: EdgeInputs & { historicalSimilarity?: number }): number {
  const base = edgeScoreFn(inputs);
  const histBoost = clamp01(inputs.historicalSimilarity ?? 0) * 0.1;
  return clamp01(base + histBoost * (1 - base));
}

export interface ReasoningSummary {
  observed: string[];
  inferred: string[];
  speculation: string[];
  unknowns: string[];
  riskFlags: string[];
  /**
   * Ambient signals that were routed to this opportunity by the matching
   * layer and contributed to `modelProb`. Persisted alongside the prose
   * rationale so the dashboard can render a structured "What moved this
   * prediction" panel without re-parsing rationale strings. Optional —
   * absent on legacy rows produced before the matching layer was added,
   * and on opportunities for which no ambient signal was matched.
   */
  appliedSignals?: import("./signalMatching").AppliedSignalSummary[];
  /**
   * Signed shift in `modelProb` (probability units) contributed by
   * `appliedSignals` in the most recent ingest cycle. 0 / absent when no
   * ambient signals were matched.
   */
  ambientShift?: number;
}

export function generateReasoningSummary(
  rationale: ReasoningSummary,
  signals: NormalizedSignal[],
  parallels: HistoricalParallel[],
): ReasoningSummary {
  // Compose: keep the seeded rationale, append high-impact signals to observed,
  // append parallels to inferred, surface low-weight items as unknowns.
  const topSignals = [...signals]
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 3)
    .map((s) => `${s.title} (impact ${s.impact.toFixed(2)})`);
  return {
    observed: [...rationale.observed, ...topSignals],
    inferred: [
      ...rationale.inferred,
      ...parallels.map((p) => `Resembles "${p.label}" — ${p.outcome}`),
    ],
    speculation: rationale.speculation,
    unknowns: rationale.unknowns,
    riskFlags: rationale.riskFlags,
  };
}

export interface TradePlan {
  direction: "yes" | "no";
  sizeUsd: number;
  entryZone: { low: number; high: number };
  cashOutLadder: Array<{ price: number; fraction: number }>;
  exitStrategy: string;
  invalidations: string[];
}

export function generateCashOutLadder(
  entryProb: number,
  direction: "yes" | "no",
  steps = 3,
): Array<{ price: number; fraction: number }> {
  // The ladder represents the *side price* the trader expects to scale out
  // at. For YES, the side price climbs toward 1 as the market converges to
  // the thesis. For NO, the *yes-leg market price* falls toward 0; we
  // express the ladder in side-price terms, so for the NO branch we step
  // entryProb down toward 0.01. Each rung scales out an even fraction.
  const fraction = Number((1 / (steps + 1)).toFixed(2));
  const ladder: Array<{ price: number; fraction: number }> = [];
  for (let i = 1; i <= steps; i++) {
    const target =
      direction === "yes"
        ? clamp(entryProb + (i * (1 - entryProb)) / (steps + 1), 0.01, 0.99)
        : clamp(entryProb - (i * entryProb) / (steps + 1), 0.01, 0.99);
    ladder.push({ price: Number(target.toFixed(3)), fraction });
  }
  return ladder;
}

export function generateExitStrategy(plan: { direction: "yes" | "no"; entryZone: { low: number; high: number } }): string {
  if (plan.direction === "yes") {
    return `Cut on a clean break below ${(plan.entryZone.low * 100).toFixed(0)}% market probability or if any invalidation fires; otherwise scale out per the cash-out ladder.`;
  }
  return `Cut on a sustained move above ${(plan.entryZone.high * 100).toFixed(0)}% market probability or if any invalidation fires; otherwise scale out per the cash-out ladder.`;
}

export function generateTradePlan(args: {
  inputs: EdgeInputs;
  bankrollUsd: number;
  maxKellyFraction: number;
  maxPositionUsd: number;
  invalidations: string[];
}): TradePlan {
  const direction: "yes" | "no" = args.inputs.modelProb >= args.inputs.marketProb ? "yes" : "no";
  const k = kellyFraction(args.inputs, args.maxKellyFraction);
  const sizeUsd = Math.min(args.maxPositionUsd, Math.round(k * args.bankrollUsd));
  const sidePrice = direction === "yes" ? args.inputs.marketProb : 1 - args.inputs.marketProb;
  const entryZone = {
    low: Number(Math.max(0.01, sidePrice - 0.03).toFixed(3)),
    high: Number(Math.min(0.99, sidePrice + 0.03).toFixed(3)),
  };
  const ladder = generateCashOutLadder(sidePrice, direction);
  const exitStrategy = generateExitStrategy({ direction, entryZone });
  return {
    direction,
    sizeUsd,
    entryZone,
    cashOutLadder: ladder,
    exitStrategy,
    invalidations: args.invalidations,
  };
}

export interface JournalEntry {
  paperTradeId: number;
  realizedPnlUsd: number;
  whatWasRight: string;
  whatWasWrong: string;
}

export function updatePredictionJournal(args: {
  paperTradeId: number;
  realizedPnlUsd: number;
  rationale: ReasoningSummary;
  signals: NormalizedSignal[];
}): JournalEntry {
  const positive = args.realizedPnlUsd > 0;
  const drivers = args.signals
    .filter((s) => (positive ? s.sentiment > 0 : s.sentiment < 0))
    .slice(0, 2)
    .map((s) => s.title);
  const counter = args.signals
    .filter((s) => (positive ? s.sentiment < 0 : s.sentiment > 0))
    .slice(0, 2)
    .map((s) => s.title);
  return {
    paperTradeId: args.paperTradeId,
    realizedPnlUsd: args.realizedPnlUsd,
    whatWasRight: positive
      ? `Thesis paid off. Drivers: ${drivers.join("; ") || "no specific signal stood out"}.`
      : `Thesis didn't pay off, but ${drivers.join("; ") || "no upside drivers materialised"}.`,
    whatWasWrong: positive
      ? `Counter-signals to watch next time: ${counter.join("; ") || "none surfaced"}.`
      : `What broke the thesis: ${counter.join("; ") || "thesis simply didn't materialise"}. Risk flags: ${args.rationale.riskFlags.join("; ") || "none recorded"}.`,
  };
}

// Re-export RawSignal so tests can import everything from one place.
export type { RawSignal };
