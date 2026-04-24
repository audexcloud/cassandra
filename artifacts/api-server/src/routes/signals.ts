import { Router, type IRouter } from "express";
import { ListSignalsQueryParams, ListSignalsResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { signalEvents } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/signals", async (req, res) => {
  const parsed = ListSignalsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { domain, kind, limit } = parsed.data;
  const filters = [];
  if (domain) filters.push(eq(signalEvents.domain, domain));
  if (kind) filters.push(eq(signalEvents.kind, kind));

  const rows = await db
    .select()
    .from(signalEvents)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(signalEvents.observedAt))
    .limit(limit ?? 100);

  res.json(
    ListSignalsResponse.parse(
      rows.map((s) => ({
        id: s.id,
        opportunityId: s.opportunityId,
        domain: s.domain,
        source: s.source,
        kind: s.kind,
        title: s.title,
        body: s.body,
        impact: s.impact,
        sentiment: s.sentiment,
        observedAt: s.observedAt.toISOString(),
      })),
    ),
  );
});

export default router;
