import {
  pgTable,
  serial,
  text,
  timestamp,
  doublePrecision,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { opportunities } from "./opportunities";

export const signalEvents = pgTable(
  "signal_events",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id").references(() => opportunities.id, {
      onDelete: "set null",
    }),
    domain: text("domain").notNull(),
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    impact: doublePrecision("impact").notNull(),
    sentiment: doublePrecision("sentiment").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("signal_events_observed_at_idx").on(table.observedAt)],
);

export const insertSignalEventSchema = createInsertSchema(signalEvents).omit({
  id: true,
  observedAt: true,
});

export type SignalEvent = typeof signalEvents.$inferSelect;
export type InsertSignalEvent = z.infer<typeof insertSignalEventSchema>;
