# Vare AI — Lovable Frontend Spec

This document is the authoritative guide for building the Vare AI frontend in Lovable.
It covers every screen, every component, every API call, and every state the UI needs to handle.

---

## 1. Foundation

### 1.1 Base URL

```
https://7c5bc484-c306-4ba2-bb1f-64010814d3cf-00-tlp0xr8xs78q.picard.replit.dev/api
```

Store this as an environment variable: `VITE_API_BASE_URL`.

### 1.2 Auth

Every API call (except registration and seeding) requires:
```
Authorization: Bearer <apiKey>
```

**Auth store** (Zustand or Context):
```ts
{
  merchantId: string | null
  apiKey: string | null       // stored in localStorage
  sourceType: "magento" | "csv" | null
  currentPhase: number        // 1–10
  isLive: boolean
}
```

On app load: read `apiKey` from `localStorage`. If present, call `GET /api/onboarding/phase` to rehydrate the store. If `401`, clear storage and show registration.

### 1.3 API Client

Thin wrapper that:
1. Prepends `VITE_API_BASE_URL`
2. Injects `Authorization: Bearer <apiKey>` header
3. On 401 → clears auth store and redirects to `/register`
4. Returns `response.data` on success, throws `{ message, code }` on error

### 1.4 Response Envelope

```ts
// All successful responses
{ data: T, generated_at: string }

// Paginated responses
{ data: T[], total: number, page: number, limit: number, generated_at: string }

// Error responses
{ error: string, code: string, details?: any }
```

### 1.5 Route Map

```
/register                         ← Create merchant account
/onboarding                       ← Wizard shell (phases 1–10)
/onboarding/source                ← Pick Magento or CSV (phase 1→2 branch)
/onboarding/magento/connect       ← Magento credentials (phase 2)
/onboarding/magento/test          ← Connection test result (phase 3)
/onboarding/magento/store-views   ← Select store views (phase 4)
/onboarding/magento/sync-config   ← Sync filters (phase 5)
/onboarding/magento/sync          ← Sync progress (phase 6)
/onboarding/csv/upload            ← Drop zone (phase 2)
/onboarding/csv/map               ← Column mapping table (phase 3)
/onboarding/csv/import            ← Import progress (phase 6)
/onboarding/health-scan           ← Attribute heatmap (shared phase 7)
/onboarding/normalization         ← Normalize products (shared phase 7)
/onboarding/agent-config          ← Slug + key + settings (phase 9)
/onboarding/review                ← Pre-launch checklist (phase 10)
/dashboard                        ← KPI overview
/dashboard/transactions           ← Event log
/dashboard/feeds                  ← Catalog health
/dashboard/bot-defense            ← Bot defense
/dashboard/insights               ← AI narrative
/catalog                          ← Normalized product browser
/settings                         ← Agent config, slug, API key rotation
```

---

## 2. Registration Screen

**Route**: `/register`  
**Redirect if already authed**: → `/onboarding`

### Layout

Full-page centered card. Vare AI logo top. Form below.

### Form Fields

| Field | Type | Validation |
|-------|------|------------|
| Company Name | text | required, max 200 |
| Contact Email | email | required, valid email |
| Contact Name | text | required |
| Contact Phone | text | optional |

### Submit

```
POST /api/onboarding/merchant
Body: { companyName, contactEmail, contactName, contactPhone }
```

**Success response:**
```json
{
  "data": {
    "merchantId": "uuid",
    "apiKey": "vare_test_sk_...",
    "slug": "company-name"
  }
}
```

**On success:**
1. Save `merchantId` + `apiKey` to `localStorage` and auth store
2. Show a one-time modal: "Copy your API key now — it won't be shown again" with a copy button
3. Redirect → `/onboarding/source`

**Error states:** Show inline field errors from `details` object.

---

## 3. Onboarding Shell

**Route**: `/onboarding/*`

