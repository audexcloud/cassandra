/**
 * Mock connectors. In this build we never call real upstreams. Each connector
 * returns a deterministic-but-noisy slate of markets/signals around the
 * current time so the dashboard always has fresh data without needing
 * credentials. Real connector swaps live in follow-up tasks.
 */

import { aggregateModelProb, confidenceFromSignals, type RawSignal } from "./scoring";

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

interface MarketSeed {
  marketKey: string;
  domain: ConnectorDomain;
  question: string;
  baseMarketProb: number;
  baseConfidence: number;
  liquidity: number;
  url?: string;
  observed: string[];
  inferred: string[];
  speculation: string[];
  unknowns: string[];
  riskFlags: string[];
  signals: ConnectorSignal[];
}

const noise = (seed: string, range = 0.04): number => {
  let h = 2166136261;
  const key = seed + Math.floor(Date.now() / 60_000);
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = ((h >>> 0) % 10_000) / 10_000;
  return (u - 0.5) * 2 * range;
};

const buildMarket = (
  source: string,
  seed: MarketSeed,
): ConnectorMarket => {
  const drift = noise(`${source}:${seed.marketKey}`);
  const marketProb = Math.min(0.99, Math.max(0.01, seed.baseMarketProb + drift));
  const signals = seed.signals;
  const modelProb = aggregateModelProb(marketProb, signals as RawSignal[]);
  const confidence = Math.min(
    0.95,
    Math.max(0.1, seed.baseConfidence + noise(`conf:${seed.marketKey}`, 0.05)),
  );
  return {
    marketKey: seed.marketKey,
    source,
    domain: seed.domain,
    question: seed.question,
    marketProb,
    modelProb,
    confidence,
    liquidity: seed.liquidity,
    url: seed.url,
    rationale: {
      observed: seed.observed,
      inferred: seed.inferred,
      speculation: seed.speculation,
      unknowns: seed.unknowns,
      riskFlags: seed.riskFlags,
    },
    signals,
  };
};

const MANIFOLD_SEEDS: MarketSeed[] = [
  {
    marketKey: "manifold-fed-cuts-2026q3",
    domain: "macro",
    question: "Will the Federal Reserve cut rates by at least 25bp in Q3 2026?",
    baseMarketProb: 0.42,
    baseConfidence: 0.55,
    liquidity: 18_000,
    url: "https://manifold.markets/example/fed-cuts",
    observed: [
      "CPI year-over-year printed below consensus for the second straight month",
      "Atlanta Fed GDPNow nowcast revised down 0.4 points this week",
    ],
    inferred: [
      "Front-end Treasury yields are pricing roughly two cuts by year-end",
      "Fed governors are unusually quiet in the blackout window, which historically precedes a dovish pivot",
    ],
    speculation: [
      "If labor data softens further, the FOMC could move at the September meeting",
    ],
    unknowns: [
      "Energy and shelter components could re-accelerate if oil rallies",
      "Any tariff escalation could change the inflation outlook",
    ],
    riskFlags: ["Fed communications can whipsaw fast pricing"],
    signals: [
      {
        domain: "macro",
        source: "fred",
        kind: "data_release",
        title: "CPI YoY 2.7% vs 2.9% expected",
        body: "Headline inflation cooled more than expected; core moderated to 3.1%.",
        impact: 0.6,
        sentiment: 0.55,
        weight: 0.8,
      },
      {
        domain: "macro",
        source: "options_flow",
        kind: "options_skew",
        title: "SOFR futures repricing two cuts by year-end",
        body: "Open interest skewed toward Sep cut strikes.",
        impact: 0.45,
        sentiment: 0.5,
        weight: 0.7,
      },
    ],
  },
  {
    marketKey: "manifold-eu-russia-sanctions-pkg",
    domain: "geopolitics",
    question: "Will the EU adopt a new Russia sanctions package before July 2026?",
    baseMarketProb: 0.61,
    baseConfidence: 0.5,
    liquidity: 9_500,
    observed: [
      "Hungary signaled willingness to abstain rather than veto on energy carve-outs",
      "EU Commission released draft text covering shadow-fleet insurers",
    ],
    inferred: [
      "Member-state alignment is unusually high after recent escalation",
    ],
    speculation: [
      "A summer recess could push final adoption into late Q3 if drafting slips",
    ],
    unknowns: ["Final scope of secondary sanctions on third-country traders"],
    riskFlags: ["Single-state veto risk persists"],
    signals: [
      {
        domain: "geopolitics",
        source: "reuters_mock",
        kind: "news",
        title: "EU drafts shadow-fleet insurance restrictions",
        body: "Officials briefed Reuters on near-final language for the next package.",
        impact: 0.55,
        sentiment: 0.4,
        weight: 0.7,
      },
    ],
  },
  {
    marketKey: "manifold-recession-2026",
    domain: "macro",
    question: "Will the US enter NBER-defined recession in 2026?",
    baseMarketProb: 0.27,
    baseConfidence: 0.4,
    liquidity: 32_000,
    observed: [
      "Unemployment ticked up to 4.3% from 4.1%",
      "Sahm rule indicator triggered last month",
    ],
    inferred: ["Hiring breadth has narrowed to a handful of sectors"],
    speculation: ["Consumer credit stress could compound if rates stay restrictive"],
    unknowns: ["Productivity boost from AI adoption could offset slowdown"],
    riskFlags: [
      "NBER definition is backward-looking; signal can be stale",
    ],
    signals: [
      {
        domain: "macro",
        source: "bls",
        kind: "data_release",
        title: "Unemployment rate ticks to 4.3%",
        body: "Sahm rule triggered.",
        impact: 0.65,
        sentiment: -0.3,
        weight: 0.8,
      },
    ],
  },
];

