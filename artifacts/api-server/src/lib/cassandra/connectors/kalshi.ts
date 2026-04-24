/**
 * Kalshi connector. Hits the public Kalshi market data REST API
 * (`api.elections.kalshi.com/trade-api/v2/markets`). Auth is optional for
 * read endpoints; if `KALSHI_API_KEY` is set we send it so the response
 * isn't downsampled.
 */

import {
  buildRationale,
  clamp01,
  depthConfidence,
  type ConnectorImpl,
  type ConnectorMarket,
} from "./index";
import { httpJson, HttpError } from "./http";

interface KalshiMarket {
  ticker: string;
  event_ticker?: string;
  title?: string;
  subtitle?: string;
  // Older shape: integer cents 0-100
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  last_price?: number;
  volume?: number;
  open_interest?: number;
  // Newer shape: dollar-denominated strings
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  liquidity_dollars?: string;
  open_interest_fp?: string;
  status?: string;
  close_time?: string;
  market_type?: string;
  is_provisional?: boolean;
}

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

interface KalshiResponse {
  markets?: KalshiMarket[];
  cursor?: string;
}

const KALSHI_URL =
  "https://api.elections.kalshi.com/trade-api/v2/markets" +
  "?status=open&limit=1000";

const MAX_MARKETS = 12;