The shell wraps all onboarding screens. It polls `GET /api/onboarding/phase` on mount and after each wizard step to keep phase state fresh.

### Phase API Response

```
GET /api/onboarding/phase
Authorization: Bearer <apiKey>
```

```json
{
  "data": {
    "currentPhase": 3,
    "totalPhases": 10,
    "label": "Columns Mapped",
    "percentComplete": 30,
    "sourceType": "csv",
    "isLive": false,
    "nextPhase": 4,
    "nextLabel": "Ready to Import",
    "nextAction": "POST /api/onboarding/csv/uploads/:id/import",
    "checklist": [
      { "phase": 1, "label": "Merchant Profile",  "complete": true  },
      { "phase": 2, "label": "CSV Uploaded",      "complete": true  },
      { "phase": 3, "label": "Columns Mapped",    "complete": true  },
      { "phase": 4, "label": "Ready to Import",   "complete": false, "nextAction": "POST ..." },
      ...
    ]
  }
}
```

### Left Sidebar: Phase Checklist

Render `checklist` array as a vertical stepper. Each item shows:
- Checkmark icon if `complete: true`
- Spinner if it is the active incomplete phase
- Lock icon for future phases
- Clicking a completed phase navigates back to that step

Show progress bar at top: `percentComplete`%.

### Smart Routing

On load, read `currentPhase` and `sourceType` from the phase response, then route the user to the correct step:

| Phase | sourceType | Route |
|-------|------------|-------|
| 1 | any | `/onboarding/source` |
| 2 | magento | `/onboarding/magento/connect` |
| 2 | csv | `/onboarding/csv/upload` |
| 3 | magento | `/onboarding/magento/test` |
| 3 | csv | `/onboarding/csv/map` |
| 4 | magento | `/onboarding/magento/store-views` |
| 4 | csv | `/onboarding/csv/import` |
| 5 | magento | `/onboarding/magento/sync-config` |
| 5 | csv | `/onboarding/csv/import` |
| 6 | magento | `/onboarding/magento/sync` |
| 6 | csv | `/onboarding/csv/import` |
| 7–8 | any | `/onboarding/normalization` |
| 9 | any | `/onboarding/agent-config` |
| 10 | any | `/onboarding/review` |

---

## 4. Source Selection Screen

**Route**: `/onboarding/source`  
**Phase**: 1 → choosing path for phase 2

### Layout

Two large cards side by side:

**Card A: Magento Store**
- Icon: store/shop icon
- Title: "Connect Magento"
- Description: "Sync your product catalog directly from your Magento 2 store"
- Button: "Connect Magento" → `/onboarding/magento/connect`

**Card B: Upload CSV**
- Icon: file upload icon
- Title: "Upload a CSV"
- Description: "Import products from a spreadsheet or flat file"
- Button: "Upload CSV" → `/onboarding/csv/upload`

No API call needed — choosing a path just navigates. The `sourceType` is set automatically by the backend when the first credential or upload occurs.

---

## 5. Magento Path — Phase 2: Credentials

**Route**: `/onboarding/magento/connect`

### Form Fields

| Field | Type | Placeholder |
|-------|------|-------------|
| Magento Base URL | url | `https://store.example.com` |
| API Username | text | Admin username |
| API Password | password | Admin password |

### Submit

```
POST /api/onboarding/connect
Body: { baseUrl, apiUser, apiPassword }
```

**Success**: Navigate → `/onboarding/magento/test` and trigger the connection test automatically.  
**Error**: Inline error below each field. Show `error` message in a red alert banner.

---

## 6. Magento Path — Phase 3: Connection Test

**Route**: `/onboarding/magento/test`

On mount, fire the test immediately (no user action required):

```
POST /api/onboarding/connect/test
```

**Response:**
```json
{
  "data": {
    "status": "connected",
    "magentoVersion": "2.4.7",
    "storeCount": 3,
    "catalogSize": 45000
  }
}
```