const POLYMARKET_SEEDS: MarketSeed[] = [
  {
    marketKey: "polymarket-spx-eoy-6500",
    domain: "macro",
    question: "Will the S&P 500 close above 6,500 by end of year?",
    baseMarketProb: 0.38,
    baseConfidence: 0.5,
    liquidity: 220_000,
    observed: ["Q1 EPS beat consensus by 5.4%"],
    inferred: ["Multiple expansion is doing most of the heavy lifting YTD"],
    speculation: ["Fed pivot could push multiples another turn higher"],
    unknowns: ["Election-cycle volatility and concentration risk"],
    riskFlags: ["Top-7 names dominate index returns"],
    signals: [
      {
        domain: "macro",
        source: "earnings",
        kind: "earnings_beat",
        title: "Q1 EPS +5.4% vs consensus",
        body: "Beat breadth strongest among megacap tech.",
        impact: 0.5,
        sentiment: 0.45,
        weight: 0.7,
      },
    ],
  },
  {
    marketKey: "polymarket-china-gdp-5pct",
    domain: "geopolitics",
    question: "Will China's official 2026 GDP print be ≥ 5.0%?",
    baseMarketProb: 0.55,
    baseConfidence: 0.45,
    liquidity: 75_000,
    observed: [
      "PBoC cut RRR by 50bp",
      "Property starts down 11% YoY",
    ],
    inferred: ["Stimulus is being deployed but property drag persists"],
    speculation: ["Official print may exceed underlying activity for political reasons"],
    unknowns: ["Export demand depends on US/EU tariff stance"],
    riskFlags: ["Reported figure may diverge from independent estimates"],
    signals: [
      {
        domain: "geopolitics",
        source: "pboc",
        kind: "policy_release",
        title: "PBoC cuts RRR by 50bp",
        body: "Targeted at small and medium banks.",
        impact: 0.5,
        sentiment: 0.4,
        weight: 0.7,
      },
    ],
  },
];

const KALSHI_SEEDS: MarketSeed[] = [
  {
    marketKey: "kalshi-cpi-jun-3pct",
    domain: "policy",
    question: "Will June CPI YoY come in at or below 3.0%?",
    baseMarketProb: 0.62,
    baseConfidence: 0.55,
    liquidity: 41_000,
    observed: ["May CPI 3.1%", "Wage growth deceleration confirmed"],
    inferred: ["Energy base effects favor a softer June print"],
    speculation: ["A surprise could re-accelerate cut expectations"],
    unknowns: ["Owner-equivalent rent revisions"],
    riskFlags: ["Single data print, high variance"],
    signals: [
      {
        domain: "policy",
        source: "bls",
        kind: "data_release",
        title: "Average hourly earnings growth slowed",
        body: "Slowest year-over-year reading since 2021.",
        impact: 0.5,
        sentiment: 0.45,
        weight: 0.7,
      },
    ],
  },
];

