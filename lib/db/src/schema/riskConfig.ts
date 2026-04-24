import {
  pgTable,
  serial,
  boolean,
  doublePrecision,
  timestamp,
} from "drizzle-orm/pg-core";

export const riskConfig = pgTable("risk_config", {
  id: serial("id").primaryKey(),
  killSwitchEngaged: boolean("kill_switch_engaged").notNull().default(false),
  liveExecutionEnabled: boolean("live_execution_enabled").notNull().default(false),
  maxKellyFraction: doublePrecision("max_kelly_fraction").notNull().default(0.25),
  maxPositionUsd: doublePrecision("max_position_usd").notNull().default(500),
  bankrollUsd: doublePrecision("bankroll_usd").notNull().default(10000),
  minConfidence: doublePrecision("min_confidence").notNull().default(0),
  minLiquidityUsd: doublePrecision("min_liquidity_usd").notNull().default(0),
  minEdgeScore: doublePrecision("min_edge_score").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type RiskConfigRow = typeof riskConfig.$inferSelect;
