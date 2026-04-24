import {
  pgTable,
  serial,
  text,
  timestamp,
  doublePrecision,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const opportunities = pgTable(
  "opportunities",
  {
    id: serial("id").primaryKey(),
    marketKey: text("market_key").notNull(),
    source: text("source").notNull(),
    domain: text("domain").notNull(),
    question: text("question").notNull(),
    marketProb: doublePrecision("market_prob").notNull(),
    modelProb: doublePrecision("model_prob").notNull(),
    edge: doublePrecision("edge").notNull(),
    edgeScore: doublePrecision("edge_score").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    liquidity: doublePrecision("liquidity").notNull(),
    spread: doublePrecision("spread").notNull().default(0),
    kellyFraction: doublePrecision("kelly_fraction").notNull(),
    suggestedDirection: text("suggested_direction").notNull(),
    url: text("url"),
    rationale: jsonb("rationale").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("opportunities_source_market_key_idx").on(
      table.source,
      table.marketKey,
    ),
  ],
);

export const insertOpportunitySchema = createInsertSchema(opportunities).omit({
  id: true,
  updatedAt: true,
});

export type Opportunity = typeof opportunities.$inferSelect;
export type InsertOpportunity = z.infer<typeof insertOpportunitySchema>;
