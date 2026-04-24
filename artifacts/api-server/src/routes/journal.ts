import { Router, type IRouter } from "express";
import {
  CreateJournalEntryBody,
  GetJournalEntryParams,
  GetJournalEntryResponse,
  ListJournalEntriesQueryParams,
  ListJournalEntriesResponse,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import { journalEntries, auditLog } from "@workspace/db";
import { desc, eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/journal", async (req, res) => {
  const parsed = ListJournalEntriesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { limit } = parsed.data;
  const rows = await db
    .select()
    .from(journalEntries)
    .orderBy(desc(journalEntries.createdAt))
    .limit(limit ?? 50);
  res.json(ListJournalEntriesResponse.parse(rows.map(serialize)));
});

router.post("/journal", async (req, res) => {
  const parsed = CreateJournalEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { title, domain, question, forecastProb, horizonDays, observed, inferred, speculation, unknowns } = parsed.data;

  const [row] = await db
    .insert(journalEntries)
    .values({
      title,
      domain,
      question,
      forecastProb,
      horizonDays: horizonDays ?? null,
      observed: observed ?? [],
      inferred: inferred ?? [],
      speculation: speculation ?? [],
      unknowns: unknowns ?? [],
    })
    .returning();

  await db.insert(auditLog).values({
    actor: "user",
    action: "journal.create",
    target: `journal:${row.id}`,
    payload: { title, domain, forecastProb },
  });

  res.status(201).json(serialize(row));
});

router.get("/journal/:id", async (req, res) => {
  const parsed = GetJournalEntryParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.id, parsed.data.id))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Journal entry not found" });
    return;
  }
  res.json(GetJournalEntryResponse.parse(serialize(row)));
});

function serialize(row: typeof journalEntries.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    domain: row.domain,
    question: row.question,
    forecastProb: row.forecastProb,
    horizonDays: row.horizonDays,
    observed: row.observed as string[],
    inferred: row.inferred as string[],
    speculation: row.speculation as string[],
    unknowns: row.unknowns as string[],
    outcome: row.outcome,
    outcomeProb: row.outcomeProb,
    createdAt: row.createdAt.toISOString(),
  };
}

export default router;