### States

**Loading**: Spinner with "Testing connection…"

**Success** (`status: "connected"`): Green checkmark card showing:
- Magento version
- Store count
- Catalog size
- Button: "Continue" → `/onboarding/magento/store-views`

**Failure**: Red card with error message + "Edit Credentials" button → back to `/onboarding/magento/connect`

---

## 7. Magento Path — Phase 4: Store Views

**Route**: `/onboarding/magento/store-views`

### On Mount

```
GET /api/onboarding/connect/store-views
```

Returns list of store views. Render as a checkbox list. Pre-select all.

### Submit

```
PATCH /api/onboarding/connect/store-views
Body: { storeViewIds: ["default", "us_en"] }
```

**Success**: Navigate → `/onboarding/magento/sync-config`

---

## 8. Magento Path — Phase 5: Sync Configuration

**Route**: `/onboarding/magento/sync-config`

### Form Fields

| Field | Type | Description |
|-------|------|-------------|
| Include Categories | text (comma-separated) | Filter to specific categories |
| Max SKU Count | number | Optional upper limit |
| Delta Sync Interval | select | hourly / daily / weekly |
| Include Out-of-Stock | toggle | Include OOS products |

### Submit

```
POST /api/onboarding/sync/configure
Body: { categories, maxSkuCount, syncInterval, includeOutOfStock }
```

**Success**: Navigate → `/onboarding/magento/sync` and start sync automatically.

---

## 9. Magento Path — Phase 6: Sync Progress

**Route**: `/onboarding/magento/sync`

On mount, trigger sync if not already running:

```
POST /api/onboarding/sync/start
Body: { mode: "full" }
```

Then poll `GET /api/onboarding/sync/status` every 3 seconds.

### Sync Status Response

```json
{
  "data": {
    "status": "running",
    "totalProducts": 45000,
    "syncedProducts": 12450,
    "failedProducts": 3,
    "progressPercent": 27,
    "estimatedTimeRemainingSeconds": 420
  }
}
```

### UI

- Large circular progress ring: `progressPercent`%
- Counters: synced / total / failed
- ETA: "~7 minutes remaining"
- Status badge: `running` → blue pulsing / `completed` → green / `failed` → red

**Actions:**
- "Pause" button → `POST /api/onboarding/sync/pause`
- "Cancel" button → `POST /api/onboarding/sync/cancel`

**On `status: "completed"`**: Auto-navigate → `/onboarding/normalization`

**On `status: "failed"`**: Show error card with error count link. Still offer "Continue anyway" → `/onboarding/normalization`.

---

## 10. CSV Path — Phase 2: File Upload

**Route**: `/onboarding/csv/upload`

### Layout

Full-width drop zone with dashed border. Icon + "Drag & drop your CSV here, or click to browse".

**Constraints shown in UI:**
- Max file size: 50 MB
- Accepted formats: .csv, .txt
- Tip: "First row must be column headers"

### Upload

```
POST /api/onboarding/csv/upload
Content-Type: multipart/form-data
Field: file = <File>
```

**Loading state**: Progress bar (indeterminate) + "Uploading…"

**Success response:**
```json
{
  "data": {
    "uploadId": "uuid",
    "headers": ["SKU", "Product Name", "Brand", "Price", ...],
    "rowCount": 4200,
    "suggestions": [
      { "csvHeader": "SKU",          "vareField": "sku",   "confidence": "high" },
      { "csvHeader": "Product Name", "vareField": "name",  "confidence": "high" },
      { "csvHeader": "Notes",        "vareField": null,    "confidence": "low"  }
    ]
  }
}
```

**On success:**
1. Save `uploadId` to component state / sessionStorage
2. Show brief success toast: "4,200 rows detected. Now map your columns →"
3. Auto-navigate → `/onboarding/csv/map` passing `uploadId`

