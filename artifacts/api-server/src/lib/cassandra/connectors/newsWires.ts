/**
 * News-wires connector. Pulls real headlines from two free sources:
 *
 *   - BBC World News RSS (no auth, redirects http -> https)
 *   - Hacker News top stories via the Firebase API (no auth)
 *
 * Each headline becomes an ambient signal whose sentiment is keyword-derived
 * and whose impact scales with engagement (HN score) or recency (BBC).
 *
 * No markets are emitted by this connector — it is a pure signal source.
 */

import {
  clamp01,
  headlineSentiment,
  type ConnectorImpl,
  type ConnectorSignal,
} from "./index";
import { httpJson, httpText } from "./http";

const BBC_RSS_URL = "https://feeds.bbci.co.uk/news/world/rss.xml";
const HN_TOP_URL = "https://hacker-news.firebaseio.com/v0/topstories.json";
const HN_ITEM_URL = (id: number) =>
  `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

const MAX_BBC = 8;
const MAX_HN = 6;

export function createNewsWiresConnector(): ConnectorImpl {
  return {
    name: "news_wires",
    source: "news_wires",
    domain: "mixed",
    async fetchRaw() {
      const errors: string[] = [];
      const ambient: ConnectorSignal[] = [];

      const [bbcResult, hnResult] = await Promise.allSettled([
        fetchBbcWorld(),
        fetchHackerNewsTop(),
      ]);

      if (bbcResult.status === "fulfilled") {
        ambient.push(...bbcResult.value);
      } else {
        errors.push(
          `BBC: ${bbcResult.reason instanceof Error ? bbcResult.reason.message : String(bbcResult.reason)}`,
        );
      }

      if (hnResult.status === "fulfilled") {
        ambient.push(...hnResult.value);
      } else {
        errors.push(
          `HN: ${hnResult.reason instanceof Error ? hnResult.reason.message : String(hnResult.reason)}`,
        );
      }

      // Both legs failed → throw so orchestrator surfaces "error".
      // Partial failure → "degraded" with a note.
      if (ambient.length === 0 && errors.length > 0) {
        throw new Error(`All news wires failed: ${errors.join("; ")}`);
      }
      return {
        markets: [],
        ambient,
        status: errors.length > 0 ? "degraded" : "ok",
        note:
          errors.length > 0
            ? `Failed ${errors.length}/2 wires: ${errors.join("; ")}`
            : undefined,
      };
    },
  };
}

/* --------------------------------- BBC ----------------------------------- */

async function fetchBbcWorld(): Promise<ConnectorSignal[]> {
  const xml = await httpText(BBC_RSS_URL, {
    headers: { accept: "application/rss+xml, application/xml, text/xml, */*" },
  });
  const items = parseRssItems(xml).slice(0, MAX_BBC);
  return items.map((item) => {
    const sentiment = headlineSentiment(`${item.title}. ${item.description}`);
    const impact = clamp01(0.4 + Math.abs(sentiment) * 0.4);
    return {
      domain: domainForHeadline(item.title, item.description),
      source: "bbc_world",
      kind: "news",
      title: truncate(item.title, 200),
      body: truncate(item.description || item.title, 400),
      impact,
      sentiment,
      weight: 0.65,
    };
  });
}

interface RssItem {
  title: string;
  description: string;
}

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRegex = /<item[\s\S]*?<\/item>/g;
  const matches = xml.match(itemRegex) ?? [];
  for (const block of matches) {
    const title = extractTag(block, "title");
    const description = extractTag(block, "description");
    if (title) items.push({ title, description });
  }
  return items;
}

function extractTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  return decodeXmlEntities(stripCdata(m[1]).trim());
}

function stripCdata(s: string): string {
  return s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'");
}

/* --------------------------------- HN ------------------------------------ */

interface HnItem {
  id: number;
  title?: string;
  url?: string;
  score?: number;
  by?: string;
  type?: string;
  time?: number;
}

async function fetchHackerNewsTop(): Promise<ConnectorSignal[]> {
  const ids = await httpJson<number[]>(HN_TOP_URL);
  const top = (Array.isArray(ids) ? ids : []).slice(0, MAX_HN * 2);
  const items = await Promise.allSettled(
    top.map((id) => httpJson<HnItem>(HN_ITEM_URL(id))),
  );
  const out: ConnectorSignal[] = [];
  for (const r of items) {
    if (r.status !== "fulfilled") continue;
    const item = r.value;
    if (out.length >= MAX_HN) break;
    if (item.type !== "story" || !item.title) continue;
    const sentiment = headlineSentiment(item.title);
    // HN engagement saturates around 500 points; map to [0.4, 0.9] impact.
    const impact = clamp01(0.4 + 0.5 * (1 - Math.exp(-(item.score ?? 0) / 200)));
    out.push({
      domain: domainForHeadline(item.title, item.url ?? ""),
      source: "hackernews",
      kind: "social_cluster",
      title: truncate(item.title, 200),
      body: `Hacker News top story (score ${item.score ?? 0}). ${item.url ?? ""}`.trim(),
      impact,
      sentiment,
      weight: 0.55,
    });
  }
  return out;
}

/* ------------------------------ heuristics ------------------------------- */

function domainForHeadline(
  title: string,
  body: string,
):
  | "geopolitics"
  | "policy"
  | "macro"
  | "commodities"
  | "metals" {
  const t = `${title} ${body}`.toLowerCase();
  if (
    /(opec|oil|crude|gas|wheat|corn|soy|copper|lithium|natural gas|brent|wti)/.test(
      t,
    )
  ) {
    return "commodities";
  }
  if (/(gold|silver|platinum|palladium|bullion)/.test(t)) return "metals";
  if (
    /(fed|federal reserve|inflation|cpi|gdp|jobs|unemployment|payroll|earnings|stock|s&p|nasdaq|treasury|yield|bond)/.test(
      t,
    )
  ) {
    return "macro";
  }
  if (
    /(senate|house|congress|biden|trump|white house|sec|cftc|regulator|tariff|sanction|ruling|court)/.test(
      t,
    )
  ) {
    return "policy";
  }
  return "geopolitics";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
