# Workspace

## Overview

This is **Cassandra** — a single-user, local-first personal predictive intelligence terminal for prediction markets, geopolitics, policy, commodities, COMEX/metals, and macro signals. The build is a pnpm workspace monorepo with a React + Vite frontend, an Express API, and Postgres via Drizzle ORM.

**Live execution is permanently disabled.** All trading is paper-only. The `liveExecutionEnabled` flag on `risk_config` is forced to `false` by the API regardless of payload.

## Artifacts

- `artifacts/cassandra` — Web frontend (React + Vite + Tailwind + shadcn/ui). Mounted at `/`.
- `artifacts/api-server` — Express API server. Mounted at `/api`.
- `artifacts/mockup-sandbox` — Component preview server (design tooling).

## Stack

- **Monorepo**: pnpm workspaces, Node 24, TypeScript 5.9
- **Frontend**: React 19, Vite 7, Tailwind 4, shadcn/ui, Wouter, TanStack Query, Recharts, Framer Motion
- **API**: Express 5, pino, Zod (`zod/v4`)
- **DB**: PostgreSQL + Drizzle ORM (push-based migrations in dev)
- **API contract**: OpenAPI at `lib/api-spec/openapi.yaml`. Codegen produces typed React Query hooks (`@workspace/api-client-react`) and Zod schemas (`@workspace/api-zod`).
- **AI**: Anthropic via the workspace integration package (`@workspace/integrations-anthropic-ai`), model `claude-sonnet-4-6`. Streaming chat is delivered as `text/event-stream` (NOT the generated mutation hook — the frontend uses a small manual fetch + ReadableStream parser).

## Key features (Task #1 Foundation)

- **Dashboard** — at-a-glance counts, P&L, win rate, top edge, kill-switch and live-execution state.
- **Top 10 / Universe / Random** — three views over the same opportunity stream from the OpenClaw orchestrator.
- **Opportunity Detail** — market vs model probability, confidence, suggested Kelly, structured Rationale rendered as five distinct sections (`observed` / `inferred` / `speculation` / `unknowns` / `riskFlags`), recent linked signals, and a paper-trade form (gated by kill-switch / max position size).
- **Live Signal Feed** — domain/kind filtered timeline of news, data releases, options flow, etc.
- **Paper Trades** — open & closed positions with mark-to-market unrealized P&L, close action settles against current model probability.
- **Prediction Journal** — calibrated forecasts captured with the same four-bucket epistemic structure.
- **OpenClaw Command Center** — orchestrator status, connector health, recent jobs, manual "Run cycle now" trigger.
- **Risk Settings** — kill switch, max Kelly fraction, max position USD, bankroll. `liveExecutionEnabled` is read-only (always false) and explained.
- **Agent Chat** — streaming Claude conversation grounded in the live opportunity universe and signal feed; persists messages in Postgres.

## OpenClaw orchestrator

`artifacts/api-server/src/lib/cassandra/openclaw.ts` runs every 60s (and once at startup). It calls each live connector under `artifacts/api-server/src/lib/cassandra/connectors/` (`manifold`, `polymarket`, `kalshi`, `metaculus`, `comex`, `news_wires`), upserts opportunities (unique on `source + marketKey`), inserts signal events, recomputes `edgeScore` / `kellyFraction` / `suggestedDirection`, prunes the signal table to the most recent 500 rows, and writes job rows + an audit-log entry per cycle. Connector status is held in process memory and exposed via `GET /api/openclaw/status`.

### Live connectors

Each connector hits a public upstream (no key required for read access except where noted), times out at 12s, retries once on transient failures (network errors, 429, 5xx), and uses a `Cassandra-OpenClaw/1.0` user-agent. The shared HTTP helper lives at `connectors/http.ts`.

| Connector | Upstream | Auth | Emits |
|-----------|----------|------|-------|
| `manifold` | `api.manifold.markets/v0/search-markets` | none | up to 12 binary markets |
| `polymarket` | `gamma-api.polymarket.com/markets` | none | up to 12 binary markets (filtered by liquidity ≥ $1k) |
| `kalshi` | `api.elections.kalshi.com/trade-api/v2/markets` | optional `KALSHI_API_KEY` | up to 12 binary markets (only those with quoted prices and volume/OI) |
| `metaculus` | `metaculus.com/api2/questions/` | required `METACULUS_API_KEY` (Token); degrades gracefully when missing | up to 12 binary forecast questions |
| `comex` | `query1.finance.yahoo.com/v8/finance/chart` for `GC=F`, `SI=F`, `HG=F`, `PL=F` | none | metals price-move signals (1d/1w/1m) above material thresholds |
| `news_wires` | BBC World News RSS + Hacker News top-stories Firebase API | none | headline signals with keyword-derived sentiment |

Connectors that can't fetch usable data set `status = "degraded"` with an actionable `note` (e.g. "set METACULUS_API_KEY"). The OpenClaw command center surfaces both fields per connector. To swap or extend a connector, edit only its file under `connectors/` — the orchestrator never has to change.

## Scoring math

`artifacts/api-server/src/lib/cassandra/scoring.ts`:

- `aggregateModelProb(market, signals)` — combines signals with the market prior in log-odds space.
- `edgeScore({marketProb, modelProb, confidence, liquidity})` — composite score in `[0, 1]`, soft-saturated by liquidity.
- `kellyFraction(inputs, maxKellyFraction)` — Kelly bet sizing for a binary outcome, multiplied by confidence and capped by `maxKellyFraction`.
- `paperPnl({direction, sizeUsd, entryProb, exitProb})` — settles a paper position against `exitProb` (current model prob on close).

## Key commands

- `pnpm run typecheck` — full typecheck across the workspace
- `pnpm run build` — build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas
- `pnpm --filter @workspace/db run push` — push schema changes to the dev DB
- `pnpm --filter @workspace/api-server run dev` — run the API server (auto-started by the workflow)
- `pnpm --filter @workspace/cassandra run dev` — run the web frontend (auto-started by the workflow)

## Environment

- `DATABASE_URL` — provided by the Replit DB
- `ANTHROPIC_API_KEY` — provided via the Replit AI Integrations connector for `@workspace/integrations-anthropic-ai`
- `PORT` — assigned per artifact
- `KALSHI_API_KEY` — *optional*. When set, sent as `Authorization: Bearer …` to the Kalshi trade-api so quoted prices come through. Without it the connector reports `degraded` with an actionable note.
- `METACULUS_API_KEY` — *optional but currently required for live data*. When set, sent as `Authorization: Token …` to the Metaculus REST API. Without it the connector reports `degraded` with an actionable note.

## Conventions

- Logs go through `req.log` (pino-http) inside route handlers and `logger` (from `lib/logger.ts`) elsewhere.
- All response bodies are validated through generated Zod schemas before being returned.
- The frontend imports hooks/types only from `@workspace/api-client-react`, never from relative generated paths.
- The Rationale block (`observed` / `inferred` / `speculation` / `unknowns` / `riskFlags`) is rendered as five visually distinct sections everywhere it appears — never collapsed or paraphrased into a single block.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