**Error states:**
- File too large → inline error, allow re-select
- Not a CSV → inline error
- Server parse error → show error message from `error` field

### Previous Uploads

Below the drop zone, render a small table from `GET /api/onboarding/csv/uploads` showing any previous uploads with their status. Clicking a completed/mapped row navigates to `/onboarding/csv/map?uploadId=<id>`.

---

## 11. CSV Path — Phase 3: Column Mapping

**Route**: `/onboarding/csv/map`  
**Query param**: `?uploadId=<uuid>`

### On Mount

```
GET /api/onboarding/csv/uploads/:uploadId
```

Returns `{ originalHeaders, suggestions, mappings }`.

Also fetch the Vare field list for dropdown options:
```
GET /api/onboarding/csv/fields
```

Returns `{ fields: [{ field, label, required }] }`.

### Mapping Table

Render one row per CSV column header:

| Column | # | Preview Values | Map To |
|--------|---|----------------|--------|
| SKU | 1 | PROD-001, WH-1000 | `[SKU ▾]` |
| Product Name | 2 | Sony WH-1000XM5 | `[Product Name ▾]` |
| Notes | 3 | Internal use only | `[Skip this column ▾]` |

**Dropdown options** for "Map To": all items from `/csv/fields` + "Skip this column" (maps to `null`).

**Auto-population rules:**
- If `suggestion.confidence === "high"` → pre-select the suggested `vareField`
- If `suggestion.confidence === "low"` → leave dropdown on "— Select field —" placeholder

**Visual cues:**
- Green tag on auto-matched rows
- Orange "!" badge on required fields (`sku`, `name`) that are still unmapped
- Counter: "9 of 9 columns mapped"

**Validation before submit:**
- `sku` must be mapped → show error if missing
- `name` must be mapped → show error if missing

### Submit

```
POST /api/onboarding/csv/uploads/:uploadId/mappings
Body: {
  "mappings": [
    { "csvHeader": "SKU",   "vareField": "sku"   },
    { "csvHeader": "Notes", "vareField": null     }
  ]
}
```

**Success**: Navigate → `/onboarding/csv/import?uploadId=<id>`

---

## 12. CSV Path — Phase 6: Import

**Route**: `/onboarding/csv/import`  
**Query param**: `?uploadId=<uuid>`

On mount, trigger import if upload `status === "mapped"`:

```
POST /api/onboarding/csv/uploads/:uploadId/import
```

Immediately poll `GET /api/onboarding/csv/uploads/:uploadId` every 2 seconds until `status !== "importing"`.

### Import Status UI

| Status | UI |
|--------|----|
| `importing` | Progress bar (indeterminate), "Importing products…" |
| `completed` | Green card: "4,200 products imported successfully" |
| `failed` | Red card with "View Errors" button |

**Completed card content:**
- `importedCount` products imported
- `errorCount` rows skipped (show "View errors" link if > 0)
- Button: "Continue to Normalization" → `/onboarding/normalization`

**Error detail**: fetch from `GET /api/onboarding/csv/uploads/:uploadId/errors` and display in a scrollable table:

| Row | Error |
|-----|-------|
| 47 | Missing SKU |
| 103 | Missing product name |

---

## 13. Shared — Phase 7–8: Normalization

**Route**: `/onboarding/normalization`

### On Mount

Fetch current state:
```
GET /api/onboarding/normalization/status
GET /api/onboarding/health-scan
```

### Health Scan Panel (top of page)

`GET /api/onboarding/health-scan` returns:
```json
{
  "data": {
    "readinessScore": 72,
    "dimensions": {
      "titleQuality": 80,
      "descriptionCoverage": 45,
      "brandCoverage": 91,
      "imageCoverage": 67
    },
    "issues": [
      { "severity": "warning", "title": "45% missing descriptions", "affectedCount": 22000 }
    ]
  }
}
```

Render as a mini-heatmap: 4 score pills (title quality, description, brand, images) in green/amber/red.

