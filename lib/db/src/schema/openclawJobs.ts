import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const openclawJobs = pgTable(
  "openclaw_jobs",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    message: text("message"),
  },
  (table) => [index("openclaw_jobs_started_at_idx").on(table.startedAt)],
);

export const insertOpenClawJobSchema = createInsertSchema(openclawJobs).omit({
  id: true,
  startedAt: true,
  finishedAt: true,
  durationMs: true,
});

export type OpenClawJobRow = typeof openclawJobs.$inferSelect;
export type InsertOpenClawJob = z.infer<typeof insertOpenClawJobSchema>;