const METACULUS_SEEDS: MarketSeed[] = [
  {
    marketKey: "metaculus-agi-2030",
    domain: "macro",
    question: "Will a recognized AGI system be deployed by 2030?",
    baseMarketProb: 0.32,
    baseConfidence: 0.3,
    liquidity: 6_000,
    observed: ["Frontier model capability benchmarks continue to climb"],
    inferred: ["Compute scaling shows no immediate plateau"],
    speculation: ["Recognition criterion is the binding constraint, not capability"],
    unknowns: ["What 'recognized' means at resolution time"],
    riskFlags: ["Definitional ambiguity"],
    signals: [],
  },
];

const COMEX_SEEDS: MarketSeed[] = [
  {
    marketKey: "comex-gold-2400",
    domain: "metals",
    question: "Will COMEX gold settle above $2,400/oz this Friday?",
    baseMarketProb: 0.58,
    baseConfidence: 0.5,
    liquidity: 130_000,
    observed: [
      "Net long positioning at 2-year highs in CFTC report",
      "Real yields fell 12bp this week",
    ],
    inferred: ["Sticky bid from EM central banks remains intact"],
    speculation: ["A risk-off shock could squeeze shorts further"],
    unknowns: ["DXY direction in next 48h"],
    riskFlags: ["CTA crowding"],
    signals: [
      {
        domain: "metals",
        source: "comex",
        kind: "price_move",
        title: "Gold up 1.8% on the week",
        body: "Largest weekly move in two months.",
        impact: 0.55,
        sentiment: 0.5,
        weight: 0.75,
      },
      {
        domain: "metals",
        source: "cftc",
        kind: "positioning",
        title: "CFTC net long at 2-yr high",
        body: "Speculative longs increased 8% week over week.",
        impact: 0.4,
        sentiment: 0.4,
        weight: 0.7,
      },
    ],
  },
  {
    marketKey: "comex-silver-30",
    domain: "metals",
    question: "Will silver close above $30/oz by end of month?",
    baseMarketProb: 0.46,
    baseConfidence: 0.45,
    liquidity: 72_000,
    observed: ["Industrial demand from solar remains robust"],
    inferred: ["Gold/silver ratio is wide vs historical norm"],
    speculation: ["Mean-reversion trade gathers attention"],
    unknowns: ["Mexican mine supply this quarter"],
    riskFlags: ["Silver moves violently on thin liquidity"],
    signals: [
      {
        domain: "metals",
        source: "comex",
        kind: "price_move",
        title: "Silver +3.2% over five sessions",
        body: "Outperforming gold on industrial demand.",
        impact: 0.5,
        sentiment: 0.5,
        weight: 0.7,
      },
    ],
  },
];

const NEWS_AMBIENT_SEEDS: ConnectorSignal[] = [
  {
    domain: "geopolitics",
    source: "wires_mock",
    kind: "news",
    title: "Red Sea shipping disruptions extend to fifth month",
    body: "Container rerouting via Cape of Good Hope continues; freight rates up 18% MoM.",
    impact: 0.45,
    sentiment: -0.3,
    weight: 0.6,
  },
  {
    domain: "policy",
    source: "wires_mock",
    kind: "policy_release",
    title: "Treasury raises auction sizes for 7s and 10s",
    body: "Quarterly refunding announcement increases coupon supply.",
    impact: 0.5,
    sentiment: -0.25,
    weight: 0.7,
  },
  {
    domain: "commodities",
    source: "wires_mock",
    kind: "news",
    title: "OPEC+ extends voluntary cuts through year-end",
    body: "Production restraint maintained; Saudi messaging firm.",
    impact: 0.55,
    sentiment: 0.4,
    weight: 0.7,
  },
];

/**
 * Production-shape connector interface. Real connectors implement the same
 * methods (`fetch`, `normalize`, `healthCheck`) and the orchestrator never
 * has to know whether it's talking to a mock or a real upstream. The mock
 * connectors below set `mockDataMode = true`; real ones flip it to false.
 */