### Normalization Status

`GET /api/onboarding/normalization/status` returns:
```json
{
  "data": {
    "status": "idle",
    "totalProducts": 50000,
    "normalizedCount": 0,
    "pendingCount": 50000,
    "failedCount": 0,
    "progressPercent": 0
  }
}
```

**If `status === "idle"` or `status === "completed"`:** Show "Run Normalization" button.

**If `status === "running"`:** Show progress bar + polling (every 3 seconds).

### Run Normalization

```
POST /api/onboarding/normalization/run
```

Poll status every 3 seconds until `status === "completed"`.

### Attribute Mapping Tab

Below normalization progress, show an "Attribute Mappings" section.

**Discover mappings:**
```
POST /api/onboarding/normalization/attribute-mappings/discover
```

**List mappings:**
```
GET /api/onboarding/normalization/attribute-mappings
```

Returns a list of mappings. Render as a table:

| Source Attribute | → Vare Field | Status | Action |
|-----------------|--------------|--------|--------|
| color | color | approved | Edit |
| finish_type | finish | pending | Approve / Reject |

Approve/reject via:
```
PATCH /api/onboarding/normalization/attribute-mappings/:id
Body: { status: "approved" | "rejected" }
```

**On completion**: "Continue" button → `/onboarding/agent-config`

---

## 14. Shared — Phase 9: Agent Configuration

**Route**: `/onboarding/agent-config`

### On Mount

```
GET /api/onboarding/agent-config
```

**Response:**
```json
{
  "data": {
    "slug": "my-store",
    "sandboxMode": true,
    "rateLimitPerMinute": 60,
    "requireCartConfirmation": false,
    "maxOrderValueCents": 500000,
    "allowedPlatforms": ["chatgpt", "claude"],
    "enabledCapabilities": ["catalog_search", "order_placement"],
    "apiKeyHint": "vare_test_sk_...d1"
  }
}
```

### Form

**URL Slug** (required first):
- Input field showing current slug
- Submit via: `POST /api/onboarding/agent-config/set-slug` `{ slug }`
- Show live preview of the agent endpoint URL: `https://api.vare-ai.com/v1/merchants/<slug>/catalog`

**Agent Settings** (update via `PATCH /api/onboarding/agent-config`):
- Rate limit per minute: number input (1–1000)
- Require cart confirmation: toggle
- Max order value: money input (or "No limit" toggle)
- Allowed platforms: multi-select chip picker (`chatgpt`, `claude`, `gemini`, `openai`, `any`)
- Enabled capabilities: toggle list (`catalog_search`, `order_placement`, `inventory_check`)
- Sandbox mode: toggle

**API Key section:**
- Show last 4 chars hint
- "Rotate Test Key" button → `POST /api/onboarding/agent-config/generate-key` `{ mode: "test" }`
- "Generate Live Key" button → same endpoint `{ mode: "live" }`
- On rotate: show new key in a one-time copy modal

**Continue**: button → `/onboarding/review`

---

## 15. Shared — Phase 10: Review & Go Live

**Route**: `/onboarding/review`

### On Mount

```
GET /api/onboarding/review
GET /api/onboarding/phase
```

**Review response:**
```json
{
  "data": {
    "ready": true,
    "checks": [
      { "key": "has_products",      "label": "Catalog imported",          "pass": true,  "detail": "50,000 products" },
      { "key": "has_normalization", "label": "Products normalized",        "pass": true,  "detail": "48,200 normalized" },
      { "key": "has_slug",          "label": "Agent slug configured",      "pass": true,  "detail": "my-store" },
      { "key": "has_agent_config",  "label": "Agent settings confirmed",   "pass": true  },
      { "key": "has_api_key",       "label": "Live API key generated",     "pass": false, "detail": "Generate a live key first" }
    ]
  }
}
```

Render each check as a row with green checkmark or red X.

