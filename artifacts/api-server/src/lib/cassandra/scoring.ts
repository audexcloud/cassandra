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
