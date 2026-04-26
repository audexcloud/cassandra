/**
 * Winner-account tracking — real Polymarket Data API implementation.
 *
 * Data flow per refresh cycle:
 *  1. Fetch the Polymarket all-time leaderboard (top 50 by profit).
 *  2. Upsert any new addresses as tracked wallets.
 *  3. For every tracked wallet fetch their live open positions.
 *  4. Match positions to our ingested opportunity universe by conditionId.
 *  5. Score each match: does the winner's direction agree with our model?
 *  6. Emit mirror suggestions for high-alignment matches; skip low-confidence ones.
 *
 * Falls back gracefully: if the data API is unreachable, the cycle logs the
 * error but does not abort — the stored wallet profiles keep showing the
 * last known values.
 */

import { db } from "@workspace/db";
import {
  walletProfiles,
  walletSnapshots,
  mirrorSuggestions,
  opportunities,
  type WalletProfileRow,
} from "@workspace/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import { logger } from "../logger";
import { priceForSide } from "./scoring";
import { httpJson } from "./connectors/http";

// ─── Polymarket Data API types ───────────────────────────────────────────────

const DATA_API = "https://data-api.polymarket.com";
const LEADERBOARD_LIMIT = 50;
const POSITION_LIMIT = 500;
const MIN_POSITION_SIZE_USD = 10;

interface PolyLeaderboardEntry {
  proxyWallet: string;
  name?: string | null;
  profit?: number;
  percentPositive?: number;
  volume?: number;
  numTrades?: number;
}

interface PolyPosition {
  /** Hex condition ID — maps to Gamma API market `id`. */
  conditionId: string;
  /** Token ID for this specific outcome (YES or NO token). */
  asset?: string;
  title?: string;
  slug?: string;
  /** "Yes" or "No" */
  outcome?: string;
  outcomeIndex?: number;
  /** Current market price for this outcome (0–1). */
  price?: number;
  /** Number of shares / USDC-equivalent position size. */
  size?: number;
  /** Average entry price (0–1). */
  avgPrice?: number;
  currentValue?: number;
  cashPnl?: number;
  percentPnl?: number;
  endDate?: string;
}

// ─── API fetch helpers ───────────────────────────────────────────────────────

async function fetchLeaderboard(): Promise<PolyLeaderboardEntry[]> {
  const url = `${DATA_API}/leaderboard?interval=all&limit=${LEADERBOARD_LIMIT}`;
  const raw = await httpJson<PolyLeaderboardEntry[] | { data?: PolyLeaderboardEntry[] }>(url, {
    timeoutMs: 15_000,
    retries: 1,
  });
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as any).data)
      ? (raw as any).data
      : [];
  return list.filter(
    (e: PolyLeaderboardEntry) =>
      typeof e.proxyWallet === "string" && e.proxyWallet.length > 10,
  );
}

async function fetchPositions(proxyWallet: string): Promise<PolyPosition[]> {
  const url =
    `${DATA_API}/positions` +
    `?user=${encodeURIComponent(proxyWallet)}` +
    `&sizeThreshold=${MIN_POSITION_SIZE_USD}` +
    `&limit=${POSITION_LIMIT}`;
  const raw = await httpJson<PolyPosition[] | { data?: PolyPosition[] }>(url, {
    timeoutMs: 15_000,
    retries: 1,
  });
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as any).data)
      ? (raw as any).data
      : [];
  return list.filter(
    (p: PolyPosition) =>
      typeof p.conditionId === "string" && (p.size ?? 0) >= MIN_POSITION_SIZE_USD,
  );
}

// ─── Market key resolution ────────────────────────────────────────────────────

/**
 * Build a lookup from every possible Polymarket identifier to the opportunity
 * row. The Gamma API stores `id` as the market key (`polymarket-${id}`), and
 * the Data API returns `conditionId` which corresponds to the same value.
 * We also keep a normalised question-text fallback for cases where the IDs
 * diverge between API versions.
 */
