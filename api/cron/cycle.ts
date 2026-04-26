/**
 * Vercel Cron handler — triggered every minute by `vercel.json` `crons` config.
 *
 * Runs one full OpenClaw cycle (fetch all connectors, ingest signals, score
 * markets, run scheduled jobs). The `runCycle` function is internally
 * serialized via an in-flight guard, but each cron invocation gets a fresh
 * function instance so concurrency is bounded by Vercel's cron scheduler
 * itself.
 *
 * Vercel signs cron requests with an `authorization: Bearer <CRON_SECRET>`
 * header when the env var is set, blocking external triggers. We accept
 * unsigned requests too so the endpoint stays usable for manual triggers
 * during development.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { runCycle } from "../../artifacts/api-server/src/lib/cassandra/openclaw";
import { ensureSeed } from "../../artifacts/api-server/src/lib/cassandra/seed";
import { ensureWinnerWalletSeed } from "../../artifacts/api-server/src/lib/cassandra/winnerWallets";

let seeded = false;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // Optional bearer-token check. Set CRON_SECRET in Vercel project env vars
  // to lock this endpoint down; without it we accept any request.
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const got = req.headers["authorization"];
    if (got !== `Bearer ${expected}`) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
  }

  try {
    if (!seeded) {
      await ensureSeed();
      await ensureWinnerWalletSeed();
      seeded = true;
    }
    const start = Date.now();
    await runCycle();
    sendJson(res, 200, { ok: true, durationMs: Date.now() - start });
  } catch (err) {
    console.error("cron cycle failed:", err);
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const config = {
  maxDuration: 60,
};
