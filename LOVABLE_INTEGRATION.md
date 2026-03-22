# Vare AI — Lovable Frontend Integration Guide

This document tells Lovable everything it needs to connect to the Vare AI backend.

---

## Base URL

```
https://7c5bc484-c306-4ba2-bb1f-64010814d3cf-00-tlp0xr8xs78q.picard.replit.dev/api
```

> All endpoints are prefixed with `/api`. The server runs 24/7 on Replit.

---

## Authentication

Every protected endpoint requires a Bearer token in the `Authorization` header:

```
Authorization: Bearer <api_key>
```

API keys have the format:
- **Live**: `vare_live_sk_<48-char-hex>`
- **Sandbox/test**: `vare_test_sk_<48-char-hex>`

A merchant account and API key are created during onboarding (`POST /api/onboarding/merchant`). The key is returned once at creation time. For the pre-seeded demo merchant use the key returned by `POST /api/test/seed-mock-data`.

The v1 agent-facing routes (`/api/v1/merchants/:slug/...`) also require the URL slug to match the authenticated merchant. Pass `X-Agent-Platform: <platform-name>` on those calls to tag the source.

---

## Response Envelope

All responses follow one of three shapes:

```jsonc
// Success
{ "data": { ... }, "generated_at": "2026-03-20T13:53:20.000Z" }

// Paginated list
{ "data": [ ... ], "total": 1000, "page": 1, "limit": 20, "generated_at": "..." }

// Error
{ "error": "Human-readable message", "code": "ERROR_CODE", "details": { ... } }
```

---

## Date Range Parameter

Many dashboard/analytics endpoints accept a `?range=` query parameter:

| Value   | Meaning             |
|---------|---------------------|
| `today` | Current day         |
| `7d`    | Last 7 days         |
| `30d`   | Last 30 days (default) |
| `90d`   | Last 90 days        |
| `ytd`   | Year to date        |

---

## Endpoints by Feature Area

### Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/healthz` | No | Server liveness check |

---

### Onboarding Wizard (10-phase merchant setup)

