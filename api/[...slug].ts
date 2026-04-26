/**
 * Vercel serverless function wrapping the Express API.
 *
 * The catch-all filename `[...slug].ts` makes Vercel route every `/api/*`
 * request through this single function. The Express app has
 * `app.use("/api", router)` so the URL prefix passes through untouched.
 *
 * Seeds run once per cold start (memoised via the `seedPromise` module
 * variable). On a warm function instance subsequent requests skip the
 * seed entirely.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import app from "../artifacts/api-server/src/app";
import { ensureSeed } from "../artifacts/api-server/src/lib/cassandra/seed";
import { ensureWinnerWalletSeed } from "../artifacts/api-server/src/lib/cassandra/winnerWallets";

let seedPromise: Promise<void> | null = null;
function seedOnce(): Promise<void> {
  if (!seedPromise) {
    seedPromise = (async () => {
      await ensureSeed();
      await ensureWinnerWalletSeed();
    })().catch((err) => {
      // Reset so a future request can retry; otherwise we'd be stuck.
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    await seedOnce();
  } catch (err) {
    // Seeding is best-effort — log and continue so health endpoints still respond.
    console.error("seed failed on cold start:", err);
  }
  return (app as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
}

export const config = {
  // SSE streaming for the Anthropic chat endpoint requires Node runtime + 60s.
  maxDuration: 60,
};
