/**
 * COMEX / metals connector. Pulls daily OHLC for the front-month gold,
 * silver, copper, and platinum futures from Yahoo Finance's public
 * `/v8/finance/chart` endpoint (no auth required) and emits ambient signals
 * describing material price moves over 1-day, 1-week, and 1-month windows.
 *
 * The connector intentionally emits no markets — there are no quoted
 * binary outcomes for futures prices. The signal feed is what downstream
 * scoring + the agent surface consume here.
 */

import {
  clamp,
  type ConnectorImpl,
  type ConnectorSignal,
} from "./index";
import { httpJson } from "./http";

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        symbol?: string;
        regularMarketPrice?: number;
        chartPreviousClose?: number;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          close?: Array<number | null>;
        }>;
      };
    }>;
    error?: { code?: string; description?: string } | null;
  };
}

interface MetalConfig {
  symbol: string;
  display: string;
  unit: string;
}

const METALS: MetalConfig[] = [
  { symbol: "GC=F", display: "Gold", unit: "/oz" },
  { symbol: "SI=F", display: "Silver", unit: "/oz" },
  { symbol: "HG=F", display: "Copper", unit: "/lb" },
  { symbol: "PL=F", display: "Platinum", unit: "/oz" },
];

const YAHOO_RANGE = "1mo";
const YAHOO_INTERVAL = "1d";

const SIGNIFICANT_DAILY_PCT = 0.5; // 0.5% intraday move is material
const SIGNIFICANT_WEEKLY_PCT = 1.5;
const SIGNIFICANT_MONTHLY_PCT = 3.5;

export function createComexConnector(): ConnectorImpl {
  return {
    name: "comex",
    source: "comex",
    domain: "metals",
    async fetchRaw() {
      const ambient: ConnectorSignal[] = [];
      const errors: string[] = [];

      const results = await Promise.allSettled(
        METALS.map((m) => fetchMetal(m)),
      );

      for (let i = 0; i < METALS.length; i++) {
        const metal = METALS[i];
        const result = results[i];
        if (result.status === "rejected") {
          const reason =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
          errors.push(`${metal.symbol}: ${reason}`);
          continue;
        }
        ambient.push(...result.value);
      }

      // If every leg failed, throw — the orchestrator will surface "error".
      // If some legs failed, surface "degraded" with a note explaining which.
      if (errors.length === METALS.length) {
        throw new Error(
          `All metal feeds failed: ${errors.slice(0, 3).join("; ")}`,
        );
      }

      return {
        markets: [],
        ambient,
        status: errors.length > 0 ? "degraded" : "ok",
        note:
          errors.length > 0
            ? `Failed ${errors.length}/${METALS.length} metal feeds: ${errors.slice(0, 3).join("; ")}`
            : undefined,
      };
    },
  };
}

async function fetchMetal(metal: MetalConfig): Promise<ConnectorSignal[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(metal.symbol)}` +
    `?interval=${YAHOO_INTERVAL}&range=${YAHOO_RANGE}`;
  const payload = await httpJson<YahooChartResponse>(url, {
    headers: { "user-agent": "Mozilla/5.0 (Cassandra-OpenClaw/1.0)" },
  });
  const result = payload.chart?.result?.[0];
  if (!result) return [];
  const closes = (result.indicators?.quote?.[0]?.close ?? []).filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (closes.length === 0) return [];
  const last = result.meta?.regularMarketPrice ?? closes[closes.length - 1];
  if (typeof last !== "number" || !Number.isFinite(last)) return [];

  const previousClose =
    result.meta?.chartPreviousClose ??
    closes[closes.length - 2] ??
    closes[closes.length - 1];
  const fiveDaysAgo = closes[Math.max(0, closes.length - 6)] ?? closes[0];
  const monthAgo = closes[0] ?? last;

  const dailyPct = pctChange(last, previousClose);
  const weeklyPct = pctChange(last, fiveDaysAgo);
  const monthlyPct = pctChange(last, monthAgo);

  const signals: ConnectorSignal[] = [];

  if (Math.abs(dailyPct) >= SIGNIFICANT_DAILY_PCT) {
    signals.push(
      moveSignal(metal, last, dailyPct, "today", SIGNIFICANT_DAILY_PCT),
    );
  }
  if (Math.abs(weeklyPct) >= SIGNIFICANT_WEEKLY_PCT) {
    signals.push(
      moveSignal(metal, last, weeklyPct, "this week", SIGNIFICANT_WEEKLY_PCT),
    );
  }
  if (Math.abs(monthlyPct) >= SIGNIFICANT_MONTHLY_PCT) {
    signals.push(
      moveSignal(metal, last, monthlyPct, "this month", SIGNIFICANT_MONTHLY_PCT),
    );
  }

  return signals;
}

function pctChange(now: number, then: number): number {
  if (!then || !Number.isFinite(then)) return 0;
  return ((now - then) / then) * 100;
}

function moveSignal(
  metal: MetalConfig,
  price: number,
  pct: number,
  windowLabel: string,
  threshold: number,
): ConnectorSignal {
  const direction = pct >= 0 ? "up" : "down";
  const sentiment = clamp(Math.tanh(pct / 5), -1, 1);
  // Impact saturates: a 1× threshold move scores ~0.4, a 3× move ~0.9.
  const impact = clamp(0.3 + 0.5 * Math.tanh(Math.abs(pct) / (threshold * 2)), 0, 1);
  return {
    domain: "metals",
    source: "comex",
    kind: "price_move",
    title: `${metal.display} ${direction} ${Math.abs(pct).toFixed(2)}% ${windowLabel}`,
    body: `${metal.display} (${metal.symbol}) trading near $${price.toFixed(2)}${metal.unit}; ${direction} ${Math.abs(pct).toFixed(2)}% ${windowLabel}.`,
    impact,
    sentiment,
    weight: 0.7,
  };
}
