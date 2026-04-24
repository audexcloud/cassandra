/**
 * Empirical tuning of the per-domain ambient-signal shift caps.
 *
 * The matching layer (`signalMatching.ts`) lets ambient signals (COMEX
 * price moves, news headlines) push a market's `modelProb` away from
 * `marketProb`. That push has to be capped, otherwise a noisy news cycle
 * can drag a published prediction many points away from the underlying
 * market consensus on the strength of a fuzzy keyword match.
 *
 * The previous implementation used a single global cap of ±15 points
 * (`MAX_AMBIENT_SHIFT`). That number was a defensible default, but
 * unvalidated: it was a guess about how much ambient news *should* be
 * allowed to move a prediction-market price. A 15pt cap is too loose for
 * sleepy spot-commodity questions and arguably still too tight for
 * things like "ceasefire by July" where a single headline can
 * legitimately move the market 20 points in a minute.
 *
 * This module replaces that single global cap with per-domain caps,
 * derived empirically from the database by joining each `signal_events`
 * row to the `opportunity_score_snapshots` rows around the time it was
 * observed:
 *
 *   1. For per-market signals (`signal_events.opportunity_id IS NOT
 *      NULL`), pair each event with (a) the most recent snapshot at-or-
 *      before `observed_at` (the baseline) and (b) the earliest snapshot
 *      after `observed_at` within the `WINDOW_MINUTES` lookahead window
 *      (the post-signal mark). The absolute marketProb delta between
 *      those two snapshots is the move the signal *actually* preceded.
 *   2. For ambient signals (`opportunity_id IS NULL`), fan the same
 *      pairing out across every opportunity that the live matching layer
 *      (`matchSignalsToMarket`) would actually have routed the signal to
 *      — i.e. shared topic keyword between the signal text and the
 *      market question. Domain-only attribution is *not* used here, for
 *      the same reason it isn't used at ingest: it generates spurious
 *      correlations (every macro headline tilting every macro market).
 *   3. Group those observations by domain, take the
 *      `TARGET_QUANTILE` (p90) of |Δ marketProb|, round to whole
 *      percentage points, and clamp into [`MIN_TUNED_CAP`,
 *      `MAX_TUNED_CAP`]. That is the empirical "right-sized" cap: the
 *      biggest move we routinely see in this domain after ambient news,
 *      excluding the long tail that's almost always overshoot.
 *   4. Domains with fewer than `MIN_SAMPLES_PER_DOMAIN` observations
 *      fall back to the hand-tuned default for that domain — a p90 over
 *      five samples is noise, not signal.
 *
 * The orchestrator (`openclaw.ts`) refreshes these caps on a schedule
 * (the `tune_ambient_shift_caps` named job) so they track the live data
 * distribution as more cycles complete and more snapshots accumulate.
 *
 * Until the analysis converges, the defaults below reflect domain
 * intuition: noisy political/geopolitical markets get a wider cap than
 * slow-moving spot-commodity questions. They are intentionally *tighter*
 * than the previous global 0.15 for slow domains and *looser* for the
 * jumpy ones.
 */

import {
  db,
  opportunities,
  opportunityScoreSnapshots,
  signalEvents,
} from "@workspace/db";
import { gte } from "drizzle-orm";

import { logger } from "../logger";

import type { ConnectorDomain, ConnectorSignal } from "./connectors";
import { matchSignalsToMarket } from "./signalMatching";

/**
 * Hand-tuned per-domain defaults used until the empirical analysis has
 * enough samples. Numbers are percentage-point fractions in [0, 1].
 *
 * Rationale (pre-data; replaced by the empirical p90 from
 * `analyzeAmbientShiftCaps` once enough snapshots have accumulated):
 *   - prediction_market: 0.10 — already-priced markets, ambient news
 *     should rarely move them double digits.
 *   - metals:            0.08 — spot metals move slowly; even a sharp
 *     COMEX day rarely justifies more than a few points of model shift.
 *   - commodities:       0.12 — oil/gas can spike on OPEC/sanctions
 *     headlines, slightly wider than metals.
 *   - macro:             0.10 — Fed/CPI digestion is gradual in
 *     prediction-market form.
 *   - policy:            0.18 — single bills/rulings legitimately swing
 *     odds materially.
 *   - geopolitics:       0.20 — ceasefire / escalation headlines move
 *     these markets the most of any domain.
 */
export const DEFAULT_AMBIENT_SHIFT_CAPS: Readonly<
  Record<ConnectorDomain, number>
> = Object.freeze({
  prediction_market: 0.1,
  metals: 0.08,
  commodities: 0.12,
  macro: 0.1,
  policy: 0.18,
  geopolitics: 0.2,
});

/**
 * Final fallback used when a domain isn't in `DEFAULT_AMBIENT_SHIFT_CAPS`
 * (e.g. an unrecognised string from upstream). Matches the historical
 * global cap so behaviour does not regress.
 */
