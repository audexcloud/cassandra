import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { conversations } from "./conversations";

// Short-term memory: per-conversation context that the agent rolls up between turns.
export const agentMemoryShort = pgTable(
  "agent_memory_short",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    facts: jsonb("facts").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("agent_memory_short_conversation_id_idx").on(table.conversationId),
  ],
);

// Long-term memory: durable facts and stances that survive across conversations.
export const agentMemoryLong = pgTable("agent_memory_long", {
  id: serial("id").primaryKey(),
  topic: text("topic").notNull(),
  fact: text("fact").notNull(),
  source: text("source"),
  weight: integer("weight").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const insertAgentMemoryShortSchema = createInsertSchema(
  agentMemoryShort,
).omit({ id: true, createdAt: true });
export const insertAgentMemoryLongSchema = createInsertSchema(
  agentMemoryLong,
).omit({ id: true, createdAt: true });

export type AgentMemoryShort = typeof agentMemoryShort.$inferSelect;
export type AgentMemoryLong = typeof agentMemoryLong.$inferSelect;
export type InsertAgentMemoryShort = z.infer<typeof insertAgentMemoryShortSchema>;
export type InsertAgentMemoryLong = z.infer<typeof insertAgentMemoryLongSchema>;