All onboarding endpoints use `Authorization: Bearer <api_key>`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/onboarding/merchant` | Create merchant — returns `{ merchantId, apiKey }`. No auth required. |
| `GET` | `/api/onboarding/phase` | Current wizard phase (1–10), percent complete, full checklist, and next action URL — automatically re-syncs `onboarding_phase` on every call |
| `GET` | `/api/onboarding/merchant/:id` | Get merchant profile + onboarding phase |
| `PATCH` | `/api/onboarding/merchant/:id` | Update merchant profile fields |
| `GET` | `/api/onboarding/merchant/:id/complexity` | Complexity score (0–4: Simple → Enterprise) |
| `POST` | `/api/onboarding/connect` | Save Magento credentials (encrypted at rest) |
| `POST` | `/api/onboarding/connect/test` | Test Magento connection, detect store metadata |
| `GET` | `/api/onboarding/connect/health` | Deep connection health (latency, catalog, inventory) |
| `GET` | `/api/onboarding/connect/store-views` | List Magento store views |
| `PATCH` | `/api/onboarding/connect/store-views` | Set selected store views |
| `POST` | `/api/onboarding/sync/configure` | Save sync filter config (categories, SKU count, etc.) |
| `POST` | `/api/onboarding/sync/start` | Start full or delta catalog sync (async) |
| `GET` | `/api/onboarding/sync/status` | Sync job progress |
| `POST` | `/api/onboarding/sync/pause` | Pause a running sync |
| `POST` | `/api/onboarding/sync/cancel` | Cancel a sync job |
| `GET` | `/api/onboarding/sync/summary` | Sync history and aggregate stats |
| `GET` | `/api/onboarding/sync/errors` | Per-product sync errors (paginated) |
| `GET` | `/api/onboarding/health-scan` | Attribute coverage heatmap + issue cards |
| `GET` | `/api/onboarding/normalization/preview` | Preview normalization rules (no DB write) |
| `POST` | `/api/onboarding/normalization/run` | Start batch normalization (async) |
| `GET` | `/api/onboarding/normalization/status` | Normalization job status |
| `GET` | `/api/onboarding/normalization/attribute-mappings` | List discovered attribute mappings |
| `POST` | `/api/onboarding/normalization/attribute-mappings/discover` | Auto-discover mappings from catalog |
| `PATCH` | `/api/onboarding/normalization/attribute-mappings/:id` | Update a mapping (manual override) |
| `GET` | `/api/onboarding/normalization/value-clusters/:mappingId` | Value normalization clusters for a mapping |
| `POST` | `/api/onboarding/normalization/value-clusters/:mappingId/discover` | Auto-cluster values |
| `PATCH` | `/api/onboarding/normalization/value-clusters/:mId/:cId` | Approve/reject/edit a cluster |
| `GET` | `/api/onboarding/fitment/assess` | Fitment coverage assessment |
| `POST` | `/api/onboarding/fitment/extract` | LLM-extract fitment data from descriptions |
| `GET` | `/api/onboarding/probe/results` | Cached inventory probe results |
| `POST` | `/api/onboarding/probe/batch` | Batch probe inventory for multiple SKUs |
| `POST` | `/api/onboarding/probe/config` | Set probe config (TTL, fallback, thresholds) |
| `GET` | `/api/onboarding/probe/:sku` | Probe a single SKU's inventory |
| `GET` | `/api/onboarding/agent-config` | Get agent config + slug + API key hint |
| `PATCH` | `/api/onboarding/agent-config` | Update agent config (rate limits, capabilities) |
| `POST` | `/api/onboarding/agent-config/set-slug` | Set the merchant URL slug |
| `POST` | `/api/onboarding/agent-config/generate-key` | Rotate API key (live or test mode) |
| `GET` | `/api/onboarding/review` | Pre-activation checklist |
| `POST` | `/api/onboarding/activate` | Go live — flip merchant to active |

---

### CSV / Flat-File Catalog Onboarding Path

Merchants who don't have Magento can upload a CSV instead. Set `sourceType = "csv"` automatically on first file upload. Phase tracking adapts: phases 2–6 map to CSV upload → column mapping → import instead of Magento connection → sync.

**Recommended workflow:**
1. `POST /api/onboarding/csv/upload` — upload the CSV file (multipart)
2. Use returned `suggestions` to pre-fill the mapping UI (all auto-detected at high confidence)
3. `POST /api/onboarding/csv/uploads/:id/mappings` — send confirmed mappings (must include `sku` and `name`)
4. `POST /api/onboarding/csv/uploads/:id/import` — run import into the product catalog
5. Continue from Phase 7 (normalization, agent config, go-live) same as Magento path

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/onboarding/csv/fields` | List all Vare field targets (for mapping UI dropdowns) |
| `POST` | `/api/onboarding/csv/upload` | Upload CSV file (multipart `field=file`). Returns `uploadId`, `headers`, `rowCount`, `suggestions` |
| `GET` | `/api/onboarding/csv/uploads` | List all uploads for the authenticated merchant (paginated) |
| `GET` | `/api/onboarding/csv/uploads/:id` | Upload detail — status, headers, current mappings, suggestions if not yet mapped |
| `POST` | `/api/onboarding/csv/uploads/:id/mappings` | Confirm column mappings. Body: `{ mappings: [{ csvHeader, vareField }] }` |
| `POST` | `/api/onboarding/csv/uploads/:id/import` | Run import — inserts/upserts into normalized_products. Returns `{ imported, errors }` |
| `GET` | `/api/onboarding/csv/uploads/:id/errors` | Fetch per-row import errors (first 500 stored) |
| `DELETE` | `/api/onboarding/csv/uploads/:id` | Delete upload (not allowed while import is running) |

**`GET /api/onboarding/csv/fields` response:**
```json
{
  "success": true,
  "data": {
    "fields": [
      { "field": "sku",   "label": "SKU",          "required": true  },
      { "field": "name",  "label": "Product Name",  "required": true  },
      { "field": "brand", "label": "Brand",         "required": false },
      ...
      { "field": "skip",  "label": "Skip this column", "required": false }
    ]
  }
}
```

**`POST /api/onboarding/csv/upload` request:**
```
Content-Type: multipart/form-data
Field name: file
Max size: 50 MB
```

**`POST /api/onboarding/csv/upload` response:**
```json
{
  "success": true,
  "data": {
    "uploadId": "uuid",
    "headers": ["SKU", "Product Name", "Brand", "Price"],
    "rowCount": 4200,
    "suggestions": [
      { "csvHeader": "SKU",          "vareField": "sku",   "confidence": "high" },
      { "csvHeader": "Product Name", "vareField": "name",  "confidence": "high" },
      { "csvHeader": "Brand",        "vareField": "brand", "confidence": "high" },
      { "csvHeader": "Price",        "vareField": "price", "confidence": "high" }
    ]
  }
}
```

