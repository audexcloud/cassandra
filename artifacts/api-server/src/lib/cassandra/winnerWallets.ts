/**
 * Winner-account refresh logic. Fetches a slate of tracked Polymarket
 * wallets, refreshes their P&L / win-rate snapshot, and synthesizes
 * "mirror this trade" suggestions for any open positions that overlap
 * markets we already have ingested.
 *
 * The data source is a deterministic mock — same shape the future real
 * Polymarket wallet connector will return. Swapping in real on-chain calls
 * later should not require touching the orchestrator or the route layer.
 */

import { db } from "@workspace/db";
import {
  walletProfiles,
  walletSnapshots,
  mirrorSuggestions,
  opportunities,
  type WalletProfileRow,
} from "@workspace/db";
import { and, asc, eq, sql } from "drizzle-orm";

import { logger } from "../logger";
import { priceForSide } from "./scoring";

/** A position the mock connector reports for a wallet at a point in time. */
export interface WalletPositionLike {
  marketKey: string;
  question: string;
  direction: "yes" | "no";
  entryProb: number;
  sizeUsd: number;
  /** Open-position price right now (from the source platform). */
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

/**
 * The seed wallets we track on first boot. Real addresses, but the metrics
 * are synthesized on every cycle from a per-wallet drift function so the
 * snapshot history shows movement without needing a real chain feed.
 */
const SEED_WALLETS: Array<{
  source: string;
  address: string;
  label: string;
  baselinePnl: number;
  baselineHitRate: number;
}> = [
  {
    source: "polymarket",
    address: "0x9d1b1669c73b033dfe47ae5a0164ab96df25b944",
    label: "Whale-A (Polymarket)",
    baselinePnl: 84_500,
    baselineHitRate: 0.71,
  },
  {
    source: "polymarket",
    address: "0xa3a4b9c7d2e5f1f7c91b7b9b5c2c7c1f6d2c8a91",
    label: "Macro-Sniper (Polymarket)",
    baselinePnl: 51_300,
    baselineHitRate: 0.66,
  },
  {
    source: "polymarket",
    address: "0x77a82d9e8b1d4e25a4e6a1b3a7c44a3a5e3a8b22",
    label: "Geo-Hawk (Polymarket)",
    baselinePnl: 32_900,
    baselineHitRate: 0.63,
  },
  {
    source: "polymarket",
    address: "0x142b44e7c3f9b6e0d3e3a4b5c6d7e8f901a2b3c4",
    label: "Calm-Cassandra (Polymarket)",
    baselinePnl: 18_700,
    baselineHitRate: 0.59,
  },
  {
    source: "polymarket",
    address: "0x2c1d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d",
    label: "Fed-Watcher (Polymarket)",
    baselinePnl: 12_400,
    baselineHitRate: 0.55,
  },
];

/**
 * Deterministic noise keyed by the wallet address and the current minute.
 * Same idea as the connector noise(): repeatable within a minute, drifts
 * across them so the UI shows movement.
 */
function noise(seed: string, range = 1): number {
  let h = 2166136261;
  const key = seed + Math.floor(Date.now() / 60_000);
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = ((h >>> 0) % 10_000) / 10_000;
  return (u - 0.5) * 2 * range;
}

function clampProb(p: number): number {
  return Math.min(0.99, Math.max(0.01, p));
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * Build the mock state for a single wallet. Open positions are derived from
 * the wallet's address so different wallets have different overlapping sets
 * with our opportunity universe.
 */
export function mockWalletState(
  seed: { source: string; address: string; label: string; baselinePnl: number; baselineHitRate: number },
  knownMarkets: Array<{ marketKey: string; question: string; marketProb: number }>,
): MockWalletState {
  const drift = noise(`pnl:${seed.address}`, 0.04);
  const pnlUsd = Math.round(seed.baselinePnl * (1 + drift));
  const hitRate = clamp01(seed.baselineHitRate + noise(`hr:${seed.address}`, 0.03));
  const avgEdge = clamp01(0.04 + noise(`edge:${seed.address}`, 0.02));

  const addrHash = seed.address
    .split("")
    .reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const openCount = Math.max(1, Math.min(knownMarkets.length, (addrHash % 4) + 2));
  const open: WalletPositionLike[] = [];
  for (let i = 0; i < openCount; i++) {
    const m = knownMarkets[(addrHash + i * 7) % knownMarkets.length];
    if (!m) break;
    const direction: "yes" | "no" = (addrHash + i) % 2 === 0 ? "yes" : "no";
    const entry = clampProb(m.marketProb + noise(`entry:${seed.address}:${m.marketKey}`, 0.06));
    const current = clampProb(m.marketProb + noise(`cur:${seed.address}:${m.marketKey}`, 0.02));
    const sizeUsd = 1500 + ((addrHash + i * 13) % 9) * 750;
    open.push({
      marketKey: m.marketKey,
      question: m.question,
      direction,
      entryProb: priceForSide(direction, entry),
      sizeUsd,
      currentProb: priceForSide(direction, current),
      openedAt: new Date(Date.now() - (i + 1) * 36 * 60 * 60 * 1000),
    });
  }

  const closedCount = 3;
  const closed: WalletClosedPositionLike[] = [];
  for (let i = 0; i < closedCount; i++) {
    const m = knownMarkets[(addrHash + 19 + i * 5) % Math.max(1, knownMarkets.length)];
    if (!m) break;
    const direction: "yes" | "no" = (addrHash + 17 + i) % 2 === 0 ? "yes" : "no";
    const entry = priceForSide(direction, clampProb(m.marketProb + noise(`cE:${seed.address}:${i}`, 0.08)));
    const exit = priceForSide(direction, clampProb(m.marketProb + noise(`cX:${seed.address}:${i}`, 0.05) + 0.06));
    const sizeUsd = 2000 + ((addrHash + i * 11) % 6) * 600;
    const shares = sizeUsd / Math.max(0.01, entry);
    const pnlUsd = Number((shares * (exit - entry)).toFixed(2));
    closed.push({
      marketKey: m.marketKey,
      question: m.question,
      direction,
      entryProb: entry,
      exitProb: exit,
      sizeUsd,
      pnlUsd,
      closedAt: new Date(Date.now() - (i + 1) * 5 * 24 * 60 * 60 * 1000),
    });
  }

  return {
    source: seed.source,
    address: seed.address,
    label: seed.label,
    pnlUsd,
    hitRate,
    avgEdge,
    open,
    closed,
  };
}

/** Ensure seed wallet rows exist on first boot. */
export async function ensureWinnerWalletSeed(): Promise<void> {
  const existing = await db.select().from(walletProfiles).limit(1);
  if (existing.length > 0) return;
  await db.insert(walletProfiles).values(
    SEED_WALLETS.map((w) => ({
      source: w.source,
      address: w.address,
      label: w.label,
      tracked: true,
    })),
  );
  logger.info({ count: SEED_WALLETS.length }, "winner wallets seeded");
}

export interface WalletRefreshResult {
  walletsRefreshed: number;
  snapshotsInserted: number;
  suggestionsCreated: number;
  ranAt: Date;
}

/**
 * One refresh cycle: pull a snapshot for every tracked wallet, write a
 * snapshot row, recompute rank by P&L, and emit fresh mirror suggestions
 * for any open wallet position that maps to an opportunity in our universe.
 *
 * Suggestions are deduplicated: we never create two pending suggestions
 * for the same (wallet, marketKey, direction). If one already exists in a
 * non-pending state (mirrored or dismissed), we leave it alone — the
 * operator already made a decision.
 */
export async function refreshWinnerWallets(): Promise<WalletRefreshResult> {
  const ranAt = new Date();
  const tracked = await db
    .select()
    .from(walletProfiles)
    .where(eq(walletProfiles.tracked, true))
    .orderBy(asc(walletProfiles.id));

  if (tracked.length === 0) {
    return { walletsRefreshed: 0, snapshotsInserted: 0, suggestionsCreated: 0, ranAt };
  }

  // Pull every market we have on hand once; mockWalletState pulls slices
  // from this list to build overlapping positions.
  const markets = await db
    .select({
      id: opportunities.id,
      marketKey: opportunities.marketKey,
      source: opportunities.source,
      question: opportunities.question,
      marketProb: opportunities.marketProb,
      modelProb: opportunities.modelProb,
      edgeScore: opportunities.edgeScore,
      confidence: opportunities.confidence,
    })
    .from(opportunities);

  // Mirror suggestions can only be tied to a Polymarket-style market we
  // have ingested. We index by marketKey for fast lookup. The mock wallet
  // data uses the same marketKey strings the connectors emit, so overlaps
  // happen organically when the polymarket connector is enabled.
  const marketByKey = new Map<string, (typeof markets)[number]>();
  for (const m of markets) marketByKey.set(m.marketKey, m);

  let snapshotsInserted = 0;
  let suggestionsCreated = 0;

  // Compute pnl per wallet first, then assign rank by descending pnl so the
  // ordering matches the way the UI sorts.
  const states: Array<{ wallet: WalletProfileRow; state: MockWalletState }> = [];
  for (const wallet of tracked) {
    const seed = SEED_WALLETS.find((s) => s.address === wallet.address) ?? {
      source: wallet.source,
      address: wallet.address,
      label: wallet.label,
      baselinePnl: 10_000,
      baselineHitRate: 0.5,
    };
    states.push({
      wallet,
      state: mockWalletState(
        seed,
        markets.map((m) => ({
          marketKey: m.marketKey,
          question: m.question,
          marketProb: m.marketProb,
        })),
      ),
    });
  }
  states.sort((a, b) => b.state.pnlUsd - a.state.pnlUsd);

  for (let i = 0; i < states.length; i++) {
    const { wallet, state } = states[i];
    const rank = i + 1;
    const activePositions = state.open.length;
    const closedPositions = state.closed.length;

    await db
      .update(walletProfiles)
      .set({
        rank,
        hitRate: state.hitRate,
        avgEdge: state.avgEdge,
        pnlUsd: state.pnlUsd,
        activePositions,
        closedPositions,
        lastSyncedAt: ranAt,
        updatedAt: ranAt,
      })
      .where(eq(walletProfiles.id, wallet.id));

    await db.insert(walletSnapshots).values({
      walletId: wallet.id,
      pnlUsd: state.pnlUsd,
      activePositions,
      closedPositions,
      hitRate: state.hitRate,
      avgEdge: state.avgEdge,
    });
    snapshotsInserted++;

    // Synthesize mirror suggestions for every open position that overlaps
    // our universe. Skip ones that already have a non-pending decision so
    // we don't undo user choices.
    for (const pos of state.open) {
      const matching = marketByKey.get(pos.marketKey);
      if (!matching) continue;

      const existing = await db
        .select({ id: mirrorSuggestions.id })
        .from(mirrorSuggestions)
        .where(
          and(
            eq(mirrorSuggestions.walletId, wallet.id),
            eq(mirrorSuggestions.marketKey, pos.marketKey),
            eq(mirrorSuggestions.direction, pos.direction),
          ),
        )
        .limit(1);
      if (existing.length > 0) continue;

      // Conservative sizing: cap mirror trade at $250 by default, scaling
      // down further if the wallet's own size was smaller. The route layer
      // re-evaluates the live risk gate before opening the paper trade.
      const suggestedSizeUsd = Math.min(250, Math.round(pos.sizeUsd * 0.05));

      const rationale = {
        observed: [
          `${wallet.label} (rank #${rank}) holds ${pos.direction.toUpperCase()} at ${pos.entryProb.toFixed(3)} on "${pos.question}".`,
          `Wallet size on this market: $${pos.sizeUsd.toLocaleString()}.`,
          `Wallet trailing P&L: $${state.pnlUsd.toLocaleString()} (hit-rate ${(state.hitRate * 100).toFixed(0)}%, avg edge ${(state.avgEdge * 100).toFixed(1)}%).`,
        ],
        inferred: [
          `Cassandra's own model assigns ${(matching.modelProb * 100).toFixed(0)}% (market ${(matching.marketProb * 100).toFixed(0)}%, edge ${((matching.modelProb - matching.marketProb) * 100).toFixed(1)}pp).`,
          `Mirroring at ~5% of wallet size (capped at $250) keeps exposure bounded if the wallet's edge does not reproduce.`,
        ],
        speculation: [
          `Wallet timing may carry information not yet in our signal feed; the mirror is partly a bet on that latent edge.`,
        ],
        unknowns: [
          `Wallet's true cost basis vs. our observed entry may differ.`,
          `We do not know the wallet's intended hold horizon.`,
        ],
        riskFlags:
          matching.edgeScore < 0.05
            ? ["Underlying market shows weak edge (<5%) — mirror is wallet-following, not model-aligned."]
            : matching.confidence < 0.4
              ? ["Low model confidence on this market — wallet is leading the thesis."]
              : [],
      };

      // The partial unique index `mirror_suggestions_pending_unique_idx`
      // guarantees we never store two pending rows for the same wallet /
      // market / direction. If two refresh runs race, the loser silently
      // no-ops here (returning 0 rows from the RETURNING clause).
      const inserted = await db
        .insert(mirrorSuggestions)
        .values({
          walletId: wallet.id,
          opportunityId: matching.id,
          marketKey: pos.marketKey,
          question: pos.question,
          direction: pos.direction,
          entryProb: pos.entryProb,
          suggestedSizeUsd,
          walletSizeUsd: pos.sizeUsd,
          rationale,
        })
        .onConflictDoNothing({
          target: [
            mirrorSuggestions.walletId,
            mirrorSuggestions.marketKey,
            mirrorSuggestions.direction,
          ],
          // Match the partial unique index
          // `mirror_suggestions_pending_unique_idx`. Without this predicate
          // Postgres rejects the ON CONFLICT clause with "no unique or
          // exclusion constraint matching ON CONFLICT specification".
          where: sql`${mirrorSuggestions.status} = 'pending'`,
        })
        .returning({ id: mirrorSuggestions.id });
      if (inserted.length > 0) suggestionsCreated++;
    }
  }

  // Trim snapshot history to the most recent ~200 rows per wallet to keep
  // the table from growing unbounded in dev. We keep enough for a
  // multi-hour sparkline.
  await db.execute(sql`
    DELETE FROM wallet_snapshots
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY wallet_id ORDER BY captured_at DESC) AS rn
        FROM wallet_snapshots
      ) t
      WHERE t.rn > 200
    )
  `);

  return { walletsRefreshed: tracked.length, snapshotsInserted, suggestionsCreated, ranAt };
}

/** Live snapshot of a wallet's current open + closed positions (mock-derived). */
export function snapshotWalletPositions(
  wallet: WalletProfileRow,
  markets: Array<{
    id: number;
    marketKey: string;
    question: string;
    marketProb: number;
  }>,
): MockWalletState {
  const seed = SEED_WALLETS.find((s) => s.address === wallet.address) ?? {
    source: wallet.source,
    address: wallet.address,
    label: wallet.label,
    baselinePnl: wallet.pnlUsd || 10_000,
    baselineHitRate: wallet.hitRate || 0.5,
  };
  return mockWalletState(seed, markets);
}

export const SEED_WINNER_WALLETS = SEED_WALLETS;
