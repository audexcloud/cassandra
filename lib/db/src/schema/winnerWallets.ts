/**
 * Winner-account tracking. These tables back the "Winner Accounts" surface,
 * which observes high-performing prediction-market wallets (initially
 * Polymarket), ranks them, snapshots their P&L curve, and records mirror-
 * trade suggestions linking back to paper trades.
 *
 * - walletProfiles: one row per tracked wallet, with rank/hit-rate/edge/notes
 *   and the latest cached snapshot fields for cheap list rendering.
 * - walletSnapshots: time-series of P&L + active-position counts. Drives the
 *   per-wallet sparkline and the rank stability indicator.
 * - mirrorSuggestions: each "mirror this trade" suggestion the orchestrator
 *   surfaces, with structured Reasoning Summary and an optional link to the
 *   paper trade that was actually opened from it (audit trail).
 */

import {
  pgTable,
  serial,
  text,
  timestamp,
  doublePrecision,
  integer,
  jsonb,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { paperTrades } from "./paperTrades";
import { opportunities } from "./opportunities";

export const walletProfiles = pgTable(
  "wallet_profiles",
  {
    id: serial("id").primaryKey(),
    /** Source platform (e.g. "polymarket"). */
    source: text("source").notNull(),
    /** On-chain address or platform-native id. */
    address: text("address").notNull(),
    /** Display label shown in the UI; defaults to a truncated address. */
    label: text("label").notNull(),
    /** Free-text notes the operator can attach. */
    notes: text("notes"),
    /** Current rank (1 = best). Recomputed each refresh; null while seeding. */
    rank: integer("rank"),
    /** Win-rate over closed positions (0-1). */
    hitRate: doublePrecision("hit_rate").notNull().default(0),
    /** Average edge per closed position (signed; positive = winning). */
    avgEdge: doublePrecision("avg_edge").notNull().default(0),
    /** Realized + unrealized P&L in USD, latest snapshot. */
    pnlUsd: doublePrecision("pnl_usd").notNull().default(0),
    /** Number of active positions in the latest snapshot. */
    activePositions: integer("active_positions").notNull().default(0),
    /** Number of closed positions used to compute hitRate / avgEdge. */
    closedPositions: integer("closed_positions").notNull().default(0),
    /** Last time the orchestrator refreshed this wallet's snapshot. */
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /** Whether the orchestrator should keep refreshing this wallet. */
    tracked: boolean("tracked").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("wallet_profiles_source_address_idx").on(
      table.source,
      table.address,
    ),
  ],
);

export const walletSnapshots = pgTable(
  "wallet_snapshots",
  {
    id: serial("id").primaryKey(),
    walletId: integer("wallet_id")
      .notNull()
      .references(() => walletProfiles.id, { onDelete: "cascade" }),
    pnlUsd: doublePrecision("pnl_usd").notNull(),
    activePositions: integer("active_positions").notNull(),
    closedPositions: integer("closed_positions").notNull(),
    hitRate: doublePrecision("hit_rate").notNull(),
    avgEdge: doublePrecision("avg_edge").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("wallet_snapshots_wallet_idx").on(table.walletId, table.capturedAt),
  ],
);

export const mirrorSuggestions = pgTable(
  "mirror_suggestions",
  {
    id: serial("id").primaryKey(),
    walletId: integer("wallet_id")
      .notNull()
      .references(() => walletProfiles.id, { onDelete: "cascade" }),
    /**
     * Linked opportunity if the wallet is trading a market we already track.
     * Nullable because winner wallets sometimes trade markets we have not
     * ingested yet.
     */
    opportunityId: integer("opportunity_id").references(() => opportunities.id, {
      onDelete: "set null",
    }),
    marketKey: text("market_key").notNull(),
    question: text("question").notNull(),
    direction: text("direction", { enum: ["yes", "no"] }).notNull(),
    /** Wallet's entry price on the market (0-1). */
    entryProb: doublePrecision("entry_prob").notNull(),
    /** Suggested USD size for the operator's mirror trade. */
    suggestedSizeUsd: doublePrecision("suggested_size_usd").notNull(),
    /** Wallet position size on the source market (in USD or shares-equivalent). */
    walletSizeUsd: doublePrecision("wallet_size_usd").notNull(),
    /**
     * Structured reasoning attached to the suggestion, mirroring the
     * Rationale shape used elsewhere in the app.
     */
    rationale: jsonb("rationale")
      .$type<{
        observed: string[];
        inferred: string[];
        speculation: string[];
        unknowns: string[];
        riskFlags: string[];
      }>()
      .notNull(),
    status: text("status", {
      enum: ["pending", "mirrored", "dismissed"],
    })
      .notNull()
      .default("pending"),
    /**
     * Audit link: when the operator clicks "mirror this trade" we record the
     * resulting paper-trade id here so the suggestion -> action chain is
     * traceable.
     */
    paperTradeId: integer("paper_trade_id").references(() => paperTrades.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("mirror_suggestions_wallet_idx").on(table.walletId),
    index("mirror_suggestions_status_idx").on(table.status),
    // Hardens dedupe: at most one pending suggestion per
    // (wallet, market, direction). Concurrent refresh runs that race on the
    // same wallet position will collide on this index instead of producing
    // duplicate "mirror this trade" cards in the UI.
    uniqueIndex("mirror_suggestions_pending_unique_idx")
      .on(table.walletId, table.marketKey, table.direction)
      .where(sql`status = 'pending'`),
  ],
);

export const insertWalletProfileSchema = createInsertSchema(walletProfiles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertWalletSnapshotSchema = createInsertSchema(walletSnapshots).omit({
  id: true,
  capturedAt: true,
});

export const insertMirrorSuggestionSchema = createInsertSchema(mirrorSuggestions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  paperTradeId: true,
  status: true,
});

export type WalletProfileRow = typeof walletProfiles.$inferSelect;
export type WalletSnapshotRow = typeof walletSnapshots.$inferSelect;
export type MirrorSuggestionRow = typeof mirrorSuggestions.$inferSelect;

export type InsertWalletProfile = z.infer<typeof insertWalletProfileSchema>;
export type InsertWalletSnapshot = z.infer<typeof insertWalletSnapshotSchema>;
export type InsertMirrorSuggestion = z.infer<typeof insertMirrorSuggestionSchema>;