export const FALLBACK_AMBIENT_SHIFT = 0.15;

/** Hard floor / ceiling for any tuned cap. */
const MIN_TUNED_CAP = 0.05;
const MAX_TUNED_CAP = 0.3;

/**
 * Minimum signal→outcome samples a domain must have for us to trust the
 * empirical p90. Below this, we keep the hand-tuned default — a p90 over
 * a handful of samples is noise, not signal.
 */
export const MIN_SAMPLES_PER_DOMAIN = 20;

/** Quantile we treat as the "right-sized" cap. */
export const TARGET_QUANTILE = 0.9;

/**
 * How long after a signal was observed we look for a follow-up snapshot
 * to attribute movement to. Long enough to catch a connector cycle (the
 * cadence is ~60s, so a market gets one snapshot per cycle), short
 * enough that we're not crediting a signal for a move that happened
 * hours later.
 */
export const WINDOW_MINUTES = 30;

/**
 * Lookback over `signal_events.observed_at` for the analysis. Beyond
 * this, signals are stale enough that the world has likely moved on and
 * including them just adds noise.
 */
export const LOOKBACK_DAYS = 14;

export interface AmbientCapStat {
  domain: string;
  /** Number of signal→outcome samples that fed the analysis. */
  sampleSize: number;
  /** p90 of |Δ marketProb| post-signal in this domain, in [0, 1]. */
  p90AbsDelta: number | null;
  /** The cap we actually recommend (clamped, defaulted if undersized). */
  recommendedCap: number;
  /**
   * Whether the recommended cap came from the empirical p90
   * (`"empirical"`) or the hand-tuned default (`"default"`).
   */
  source: "empirical" | "default";
}

/** One row of raw signal→outcome data: a signal in `domain` was followed by a |Δ marketProb| of `absDelta`. */
export interface SignalOutcomeObservation {
  domain: string;
  absDelta: number;
}

/**
 * Tuned-cap cache. Populated by `tuneAmbientShiftCaps()`; read by
 * `getAmbientShiftCap()`. Cleared on process restart, which is fine
 * because the orchestrator re-runs the tuning job each cycle.
 */
const tunedCaps = new Map<string, number>();
let lastTunedAt: Date | null = null;

