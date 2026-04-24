/**
 * Seed minimal initial state: a single risk_config row, plus realistic
 * historical patterns/parallels and source-reliability scores so the
 * long-term memory tables are not empty on first boot. The opportunity and
 * signal universe is populated by the OpenClaw orchestrator on first cycle.
 */

import { db } from "@workspace/db";
import {
  riskConfig,
  historicalPatterns,
  historicalParallels,
  sourceReliability,
  scoringModelVersions,
  autopilotConfig,
  thesisProfiles,
} from "@workspace/db";

const PATTERNS = [
  {
    label: "2018 trade-war escalation",
    description:
      "Multi-step tariff escalations between US and major trading partners; equity vol up, specific commodity dislocations.",
    domain: "geopolitics",
    fingerprint: { tariff: 0.9, equity_vol: 0.7, supply_chain: 0.6 },
    baseRate: 0.55,
  },
  {
    label: "2020 COVID supply shock",
    description:
      "Cross-domain disruption: supply chains, energy demand, central-bank pivots all moving at once.",
    domain: "macro",
    fingerprint: { supply_chain: 0.95, demand_shock: 0.9, central_bank_pivot: 0.85 },
    baseRate: 0.4,
  },
  {
    label: "2022 European energy crisis",
    description:
      "Pipeline disruption + power-price spike + LNG re-routing; metals demand fell, gold bid up.",
    domain: "commodities",
    fingerprint: { energy: 0.95, metals: 0.5, geopolitics: 0.85 },
    baseRate: 0.5,
  },
  {
    label: "2023 banking stress mini-cycle",
    description:
      "Regional bank failures, deposit flight, and Fed liquidity backstops; macro stress signals stacked.",
    domain: "macro",
    fingerprint: { banking_stress: 0.9, central_bank_pivot: 0.6, equity_vol: 0.5 },
    baseRate: 0.45,
  },
];

const PARALLELS = [
  {
    patternIdx: 0,
    label: "2018 Section 301 tariffs",
    summary: "Tariff escalation drove equity vol higher and metals into a wide range.",
    outcome: "Markets faded the announcement, then re-priced as escalation continued.",
    similarity: 0.74,
  },
  {
    patternIdx: 1,
    label: "March 2020 cross-asset dislocation",
    summary: "Liquidity vacuum hit every domain at once; central-bank action followed within weeks.",
    outcome: "Sharp recovery in risk assets after the Fed's emergency facilities.",
    similarity: 0.61,
  },
  {
    patternIdx: 2,
    label: "Q3 2022 European NatGas spike",
    summary: "Pipeline disruption flowed into metals and macro stress signals.",
    outcome: "Gold bid up; industrial metals saw demand destruction.",
    similarity: 0.58,
  },
];

const SOURCES = [
  { source: "manifold", reliability: 0.62, sampleSize: 120 },
  { source: "polymarket", reliability: 0.71, sampleSize: 240 },
  { source: "kalshi", reliability: 0.66, sampleSize: 90 },
  { source: "metaculus", reliability: 0.55, sampleSize: 60 },
  { source: "comex", reliability: 0.78, sampleSize: 300 },
  { source: "fred", reliability: 0.85, sampleSize: 500 },
  { source: "bls", reliability: 0.83, sampleSize: 410 },
  { source: "wires_mock", reliability: 0.4, sampleSize: 50 },
  { source: "options_flow", reliability: 0.6, sampleSize: 75 },
];

export async function ensureSeed(): Promise<void> {
  const existing = await db.select().from(riskConfig).limit(1);
  if (existing.length === 0) {
    await db.insert(riskConfig).values({});
  }

  const autoExisting = await db.select().from(autopilotConfig).limit(1);
  if (autoExisting.length === 0) {
    await db.insert(autopilotConfig).values({});
  }

  const versionExisting = await db.select().from(scoringModelVersions).limit(1);
  if (versionExisting.length === 0) {
    await db.insert(scoringModelVersions).values({
      version: "foundation-0.1.0",
      notes: "Initial scoring + reasoning pipeline (paper-only).",
    });
  }

  const thesisExisting = await db.select().from(thesisProfiles).limit(1);
  if (thesisExisting.length === 0) {
    await db.insert(thesisProfiles).values([
      {
        label: "Front-end rates dovish drift",
        description:
          "Hypothesis: front-end rates are pricing too few cuts given decelerating wage growth.",
      },
      {
        label: "Metals demand bid",
        description:
          "Hypothesis: real-yield decline + EM central-bank buying keep gold bid.",
      },
    ]);
  }

  const patternExisting = await db.select().from(historicalPatterns).limit(1);
  let patternIds: number[] = [];
  if (patternExisting.length === 0) {
    const inserted = await db
      .insert(historicalPatterns)
      .values(
        PATTERNS.map((p) => ({
          label: p.label,
          description: p.description,
          domain: p.domain,
          fingerprint: p.fingerprint,
          baseRate: p.baseRate,
        })),
      )
      .returning({ id: historicalPatterns.id });
    patternIds = inserted.map((r) => r.id);
  } else {
    patternIds = patternExisting.map((p) => p.id);
  }

  const parallelExisting = await db.select().from(historicalParallels).limit(1);
  if (parallelExisting.length === 0 && patternIds.length > 0) {
    await db.insert(historicalParallels).values(
      PARALLELS.map((p) => ({
        opportunityId: null,
        patternId: patternIds[Math.min(p.patternIdx, patternIds.length - 1)],
        label: p.label,
        summary: p.summary,
        outcome: p.outcome,
        similarity: p.similarity,
      })),
    );
  }

  const sourceExisting = await db.select().from(sourceReliability).limit(1);
  if (sourceExisting.length === 0) {
    await db.insert(sourceReliability).values(SOURCES);
  }
}