**Confidence levels:**
- `high` — header matched a known alias (auto-fill the dropdown)
- `low` — no alias match (show empty dropdown, user must select)

**`POST /api/onboarding/csv/uploads/:id/mappings` body:**
```json
{
  "mappings": [
    { "csvHeader": "SKU",          "vareField": "sku"   },
    { "csvHeader": "Product Name", "vareField": "name"  },
    { "csvHeader": "Brand",        "vareField": "brand" },
    { "csvHeader": "Notes",        "vareField": null    }
  ]
}
```
`vareField: null` skips the column. `"sku"` and `"name"` are required — validation returns 400 if missing.

**Upload status values:**
| Status | Meaning |
|--------|---------|
| `pending_mapping` | Uploaded, awaiting column mapping confirmation |
| `mapped` | Mappings confirmed, ready to import |
| `importing` | Import running |
| `completed` | Import finished |
| `failed` | All rows errored |

**Phase response when `sourceType = "csv"`:**
```json
{
  "currentPhase": 6,
  "totalPhases": 10,
  "label": "Catalog Imported",
  "percentComplete": 60,
  "sourceType": "csv",
  "nextPhase": 7,
  "nextLabel": "Products Normalized",
  "nextAction": "POST /api/onboarding/normalization/run",
  "checklist": [
    { "phase": 1, "label": "Merchant Profile",  "complete": true  },
    { "phase": 2, "label": "CSV Uploaded",      "complete": true  },
    { "phase": 3, "label": "Columns Mapped",    "complete": true  },
    { "phase": 4, "label": "Ready to Import",   "complete": true  },
    { "phase": 5, "label": "Import Configured", "complete": true  },
    { "phase": 6, "label": "Catalog Imported",  "complete": true  },
    { "phase": 7, "label": "Products Normalized","complete": false, "nextAction": "POST /api/onboarding/normalization/run" },
    ...
  ]
}
```

---

### Dashboard — Metrics & Analytics

All accept `?range=` (default `30d`).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/metrics/kpi` | Core KPIs: revenue, orders, queries, conversion rate, AOV — each with value, % change, 15-point sparkline, and platform breakdown |
| `GET` | `/api/metrics/timeseries` | Revenue + orders + queries over time (hourly/daily/weekly, auto-selected by range) |
| `GET` | `/api/metrics/platform-breakdown` | Orders and revenue split by agent platform |
| `GET` | `/api/metrics/top-products` | Top products by order count. `?limit=N` |
| `GET` | `/api/metrics/query-intents` | Query intent distribution (search, fitment, stock, price, etc.) |
| `GET` | `/api/metrics/unmatched-queries` | Queries that matched no product. `?limit=N` |
| `GET` | `/api/metrics/conversion-funnel` | Step-by-step funnel: queries → matched → cart → checkout → order |
| `GET` | `/api/metrics/failed-transactions` | Failed transactions with reason breakdown (paginated) |

---

### Dashboard — Feed & Catalog Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/feeds/connections` | Magento connection info for the merchant |
| `GET` | `/api/feeds/sync-timeline` | Timeline of sync jobs with status |
| `GET` | `/api/feeds/readiness-score` | Feed readiness score (0–100) with sub-scores by dimension |
| `GET` | `/api/feeds/sync-history` | Paginated sync job history. Append `?format=csv` to download as CSV |
| `GET` | `/api/feeds/data-quality` | Data quality breakdown: completeness, normalization, fitment |
| `GET` | `/api/feeds/normalization` | Normalization coverage stats |
| `GET` | `/api/feeds/errors` | Feed errors log. Append `?format=csv` to download |
| `GET` | `/api/feeds/inventory-health` | Inventory health: coverage, low-stock, out-of-stock rates |
| `GET` | `/api/feeds/system-alerts` | Active system alerts and notifications |

---

### Dashboard — Insights

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/insights` | AI-generated narrative insights (Claude-backed, cached per day). Accepts `?range=` |

---

### Dashboard — Transactions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/transactions` | Full funnel event log (paginated). Query params: `range`, `page`, `limit`, `search`, `eventType`, `status` |

---

