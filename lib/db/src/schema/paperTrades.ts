import {
  pgTable,
  serial,
  text,
  timestamp,
  doublePrecision,
  integer,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { opportunities } from "./opportunities";

export const paperTrades = pgTable("paper_trades", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id")
    .notNull()
    .references(() => opportunities.id, { onDelete: "cascade" }),
  marketKey: text("market_key").notNull(),
  question: text("question").notNull(),
  direction: text("direction").notNull(),
  sizeUsd: doublePrecision("size_usd").notNull(),
  entryProb: doublePrecision("entry_prob").notNull(),
  exitProb: doublePrecision("exit_prob"),
  status: text("status").notNull().default("open"),
  pnlUsd: doublePrecision("pnl_usd"),
  rationale: text("rationale"),
  openedAt: timestamp("opened_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const insertPaperTradeSchema = createInsertSchema(paperTrades).omit({
  id: true,
  openedAt: true,
  closedAt: true,
  exitProb: true,
  pnlUsd: true,
  status: true,
});

export type PaperTrade = typeof paperTrades.$inferSelect;
export type InsertPaperTrade = z.infer<typeof insertPaperTradeSchema>;
