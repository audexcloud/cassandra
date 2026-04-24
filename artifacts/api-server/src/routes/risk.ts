import { Router, type IRouter } from "express";
import {
  GetRiskConfigResponse,
  UpdateRiskConfigBody,
  UpdateRiskConfigResponse,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import { riskConfig, auditLog, killSwitchEvents } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

async function loadOrInit() {
  const [existing] = await db.select().from(riskConfig).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(riskConfig).values({}).returning();
  return created;
}

function serialize(row: typeof riskConfig.$inferSelect) {
  return {
    killSwitchEngaged: row.killSwitchEngaged,
    // liveExecutionEnabled is hard-pinned to false at the response layer in
    // this build; live execution is unimplemented and intentionally so.
    liveExecutionEnabled: false,
    maxKellyFraction: row.maxKellyFraction,
    maxPositionUsd: row.maxPositionUsd,
    bankrollUsd: row.bankrollUsd,
    minConfidence: row.minConfidence,
    minLiquidityUsd: row.minLiquidityUsd,
    minEdgeScore: row.minEdgeScore,
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/risk/config", async (_req, res) => {
  const row = await loadOrInit();
  res.json(GetRiskConfigResponse.parse(serialize(row)));
});

router.patch("/risk/config", async (req, res) => {
  const parsed = UpdateRiskConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const existing = await loadOrInit();
  const [updated] = await db
    .update(riskConfig)
    .set({
      killSwitchEngaged: parsed.data.killSwitchEngaged ?? existing.killSwitchEngaged,
      // Refuse to flip liveExecutionEnabled regardless of payload.
      liveExecutionEnabled: false,
      maxKellyFraction: parsed.data.maxKellyFraction ?? existing.maxKellyFraction,
      maxPositionUsd: parsed.data.maxPositionUsd ?? existing.maxPositionUsd,
      bankrollUsd: parsed.data.bankrollUsd ?? existing.bankrollUsd,
      minConfidence: parsed.data.minConfidence ?? existing.minConfidence,
      minLiquidityUsd: parsed.data.minLiquidityUsd ?? existing.minLiquidityUsd,
      minEdgeScore: parsed.data.minEdgeScore ?? existing.minEdgeScore,
      updatedAt: new Date(),
    })
    .where(eq(riskConfig.id, existing.id))
    .returning();

  await db.insert(auditLog).values({
    actor: "user",
    action: "risk.update",
    target: `risk_config:${existing.id}`,
    payload: parsed.data,
  });

  // Kill-switch toggles are safety-critical: write a dedicated
  // kill_switch_events row whenever the engaged flag flips. The audit
  // log captures *all* config edits, but operators (and any future
  // calibration tooling) need a clean, filterable history of just the
  // kill-switch state changes with the toggling actor and reason.
  const newEngaged =
    parsed.data.killSwitchEngaged ?? existing.killSwitchEngaged;
  if (newEngaged !== existing.killSwitchEngaged) {
    await db.insert(killSwitchEvents).values({
      engaged: newEngaged,
      actor: "user",
      reason:
        typeof (parsed.data as { reason?: unknown }).reason === "string"
          ? ((parsed.data as { reason?: string }).reason as string)
          : newEngaged
            ? "Manual kill switch engaged via /risk/config."
            : "Manual kill switch disengaged via /risk/config.",
    });
  }

  res.json(UpdateRiskConfigResponse.parse(serialize(updated)));
});

export default router;
