/**
 * Manifold Markets connector. Hits Manifold's free public read API
 * (`api.manifold.markets/v0`) — no auth required for market data.
 */

import {
  buildRationale,
  clamp01,
  depthConfidence,
  type ConnectorImpl,
  type ConnectorMarket,
} from "./index";
import { httpJson } from "./http";

interface ManifoldMarket {
  id: string;
  question: string;
  slug: string;
  url: string;
  outcomeType: string;
  isResolved: boolean;
  closeTime?: number;
  probability?: number;
  totalLiquidity?: number;
  volume?: number;
  volume24Hours?: number;
  uniqueBettorCount?: number;
  lastBetTime?: number;
}

const MANIFOLD_URL =
  "https://api.manifold.markets/v0/search-markets" +
  "?term=&filter=open&sort=score&contractType=BINARY&limit=25";

const MAX_MARKETS = 12;

export function createManifoldConnector(): ConnectorImpl {
  return {
    name: "manifold",
    source: "manifold",
    domain: "prediction_market",
    async fetchRaw() {
      const raw = await httpJson<ManifoldMarket[]>(MANIFOLD_URL);
      const all = Array.isArray(raw) ? raw : [];
      const markets: ConnectorMarket[] = [];
      const dropped: string[] = [];

      for (const m of all) {
        if (markets.length >= MAX_MARKETS) break;
        if (m.outcomeType !== "BINARY" || m.isResolved) continue;
        if (typeof m.probability !== "number") {
          dropped.push(m.id);
          continue;
        }
        if (m.closeTime && m.closeTime < Date.now()) continue;

        const marketProb = clamp01(m.probability);
        const liquidity = Math.max(0, m.volume ?? 0); // Manifold volume in mana ≈ $1 USD effective
        const traders = m.uniqueBettorCount ?? 0;
        const closesInDays = m.closeTime
          ? Math.max(0, (m.closeTime - Date.now()) / 86_400_000)
          : null;

        const observed: string[] = [
          `Live binary market on Manifold (slug: ${m.slug}).`,
          `Total volume traded: ${formatNumber(m.volume ?? 0)} mana.`,
          `${traders} unique participants have bet on this market.`,
        ];
        if (m.volume24Hours && m.volume24Hours > 0) {
          observed.push(
            `${formatNumber(m.volume24Hours)} mana of volume in the last 24h.`,
          );
        }
        if (closesInDays !== null) {
          observed.push(
            closesInDays < 1
              ? "Market closes within the next 24 hours."
              : `Market closes in ~${Math.round(closesInDays)} days.`,
          );
        }

        const inferred: string[] = [
          `Implied probability: ${(marketProb * 100).toFixed(1)}% YES.`,
        ];
        if (m.lastBetTime) {
          const ageMin = Math.round((Date.now() - m.lastBetTime) / 60_000);
          inferred.push(`Last trade ${ageMin} minutes ago — book is active.`);
        }

        const riskFlags: string[] = [];
        if ((m.volume ?? 0) < 500) {
          riskFlags.push(
            "Low cumulative volume — the price is easy to move and may be unreliable.",
          );
        }
        if (closesInDays !== null && closesInDays < 1) {
          riskFlags.push(
            "Market closes within 24h — execution risk is elevated.",
          );
        }
        if (traders < 20) {
          riskFlags.push(
            "Few participants — single-actor dominance is possible.",
          );
        }

        markets.push({
          marketKey: `manifold-${m.id}`,
          source: "manifold",
          domain: "prediction_market",
          question: m.question,
          marketProb,
          modelProb: marketProb,
          confidence: depthConfidence({
            volumeUsd: m.volume,
            liquidityUsd: m.totalLiquidity,
            traders,
          }),
          liquidity,
          spread: 0.02, // Manifold CPMM has no quoted spread; conventional default.
          url: m.url,
          rationale: buildRationale({ observed, inferred, riskFlags }),
          signals: [],
        });
      }

      const status = markets.length === 0 ? "degraded" : "ok";
      const note =
        markets.length === 0
          ? "Manifold returned no usable open binary markets."
          : dropped.length > 0
            ? `Skipped ${dropped.length} markets without a current probability.`
            : undefined;

      return { markets, ambient: [], status, note };
    },
  };
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}