/** Round to nearest percentage point so the published cap is legible. */
function roundToPct(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Linear-interpolated quantile of a numeric array. */
export function quantile(sortedAsc: number[], q: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * clamp(q, 0, 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  const frac = pos - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/**
 * Look up the per-domain cap. Resolution order:
 *   1. Empirical cap (if `tuneAmbientShiftCaps()` has run and produced
 *      one for this domain).
 *   2. Hand-tuned default for the domain.
 *   3. Final global fallback.
 */
export function getAmbientShiftCap(domain: string): number {
  const tuned = tunedCaps.get(domain);
  if (tuned !== undefined) return tuned;
  const defaulted = (DEFAULT_AMBIENT_SHIFT_CAPS as Record<string, number>)[
    domain
  ];
  if (defaulted !== undefined) return defaulted;
  return FALLBACK_AMBIENT_SHIFT;
}

/**
 * Pure helper: given a flat list of `SignalOutcomeObservation` rows,
 * compute the per-domain `AmbientCapStat`. Exposed (and tested) on its
 * own so the aggregation logic is verifiable without a database.
 *
 * Domains in `DEFAULT_AMBIENT_SHIFT_CAPS` are *always* present in the
 * output, even when there are zero observations for them — the caller
 * gets a row showing it fell back to the default rather than the row
 * silently disappearing.
 */
export function computeRecommendedCapsFromObservations(
  observations: SignalOutcomeObservation[],
): AmbientCapStat[] {
  // Bucket observations by domain.
  const byDomain = new Map<string, number[]>();
  for (const obs of observations) {
    if (!Number.isFinite(obs.absDelta)) continue;
    const arr = byDomain.get(obs.domain);
    if (arr) arr.push(Math.abs(obs.absDelta));
    else byDomain.set(obs.domain, [Math.abs(obs.absDelta)]);
  }

  const out: AmbientCapStat[] = [];
  const seen = new Set<string>();

  // Always emit a row for every known default domain.
  for (const domain of Object.keys(DEFAULT_AMBIENT_SHIFT_CAPS)) {
    seen.add(domain);
    const samples = byDomain.get(domain) ?? [];
    out.push(buildStat(domain, samples));
  }
  // Defensive: if a connector starts emitting a new domain string not
  // in the defaults table, surface it too rather than dropping it.
  for (const [domain, samples] of byDomain.entries()) {
    if (seen.has(domain)) continue;
    out.push(buildStat(domain, samples));
  }
  return out;
}

function buildStat(domain: string, samples: number[]): AmbientCapStat {
  const sorted = samples.slice().sort((a, b) => a - b);
  const p90 = quantile(sorted, TARGET_QUANTILE);
  const sampleSize = sorted.length;
  if (p90 !== null && sampleSize >= MIN_SAMPLES_PER_DOMAIN) {
    return {
      domain,
      sampleSize,
      p90AbsDelta: p90,
      recommendedCap: roundToPct(clamp(p90, MIN_TUNED_CAP, MAX_TUNED_CAP)),
      source: "empirical",
    };
  }
  const fallback =
    (DEFAULT_AMBIENT_SHIFT_CAPS as Record<string, number>)[domain] ??
    FALLBACK_AMBIENT_SHIFT;
  return {
    domain,
    sampleSize,
    p90AbsDelta: p90,
    recommendedCap: fallback,
    source: "default",
  };
}

/**
 * One row pulled from `signal_events` for the analysis window. Carries
 * just the fields we need to (a) identify which opportunities the
 * matching layer would have routed it to and (b) look up the
 * surrounding marketProb snapshots.
 */
export interface AnalysisSignal {
  id: number;
  opportunityId: number | null;
  domain: string;
  source: string;
  kind: string;
  title: string;
  body: string;
  impact: number;
  sentiment: number;
  observedAt: Date;
}

/** One opportunity with the fields needed to replay matching against it. */
export interface AnalysisOpportunity {
  id: number;
  domain: string;
  question: string;
}

/** One row from `opportunity_score_snapshots`. */
export interface AnalysisSnapshot {
  opportunityId: number;
  marketProb: number;
  capturedAt: Date;
}

export interface AnalysisInputs {
  signals: AnalysisSignal[];
  opportunities: AnalysisOpportunity[];
  snapshots: AnalysisSnapshot[];
}

/**
 * Convert a `signal_events` row into the `ConnectorSignal` shape that
 * `matchSignalsToMarket` understands, so we can replay the live matching
 * logic against historical data.
 */
function asConnectorSignal(s: AnalysisSignal): ConnectorSignal {
  return {
    domain: s.domain as ConnectorDomain,
    source: s.source,
    kind: s.kind,
    title: s.title,
    body: s.body,
    impact: s.impact,
    sentiment: s.sentiment,
  };
}

/**
 * Look up the marketProb of the most recent snapshot at-or-before
 * `observedAt`, and the earliest snapshot strictly after `observedAt`
 * within the lookahead window. Returns the absolute delta, or `null` if
 * either side is missing.
 */
function absDeltaAroundSignal(
  snapshots: AnalysisSnapshot[] | undefined,
  observedAtMs: number,
  windowMs: number,
): number | null {
  if (!snapshots || snapshots.length === 0) return null;
  let before: AnalysisSnapshot | null = null;
  let after: AnalysisSnapshot | null = null;
  // snapshots is assumed pre-sorted ascending by capturedAt; both passes
  // are O(n) which is fine — the per-opp series is short.
  for (const snap of snapshots) {
    const t = snap.capturedAt.getTime();
    if (t <= observedAtMs) {
      before = snap;
    } else if (t <= observedAtMs + windowMs) {
      after = snap;
      break;
    } else {
      break;
    }
  }
  if (!before || !after) return null;
  return Math.abs(after.marketProb - before.marketProb);
}

/**
 * Pure helper: given the raw inputs (signals + opportunities + snapshots
 * pulled from the DB), produce the flat list of signal→outcome
 * observations the cap analysis aggregates over. Replays the exact
 * matching logic the live router uses (`matchSignalsToMarket`) so the
 * observations reflect *matched* signal-to-outcome pairs, not blind
 * domain fanout. Exposed (and tested) on its own so this attribution
 * step is verifiable without a database.
 */
export function buildSignalOutcomeObservations(
  inputs: AnalysisInputs,
  windowMinutes: number = WINDOW_MINUTES,
): SignalOutcomeObservation[] {
  // Index snapshots by opportunity, sorted ascending by capturedAt.
  const snapsByOpp = new Map<number, AnalysisSnapshot[]>();
  for (const snap of inputs.snapshots) {
    const arr = snapsByOpp.get(snap.opportunityId);
    if (arr) arr.push(snap);
    else snapsByOpp.set(snap.opportunityId, [snap]);
  }
  for (const arr of snapsByOpp.values()) {
    arr.sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  }

  // Index opportunities by id (for per-market signals) and by domain
  // (for the ambient fanout).
  const oppById = new Map<number, AnalysisOpportunity>();
  const oppsByDomain = new Map<string, AnalysisOpportunity[]>();
  for (const opp of inputs.opportunities) {
    oppById.set(opp.id, opp);
    const arr = oppsByDomain.get(opp.domain);
    if (arr) arr.push(opp);
    else oppsByDomain.set(opp.domain, [opp]);
  }

  const windowMs = windowMinutes * 60_000;
  const observations: SignalOutcomeObservation[] = [];

  for (const sig of inputs.signals) {
    const observedAtMs = sig.observedAt.getTime();

    if (sig.opportunityId !== null) {
      // Per-market signal: attribute directly to that opportunity.
      const opp = oppById.get(sig.opportunityId);
      if (!opp) continue;
      const delta = absDeltaAroundSignal(
        snapsByOpp.get(opp.id),
        observedAtMs,
        windowMs,
      );
      if (delta !== null) {
        observations.push({ domain: opp.domain, absDelta: delta });
      }
      continue;
    }

    // Ambient signal: replay the live matching layer to find which
    // opportunities it would have actually been routed to. Pre-filter
    // by domain because `matchSignalsToMarket` considers domain a
    // prerequisite — opps in other domains can never produce a match.
    const candidateOpps = oppsByDomain.get(sig.domain) ?? [];
    if (candidateOpps.length === 0) continue;
    const connectorSignal = asConnectorSignal(sig);
    for (const opp of candidateOpps) {
      const matched = matchSignalsToMarket(
        { question: opp.question, domain: opp.domain as ConnectorDomain },
        [connectorSignal],
      );
      if (matched.length === 0) continue;
      const delta = absDeltaAroundSignal(
        snapsByOpp.get(opp.id),
        observedAtMs,
        windowMs,
      );
      if (delta !== null) {
        observations.push({ domain: opp.domain, absDelta: delta });
      }
    }
  }

  return observations;
}

/**
 * Run the empirical analysis. Pulls recent `signal_events`, the live
 * `opportunities` table, and `opportunity_score_snapshots` from the
 * lookback window, then replays the matching layer in
 * `buildSignalOutcomeObservations` so each ambient signal only
 * contributes observations against the markets it would actually have
 * been routed to. Per-market signals attribute to their own market.
 */
export async function analyzeAmbientShiftCaps(): Promise<AmbientCapStat[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const [sigRows, oppRows, snapRows] = await Promise.all([
    db
      .select({
        id: signalEvents.id,
        opportunityId: signalEvents.opportunityId,
        domain: signalEvents.domain,
        source: signalEvents.source,
        kind: signalEvents.kind,
        title: signalEvents.title,
        body: signalEvents.body,
        impact: signalEvents.impact,
        sentiment: signalEvents.sentiment,
        observedAt: signalEvents.observedAt,
      })
      .from(signalEvents)
      .where(gte(signalEvents.observedAt, since)),
    db
      .select({
        id: opportunities.id,
        domain: opportunities.domain,
        question: opportunities.question,
      })
      .from(opportunities),
    db
      .select({
        opportunityId: opportunityScoreSnapshots.opportunityId,
        marketProb: opportunityScoreSnapshots.marketProb,
        capturedAt: opportunityScoreSnapshots.capturedAt,
      })
      .from(opportunityScoreSnapshots)
      .where(gte(opportunityScoreSnapshots.capturedAt, since)),
  ]);

  const observations = buildSignalOutcomeObservations({
    signals: sigRows as AnalysisSignal[],
    opportunities: oppRows as AnalysisOpportunity[],
    snapshots: snapRows as AnalysisSnapshot[],
  });

  return computeRecommendedCapsFromObservations(observations);
}

/**
 * Commit a set of analysed caps into the in-memory cache so the next
 * `getAmbientShiftCap()` call sees them. Returns the count of caps that
 * were actually overwritten (useful for the job summary).
 */
export function applyTunedCaps(stats: AmbientCapStat[]): number {
  let applied = 0;
  for (const s of stats) {
    tunedCaps.set(s.domain, s.recommendedCap);
    applied++;
  }
  lastTunedAt = new Date();
  return applied;
}

/** Convenience: analyse + apply in one call. */
export async function tuneAmbientShiftCaps(): Promise<{
  stats: AmbientCapStat[];
  applied: number;
  ranAt: Date;
}> {
  const stats = await analyzeAmbientShiftCaps();
  const applied = applyTunedCaps(stats);
  logger.info(
    {
      applied,
      caps: Object.fromEntries(
        stats.map((s) => [
          s.domain,
          { cap: s.recommendedCap, n: s.sampleSize, source: s.source },
        ]),
      ),
    },
    "ambient shift caps tuned",
  );
  return { stats, applied, ranAt: lastTunedAt ?? new Date() };
}

/** Test/debug helper: clear the tuned-cap cache. */
export function _resetTunedCaps(): void {
  tunedCaps.clear();
  lastTunedAt = null;
}

/** Test/debug helper: read the last tuning timestamp. */
export function getLastTunedAt(): Date | null {
  return lastTunedAt;
}