### Dashboard — Bot Defense

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/bot-defense/overview` | Summary: total requests, match rate, flagged count. Accepts `?range=` |
| `GET` | `/api/bot-defense/events` | Paginated event log with platform + match info. Accepts `?range=`, `?page=`, `?limit=` |
| `GET` | `/api/bot-defense/suspicious-agents` | Agents exceeding rate limits or with high unmatched rates. Accepts `?range=` |
| `GET` | `/api/bot-defense/settings` | Get current bot defense config (rate limits, allowed platforms, max order value) |
| `PATCH` | `/api/bot-defense/settings` | Update bot defense config |

Bot defense settings schema:
```jsonc
{
  "rateLimitPerMinute": 60,          // integer 1–1000
  "requireCartConfirmation": false,   // boolean
  "maxOrderValueCents": 500000,       // integer cents, or null for no limit
  "allowedPlatforms": ["chatgpt", "claude"],  // string[], or null for all
  "testOrderEnabled": true,           // boolean
  "enabledCapabilities": ["catalog_search", "order_placement"]  // string[]
}
```

---

### Agent-Facing API (v1) — for AI agents/LLMs

Auth: `Authorization: Bearer <api_key>` + URL slug must match the authenticated merchant.
Optional: `X-Agent-Platform: <platform>` header to tag the source (e.g. `chatgpt`, `claude`, `gemini`).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/merchants/:slug/catalog` | Search normalized product catalog. Params: `q` (keyword), `category`, `page`, `limit` |
| `GET` | `/api/v1/merchants/:slug/catalog/:sku` | Get single product with inventory |
| `GET` | `/api/v1/merchants/:slug/catalog/:sku/inventory` | Real-time inventory state for a SKU |
| `POST` | `/api/v1/merchants/:slug/cart` | Create a cart with line items |
| `GET` | `/api/v1/merchants/:slug/carts/:id` | Get cart state |
| `POST` | `/api/v1/merchants/:slug/cart/:id/checkout` | Place order via Magento (or simulate in test mode) |
| `GET` | `/api/v1/merchants/:slug/orders` | List agent orders (paginated) |
| `GET` | `/api/v1/merchants/:slug/orders/:id` | Get order by Magento order ID |
| `DELETE` | `/api/v1/merchants/:slug/orders/:id` | Cancel a simulated/test order |

Cart request body:
```jsonc
{
  "items": [
    { "sku": "PROD-001", "qty": 2 }
  ],
  "shippingAddress": {
    "firstname": "Jane", "lastname": "Smith",
    "street": ["123 Main St"], "city": "Austin",
    "regionCode": "TX", "postcode": "78701",
    "countryId": "US", "telephone": "5125550000"
  }
}
```

---

### Test / Development Utilities

These endpoints have no auth requirement and are disabled in production.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/test/seed-mock-data` | Seed demo merchant with 50k products, 30 days of analytics. Body: `{ "force": true }` to re-seed. Returns `{ merchantId, apiKey }` |
| `GET` | `/api/test/health` | Full system health check (DB connectivity, env vars) |
| `POST` | `/api/test/simulate-agent-query` | Simulate a keyword query and log to analytics |
| `POST` | `/api/test/simulate-order` | Simulate cart build + optional test order |
| `GET` | `/api/test/agent-orders` | Recent agent order records |
| `GET` | `/api/test/agent-queries` | Recent agent query records |

---

## Quick Start: Demo Data

To get a working merchant with 30 days of realistic analytics data:

```http
POST /api/test/seed-mock-data
Content-Type: application/json

{ "force": false }
```

Response:
```jsonc
{
  "data": {
    "merchantId": "...",
    "apiKey": "vare_test_sk_...",
    "stats": { "existingProducts": 50000, "existingQueries": 30000, "existingOrders": 734 }
  }
}
```

Use the returned `apiKey` in `Authorization: Bearer <apiKey>` for all subsequent dashboard calls.

---

## CORS

The following origins are allowed:

- `https://www.vare-ai.com`
- `https://vare-ai.com`
- `https://vareai.lovable.app`
- `https://id-preview--e2850076-57e5-4c16-a21b-819c1d133972.lovable.app`
- `http://localhost:3000`
- `http://localhost:5173`

---

## Environment Variables (backend — for reference only)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `ENCRYPTION_KEY` | 64-char hex — AES-256-GCM for Magento credential encryption |
| `VARE_API_SECRET` | 64-char hex — HMAC signing for API keys |
