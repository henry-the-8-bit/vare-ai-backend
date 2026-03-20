# Vare AI — Backend Workspace

## Overview

pnpm workspace monorepo using TypeScript. Powers the Vare AI platform backend — a multi-tenant API that handles merchant onboarding, catalog sync from Magento, AI-driven product normalization, agent-facing product discovery/ordering, and dashboard analytics.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Structure

```text
workspace/
├── artifacts/
│   └── api-server/           # Express 5 API server — Vare AI backend
│       └── src/
│           ├── app.ts         # Express app, CORS (allows vare-ai.com), pino logging
│           ├── index.ts       # Entry — reads PORT, starts server
│           ├── lib/
│           │   ├── logger.ts  # Pino structured logger
│           │   ├── response.ts # successResponse / errorResponse / paginatedResponse helpers
│           │   └── crypto.ts  # AES-256-GCM encrypt/decrypt, generateApiKey (HMAC)
│           ├── middlewares/
│           │   └── auth.ts    # requireAuth — validates Bearer token, attaches merchantId
│           ├── services/
│           │   ├── magentoConnector.ts  # MagentoConnector — HTTP client wrapping Magento REST API
│           │   │                        # testConnection, fetchProducts (paginated), healthCheck
│           │   └── catalogSync.ts       # CatalogSyncService — background batch sync, pause/cancel
│           └── routes/
│               ├── index.ts        # Mounts all sub-routers at /api
│               ├── health.ts       # GET /api/healthz
│               ├── onboarding.ts   # POST/GET/PATCH /api/onboarding/merchant[/:id]
│               │                   # GET /api/onboarding/merchant/:id/complexity
│               ├── agentConfig.ts  # POST /api/onboarding/agent-config/generate-key
│               ├── connect.ts      # POST/GET /api/onboarding/connect[/test|/health|/store-views]
│               ├── sync.ts         # POST/GET /api/onboarding/sync[/configure|/start|/status|/...]
│               └── testRoutes.ts   # GET /api/test/health
├── lib/
│   ├── api-spec/             # OpenAPI spec + Orval codegen config
│   ├── api-client-react/     # Generated React Query hooks
│   ├── api-zod/              # Generated Zod schemas from OpenAPI
│   └── db/
│       └── src/
│           ├── index.ts       # DB pool + Drizzle instance
│           └── schema/
│               ├── index.ts          # Barrel export of all tables
│               ├── merchants.ts      # merchants table
│               ├── connections.ts    # magento_connections, store_views tables
│               ├── products.ts       # raw_products, normalized_products tables
│               ├── normalization.ts  # attribute_mappings, value_normalizations tables
│               ├── inventory.ts      # inventory, probe_configs tables
│               ├── jobs.ts           # sync_jobs table
│               ├── analytics.ts      # agent_orders, agent_queries, transaction_events tables
│               └── alerts.ts         # system_alerts, insights tables
├── scripts/                  # Utility scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string (Replit-managed) |
| `ENCRYPTION_KEY` | Yes | 64-char hex key for AES-256-GCM credential encryption |
| `VARE_API_SECRET` | Yes | 64-char hex secret for HMAC API key signing |

## Database Tables (15 total)

All tables are in PostgreSQL. Schema managed by Drizzle Kit.

| Table | Purpose |
|---|---|
| `merchants` | Merchant accounts + onboarding state |
| `magento_connections` | Magento API credentials (encrypted at rest) |
| `store_views` | Store view selections per merchant |
| `raw_products` | Raw JSONB product data from Magento |
| `normalized_products` | Agent-ready normalized product data |
| `attribute_mappings` | Magento attribute → Vare universal attribute mappings |
| `value_normalizations` | Value cluster rules (e.g., "Blk" → "Black") |
| `inventory` | Real-time inventory state per SKU |
| `probe_configs` | Inventory probe configuration |
| `sync_jobs` | Background job tracking (catalog sync, normalization) |
| `agent_orders` | Orders placed via AI agents |
| `agent_queries` | Query log from AI agents (for analytics) |
| `transaction_events` | Full funnel event tracking |
| `system_alerts` | Health alerts and notifications |
| `insights` | AI-generated insights (cached) |

## API Endpoints

All protected endpoints require: `Authorization: Bearer <api_key>`

### Phase 1 — Foundation
| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/healthz` | No | Server health check |
| `POST` | `/api/onboarding/merchant` | No | Create merchant (returns API key) |
| `GET` | `/api/onboarding/merchant/:id` | Yes | Get merchant profile |
| `PATCH` | `/api/onboarding/merchant/:id` | Yes | Update merchant profile |
| `GET` | `/api/onboarding/merchant/:id/complexity` | Yes | Get complexity score breakdown |
| `POST` | `/api/onboarding/agent-config/generate-key` | Yes | Rotate API key |
| `GET` | `/api/test/health` | No | Full system health check (DB + env vars) |

### Phase 2 — Magento Connection & Sync
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/onboarding/connect` | Yes | Save/update Magento credentials (encrypted) |
| `POST` | `/api/onboarding/connect/test` | Yes | Test connection, detect store metadata + views |
| `GET` | `/api/onboarding/connect/health` | Yes | Deep health check (latency, catalog, inventory) |
| `GET` | `/api/onboarding/connect/store-views` | Yes | List detected store views |
| `PATCH` | `/api/onboarding/connect/store-views` | Yes | Update selected store views |
| `POST` | `/api/onboarding/sync/configure` | Yes | Save sync filter config |
| `POST` | `/api/onboarding/sync/start` | Yes | Start full or delta sync job (async) |
| `GET` | `/api/onboarding/sync/status` | Yes | Get sync job progress |
| `POST` | `/api/onboarding/sync/pause` | Yes | Pause a running sync job |
| `POST` | `/api/onboarding/sync/cancel` | Yes | Cancel a sync job |
| `GET` | `/api/onboarding/sync/summary` | Yes | Sync history and stats |
| `GET` | `/api/onboarding/sync/errors` | Yes | Per-product error log (paginated) |

## Response Format

All endpoints follow the spec response envelope:
- **Success**: `{ "data": {...}, "generated_at": "ISO8601" }`
- **Paginated**: `{ "data": [...], "total": N, "page": N, "limit": N, "generated_at": "ISO8601" }`
- **Error**: `{ "error": "message", "code": "ERROR_CODE", "details": {...} }`

## API Key Format

`vare_live_sk_<48-char-hex>` (live) or `vare_test_sk_<48-char-hex>` (sandbox)

## Auth Middleware

`requireAuth` in `src/middlewares/auth.ts` — validates Bearer token by looking up the merchant in the DB. Attaches `req.merchantId` to the request context. All protected routes automatically scope queries to the authenticated merchant.

## Complexity Score

Computed from: Magento edition (commerce/enterprise = +1), ERP system (non-none = +1), PIM system (non-none = +1), large SKU count (100k+ = +1). Range: 0–4 (Simple → Enterprise).

## TypeScript & Composite Projects

Every `lib/*` package extends `tsconfig.base.json` with `composite: true`. The root `tsconfig.json` lists lib packages as project references.

- Run `pnpm run typecheck:libs` — builds the lib dependency graph
- Run `pnpm run typecheck` — full check (libs + artifacts)
- Run `pnpm --filter @workspace/db run push` — push schema changes to DB

## Development

```bash
# Start API server (dev mode with hot reload)
pnpm --filter @workspace/api-server run dev

# Push DB schema changes
pnpm --filter @workspace/db run push

# Full typecheck
pnpm run typecheck
```