**If `ready: false`**: Disable Go Live button, show which checks failed with fix links.

**If `ready: true`**: Enable "Go Live" button.

### Go Live

```
POST /api/onboarding/activate
```

On success: confetti animation, then redirect → `/dashboard`.

---

## 16. Dashboard Layout

**Route**: `/dashboard/*`  
**Guard**: redirect to `/register` if not authed, `/onboarding` if `isLive === false`

### Navigation

Left sidebar or top nav tabs:
- Overview (default)
- Transactions
- Feed Health
- Bot Defense
- Insights

Top bar: merchant name, phase badge if not live, `isLive` green dot.

---

## 17. Dashboard — Overview

**Route**: `/dashboard`

### Date Range Picker

Dropdown: Today / Last 7 days / Last 30 days (default) / Last 90 days / Year to date  
Sets `?range=` query param for all metrics calls.

### KPI Cards Row

```
GET /api/metrics/kpis?range=30d
```

**Response:**
```json
{
  "data": {
    "totalQueries": { "value": 28450, "change": 12.4, "sparkline": [210, 230, ...] },
    "matchRate":    { "value": 87.3,  "change": 2.1,  "sparkline": [...] },
    "totalOrders":  { "value": 734,   "change": -3.2, "sparkline": [...] },
    "revenue":      { "value": 182450,"change": 8.7,  "sparkline": [...] },
    "avgOrderValue":{ "value": 248.57,"change": 1.1,  "sparkline": [...] }
  }
}
```

Render 5 KPI cards in a row. Each shows:
- Label (e.g. "Total Queries")
- Value (formatted: revenue as $, matchRate as %, others as integers with commas)
- Change badge: green ▲ or red ▼ `X%`
- Sparkline chart (small 20-point line chart)

### Charts Row

**Query Volume Over Time:**
```
GET /api/metrics/query-volume?range=30d
```
Returns `{ data: [{ date, queryCount }] }` — render as a line chart.

**Revenue Over Time:**
```
GET /api/metrics/revenue?range=30d
```
Returns `{ data: [{ date, revenue, orderCount }] }` — render as a bar chart with order count overlay.

**Match Rate Trend:**
```
GET /api/metrics/match-rate-trend?range=30d
```
Returns `{ data: [{ date, matchRate }] }` — render as a line chart with 80% reference line.

### Top Products Widget

```
GET /api/metrics/top-products?range=30d&limit=10
```

Returns `[{ sku, name, queryCount, orderCount, revenue }]`.
Render as a compact table with rank numbers.

### Unmatched Queries Widget

```
GET /api/metrics/unmatched-queries?limit=10
```

Returns common queries that returned no product. Render as a word cloud or tag list with count badges.

### Conversion Funnel

```
GET /api/metrics/conversion-funnel?range=30d
```

Returns `[{ step, count, dropOffRate }]`.
Render as a horizontal funnel chart: Queries → Matched → Cart → Checkout → Ordered.

---

## 18. Dashboard — Transactions

**Route**: `/dashboard/transactions`

### Filters Bar

- Search input (free text — goes to `?search=`)
- Event type multi-select: `query`, `cart`, `checkout`, `order` (→ `?eventType=`)
- Status filter: `success`, `failed` (→ `?status=`)
- Date range picker

### Table

```
GET /api/transactions?range=30d&page=1&limit=50&search=&eventType=&status=
```

**Columns:**
| Timestamp | Event Type | Agent Platform | Query / SKU | Status | Value |
|-----------|------------|----------------|-------------|--------|-------|

- Paginated with prev/next buttons
- Clicking a row expands it to show full payload

---

## 19. Dashboard — Feed Health

**Route**: `/dashboard/feeds`

### Connection Status Card

```
GET /api/feeds/connections
```

Shows: connection type (Magento / CSV), status, last synced time.

For Magento: shows URL, version, store count.
For CSV: shows last upload filename and row count.

