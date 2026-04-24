/**
 * Seed minimal initial state: ensure a single risk_config row exists. The
 * opportunity/signal universe is populated by the OpenClaw orchestrator on
 * first cycle, so the dashboard is never empty.
 */

import { db } from "@workspace/db";
import { riskConfig } from "@workspace/db";

export async function ensureSeed(): Promise<void> {
  const existing = await db.select().from(riskConfig).limit(1);
  if (existing.length === 0) {
    await db.insert(riskConfig).values({});
  }
}
