/**
 * Polymarket connector. Uses the public Gamma read API
 * (`gamma-api.polymarket.com/markets`) — no auth required for market data.
 */

import {
  buildRationale,
  clamp01,
  depthConfidence,
  type ConnectorImpl,
  type ConnectorMarket,
} from "./index";
import { httpJson } from "./http";

interface PolymarketRow {
  id: string;
  question: string;
  slug: string;
  endDate?: string;
  outcomes?: string;
  outcomePrices?: string;
  volume?: string;
  volumeNum?: number;
  liquidity?: string;
  liquidityNum?: number;
  active?: boolean;
  closed?: boolean;
  description?: string;
  volume24hr?: number;
  enableOrderBook?: boolean;
  orderPriceMinTickSize?: number;
}

const POLYMARKET_URL =
  "https://gamma-api.polymarket.com/markets" +
  "?active=true&closed=false&limit=40&order=volume&ascending=false";

const MAX_MARKETS = 12;
const MIN_LIQUIDITY_USD = 1_000;

export function createPolymarketConnector(): ConnectorImpl {
  return {
    name: "polymarket",
    source: "polymarket",
    domain: "prediction_market",
    async fetchRaw() {
      const raw = await httpJson<PolymarketRow[]>(POLYMARKET_URL);
      const all = Array.isArray(raw) ? raw : [];
      const markets: ConnectorMarket[] = [];
      let dropped = 0;

      for (const m of all) {
        if (markets.length >= MAX_MARKETS) break;
        if (!m.active || m.closed) continue;

        const outcomes = parseStringArray(m.outcomes);
        const prices = parseStringArray(m.outcomePrices).map((s) =>
          Number.parseFloat(s),
        );
        const yesIndex = outcomes.findIndex(
          (o) => o.toLowerCase() === "yes",
        );
        if (yesIndex === -1 || !Number.isFinite(prices[yesIndex])) {
          dropped++;
          continue;
        }
        const marketProb = clamp01(prices[yesIndex]);
        const liquidityUsd = m.liquidityNum ?? Number(m.liquidity ?? 0);
        const volumeUsd = m.volumeNum ?? Number(m.volume ?? 0);
        if (liquidityUsd < MIN_LIQUIDITY_USD) {
          dropped++;
          continue;
        }

        const closesAt = m.endDate ? new Date(m.endDate) : null;
        const closesInDays = closesAt
          ? Math.max(0, (closesAt.getTime() - Date.now()) / 86_400_000)
          : null;

        const observed: string[] = [
          `Live binary market on Polymarket (slug: ${m.slug}).`,
          `Volume traded: $${formatUsd(volumeUsd)}; on-book liquidity: $${formatUsd(liquidityUsd)}.`,
        ];
        if (m.volume24hr && m.volume24hr > 0) {
          observed.push(`$${formatUsd(m.volume24hr)} traded in the last 24h.`);
        }
        if (closesAt) {
          observed.push(
            closesInDays !== null && closesInDays < 1
              ? `Market resolves within the next 24 hours (at ${closesAt.toISOString()}).`
              : `Market resolves on ${closesAt.toISOString().slice(0, 10)}.`,
          );
        }

        const inferred: string[] = [
          `YES side priced at ${(marketProb * 100).toFixed(1)}¢; NO side at ${((1 - marketProb) * 100).toFixed(1)}¢.`,
        ];

        const riskFlags: string[] = [];
        if (liquidityUsd < 5_000) {
          riskFlags.push(
            "Thin order book — fills above $200 will move the price.",
          );
        }
        if (closesInDays !== null && closesInDays < 1) {
          riskFlags.push(
            "Resolution is imminent; latency between signal and trade matters.",
          );
        }

        const tick = m.orderPriceMinTickSize ?? 0.01;

        markets.push({
          marketKey: `polymarket-${m.id}`,
          source: "polymarket",
          domain: "prediction_market",
          question: m.question,
          marketProb,
          modelProb: marketProb,
          confidence: depthConfidence({
            liquidityUsd,
            volumeUsd,
          }),
          liquidity: liquidityUsd,
          spread: clamp01(tick * 2), // CLOB tick size is the floor; doubling approximates a one-tick spread.
          url: `https://polymarket.com/event/${m.slug}`,
          rationale: buildRationale({ observed, inferred, riskFlags }),
          signals: [],
        });
      }

      const status = markets.length === 0 ? "degraded" : "ok";
      const note =
        markets.length === 0
          ? "Polymarket returned no usable active binary markets."
          : dropped > 0
            ? `Skipped ${dropped} markets without YES/NO outcomes or sufficient liquidity.`
            : undefined;

      return { markets, ambient: [], status, note };
    },
  };
}

function parseStringArray(input: string | undefined): string[] {
  if (!input) return [];
  try {
    const parsed = JSON.parse(input);
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}