### Readiness Score Gauge

```
GET /api/feeds/readiness-score
```

**Response:**
```json
{
  "data": {
    "overall": 78,
    "dimensions": {
      "completeness": 85,
      "normalization": 72,
      "fitment": 45,
      "inventory": 90
    }
  }
}
```

Large circular gauge showing overall score. Below it: 4 dimension score bars.

### Sync Timeline

```
GET /api/feeds/sync-timeline
```

Render as a vertical timeline of sync events (or CSV import events) with status icons.

### Data Quality Panel

```
GET /api/feeds/data-quality
```

Returns completeness per field (brand, description, image, etc.). Render as a horizontal bar chart per field.

### Inventory Health

```
GET /api/feeds/inventory-health
```

Returns: coverage%, low-stock%, out-of-stock%. Render as 3 metric tiles with color coding.

### Active Alerts

```
GET /api/feeds/system-alerts
```

Render as a list of alert cards with severity badges (info / warning / error).

---

## 20. Dashboard — Bot Defense

**Route**: `/dashboard/bot-defense`

### Overview Cards

```
GET /api/bot-defense/overview?range=30d
```

3 stat cards:
- Total agent requests
- Match rate
- Flagged / blocked requests

### Suspicious Agents Table

```
GET /api/bot-defense/suspicious-agents?range=30d
```

| Agent Platform | Request Count | Unmatched Rate | Flagged | Action |
|----------------|---------------|----------------|---------|--------|

### Event Log

```
GET /api/bot-defense/events?range=30d&page=1&limit=50
```

Paginated table of individual events. Columns: timestamp, platform, matched SKU, flagged.

### Settings Panel

```
GET /api/bot-defense/settings
```

Editable form:
- Rate limit per minute: number slider (1–1000)
- Require cart confirmation: toggle
- Max order value: money input + "No limit" toggle
- Allowed platforms: chip picker
- Enabled capabilities: checkbox list
- Test orders: toggle

Submit via: `PATCH /api/bot-defense/settings`

---

## 21. Dashboard — Insights

**Route**: `/dashboard/insights`

```
GET /api/insights?range=30d
```

**Response:**
```json
{
  "data": {
    "summary": "Your match rate improved 2.1% this week, driven by...",
    "sections": [
      { "title": "Top Trends",     "body": "..." },
      { "title": "Revenue Drivers","body": "..." },
      { "title": "Recommendations","body": "..." }
    ],
    "generatedAt": "2026-03-22T00:00:00.000Z"
  }
}
```

Render as a clean editorial layout: summary paragraph at top, then each section as a card.
Show "Generated daily — last updated X hours ago" note.

---

## 22. Catalog Browser

**Route**: `/catalog`

### Search & Filter Bar

- Keyword search → `?q=`
- Category filter dropdown → `?category=`
- Pagination

### API Call

```
GET /api/v1/merchants/:slug/catalog?q=headphones&category=Electronics&page=1&limit=24
```

**Response:**
```json
{
  "data": [
    {
      "sku": "WH-1000XM5",
      "productTitle": "Sony WH-1000XM5",
      "brand": "Sony",
      "price": "349.99",
      "categoryPath": "Electronics > Audio",
      "normalizationStatus": "normalized",
      "agentReadinessScore": 95,
      "imageUrls": ["https://..."]
    }
  ],
  "total": 50000,
  "page": 1,
  "limit": 24
}
```

### Product Grid

Render as a responsive card grid (4 col desktop, 2 col mobile).

Each card:
- Product image (or placeholder icon)
- SKU badge
- Product title
- Brand
- Price
- Agent Readiness Score: colored pill (green ≥ 80 / amber 50–79 / red < 50)

Clicking a card → `/catalog/:sku`

### Product Detail Drawer

```
GET /api/v1/merchants/:slug/catalog/:sku
GET /api/v1/merchants/:slug/catalog/:sku/inventory
```

