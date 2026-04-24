/**
 * Cassandra extended memory + safety schema. These tables back the
 * connector-status board, anomaly + candidate pipelines, narrative + entity
 * memory, historical patterns/parallels, signal-effectiveness calibration,
 * and the kill-switch / autopilot safety surfaces.
 *
 * Most are scaffolding the foundation seeds and unit tests exercise; the
 * follow-up tasks fill them in with deeper analytics.
 */

import {
  pgTable,
  serial,
  text,
  doublePrecision,
  integer,
  jsonb,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";

// ---------- short-term memory ----------

export const observations = pgTable("observations", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(),
  domain: text("domain").notNull(),
  body: text("body").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
});

export const narratives = pgTable("narratives", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  description: text("description"),
  velocity: doublePrecision("velocity").notNull().default(0),
  decay: doublePrecision("decay").notNull().default(0),
  recurrence: integer("recurrence").notNull().default(0),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
});

export const marketContext = pgTable("market_context", {
  id: serial("id").primaryKey(),
  marketKey: text("market_key").notNull(),
  source: text("source").notNull(),
  context: jsonb("context").$type<Record<string, unknown>>().notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
});

export const anomalies = pgTable("anomalies", {
  id: serial("id").primaryKey(),
  domain: text("domain").notNull(),
  kind: text("kind").notNull(),
  severity: doublePrecision("severity").notNull(),
  description: text("description").notNull(),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().default({}).notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow().notNull(),
});

export const opportunityCandidates = pgTable("opportunity_candidates", {
  id: serial("id").primaryKey(),
  marketKey: text("market_key").notNull(),
  source: text("source").notNull(),
  rationale: text("rationale").notNull(),
  rawScore: doublePrecision("raw_score").notNull(),
  status: text("status", { enum: ["pending", "promoted", "discarded"] }).notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const connectorStatus = pgTable("connector_status", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  status: text("status", { enum: ["ok", "degraded", "error", "idle"] }).notNull().default("idle"),
  mockDataMode: boolean("mock_data_mode").notNull().default(true),
  lastSuccessfulRun: timestamp("last_successful_run", { withTimezone: true }),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const investigations = pgTable("investigations", {
  id: serial("id").primaryKey(),
  topic: text("topic").notNull(),
  status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
  summary: text("summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const agentTasks = pgTable("agent_tasks", {
  id: serial("id").primaryKey(),
  agent: text("agent").notNull(),
  kind: text("kind").notNull(),
  status: text("status", { enum: ["queued", "running", "ok", "error"] }).notNull().default("queued"),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
  result: jsonb("result").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const chatContext = pgTable("chat_context", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id"),
  role: text("role").notNull(),
  contextSnapshot: jsonb("context_snapshot").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------- long-term memory ----------

export const opportunityScoreSnapshots = pgTable("opportunity_score_snapshots", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id").notNull(),
  marketProb: doublePrecision("market_prob").notNull(),
  modelProb: doublePrecision("model_prob").notNull(),
  edgeScore: doublePrecision("edge_score").notNull(),
  confidence: doublePrecision("confidence").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tradePlans = pgTable("trade_plans", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id").notNull(),
  direction: text("direction", { enum: ["yes", "no"] }).notNull(),
  entryZone: jsonb("entry_zone").$type<{ low: number; high: number }>().notNull(),
  cashOutLadder: jsonb("cash_out_ladder").$type<Array<{ price: number; fraction: number }>>().notNull(),
  exitStrategy: text("exit_strategy").notNull(),
  invalidations: jsonb("invalidations").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const paperTradeOutcomes = pgTable("paper_trade_outcomes", {
  id: serial("id").primaryKey(),
  paperTradeId: integer("paper_trade_id").notNull(),
  realizedPnlUsd: doublePrecision("realized_pnl_usd").notNull(),
  whatWasRight: text("what_was_right"),
  whatWasWrong: text("what_was_wrong"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
});

export const signalEffectiveness = pgTable("signal_effectiveness", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(),
  kind: text("kind").notNull(),
  domain: text("domain").notNull(),
  hits: integer("hits").notNull().default(0),
  misses: integer("misses").notNull().default(0),
  hitRate: doublePrecision("hit_rate").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sourceReliability = pgTable("source_reliability", {
  id: serial("id").primaryKey(),
  source: text("source").notNull().unique(),
  reliability: doublePrecision("reliability").notNull().default(0.5),
  sampleSize: integer("sample_size").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const entityProfiles = pgTable("entity_profiles", {
  id: serial("id").primaryKey(),
  entity: text("entity").notNull().unique(),
  kind: text("kind").notNull(),
  notes: text("notes"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const narrativeClusters = pgTable("narrative_clusters", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  centroid: jsonb("centroid").$type<Record<string, number>>().notNull(),
  size: integer("size").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const historicalPatterns = pgTable("historical_patterns", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  description: text("description").notNull(),
  domain: text("domain").notNull(),
  fingerprint: jsonb("fingerprint").$type<Record<string, unknown>>().notNull(),
  baseRate: doublePrecision("base_rate").notNull().default(0.5),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const historicalParallels = pgTable("historical_parallels", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id"),
  patternId: integer("pattern_id"),
  label: text("label").notNull(),
  summary: text("summary").notNull(),
  outcome: text("outcome"),
  similarity: doublePrecision("similarity").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const thesisProfiles = pgTable("thesis_profiles", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  description: text("description").notNull(),
  status: text("status", { enum: ["active", "retired"] }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const scoringModelVersions = pgTable("scoring_model_versions", {
  id: serial("id").primaryKey(),
  version: text("version").notNull().unique(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------- safety ----------

export const killSwitchEvents = pgTable("kill_switch_events", {
  id: serial("id").primaryKey(),
  engaged: boolean("engaged").notNull(),
  actor: text("actor").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Stub for autopilot. In this build all fields are read-only and
 * `enabled` cannot be flipped to true via the API; the live trading layer
 * is intentionally absent. Present so follow-up tasks can wire it in
 * without a destructive migration.
 */
export const autopilotConfig = pgTable("autopilot_config", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  paperEnabled: boolean("paper_enabled").notNull().default(false),
  approvalQueueRequired: boolean("approval_queue_required").notNull().default(true),
  maxConcurrentPositions: integer("max_concurrent_positions").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ConnectorStatusRow = typeof connectorStatus.$inferSelect;
export type AnomalyRow = typeof anomalies.$inferSelect;
export type OpportunityCandidateRow = typeof opportunityCandidates.$inferSelect;
export type HistoricalParallelRow = typeof historicalParallels.$inferSelect;
export type SignalEffectivenessRow = typeof signalEffectiveness.$inferSelect;
export type SourceReliabilityRow = typeof sourceReliability.$inferSelect;
