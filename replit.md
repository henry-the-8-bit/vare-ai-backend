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
│           ├── data/
│           │   ├── colorMappings.ts    # Color alias → normalized name map + normalizeColor()
│           │   ├── unitConversions.ts  # Measurement parsers for weight/dimension units
│           │   └── automotiveRules.ts  # Attribute alias map, finish normalizations, edit-distance
│           ├── services/
│           │   ├── magentoConnector.ts      # MagentoConnector — HTTP client wrapping Magento REST API
│           │   │                             # Includes createGuestCart, addItemToGuestCart, setGuestShipping, placeGuestOrder, cancelOrder
│           │   ├── catalogSync.ts           # CatalogSyncService — background batch sync, pause/cancel
│           │   ├── healthScanService.ts     # Attribute coverage heatmap, issue cards, readiness score
│           │   ├── normalizationService.ts  # 3-layer pipeline: rules → LLM (claude-haiku-4-5) → score
│           │   │                             # discoverAttributeMappings, discoverValueClusters, batch
│           │   ├── fitmentService.ts        # Fitment assessment, LLM extraction from descriptions
│           │   ├── inventoryProbeService.ts # SKU-level inventory probe with cache + fallback logic
│           │   └── orderInjectionService.ts # buildCart, injectOrder, cancelTestOrder — Magento order injection
│           └── routes/
│               ├── index.ts          # Mounts all sub-routers at /api
│               ├── health.ts         # GET /api/healthz
│               ├── onboarding.ts     # POST/GET/PATCH /api/onboarding/merchant[/:id]
│               ├── agentConfig.ts    # GET/PATCH /api/onboarding/agent-config, set-slug, generate-key, review, activate
│               ├── connect.ts        # POST/GET /api/onboarding/connect[/test|/health|/store-views]
│               ├── sync.ts           # POST/GET /api/onboarding/sync[/configure|/start|/status|/...]
│               ├── healthScan.ts     # GET /api/onboarding/health-scan
│               ├── normalization.ts  # GET/POST /api/onboarding/normalization/*
│               ├── fitment.ts        # GET/POST /api/onboarding/fitment/*
│               ├── probe.ts          # GET/POST /api/onboarding/probe/*
│               ├── csv.ts            # CSV upload/mapping/import onboarding path (/api/onboarding/csv/*)
│               ├── phase.ts          # GET /api/onboarding/phase — 10-phase checklist, sourceType-aware
│               ├── testRoutes.ts     # GET /api/test/health, POST simulate-agent-query, simulate-order
│               └── v1/
│                   ├── index.ts      # Mounts catalog + orders under /api/v1/merchants/:slug
│                   ├── catalog.ts    # GET /catalog, /catalog/:sku, /catalog/:sku/inventory (slug-auth)
│                   └── orders.ts     # POST /cart, /cart/:id/checkout, GET /orders, /carts/:id (slug-auth)
├── lib/
│   ├── api-spec/             # OpenAPI spec + Orval codegen config
│   ├── api-client-react/     # Generated React Query hooks
│   ├── api-zod/              # Generated Zod schemas from OpenAPI
│   ├── integrations-anthropic-ai/  # Anthropic AI integration (client + batchProcess)
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

## Database Tables (17 total)

All tables are in PostgreSQL. Schema managed by Drizzle Kit.

| Table | Purpose |
|---|---|
| `merchants` | Merchant accounts + onboarding state (includes `slug` for v1 URL routing) |
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
| `agent_configs` | Per-merchant agent configuration (rate limits, payment/shipping defaults, capabilities) |
| `agent_carts` | Active and checked-out agent shopping carts |
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
| `POST` | `/api/test/health` | Yes | Full system health check (DB + env vars) |

