/**
 * Metaculus connector. Both Metaculus's `/api2/questions` and the newer
 * `/api/posts` endpoints currently require an API token (HTTP 403 anonymous).
 * If `METACULUS_API_KEY` is present we send it; otherwise the connector
 * surfaces "degraded" with an actionable note instead of crashing.
 */

import {
  buildRationale,
  clamp01,
  type ConnectorImpl,
  type ConnectorMarket,
} from "./index";
import { httpJson, HttpError } from "./http";

interface MetaculusV2Question {
  id: number;
  title: string;
  page_url?: string;
  url?: string;
  status?: string;
  type?: string;
  possibilities?: { type?: string };
  community_prediction?: {
    full?: { q1?: number; q2?: number; q3?: number };
  };
  number_of_forecasters?: number;
  publish_time?: string;
  close_time?: string;
}

interface MetaculusV2Response {
  results?: MetaculusV2Question[];
}

const METACULUS_URL =
  "https://www.metaculus.com/api2/questions/" +
  "?type=forecast&status=open&forecast_type=binary" +
  "&order_by=-publish_time&limit=20&format=json";

const MAX_MARKETS = 12;

export function createMetaculusConnector(): ConnectorImpl {
  return {
    name: "metaculus",
    source: "metaculus",
    domain: "prediction_market",
    async fetchRaw() {
      const headers: Record<string, string> = {};
      const apiKey = process.env.METACULUS_API_KEY;
      if (apiKey) {
        headers["authorization"] = `Token ${apiKey}`;
      }

      let payload: MetaculusV2Response;
      try {
        payload = await httpJson<MetaculusV2Response>(METACULUS_URL, { headers });
      } catch (err) {
        if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
          return {
            markets: [],
            ambient: [],
            status: "degraded" as const,
            note:
              "Metaculus requires authentication — set METACULUS_API_KEY (a Token from your Metaculus account) to ingest live community forecasts.",
          };
        }
        throw err;
      }

      const all = Array.isArray(payload.results) ? payload.results : [];
      const markets: ConnectorMarket[] = [];
      let dropped = 0;

      for (const q of all) {
        if (markets.length >= MAX_MARKETS) break;
        if (q.status && q.status !== "open") continue;
        if (q.possibilities && q.possibilities.type && q.possibilities.type !== "binary") {
          continue;
        }
        const median = q.community_prediction?.full?.q2;
        if (typeof median !== "number") {
          dropped++;
          continue;
        }
        const marketProb = clamp01(median);
        const forecasters = q.number_of_forecasters ?? 0;
        const closesAt = q.close_time ? new Date(q.close_time) : null;
        const closesInDays = closesAt
          ? Math.max(0, (closesAt.getTime() - Date.now()) / 86_400_000)
          : null;

        const observed: string[] = [
          `Metaculus question #${q.id}: "${q.title}".`,
          `${forecasters} forecasters contributing to the community median.`,
        ];
        if (closesAt) {
          observed.push(
            `Resolution window closes ${closesAt.toISOString().slice(0, 10)}.`,
          );
        }

        const inferred: string[] = [
          `Community median forecast: ${(marketProb * 100).toFixed(1)}%.`,
        ];
        if (
          typeof q.community_prediction?.full?.q1 === "number" &&
          typeof q.community_prediction?.full?.q3 === "number"
        ) {
          const lo = (q.community_prediction.full.q1 * 100).toFixed(1);
          const hi = (q.community_prediction.full.q3 * 100).toFixed(1);
          inferred.push(`Inter-quartile spread: ${lo}% – ${hi}%.`);
        }

        const riskFlags: string[] = [];
        if (forecasters < 30) {
          riskFlags.push(
            "Few forecasters — community median may not be well-calibrated.",
          );
        }
        if (closesInDays !== null && closesInDays > 365) {
          riskFlags.push(
            "Long resolution horizon — base rates dominate over short-term signal.",
          );
        }

        const url = q.page_url
          ? `https://www.metaculus.com${q.page_url}`
          : (q.url ?? `https://www.metaculus.com/questions/${q.id}/`);

        // Confidence comes from forecaster depth — Metaculus has no liquidity.
        const forecasterConfidence = clamp01(
          0.3 + 0.55 * (1 - Math.exp(-forecasters / 200)),
        );

        markets.push({
          marketKey: `metaculus-${q.id}`,
          source: "metaculus",
          domain: "prediction_market",
          question: q.title,
          marketProb,
          modelProb: marketProb,
          confidence: forecasterConfidence,
          liquidity: 0, // Metaculus is reputational, not money-weighted.
          spread: 0.05, // No book; we treat the IQR as a soft "spread" proxy.
          url,
          rationale: buildRationale({ observed, inferred, riskFlags }),
          signals: [],
        });
      }

      const status = markets.length === 0 ? "degraded" : "ok";
      const note =
        markets.length === 0
          ? "Metaculus returned no usable open binary questions in this window."
          : dropped > 0
            ? `Skipped ${dropped} questions without a community median.`
            : undefined;

      return { markets, ambient: [], status, note };
    },
  };
}
