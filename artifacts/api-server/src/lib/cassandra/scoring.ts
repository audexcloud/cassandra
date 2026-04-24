/**
 * Cassandra scoring primitives.
 *
 * All probabilities are in [0, 1]. All Kelly fractions are bankroll-fractions
 * in [0, 1]. The system is deliberately conservative: edge is computed
 * conventionally, then the suggested Kelly fraction is capped by both a
 * confidence multiplier and a hard ceiling.
 */

export type Direction = "yes" | "no";

export interface RawSignal {
  /** Bullish (+) or bearish (-) impact on the YES outcome, in [-1, 1]. */
  sentiment: number;
  /** Magnitude of the move/news, in [0, 1]. */
  impact: number;
  /** Source-specific reliability weight, in [0, 1]. */
  weight?: number;
}

export interface EdgeInputs {
  marketProb: number;
  modelProb: number;
  confidence: number;
  liquidity: number;
}

export const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, n));

export const clamp01 = (n: number): number => clamp(n, 0, 1);

/**
 * Combine raw signals into a model probability adjustment, around the market
 * probability. We treat the market as the prior and use signals as a
 * weighted nudge in log-odds space, so the result stays in (0, 1).
 */
export function aggregateModelProb(
  marketProb: number,
  signals: RawSignal[],
): number {
  const prior = clamp(marketProb, 0.001, 0.999);
  const logitPrior = Math.log(prior / (1 - prior));

  let nudge = 0;
  for (const s of signals) {
    const w = clamp01(s.weight ?? 0.5);
    const impact = clamp01(s.impact);
    const sentiment = clamp(s.sentiment, -1, 1);
    // Each signal contributes up to ~1.0 logit in either direction.
    nudge += w * impact * sentiment;
  }

  const logitPosterior = logitPrior + nudge;
  const prob = 1 / (1 + Math.exp(-logitPosterior));
  return clamp(prob, 0.001, 0.999);
}

/**
 * Composite edge score in [0, 1]:
 *   |modelProb - marketProb| × confidence × liquidityFactor
 * Liquidity factor is a soft saturation: $0 -> 0, $5k -> ~0.5, $100k -> ~0.95.
 */
export function edgeScore(inputs: EdgeInputs): number {
  const rawEdge = Math.abs(inputs.modelProb - inputs.marketProb);
  const conf = clamp01(inputs.confidence);
  const liq = clamp01(1 - Math.exp(-Math.max(0, inputs.liquidity) / 20000));
  return clamp01(rawEdge * conf * liq);
}

export function suggestedDirection(inputs: EdgeInputs): Direction {
  return inputs.modelProb >= inputs.marketProb ? "yes" : "no";
}

/**
 * Kelly fraction for a binary outcome priced at p (market) when our true
 * probability is q (model). Returns the bankroll fraction to allocate, in
 * [0, 1]. Always reduced by confidence and capped by `maxKellyFraction`.
 */
export function kellyFraction(
  inputs: EdgeInputs,
  maxKellyFraction: number,
): number {
  const p = clamp(inputs.marketProb, 0.001, 0.999);
  const q = clamp(inputs.modelProb, 0.001, 0.999);
  const dir = suggestedDirection(inputs);
  // For YES at price p, payout per $1 is 1/p, so b = (1-p)/p, and the Kelly
  // fraction is q*b - (1-q) divided by b. Equivalently:
  const f = dir === "yes" ? (q - p) / (1 - p) : (p - q) / p;
  const conf = clamp01(inputs.confidence);
  return clamp(f * conf, 0, clamp01(maxKellyFraction));
}

/**
 * Convert a YES market probability into the side-appropriate price.
 * - "yes" position: priced at marketProb (pay p, win 1 if YES)
 * - "no"  position: priced at 1 - marketProb (pay 1-p, win 1 if NO)
 */
export function priceForSide(direction: Direction, marketProb: number): number {
  return direction === "yes" ? clamp(marketProb, 0.001, 0.999) : clamp(1 - marketProb, 0.001, 0.999);
}

/**
 * Settle a paper position. `entryProb` and `exitProb` are the side-appropriate
 * prices (NOT the YES probability). `shares = sizeUsd / entryProb` and each
 * share pays $1 if the side resolves true. PnL is shares * (exit - entry)
 * regardless of side, because price is already side-appropriate.
 */
export function paperPnl(args: {
  direction: Direction;
  sizeUsd: number;
  entryProb: number;
  exitProb: number;
}): number {
  const { sizeUsd, entryProb, exitProb } = args;
  const entry = clamp(entryProb, 0.001, 0.999);
  const exit = clamp(exitProb, 0.001, 0.999);
  const shares = sizeUsd / entry;
  return shares * (exit - entry);
}

/**
 * Structured risk gate. Returns the full set of reasons a trade would be
 * blocked, so callers can surface a "why not trade?" explanation rather than
 * a single opaque error string. An empty `reasons` array means the trade is
 * permitted.
 */
