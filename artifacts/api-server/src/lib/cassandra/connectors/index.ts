/**
 * Real upstream connectors. Each one calls a public API, normalizes the
 * payload to our internal `ConnectorMarket` / `ConnectorSignal` shape, and
 * exposes the same `Connector` interface the OpenClaw orchestrator already
 * consumed when this code base was running on six mock connectors.
 *
 * The contract for the rest of the system (`Connector`, `ConnectorResult`,
 * the `connectors` array) is unchanged — only the implementations are real
 * now.
 */

import { aggregateModelProb, type RawSignal } from "../scoring";
import { createManifoldConnector } from "./manifold";
import { createPolymarketConnector } from "./polymarket";
import { createKalshiConnector } from "./kalshi";
import { createMetaculusConnector } from "./metaculus";
import { createComexConnector } from "./comex";
import { createNewsWiresConnector } from "./newsWires";

export type ConnectorDomain =
  | "prediction_market"
  | "geopolitics"
  | "policy"
  | "commodities"
  | "metals"
  | "macro";

export interface ConnectorMarket {
  marketKey: string;
  source: string;
  domain: ConnectorDomain;
  question: string;
  marketProb: number;
  modelProb: number;
  confidence: number;
  liquidity: number;
  /** Quoted bid/ask spread on the underlying market (0–1). */
  spread: number;
  url?: string;
  rationale: {
    observed: string[];
    inferred: string[];
    speculation: string[];
    unknowns: string[];
    riskFlags: string[];
  };
  signals: ConnectorSignal[];
}

export interface ConnectorSignal {
  domain: ConnectorDomain;
  source: string;
  kind: string;
  title: string;
  body: string;
  impact: number;
  sentiment: number;
  weight?: number;
}

export interface ConnectorResult {
  name: string;
  status: "ok" | "degraded" | "error";
  fetchedAt: Date;
  markets: ConnectorMarket[];
  /** Signals that are not tied to a specific market (broader feed). */
  ambientSignals: ConnectorSignal[];
  note?: string;
}

export interface RawFetchResult {
  source: string;
  rawMarkets: ConnectorMarket[];
  rawAmbient: ConnectorSignal[];
  fetchedAt: Date;
  status?: "ok" | "degraded";
  note?: string;
}

export interface ConnectorHealth {
  status: "ok" | "degraded" | "error" | "idle";
  lastSuccessfulRun: Date | null;
  message?: string;
}

export interface Connector {
  name: string;
  domain: ConnectorDomain | "mixed";
  /**
   * Whether this connector is using mock data. All real connectors set this
   * to `false`; the OpenClaw command center surfaces this so the operator
   * can tell at a glance which signals are live.
   */
  mockDataMode: boolean;
  /** Last time `fetch()` returned ok. Updated by the orchestrator. */
  lastSuccessfulRun: Date | null;
  /** Pull raw data from the upstream API. */
  fetch(): Promise<RawFetchResult>;
  /** Shape raw data into the internal `ConnectorMarket` / `ConnectorSignal` shape. */
  normalize(raw: RawFetchResult): ConnectorResult;
  /** Quick liveness probe used by the OpenClaw command center. */
  healthCheck(): Promise<ConnectorHealth>;
  /**
   * Convenience that runs fetch -> normalize -> updates `lastSuccessfulRun`.
   * The orchestrator typically calls this; tests can call fetch/normalize
   * separately to verify each step.
   */
  run(): Promise<ConnectorResult>;
}

/**
 * Helpers that real connectors share. A connector hands back already-shaped
 * markets + ambient signals; the builder applies signal-aware modelProb so
 * downstream scoring math behaves the same way it did on the mocks.
 */
export interface ConnectorImpl {
  name: string;
  source: string;
  domain: ConnectorDomain | "mixed";
  /**
   * Pull raw data from the upstream and shape it into our internal types.
   * Throw to signal a hard error (the orchestrator will surface "error"); to
   * surface a soft error keep returning markets but set `status: "degraded"`
   * with a `note`.
   */
  fetchRaw(): Promise<{
    markets: ConnectorMarket[];
    ambient: ConnectorSignal[];
    status?: "ok" | "degraded";
    note?: string;
  }>;
  /** Optional cheap probe; defaults to mirroring `lastSuccessfulRun`. */
  probe?(): Promise<ConnectorHealth>;
}