export interface RawFetchResult {
  /** Raw upstream payload — for mocks this is just the seeds we'll normalize. */
  source: string;
  rawMarkets: MarketSeed[];
  rawAmbient: ConnectorSignal[];
  fetchedAt: Date;
}

export interface ConnectorHealth {
  status: "ok" | "degraded" | "error" | "idle";
  lastSuccessfulRun: Date | null;
  message?: string;
}

export interface Connector {
  name: string;
  domain: ConnectorDomain | "mixed";
  mockDataMode: boolean;
  /** Last time `fetch()` returned ok. Updated by the orchestrator. */
  lastSuccessfulRun: Date | null;
  /** Pull raw data from the upstream (or, for mocks, the seed bank). */
  fetch(): Promise<RawFetchResult>;
  /** Shape raw data into the internal `ConnectorMarket`/`ConnectorSignal` shape. */
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

const buildConnector = (
  name: string,
  source: string,
  domain: ConnectorDomain | "mixed",
  seeds: MarketSeed[],
  ambient: ConnectorSignal[] = [],
): Connector => {
  const c: Connector = {
    name,
    domain,
    mockDataMode: true,
    lastSuccessfulRun: null,
    async fetch(): Promise<RawFetchResult> {
      // Mock connector: "fetching" is just returning the seed bank with a
      // current timestamp. Real connectors hit the upstream API here.
      return {
        source,
        rawMarkets: seeds,
        rawAmbient: ambient,
        fetchedAt: new Date(),
      };
    },
    normalize(raw: RawFetchResult): ConnectorResult {
      const markets = raw.rawMarkets.map((s) => buildMarket(raw.source, s));
      for (const m of markets) {
        const signalConfidence = confidenceFromSignals(m.signals as RawSignal[]);
        m.confidence = Math.max(m.confidence, signalConfidence);
      }
      return {
        name,
        status: "ok",
        fetchedAt: raw.fetchedAt,
        markets,
        ambientSignals: raw.rawAmbient,
      };
    },
    async healthCheck(): Promise<ConnectorHealth> {
      // Mock connectors are always available; their `mockDataMode` flag
      // tells the UI not to trust this number for production purposes.
      return {
        status: "ok",
        lastSuccessfulRun: c.lastSuccessfulRun,
        message: "mock connector",
      };
    },
    async run(): Promise<ConnectorResult> {
      const raw = await c.fetch();
      const result = c.normalize(raw);
      c.lastSuccessfulRun = result.fetchedAt;
      return result;
    },
  };
  return c;
};

const buildAmbientConnector = (
  name: string,
  ambient: ConnectorSignal[],
): Connector => {
  const c: Connector = {
    name,
    domain: "mixed",
    mockDataMode: true,
    lastSuccessfulRun: null,
    async fetch(): Promise<RawFetchResult> {
      return { source: name, rawMarkets: [], rawAmbient: ambient, fetchedAt: new Date() };
    },
    normalize(raw: RawFetchResult): ConnectorResult {
      return {
        name,
        status: "ok",
        fetchedAt: raw.fetchedAt,
        markets: [],
        ambientSignals: raw.rawAmbient,
        note: "Ambient news signals (mock).",
      };
    },
    async healthCheck(): Promise<ConnectorHealth> {
      return { status: "ok", lastSuccessfulRun: c.lastSuccessfulRun, message: "mock connector" };
    },
    async run(): Promise<ConnectorResult> {
      const raw = await c.fetch();
      const result = c.normalize(raw);
      c.lastSuccessfulRun = result.fetchedAt;
      return result;
    },
  };
  return c;
};

export const connectors: Connector[] = [
  buildConnector("manifold", "manifold", "prediction_market", MANIFOLD_SEEDS),
  buildConnector("polymarket", "polymarket", "prediction_market", POLYMARKET_SEEDS),
  buildConnector("kalshi", "kalshi", "prediction_market", KALSHI_SEEDS),
  buildConnector("metaculus", "metaculus", "prediction_market", METACULUS_SEEDS),
  buildConnector("comex", "comex", "metals", COMEX_SEEDS),
  buildAmbientConnector("news_wires", NEWS_AMBIENT_SEEDS),
];