export interface RiskGateInputs {
  sizeUsd: number;
  opportunity: {
    confidence: number;
    liquidity: number;
    edgeScore: number;
    spread?: number;
  };
  config: {
    killSwitchEngaged: boolean;
    liveExecutionEnabled: boolean;
    watchOnlyMode?: boolean;
    maxPositionUsd: number;
    minConfidence?: number;
    minLiquidityUsd?: number;
    minEdgeScore?: number;
    maxSpread?: number;
  };
}

export interface RiskGateReason {
  code:
    | "kill_switch_engaged"
    | "live_execution_blocked"
    | "watch_only_mode"
    | "size_exceeds_max_position"
    | "confidence_below_floor"
    | "liquidity_below_floor"
    | "edge_below_floor"
    | "spread_above_ceiling";
  message: string;
}

export interface RiskGateResult {
  allowed: boolean;
  reasons: RiskGateReason[];
}

export function evaluateRiskGate(input: RiskGateInputs): RiskGateResult {
  const reasons: RiskGateReason[] = [];
  const { sizeUsd, opportunity: opp, config: cfg } = input;

  if (cfg.killSwitchEngaged) {
    reasons.push({
      code: "kill_switch_engaged",
      message: "Kill switch is engaged — all new trades are blocked.",
    });
  }
  if (cfg.liveExecutionEnabled) {
    reasons.push({
      code: "live_execution_blocked",
      message:
        "Live execution is permanently disabled in this build. Refusing to trade.",
    });
  }
  if (cfg.watchOnlyMode) {
    reasons.push({
      code: "watch_only_mode",
      message:
        "Watch-only mode is on — observation only, no new paper trades may be opened.",
    });
  }
  if (sizeUsd > cfg.maxPositionUsd) {
    reasons.push({
      code: "size_exceeds_max_position",
      message: `Size $${sizeUsd.toFixed(2)} exceeds maxPositionUsd $${cfg.maxPositionUsd.toFixed(2)}.`,
    });
  }
  if (typeof cfg.minConfidence === "number" && opp.confidence < cfg.minConfidence) {
    reasons.push({
      code: "confidence_below_floor",
      message: `Opportunity confidence ${opp.confidence.toFixed(2)} is below floor ${cfg.minConfidence.toFixed(2)}.`,
    });
  }
  if (typeof cfg.minLiquidityUsd === "number" && opp.liquidity < cfg.minLiquidityUsd) {
    reasons.push({
      code: "liquidity_below_floor",
      message: `Opportunity liquidity $${opp.liquidity.toFixed(0)} is below floor $${cfg.minLiquidityUsd.toFixed(0)}.`,
    });
  }
  if (typeof cfg.minEdgeScore === "number" && opp.edgeScore < cfg.minEdgeScore) {
    reasons.push({
      code: "edge_below_floor",
      message: `Edge score ${opp.edgeScore.toFixed(3)} is below floor ${cfg.minEdgeScore.toFixed(3)}.`,
    });
  }
  if (
    typeof cfg.maxSpread === "number" &&
    typeof opp.spread === "number" &&
    opp.spread > cfg.maxSpread
  ) {
    reasons.push({
      code: "spread_above_ceiling",
      message: `Market spread ${opp.spread.toFixed(3)} is above ceiling ${cfg.maxSpread.toFixed(3)}.`,
    });
  }

  return { allowed: reasons.length === 0, reasons };
}

/**
 * Weighted random selection by edgeScore. Opportunities with higher edge are
 * proportionally more likely to be returned. Falls back to uniform if every
 * weight is zero. Returns `null` for an empty input.
 */