### Phase 4 — Agent-Facing API & Order Injection
| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/onboarding/agent-config` | Bearer | Get current agent config + slug + key hint |
| `PATCH` | `/api/onboarding/agent-config` | Bearer | Update agent config (rate limits, capabilities, etc.) |
| `POST` | `/api/onboarding/agent-config/set-slug` | Bearer | Set merchant URL slug |
| `POST` | `/api/onboarding/agent-config/generate-key` | Bearer | Rotate API key (live or test mode) |
| `POST` | `/api/onboarding/agent-config/review` | Bearer | Pre-activation checklist |
| `POST` | `/api/onboarding/agent-config/activate` | Bearer | Go live — flip isLive flag |
| `GET` | `/api/v1/merchants/:slug/catalog` | Slug+Bearer | Search normalized product catalog |
| `GET` | `/api/v1/merchants/:slug/catalog/:sku` | Slug+Bearer | Get single product with inventory |
| `GET` | `/api/v1/merchants/:slug/catalog/:sku/inventory` | Slug+Bearer | Inventory state for a SKU |
| `POST` | `/api/v1/merchants/:slug/cart` | Slug+Bearer | Create a cart with line items |
| `GET` | `/api/v1/merchants/:slug/carts/:id` | Slug+Bearer | Get cart state |
| `POST` | `/api/v1/merchants/:slug/cart/:id/checkout` | Slug+Bearer | Place order via Magento (or simulate) |
| `GET` | `/api/v1/merchants/:slug/orders` | Slug+Bearer | List agent orders (paginated) |
| `GET` | `/api/v1/merchants/:slug/orders/:id` | Slug+Bearer | Get order by Magento order ID |
| `DELETE` | `/api/v1/merchants/:slug/orders/:id` | Slug+Bearer | Cancel a simulated/test order |
| `POST` | `/api/test/simulate-agent-query` | Bearer | Simulate a keyword query + log to analytics |
| `POST` | `/api/test/simulate-order` | Bearer | Simulate cart build + optional test order |
| `GET` | `/api/test/agent-orders` | Bearer | Get recent agent order records |
| `GET` | `/api/test/agent-queries` | Bearer | Get recent agent query records |

### Phase 3 — Normalization Engine, Fitment & Inventory Probe
| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/onboarding/health-scan` | Yes | Attribute coverage heatmap + issue cards |
| `GET` | `/api/onboarding/normalization/preview` | Yes | Preview rules-based normalization (no DB write) |
| `POST` | `/api/onboarding/normalization/run` | Yes | Start async batch normalization job |
| `GET` | `/api/onboarding/normalization/status` | Yes | Get normalization job status |
| `GET` | `/api/onboarding/normalization/attribute-mappings` | Yes | List discovered attribute mappings |
| `POST` | `/api/onboarding/normalization/attribute-mappings/discover` | Yes | Auto-discover attribute mappings from catalog |
| `PATCH` | `/api/onboarding/normalization/attribute-mappings/:id` | Yes | Update mapping (manual override) |
| `GET` | `/api/onboarding/normalization/value-clusters/:mappingId` | Yes | List value normalization clusters |
| `POST` | `/api/onboarding/normalization/value-clusters/:mappingId/discover` | Yes | Auto-cluster values for a mapping |
| `PATCH` | `/api/onboarding/normalization/value-clusters/:mId/:cId` | Yes | Approve/reject/edit a value cluster |
| `GET` | `/api/onboarding/fitment/assess` | Yes | Fitment coverage assessment |
| `POST` | `/api/onboarding/fitment/extract` | Yes | LLM-extract fitment from descriptions |
| `GET` | `/api/onboarding/probe/results` | Yes | List cached inventory probe results |
| `POST` | `/api/onboarding/probe/batch` | Yes | Batch probe inventory for multiple SKUs |
| `POST` | `/api/onboarding/probe/config` | Yes | Set probe config (TTL, fallback, thresholds) |
| `GET` | `/api/onboarding/probe/:sku` | Yes | Probe single SKU inventory |

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

Two middleware patterns in `src/middlewares/auth.ts`:

- `requireAuth` — validates `Bearer <api_key>` token against the `merchants` table. Attaches `req.merchantId`. Used for onboarding/admin routes.
- `requireAgentAuth` — validates `Bearer <api_key>` AND URL path `:merchant_slug` together. Both must match the same merchant row. Attaches `req.merchantId`, `req.merchantSlug`, and `req.agentPlatform` (from `X-Agent-Platform` header). Used for all `/api/v1/` agent-facing routes to prevent IDOR across merchants.

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