export function createKalshiConnector(): ConnectorImpl {
  return {
    name: "kalshi",
    source: "kalshi",
    domain: "prediction_market",
    async fetchRaw() {
      const headers: Record<string, string> = {};
      const apiKey = process.env.KALSHI_API_KEY;
      if (apiKey) {
        headers["authorization"] = `Bearer ${apiKey}`;
      }

      let payload: KalshiResponse;
      try {
        payload = await httpJson<KalshiResponse>(KALSHI_URL, { headers });
      } catch (err) {
        if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
          return {
            markets: [],
            ambient: [],
            status: "degraded" as const,
            note:
              "Kalshi returned 401/403 — set KALSHI_API_KEY to authenticate to the public market data API.",
          };
        }
        throw err;
      }

      const all = Array.isArray(payload.markets) ? payload.markets : [];
      const markets: ConnectorMarket[] = [];
      let dropped = 0;
      let unquoted = 0;

      // Kalshi returns prices either as integer cents (older shape) or as
      // dollar-denominated strings (newer shape). Coerce to a unified
      // probability in [0, 1].
      const probFromCents = (cents: number | null): number | null =>
        cents === null ? null : clamp01(cents / 100);
      const probFromDollars = (dollars: number | null): number | null =>
        dollars === null ? null : clamp01(dollars);

      for (const m of all) {
        if (markets.length >= MAX_MARKETS) break;
        if (m.status !== "active" && m.status !== "open" && m.status !== undefined) {
          continue;
        }
        if (m.market_type && m.market_type !== "binary") continue;
        if (m.is_provisional) continue;

        // Try newer dollar shape first, fall back to cents.
        const yesAskD = num(m.yes_ask_dollars);
        const yesBidD = num(m.yes_bid_dollars);
        const lastD = num(m.last_price_dollars);
        const yesAskC = num(m.yes_ask);
        const yesBidC = num(m.yes_bid);
        const lastC = num(m.last_price);

        const midProb = (() => {
          if (yesAskD !== null && yesBidD !== null && yesAskD < 1 && yesBidD > 0) {
            return probFromDollars((yesAskD + yesBidD) / 2);
          }
          if (
            yesAskC !== null &&
            yesBidC !== null &&
            yesAskC < 100 &&
            yesBidC > 0
          ) {
            return probFromCents((yesAskC + yesBidC) / 2);
          }
          if (lastD !== null && lastD > 0 && lastD < 1) return probFromDollars(lastD);
          if (lastC !== null && lastC > 0 && lastC < 100) return probFromCents(lastC);
          return null;
        })();

        if (midProb === null) {
          unquoted++;
          continue;
        }
        const marketProb = midProb;

        const volume = num(m.volume) ?? 0;
        const liquidityUsd = num(m.liquidity_dollars) ?? 0;
        const oi = num(m.open_interest) ?? num(m.open_interest_fp) ?? 0;
        if (volume < 1 && liquidityUsd < 1 && oi < 1) {
          dropped++;
          continue;
        }

        const closesAt = m.close_time ? new Date(m.close_time) : null;
        const closesInDays = closesAt
          ? Math.max(0, (closesAt.getTime() - Date.now()) / 86_400_000)
          : null;

        const observed: string[] = [
          `Kalshi market ${m.ticker} (${m.title ?? m.subtitle ?? "untitled"}).`,
          `Volume: ${formatNumber(volume)} contracts; open interest: ${formatNumber(oi)}.`,
        ];
        if (liquidityUsd > 0) {
          observed.push(`On-book liquidity: $${formatNumber(liquidityUsd)}.`);
        }
        if (closesAt) {
          observed.push(
            closesInDays !== null && closesInDays < 1
              ? "Market closes within 24 hours."
              : `Closes ${closesAt.toISOString().slice(0, 10)}.`,
          );
        }

        const inferred: string[] = [
          `Mid implied probability ${(marketProb * 100).toFixed(1)}% YES.`,
        ];

        // Compute spread in probability units, preferring the dollar shape.
        let spreadProb = 0.02;
        if (
          yesAskD !== null &&
          yesBidD !== null &&
          yesAskD > yesBidD &&
          yesAskD < 1 &&
          yesBidD > 0
        ) {
          spreadProb = clamp01(yesAskD - yesBidD);
          inferred.push(
            `Quoted spread: ${(spreadProb * 100).toFixed(1)}¢ (${(yesBidD * 100).toFixed(1)}¢ / ${(yesAskD * 100).toFixed(1)}¢).`,
          );
        } else if (
          yesAskC !== null &&
          yesBidC !== null &&
          yesAskC > yesBidC &&
          yesAskC < 100 &&
          yesBidC > 0
        ) {
          spreadProb = clamp01((yesAskC - yesBidC) / 100);
          inferred.push(
            `Quoted spread: ${(yesAskC - yesBidC).toFixed(0)}¢ (${yesBidC}¢ / ${yesAskC}¢).`,
          );
        }

        const riskFlags: string[] = [];
        if (volume < 500) {
          riskFlags.push("Thin volume — single trades may move the price.");
        }
        if (closesInDays !== null && closesInDays < 1) {
          riskFlags.push("Settles within 24h — execution risk is elevated.");
        }

        const eventTicker = m.event_ticker ?? m.ticker;
        const proxyVolumeUsd = volume * marketProb;

        markets.push({
          marketKey: `kalshi-${m.ticker}`,
          source: "kalshi",
          domain: "prediction_market",
          question: m.title ?? m.ticker,
          marketProb,
          modelProb: marketProb,
          confidence: depthConfidence({
            liquidityUsd,
            volumeUsd: proxyVolumeUsd,
            traders: oi,
          }),
          liquidity: liquidityUsd > 0 ? liquidityUsd : proxyVolumeUsd,
          spread: spreadProb,
          url: `https://kalshi.com/markets/${eventTicker.toLowerCase()}`,
          rationale: buildRationale({ observed, inferred, riskFlags }),
          signals: [],
        });
      }

      const status = markets.length === 0 ? "degraded" : "ok";
      const note = (() => {
        if (markets.length === 0) {
          if (unquoted > 0 && !apiKey) {
            return `Kalshi public API returned no priced markets (${unquoted} entries had no live quote). Set KALSHI_API_KEY to authenticate to the trade-api.`;
          }
          return "Kalshi returned no usable open binary markets in this window.";
        }
        if (dropped + unquoted > 0) {
          return `Skipped ${dropped} markets without volume/OI and ${unquoted} without quoted prices.`;
        }
        return undefined;
      })();

      return { markets, ambient: [], status, note };
    },
  };
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}