export function weightedRandomPick<T extends { edgeScore: number }>(
  items: T[],
  rng: () => number = Math.random,
): T | null {
  if (items.length === 0) return null;
  const total = items.reduce((s, x) => s + Math.max(0, x.edgeScore), 0);
  if (total <= 0) {
    return items[Math.floor(rng() * items.length)];
  }
  let r = rng() * total;
  for (const it of items) {
    r -= Math.max(0, it.edgeScore);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

// ---------- Calibration / backtesting ----------

/**
 * A single resolved prediction: `predicted` is the forecasted probability
 * the binary outcome occurs in (0, 1), `realized` is 1 if the outcome
 * happened and 0 otherwise.
 */
export interface CalibrationDatum {
  predicted: number;
  realized: 0 | 1;
}

export interface CalibrationBucket {
  low: number;
  high: number;
  predictedAvg: number;
  realizedRate: number;
  count: number;
}

/**
 * Brier score: mean squared error between predicted probability and
 * realized outcome. Lower is better; 0 is perfect, 0.25 is the Brier
 * score of "always predict 0.5".
 */
export function brierScore(items: CalibrationDatum[]): number {
  if (items.length === 0) return 0;
  let sum = 0;
  for (const it of items) {
    const p = clamp01(it.predicted);
    const o = it.realized;
    sum += (p - o) * (p - o);
  }
  return sum / items.length;
}

/**
 * Log loss (cross-entropy). Lower is better; predictions are clamped into
 * (eps, 1-eps) to avoid -Infinity on overconfident misses.
 */
export function logLoss(items: CalibrationDatum[], eps = 1e-6): number {
  if (items.length === 0) return 0;
  let sum = 0;
  for (const it of items) {
    const p = clamp(it.predicted, eps, 1 - eps);
    const o = it.realized;
    sum += -(o * Math.log(p) + (1 - o) * Math.log(1 - p));
  }
  return sum / items.length;
}

/**
 * Bucketise items into N equal-width probability buckets across [0, 1].
 * Each bucket reports the mean predicted probability of items inside it,
 * the empirical realized rate, and the count. A perfectly calibrated
 * forecaster has `realizedRate ≈ predictedAvg` for every populated bucket.
 */
export function bucketize(
  items: CalibrationDatum[],
  numBuckets = 10,
): CalibrationBucket[] {
  const n = Math.max(1, Math.floor(numBuckets));
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < n; i++) {
    buckets.push({
      low: i / n,
      high: (i + 1) / n,
      predictedAvg: 0,
      realizedRate: 0,
      count: 0,
    });
  }
  // Running sums per bucket so we can compute means at the end.
  const sums = buckets.map(() => ({ predicted: 0, realized: 0 }));
  for (const it of items) {
    const p = clamp01(it.predicted);
    // The top of the range falls into the last bucket, not a phantom n+1.
    const idx = Math.min(n - 1, Math.floor(p * n));
    sums[idx].predicted += p;
    sums[idx].realized += it.realized;
    buckets[idx].count++;
  }
  for (let i = 0; i < n; i++) {
    if (buckets[i].count > 0) {
      buckets[i].predictedAvg = sums[i].predicted / buckets[i].count;
      buckets[i].realizedRate = sums[i].realized / buckets[i].count;
    } else {
      // Use the bucket's midpoint so an empty bucket doesn't fake a perfect 0.
      buckets[i].predictedAvg = (buckets[i].low + buckets[i].high) / 2;
      buckets[i].realizedRate = 0;
    }
  }
  return buckets;
}

/**
 * Realised hit rate per confidence bucket: for each bucket, the fraction of
 * predictions whose realised outcome agreed with the side they were
 * pricing in (predicted >= 0.5 → expected YES, else expected NO).
 */
export function hitRateByConfidenceBucket(
  items: CalibrationDatum[],
  numBuckets = 10,
): Array<{ low: number; high: number; hitRate: number; count: number }> {
  const n = Math.max(1, Math.floor(numBuckets));
  // Bucket by *confidence* (= |2p - 1|) rather than by raw probability,
  // so 0.05 and 0.95 are both "very confident" and 0.5 is "no edge".
  const out = Array.from({ length: n }, (_, i) => ({
    low: i / n,
    high: (i + 1) / n,
    hits: 0,
    total: 0,
  }));
  for (const it of items) {
    const p = clamp01(it.predicted);
    const conf = Math.abs(2 * p - 1);
    const idx = Math.min(n - 1, Math.floor(conf * n));
    const expected = p >= 0.5 ? 1 : 0;
    if (expected === it.realized) out[idx].hits++;
    out[idx].total++;
  }
  return out.map((b) => ({
    low: b.low,
    high: b.high,
    count: b.total,
    hitRate: b.total === 0 ? 0 : b.hits / b.total,
  }));
}

/**
 * Categorise a journal entry by its predominant evidence bucket. Used to
 * group calibration metrics by "signal category" — i.e. is this forecast
 * mostly grounded in observed facts, inference, or speculation?
 *
 * Returns one of: "observation_heavy", "inference_heavy",
 * "speculation_heavy", or "uncategorized" (when there is no evidence).
 */
export type SignalCategory =
  | "observation_heavy"
  | "inference_heavy"
  | "speculation_heavy"
  | "uncategorized";

export function signalCategoryFromEvidence(input: {
  observed?: unknown[] | null;
  inferred?: unknown[] | null;
  speculation?: unknown[] | null;
}): SignalCategory {
  const o = input.observed?.length ?? 0;
  const i = input.inferred?.length ?? 0;
  const s = input.speculation?.length ?? 0;
  if (o + i + s === 0) return "uncategorized";
  if (o >= i && o >= s) return "observation_heavy";
  if (i >= o && i >= s) return "inference_heavy";
  return "speculation_heavy";
}

// ---------- /Calibration ----------

/**
 * Map an edge score to a 0-1 confidence we publish. We take a slightly
 * pessimistic transform: low edges look low, high edges saturate.
 */
export function confidenceFromSignals(signals: RawSignal[]): number {
  if (signals.length === 0) return 0.2;
  let weightedImpact = 0;
  let totalWeight = 0;
  for (const s of signals) {
    const w = clamp01(s.weight ?? 0.5);
    weightedImpact += w * clamp01(s.impact);
    totalWeight += w;
  }
  const avg = totalWeight === 0 ? 0 : weightedImpact / totalWeight;
  // Diminishing returns above ~0.7
  return clamp01(0.2 + 0.7 * (1 - Math.exp(-2 * avg)));
}