Slide-in drawer showing:
- All product fields
- Inventory: qty, status (in_stock / low_stock / out_of_stock)
- Normalization status badge
- Raw `customAttributes` JSON panel (collapsible)

---

## 23. Settings

**Route**: `/settings`

Tabs: **Agent Config** | **API Keys** | **Merchant Profile**

### Agent Config Tab

Same as `/onboarding/agent-config` but in settings layout (no wizard chrome).

### API Keys Tab

```
GET /api/onboarding/agent-config   (for key hint)
```

Show:
- Current test key (last 4 chars)
- Current live key (last 4 chars, or "None generated")
- "Rotate Test Key" button
- "Generate Live Key" button

Both call: `POST /api/onboarding/agent-config/generate-key` with `{ mode: "test" | "live" }`

Show new key in a one-time modal with a copy button. Warn: "Store this key securely — it won't be shown again."

### Merchant Profile Tab

```
GET /api/onboarding/merchant/:id
```

Editable form for: company name, contact email, contact name, contact phone.

Submit via: `PATCH /api/onboarding/merchant/:id`

---

## 24. Global Components

### Toast / Notification System

- Success (green): after form submits, imports, sync completion
- Error (red): any API error — show `error` message from response
- Info (blue): background operations starting

### Loading Skeleton

All data-fetching screens show a skeleton layout (not a spinner) while loading. Match the layout of the actual content.

### Empty States

Each data table / list should have an illustrated empty state with a contextual CTA:
- Catalog empty → "Run normalization first"
- Transactions empty → "No agent activity yet"
- Alerts empty → "All systems healthy"

### Error Boundary

Wrap each route in an error boundary that shows a "Something went wrong" card with a reload button. Log the error to console.

---

## 25. Data Demo Mode

For development and Lovable preview: call the seed endpoint once to get a pre-populated merchant:

```
POST /api/test/seed-mock-data
Body: { "force": false }
```

Returns `{ merchantId, apiKey }`. Save to localStorage and use for all subsequent calls.

The seeded merchant has:
- 50,000 normalized products
- 30 days of realistic analytics events
- 734 agent orders
- Pre-configured agent config and slug

---

## 26. Error Handling Cheatsheet

| HTTP Status | Meaning | UI Action |
|-------------|---------|-----------|
| 400 | Validation failed — show `details` | Inline field errors |
| 401 | Invalid or expired API key | Clear auth, redirect to `/register` |
| 404 | Resource not found | Show "Not found" card |
| 409 | Conflict (e.g. import in progress) | Show warning toast |
| 429 | Rate limited | Show "Too many requests, wait X seconds" |
| 500 | Server error | Show generic error card + retry button |

---

## 27. Key Implementation Notes

1. **API key is in `localStorage`** — read it on every page load, inject it in the API client.
2. **Phase endpoint is the source of truth** — call `GET /api/onboarding/phase` on every wizard step mount to prevent routing to an incorrect step.
3. **`sourceType` drives the wizard branch** — always read it from the phase response, never guess.
4. **Polling** — use `setInterval` (clear on unmount) for sync status, normalization status, and CSV import status. Poll every 2–3 seconds.
5. **Multipart upload** — use native `FormData` for the CSV upload. Do not set `Content-Type` manually; the browser sets it automatically with the correct boundary.
6. **CORS is configured** — `http://localhost:5173` is in the allowlist for local dev.
7. **All amounts are in cents** when the field name ends in `Cents` (e.g. `maxOrderValueCents`). Divide by 100 before displaying.
8. **Revenue values** from metrics are in dollars (not cents).
9. **Slug** must be URL-safe: lowercase, letters, numbers, hyphens only. Validate client-side before submit.
10. **Agent endpoint URLs** use the slug: `https://api.vare-ai.com/v1/merchants/<slug>/catalog`. Show these to the user in the agent config and settings screens.
