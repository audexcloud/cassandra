import {
  pgTable,
  serial,
  text,
  timestamp,
  doublePrecision,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const journalEntries = pgTable("journal_entries", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  domain: text("domain").notNull(),
  question: text("question").notNull(),
  forecastProb: doublePrecision("forecast_prob").notNull(),
  horizonDays: integer("horizon_days"),
  observed: jsonb("observed").notNull().default([]),
  inferred: jsonb("inferred").notNull().default([]),
  speculation: jsonb("speculation").notNull().default([]),
  unknowns: jsonb("unknowns").notNull().default([]),
  outcome: text("outcome").default("pending"),
  outcomeProb: doublePrecision("outcome_prob"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const insertJournalEntrySchema = createInsertSchema(journalEntries).omit({
  id: true,
  createdAt: true,
  outcome: true,
  outcomeProb: true,
});

export type JournalEntry = typeof journalEntries.$inferSelect;
export type InsertJournalEntry = z.infer<typeof insertJournalEntrySchema>;