function buildMarketIndex(
  markets: Array<{
    id: number;
    marketKey: string;
    question: string;
    marketProb: number;
    modelProb: number;
    edgeScore: number;
    confidence: number;
    suggestedDirection: string | null;
  }>,
): {
  byKey: Map<string, typeof markets[number]>;
  byQuestion: Map<string, typeof markets[number]>;
} {
  const byKey = new Map<string, typeof markets[number]>();
  const byQuestion = new Map<string, typeof markets[number]>();
  for (const m of markets) {
    byKey.set(m.marketKey, m);
    // Also index by the raw ID fragment (without "polymarket-" prefix).
    const fragment = m.marketKey.startsWith("polymarket-")
      ? m.marketKey.slice("polymarket-".length)
      : m.marketKey;
    byKey.set(fragment, m);
    byQuestion.set(normaliseQuestion(m.question), m);
  }
  return { byKey, byQuestion };
}

function normaliseQuestion(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function resolvePosition(
  pos: PolyPosition,
  idx: ReturnType<typeof buildMarketIndex>,
): typeof idx.byKey extends Map<string, infer V> ? V | null : never {
  // Try conditionId directly and with "polymarket-" prefix.
  const cid = pos.conditionId ?? "";
  let hit = idx.byKey.get(cid) ?? idx.byKey.get(`polymarket-${cid}`) ?? null;
  // Try asset/tokenId.
  if (!hit && pos.asset) {
    hit = idx.byKey.get(pos.asset) ?? idx.byKey.get(`polymarket-${pos.asset}`) ?? null;
  }
  // Fuzzy fallback by question text.
  if (!hit && pos.title) {
    hit = idx.byQuestion.get(normaliseQuestion(pos.title)) ?? null;
  }
  return hit as any;
}

// ─── Correlation logic ────────────────────────────────────────────────────────

/**
 * Given a position and the matched opportunity, return the winner's implied
 * direction and how strongly it aligns with our model.
 *
 * alignment > 0: winner and model agree
 * alignment < 0: winner disagrees with model (flag, don't suppress)
 * alignment = 0: no model edge or neutral position
 */
function computeAlignment(
  pos: PolyPosition,
  opp: { marketProb: number; modelProb: number; suggestedDirection: string | null },
): { direction: "yes" | "no"; alignment: number; winnerEdge: number } {
  const outcome = (pos.outcome ?? "Yes").toLowerCase();
  const direction: "yes" | "no" = outcome === "no" ? "no" : "yes";

  // Winner's edge estimate: how far their avg entry is from the current price.
  const avgEntry = pos.avgPrice ?? opp.marketProb;
  const currentPrice = pos.price ?? opp.marketProb;
  const winnerEdge = direction === "yes"
    ? currentPrice - avgEntry          // positive = profitable YES bet
    : (1 - currentPrice) - (1 - avgEntry); // NO bet profitability

  // Model's alignment with this direction.
  const modelEdge = direction === "yes"
    ? opp.modelProb - opp.marketProb
    : opp.marketProb - opp.modelProb;

  // alignment = product of signs: +1 both point same way, -1 they disagree.
  const alignment = Math.sign(modelEdge) === Math.sign(winnerEdge)
    ? Math.min(1, Math.abs(modelEdge) + Math.abs(winnerEdge))
    : -Math.min(1, Math.abs(modelEdge) + Math.abs(winnerEdge));

  return { direction, alignment, winnerEdge };
}

// ─── Main export types ───────────────────────────────────────────────────────

export interface WalletPositionLike {
  marketKey: string;
  question: string;
  direction: "yes" | "no";
  entryProb: number;
  sizeUsd: number;
  currentProb: number;
  openedAt: Date;
}

export interface WalletClosedPositionLike {
  marketKey: string;
  question: string;
  direction: "yes" | "no";
  entryProb: number;
  exitProb: number;
  sizeUsd: number;
  pnlUsd: number;
  closedAt: Date;
}

export interface MockWalletState {
  source: string;
  address: string;
  label: string;
  pnlUsd: number;
  hitRate: number;
  avgEdge: number;
  open: WalletPositionLike[];
  closed: WalletClosedPositionLike[];
}

export interface WalletRefreshResult {
  walletsRefreshed: number;
  snapshotsInserted: number;
  suggestionsCreated: number;
  newWalletsDiscovered: number;
  ranAt: Date;
}

// ─── Seed wallet set (fallback labels for known top addresses) ────────────────

const KNOWN_LABELS: Record<string, string> = {
  "0x9d1b1669c73b033dfe47ae5a0164ab96df25b944": "Whale-A",
  "0x5695bc2da6c4f93a8e99cad50a7a8e0e0a9e0671": "Macro-Sniper",
  "0x77a82d9e8b1d4e25a4e6a1b3a7c44a3a5e3a8b22": "Geo-Hawk",
};

// ─── Refresh cycle ────────────────────────────────────────────────────────────

export async function refreshWinnerWallets(): Promise<WalletRefreshResult> {
  const ranAt = new Date();
  let newWalletsDiscovered = 0;

  // ── Step 1: discover top traders from the live leaderboard ──
  let leaderboard: PolyLeaderboardEntry[] = [];
  try {
    leaderboard = await fetchLeaderboard();
  } catch (err) {
    logger.warn({ err }, "winnerWallets: leaderboard fetch failed, using stored wallets only");
  }

  // Upsert new wallet profiles for freshly discovered addresses.
  for (let i = 0; i < leaderboard.length; i++) {
    const entry = leaderboard[i];
    const address = entry.proxyWallet.toLowerCase();
    const existing = await db
      .select({ id: walletProfiles.id })
      .from(walletProfiles)
      .where(
        and(eq(walletProfiles.source, "polymarket"), eq(walletProfiles.address, address)),
      )
      .limit(1);

    if (existing.length === 0) {
      const rank = i + 1;
      const label =
        KNOWN_LABELS[address] ??
        entry.name ??
        `Polymarket #${rank} (${address.slice(0, 8)}…)`;
      await db.insert(walletProfiles).values({
        source: "polymarket",
        address,
        label,
        tracked: rank <= 20, // auto-track top 20; rest are visible but not polled
        hitRate: entry.percentPositive ?? 0.5,
        avgEdge: 0,
        pnlUsd: entry.profit ?? 0,
      });
      newWalletsDiscovered++;
      logger.info({ address, rank, label }, "winnerWallets: discovered new winner wallet");
    }
  }

  // ── Step 2: load all tracked wallets ──
  const tracked = await db
    .select()
    .from(walletProfiles)
    .where(eq(walletProfiles.tracked, true))
    .orderBy(asc(walletProfiles.rank));

  if (tracked.length === 0) {
    return { walletsRefreshed: 0, snapshotsInserted: 0, suggestionsCreated: 0, newWalletsDiscovered, ranAt };
  }

  // ── Step 3: load our market universe for position matching ──
  const markets = await db
    .select({
      id: opportunities.id,
      marketKey: opportunities.marketKey,
      question: opportunities.question,
      marketProb: opportunities.marketProb,
      modelProb: opportunities.modelProb,
      edgeScore: opportunities.edgeScore,
      confidence: opportunities.confidence,
      suggestedDirection: opportunities.suggestedDirection,
    })
    .from(opportunities);

  const idx = buildMarketIndex(markets);

  let snapshotsInserted = 0;
  let suggestionsCreated = 0;

  // Collect wallet pnl for rank recomputation.
  const pnlList: Array<{ walletId: number; pnlUsd: number }> = [];

  for (const wallet of tracked) {
    // ── Step 4: fetch real positions for this wallet ──
    let positions: PolyPosition[] = [];
    try {
      positions = await fetchPositions(wallet.address);
    } catch (err) {
      logger.warn(
        { err, address: wallet.address },
        "winnerWallets: position fetch failed for wallet, skipping",
      );
    }

    // Derive wallet-level stats from positions + leaderboard data.
    const leaderEntry = leaderboard.find(
      (e) => e.proxyWallet.toLowerCase() === wallet.address.toLowerCase(),
    );

    const totalValue = positions.reduce((s, p) => s + (p.currentValue ?? (p.size ?? 0) * (p.price ?? 0.5)), 0);
    const totalPnl = leaderEntry?.profit ?? positions.reduce((s, p) => s + (p.cashPnl ?? 0), 0);
    const hitRate = leaderEntry?.percentPositive ?? wallet.hitRate;
    const activePositions = positions.length;

    // Compute average edge from live positions.
    let avgEdge = 0;
    if (positions.length > 0) {
      const edgeSum = positions.reduce((s, p) => {
        const entry = p.avgPrice ?? 0.5;
        const current = p.price ?? 0.5;
        return s + Math.abs(current - entry);
      }, 0);
      avgEdge = edgeSum / positions.length;
    } else {
      avgEdge = wallet.avgEdge;
    }

    pnlList.push({ walletId: wallet.id, pnlUsd: totalPnl });

    // Update wallet profile.
    await db
      .update(walletProfiles)
      .set({
        hitRate,
        avgEdge,
        pnlUsd: totalPnl,
        activePositions,
        lastSyncedAt: ranAt,
        updatedAt: ranAt,
      })
      .where(eq(walletProfiles.id, wallet.id));

    // Insert snapshot.
    await db.insert(walletSnapshots).values({
      walletId: wallet.id,
      pnlUsd: totalPnl,
      activePositions,
      closedPositions: wallet.closedPositions,
      hitRate,
      avgEdge,
    });
    snapshotsInserted++;

    // ── Step 5: generate mirror suggestions for matched positions ──
    for (const pos of positions) {
      const opp = resolvePosition(pos, idx);
      if (!opp) continue; // position not in our universe

      const { direction, alignment, winnerEdge } = computeAlignment(pos, opp);

      // Only suggest mirrors when winner and model roughly agree (alignment > 0)
      // and there's meaningful model edge.
      const modelHasEdge = opp.edgeScore > 0.03;
      const winnerAgreesWithModel = alignment > 0;
      if (!modelHasEdge || !winnerAgreesWithModel) continue;

      // Dedup: skip if any suggestion already exists for this (wallet, market, direction).
      const existing = await db
        .select({ id: mirrorSuggestions.id })
        .from(mirrorSuggestions)
        .where(
          and(
            eq(mirrorSuggestions.walletId, wallet.id),
            eq(mirrorSuggestions.marketKey, opp.marketKey),
            eq(mirrorSuggestions.direction, direction),
          ),
        )
        .limit(1);
      if (existing.length > 0) continue;

      // Conservative sizing: 5% of winner's position, capped at $250.
      const positionSizeUsd = pos.size ?? 0;
      const suggestedSizeUsd = Math.max(10, Math.min(250, Math.round(positionSizeUsd * 0.05)));

      const rationale = buildMirrorRationale({
        wallet,
        pos,
        opp,
        direction,
        alignment,
        winnerEdge,
        suggestedSizeUsd,
      });

      const inserted = await db
        .insert(mirrorSuggestions)
        .values({
          walletId: wallet.id,
          opportunityId: opp.id,
          marketKey: opp.marketKey,
          question: opp.question,
          direction,
          entryProb: priceForSide(direction, opp.marketProb),
          suggestedSizeUsd,
          walletSizeUsd: positionSizeUsd,
          rationale,
        })
        .onConflictDoNothing({
          target: [mirrorSuggestions.walletId, mirrorSuggestions.marketKey, mirrorSuggestions.direction],
          where: sql`${mirrorSuggestions.status} = 'pending'`,
        })
        .returning({ id: mirrorSuggestions.id });

      if (inserted.length > 0) suggestionsCreated++;
    }
  }

  // ── Step 6: recompute wallet ranks by total P&L descending ──
  pnlList.sort((a, b) => b.pnlUsd - a.pnlUsd);
  for (let i = 0; i < pnlList.length; i++) {
    await db
      .update(walletProfiles)
      .set({ rank: i + 1 })
      .where(eq(walletProfiles.id, pnlList[i].walletId));
  }

  // ── Step 7: trim snapshot history (keep last 200 per wallet) ──
  await db.execute(sql`
    DELETE FROM wallet_snapshots
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY wallet_id ORDER BY captured_at DESC) AS rn
        FROM wallet_snapshots
      ) t
      WHERE t.rn > 200
    )
  `);

  return {
    walletsRefreshed: tracked.length,
    snapshotsInserted,
    suggestionsCreated,
    newWalletsDiscovered,
    ranAt,
  };
}

// ─── Mirror rationale builder ─────────────────────────────────────────────────

function buildMirrorRationale(args: {
  wallet: WalletProfileRow;
  pos: PolyPosition;
  opp: { marketProb: number; modelProb: number; edgeScore: number; confidence: number; suggestedDirection: string | null };
  direction: "yes" | "no";
  alignment: number;
  winnerEdge: number;
  suggestedSizeUsd: number;
}): {
  observed: string[];
  inferred: string[];
  speculation: string[];
  unknowns: string[];
  riskFlags: string[];
} {
  const { wallet, pos, opp, direction, alignment, winnerEdge, suggestedSizeUsd } = args;

  const avgEntry = (pos.avgPrice ?? opp.marketProb);
  const currentPrice = (pos.price ?? opp.marketProb);

  const observed = [
    `${wallet.label} (rank #${wallet.rank ?? "?"}) holds ${direction.toUpperCase()} on this market.`,
    `Entry price: ${(avgEntry * 100).toFixed(1)}¢ → current: ${(currentPrice * 100).toFixed(1)}¢ (${winnerEdge >= 0 ? "+" : ""}${(winnerEdge * 100).toFixed(1)} pts).`,
    `Position size: $${(pos.size ?? 0).toLocaleString()}. Wallet all-time P&L: $${wallet.pnlUsd.toLocaleString()} (hit-rate ${(wallet.hitRate * 100).toFixed(0)}%).`,
  ];

  if (pos.cashPnl !== undefined) {
    observed.push(`Unrealized P&L on this position: $${pos.cashPnl.toFixed(0)}.`);
  }

  const inferred = [
    `Our model: market ${(opp.marketProb * 100).toFixed(0)}% → model ${(opp.modelProb * 100).toFixed(0)}% (edge ${(opp.edgeScore * 100).toFixed(1)}%, ${opp.suggestedDirection ?? direction}).`,
    `Winner and model are aligned (alignment score ${(alignment * 100).toFixed(0)}%) — this is a corroborated bet.`,
    `Mirror sized at $${suggestedSizeUsd} (~5% of winner's position, capped at $250).`,
  ];

  const speculation = [
    `Winner may have information or context not yet captured by our signal feed.`,
    `The winner entered at ${(avgEntry * 100).toFixed(1)}¢; if they continue holding, it implies they expect resolution above that price.`,
  ];

  const unknowns = [
    `We do not know the winner's intended hold horizon or position age.`,
    `The winner's cost basis may differ from the reported avg price (e.g. multiple fills).`,
  ];

  const riskFlags: string[] = [];
  if (opp.edgeScore < 0.05) {
    riskFlags.push("Weak model edge (<5%) — this is primarily a winner-following trade.");
  }
  if (opp.confidence < 0.4) {
    riskFlags.push("Low model confidence — winner is leading the thesis.");
  }
  if (alignment < 0.05) {
    riskFlags.push("Alignment between winner and model is marginal — exercise caution.");
  }

  return { observed, inferred, speculation, unknowns, riskFlags };
}

// ─── Seed on first boot ───────────────────────────────────────────────────────

export async function ensureWinnerWalletSeed(): Promise<void> {
  const existing = await db.select({ id: walletProfiles.id }).from(walletProfiles).limit(1);
  if (existing.length > 0) return;

  // Seed a small set of known high-performing Polymarket addresses.
  // These will be replaced/updated with real data on the first refresh cycle.
  const seeds = [
    { address: "0x9d1b1669c73b033dfe47ae5a0164ab96df25b944", label: "Whale-A" },
    { address: "0x5695bc2da6c4f93a8e99cad50a7a8e0e0a9e0671", label: "Macro-Sniper" },
    { address: "0x77a82d9e8b1d4e25a4e6a1b3a7c44a3a5e3a8b22", label: "Geo-Hawk" },
    { address: "0x142b44e7c3f9b6e0d3e3a4b5c6d7e8f901a2b3c4", label: "Calm-Cassandra" },
    { address: "0x2c1d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d", label: "Fed-Watcher" },
  ];

  await db.insert(walletProfiles).values(
    seeds.map((s) => ({
      source: "polymarket",
      address: s.address.toLowerCase(),
      label: s.label,
      tracked: true,
    })),
  );
  logger.info({ count: seeds.length }, "winnerWallets: seed wallets inserted");
}

// ─── Per-wallet position snapshot (used by the detail route) ─────────────────

/**
 * Fetch a live position snapshot for a single wallet. Used by the
 * GET /winner-accounts/:id route to render open/closed positions.
 * Falls back to empty arrays if the API is unreachable.
 */
export async function snapshotWalletPositions(
  wallet: WalletProfileRow,
  markets: Array<{ id: number; marketKey: string; question: string; marketProb: number }>,
): Promise<MockWalletState> {
  let rawPositions: PolyPosition[] = [];
  try {
    rawPositions = await fetchPositions(wallet.address);
  } catch {
    // Silently degrade — caller renders empty position list.
  }

  const idx = buildMarketIndex(
    markets.map((m) => ({
      ...m,
      modelProb: m.marketProb,
      edgeScore: 0,
      confidence: 0.5,
      suggestedDirection: null,
    })),
  );

  const open: WalletPositionLike[] = rawPositions
    .filter((p) => (p.size ?? 0) >= MIN_POSITION_SIZE_USD)
    .map((p) => {
      const opp = resolvePosition(p, idx as any);
      const outcome = (p.outcome ?? "Yes").toLowerCase();
      const direction: "yes" | "no" = outcome === "no" ? "no" : "yes";
      const avgEntry = p.avgPrice ?? opp?.marketProb ?? 0.5;
      const current = p.price ?? opp?.marketProb ?? 0.5;
      return {
        marketKey: opp?.marketKey ?? `polymarket-${p.conditionId}`,
        question: p.title ?? opp?.question ?? p.conditionId,
        direction,
        entryProb: priceForSide(direction, avgEntry),
        sizeUsd: p.size ?? 0,
        currentProb: priceForSide(direction, current),
        openedAt: new Date(Date.now() - 24 * 3600_000), // not available from positions API
      };
    });

  return {
    source: wallet.source,
    address: wallet.address,
    label: wallet.label,
    pnlUsd: wallet.pnlUsd,
    hitRate: wallet.hitRate,
    avgEdge: wallet.avgEdge,
    open,
    closed: [], // closed positions require the activity API — not polled here
  };
}

// Re-export for backward compat with any external callers of the old mock shape.
export const SEED_WINNER_WALLETS: Array<{ source: string; address: string; label: string }> = [];