export function makeConnector(impl: ConnectorImpl): Connector {
  let lastSuccessfulRun: Date | null = null;
  let lastNote: string | undefined;
  let lastStatus: ConnectorHealth["status"] = "idle";

  const c: Connector = {
    name: impl.name,
    domain: impl.domain,
    mockDataMode: false,
    get lastSuccessfulRun(): Date | null {
      return lastSuccessfulRun;
    },
    set lastSuccessfulRun(v: Date | null) {
      lastSuccessfulRun = v;
    },
    async fetch(): Promise<RawFetchResult> {
      const raw = await impl.fetchRaw();
      return {
        source: impl.source,
        rawMarkets: raw.markets,
        rawAmbient: raw.ambient,
        fetchedAt: new Date(),
        status: raw.status ?? "ok",
        note: raw.note,
      };
    },
    normalize(raw: RawFetchResult): ConnectorResult {
      // For real connectors we shape upstream data inside fetchRaw, so
      // normalize is mostly a pass-through that recomputes modelProb from
      // any signals attached to a market (so the downstream pipeline keeps
      // working the same way it did on the mocks).
      const markets: ConnectorMarket[] = raw.rawMarkets.map((m) => {
        const modelProb =
          m.signals.length > 0
            ? aggregateModelProb(m.marketProb, m.signals as RawSignal[])
            : m.marketProb;
        return { ...m, modelProb };
      });
      return {
        name: impl.name,
        status: raw.status ?? "ok",
        fetchedAt: raw.fetchedAt,
        markets,
        ambientSignals: raw.rawAmbient,
        note: raw.note,
      };
    },
    async healthCheck(): Promise<ConnectorHealth> {
      if (impl.probe) {
        try {
          return await impl.probe();
        } catch (err) {
          return {
            status: "error",
            lastSuccessfulRun,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }
      return {
        status: lastStatus,
        lastSuccessfulRun,
        message: lastNote,
      };
    },
    async run(): Promise<ConnectorResult> {
      const raw = await c.fetch();
      const result = c.normalize(raw);
      lastSuccessfulRun = result.fetchedAt;
      lastStatus = result.status;
      lastNote = result.note;
      return result;
    },
  };
  return c;
}

/* ---------------------------- shared utilities ---------------------------- */

export const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, n));

export const clamp01 = (n: number): number => clamp(n, 0, 1);

/**
 * Confidence baseline derived from upstream "depth" signals (volume, traders,
 * open interest). Real markets don't ship signals on the wire the way our
 * mocks did, so we use exchange depth as a proxy: deeper markets get more
 * baseline confidence, shallower ones less.
 */
export function depthConfidence(opts: {
  liquidityUsd?: number;
  volumeUsd?: number;
  traders?: number;
}): number {
  const liq = Math.max(0, opts.liquidityUsd ?? 0);
  const vol = Math.max(0, opts.volumeUsd ?? 0);
  const traders = Math.max(0, opts.traders ?? 0);
  // Saturating: tiny markets sit near 0.2; mid markets ~0.5; deep markets ~0.85.
  const liqPart = 0.55 * (1 - Math.exp(-liq / 80_000));
  const volPart = 0.25 * (1 - Math.exp(-vol / 50_000));
  const traderPart = 0.15 * (1 - Math.exp(-traders / 250));
  return clamp(0.2 + liqPart + volPart + traderPart, 0.15, 0.95);
}

/**
 * Lightweight keyword-based sentiment for headline ingestion. Returns a
 * value in [-1, 1]; 0 means neutral / mixed signal. Intentionally crude —
 * downstream models can replace this without changing the connector
 * contract.
 */
export function headlineSentiment(text: string): number {
  const t = text.toLowerCase();
  const pos = [
    "ceasefire",
    "deal",
    "agreement",
    "approves",
    "approved",
    "growth",
    "rebound",
    "rally",
    "beats",
    "beat",
    "stronger",
    "easing",
    "cooling",
    "resolves",
    "breakthrough",
    "rises",
    "surge",
    "gains",
    "wins",
    "settle",
    "settled",
    "recovery",
  ];
  const neg = [
    "war",
    "attack",
    "attacks",
    "strike",
    "strikes",
    "killed",
    "dead",
    "deaths",
    "crisis",
    "collapse",
    "plunge",
    "falls",
    "fall",
    "drop",
    "drops",
    "decline",
    "miss",
    "missed",
    "warning",
    "sanctions",
    "tariff",
    "tariffs",
    "fired",
    "shutdown",
    "default",
    "downgrade",
    "recession",
    "tensions",
    "loss",
    "losses",
    "warn",
    "explosion",
    "outbreak",
  ];
  let score = 0;
  for (const w of pos) if (t.includes(w)) score += 1;
  for (const w of neg) if (t.includes(w)) score -= 1;
  if (score === 0) return 0;
  // Compress to [-1, 1] with diminishing returns past 3 keyword hits.
  return clamp(Math.tanh(score / 2), -1, 1);
}

/**
 * Build a list of 5-bucket rationale lines from raw upstream metadata. Each
 * connector calls this so every real market has the same five-section
 * structure the dashboard expects.
 */
export function buildRationale(opts: {
  observed: string[];
  inferred: string[];
  speculation?: string[];
  unknowns?: string[];
  riskFlags?: string[];
}): ConnectorMarket["rationale"] {
  return {
    observed: opts.observed,
    inferred: opts.inferred,
    speculation: opts.speculation ?? [
      "Pricing reflects the consensus of current participants — new information could move it materially.",
    ],
    unknowns: opts.unknowns ?? [
      "Resolution-criteria edge cases not yet stress-tested",
      "Upstream data freshness depends on the exchange's own latency",
    ],
    riskFlags: opts.riskFlags ?? [],
  };
}

/* ----------------------------- assembled list ----------------------------- */

export const connectors: Connector[] = [
  makeConnector(createManifoldConnector()),
  makeConnector(createPolymarketConnector()),
  makeConnector(createKalshiConnector()),
  makeConnector(createMetaculusConnector()),
  makeConnector(createComexConnector()),
  makeConnector(createNewsWiresConnector()),
];
